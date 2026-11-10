'use strict';
/*
 * The tools the MCP server offers. Each one takes the arguments object from the model and returns MCP content:
 * a list of {type: 'text', text} and {type: 'image', data, mimeType}. A thrown Error becomes a tool error the model
 * can read and act on, so messages say what to do next.
 */
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
// Plain relative requires, so scripts/build-mcp.js can fold everything into one file. The PDF parts are required only
// when a PDF tool is used, and a build without PDF support (globalThis.__HW_NO_PDF__) leaves them out altogether.
const S = require('../src/style');
const R = require('../src/render');
const Sheet = require('../src/sheet');
const Y = require('../src/synth');
const Math2 = require('../src/math');
const Mixed = require('../src/mixed');
const { renderPng } = require('./raster');
const { isSealed, unseal } = require('./sealed');
const Notability = require('../src/notability');
const Marks = require('../src/marks');
const Anchors = require('./anchors');
const Placing = require('./placing');
const PDF = !globalThis.__HW_NO_PDF__;
const pdfLib = () => require('../vendor/pdf-lib.min.js');
const inspectPdf = (bytes, o) => require('./pdfinfo').inspect(bytes, o);

const LOOK = { messiness: 0.3, variation: 0.4, neatness: 0.5, wordReuse: 0.25, bounce: 1.5, slantDelta: 0, wordSpacing: 1 }; // the Write tab's defaults
const DEFAULT_INK = '#1749b3';

function createTools(config) {
  const source = config.samples || config.samplesUrl; // a path, or an address (the sealed file the site publishes)
  const isUrl = /^https?:\/\//i.test(source || '');
  const REFRESH_MS = 10 * 60 * 1000; // a server that stays up looks for newer samples this often
  const outDir = path.resolve(config.out || 'handwriting-out');
  let cache = null; // {mtime, style, words}

  // Building the style (cutting every recorded word into letters) takes several seconds for a full set of samples, and a
  // client that starts this program for every call would pay that every time. So the built style is kept on disk, next to the
  // samples, keyed by a hash of the samples and of the engine code. It holds the same strokes as the samples file, so it gets
  // the same care: a private folder, and .gitignore skips it.
  const stamp = (() => {
    const own = ['../src/align.js', '../src/style.js', '../src/geometry.js'].map((f) => path.join(__dirname, f));
    const files = own.every((f) => fs.existsSync(f)) ? own : [__filename]; // in the one-file build, the file itself is the engine
    return crypto.createHash('sha256').update(files.map((f) => fs.readFileSync(f)).join('\n')).digest('hex');
  })();
  const cacheDir = config.cache === false ? null : path.resolve(config.cache || (isUrl || !source ? path.resolve('.handwriting-cache') : path.join(path.dirname(path.resolve(source)), '.handwriting-cache')));

  function readCache(key) {
    if (!cacheDir) return null;
    try {
      return v8.deserialize(fs.readFileSync(path.join(cacheDir, 'style-' + key.slice(0, 32) + '.v8')));
    } catch {
      return null; // none, or an unreadable one: build again
    }
  }
  function writeCache(key, value) {
    if (!cacheDir) return;
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      const file = path.join(cacheDir, 'style-' + key.slice(0, 32) + '.v8');
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, v8.serialize(value), { mode: 0o600 });
      fs.renameSync(tmp, file); // whole or not at all, so another call starting now never reads half a file
      for (const f of fs.readdirSync(cacheDir)) if (/^style-.*\.v8$/.test(f) && f !== path.basename(file)) fs.unlinkSync(path.join(cacheDir, f));
    } catch {
      /* a read-only folder: it just stays slow */
    }
  }

  /** GET an address (http or https), following redirects. */
  function fetchBytes(url, hops) {
    return new Promise((resolve, reject) => {
      const req = (/^https:/i.test(url) ? https : http).get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 5) {
          res.resume();
          return resolve(fetchBytes(new URL(res.headers.location, url).href, (hops || 0) + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Could not download the handwriting from ${url} (HTTP ${res.statusCode}).`));
        }
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve(Buffer.concat(parts)));
      });
      req.on('timeout', () => req.destroy(new Error('Timed out downloading ' + url)));
      req.on('error', (e) => reject(new Error(`Could not download the handwriting from ${url}: ${e.message}. If this computer needs a proxy, download the file with curl and give its path with --samples instead.`)));
    });
  }

  async function load() {
    if (!source) throw new Error('No handwriting is set. Start the server with --samples /path/to/my-handwriting.json (the file the Export button in the Teach tab saves), or --samples-url <address of the sealed file> with --password, or set HANDWRITING_FILE.');
    let stamp2 = null;
    if (!isUrl) {
      try {
        stamp2 = fs.statSync(source).mtimeMs;
      } catch {
        throw new Error('Cannot read the handwriting file at ' + source + '. Check the path.');
      }
    }
    if (cache && (isUrl ? Date.now() - cache.at < REFRESH_MS : cache.mtime === stamp2)) return cache;
    let bytes = isUrl ? await fetchBytes(source) : fs.readFileSync(source);
    if (isSealed(bytes)) bytes = unseal(bytes, config.password); // the plain samples are only ever in memory
    const key = crypto.createHash('sha256').update(stamp).update(bytes).digest('hex');
    let built = readCache(key);
    if (!built) {
      const words = S.fromJSON(bytes.toString('utf8'));
      built = { style: S.buildStyle(words), words: words.length };
      writeCache(key, built);
    }
    cache = { mtime: stamp2, at: Date.now(), style: built.style, words: built.words };
    return cache;
  }

  const clampNum = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Math.max(lo, Math.min(hi, Number(v))) : d);
  /** The seed of a call: a whole number from 0 up, or 1 when none is given (another number gives another take of the same text). */
  function seedOf(v, where) {
    if (v === undefined || v === null || v === '') return { seed: 1, given: false };
    const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
    if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new Error(`${where ? where + ': ' : ''}seed must be a whole number from 0 to 2147483647, not ${JSON.stringify(v)}.`);
    return { seed: n, given: true };
  }
  // ---- redo: draw one word again (write_text, write_batch items, fill_pdf answers) -----------------------------------
  const REDO_SCHEMA = {
    type: 'array',
    maxItems: 20,
    description: 'Draw one word again and keep every other word exactly as it was (same examples of every letter; positions may shift a little because the redone word has another width). For when ONE word or number came out badly and a new seed would redraw, and perhaps spoil, the rest. Each entry: {word, nth, take}. word: a word of the text as typed (split on spaces); the whole token is matched first, then ignoring punctuation round it, so "9.81" finds "9.81," and "(9.81)". nth: which match, from 1 in reading order (default 1; with more matches and no nth the first is used and the report says "first of N"). take: whole number from 1 (default 1): take 1 is another drawing than the plain one, take 2 yet another; the same call always gives the same picture. A word that is not in the text stops that answer before anything is drawn and lists the words. In kind mixed a piece of math is one word: word is its TeX (the text between the dollar signs) or give math: 2 for the second piece. Not available for kind math.',
    items: { type: 'object', properties: { word: { type: 'string' }, nth: { type: 'integer' }, take: { type: 'integer' }, math: { type: 'integer', description: 'kind mixed only: the piece of math to redo, counted from 1, instead of word.' } } },
  };
  /** Checks a redo argument and returns the list the engine takes (see synth.redoLayout). Throws before anything is drawn. */
  function redoOf(v, where, kind) {
    if (v === undefined || v === null) return undefined;
    const at = where ? where + ': ' : '';
    if (!Array.isArray(v)) throw new Error(`${at}redo must be a list like [{"word": "9.81", "take": 2}].`);
    if (!v.length) return undefined;
    if (kind === 'math') throw new Error(`${at}redo is not available for kind math yet (a number in math is drawn from one shared stream, so redrawing it would change the other numbers). Put the number in a kind mixed answer (words with $math$ inside, or the number as a plain word) or use another seed.`);
    if (v.length > 20) throw new Error(`${at}at most 20 redo entries.`);
    const whole = (x, name, i, min) => {
      const n = typeof x === 'string' && /^\d+$/.test(x.trim()) ? Number(x) : x;
      if (!Number.isInteger(n) || n < min || n > 1000) throw new Error(`${at}redo ${i + 1}: ${name} must be a whole number from ${min}, not ${JSON.stringify(x)}.`);
      return n;
    };
    return v.map((r, i) => {
      if (!r || typeof r !== 'object') throw new Error(`${at}redo ${i + 1} must be an object like {"word": "9.81", "take": 2}.`);
      const out = {};
      const hasMath = r.math !== undefined && r.math !== null && r.math !== '';
      if (hasMath) {
        if (kind !== 'mixed') throw new Error(`${at}redo ${i + 1}: math is only for kind mixed (pieces of math inside words).`);
        out.math = whole(r.math, 'math', i, 1);
      } else if (typeof r.word !== 'string' || !r.word.trim()) throw new Error(`${at}redo ${i + 1}: word is required (a word of the text as typed)${kind === 'mixed' ? ', or math: 2 for the second piece of math' : ''}.`);
      else out.word = r.word.trim();
      if (r.nth !== undefined && r.nth !== null && r.nth !== '') out.nth = whole(r.nth, 'nth', i, 1);
      out.take = r.take === undefined || r.take === null || r.take === '' ? 1 : whole(r.take, 'take', i, 1);
      return out;
    });
  }
  /** One report line per redo entry the layout carried out. */
  function redoLines(placed) {
    return (placed.redo || []).map((r) => {
      const name = r.type === 'math' ? `math "${r.text}"` : `"${r.word}"`;
      const bits = [`take ${r.take}`];
      if (r.nth) bits.unshift(`nth ${r.nth}`);
      else if (r.matches > 1) bits.push(`first of ${r.matches}`);
      if (!r.ok) return `redo ${name} (${bits.join(', ')}): could not change "${r.text}": ${r.reason}; it is drawn as it is without redo.`;
      const short = r.usedTake < r.take ? `only ${r.usedTake} different drawing${r.usedTake === 1 ? '' : 's'} exist${r.usedTake === 1 ? 's' : ''}, so this is take ${r.usedTake}: ` : '';
      return `redo ${name} (${bits.join(', ')}): ${short}${r.changed} of ${r.total} characters changed.`;
    });
  }
  /** Sheet.layoutBox, with a word that is not in the text reported by answer (nothing has been drawn at that point). */
  function layoutWithRedo(where, style, box, look) {
    try {
      return Sheet.layoutBox(style, box, look);
    } catch (e) {
      if (e.redo) throw new Error(`${where}: ${e.message}`);
      throw e;
    }
  }
  const lookFrom = (a) => ({
    messiness: clampNum(a.messiness, 0, 1, LOOK.messiness),
    variation: clampNum(a.variation, 0, 1, LOOK.variation),
    neatness: clampNum(a.neatness, 0, 1, LOOK.neatness),
    bounce: clampNum(a.bounce, 0, 3, LOOK.bounce),
    wordReuse: clampNum(a.word_reuse, 0, 1, LOOK.wordReuse),
    slantDelta: LOOK.slantDelta,
    wordSpacing: LOOK.wordSpacing,
  });
  // An em dash in a piece of writing is refused: it is the first thing that makes a fill read as machine text, and some assignments ban it outright.
  const EM_DASH = /\u2014/;
  function banEmDash(txt, where) {
    if (EM_DASH.test(txt)) throw new Error(`${where ? where + ': ' : ''}the text has an em dash (\u2014). Em dashes are not written: use a comma, a full stop or a new sentence instead.`);
  }
  /** A number from where an answer sits and what it says: the seed it gets when none was given, so no two answers open alike. */
  function placeSeed(page, x, y, txt) {
    let h = 2166136261;
    for (const c of `${page}:${Math.round(x)}:${Math.round(y)}:${String(txt).slice(0, 24)}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return h % 2147483647;
  }
  /** What to tell about digits whose examples are few: another seed may give the same one back. */
  function digitNotes(style, txt) {
    const out = [];
    for (const d of new Set(String(txt).match(/[0-9]/g) || [])) {
      const clean = (style.byChar.get(d) || []).filter((u) => u.iso).length;
      if (clean <= 2) out.push(`digit ${d}: only ${clean} clean example${clean === 1 ? '' : 's'} of it, so another seed can give the same one again; the person can write more in the Teach tab`);
    }
    return out;
  }
  const inkOf = (a) => (/^#[0-9a-f]{6}$/i.test(a.ink || '') ? a.ink : DEFAULT_INK);
  const text = (t) => ({ type: 'text', text: t });
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'out';
  function outPath(name) {
    fs.mkdirSync(outDir, { recursive: true });
    return path.join(outDir, name);
  }

  let counter = 0;
  const FORMATS = ['png', 'svg', 'both', 'note'];
  const formatOf = (a) => (FORMATS.includes(a.format) ? a.format : FORMATS.includes(config.format) ? config.format : 'png');

  // ---- characters the handwriting has no sample of -------------------------------------------------
  // Everything is checked BEFORE anything is drawn. A character with no sample is never skipped or guessed: the call stops and
  // says which characters, and which words of the text they are in, or (on_missing: "fallback") a clean drawing stands in for
  // the ones that have one and the reply says so.
  const fallbackOn = (a) => a.on_missing === 'fallback';
  const shown = (ch) => (/[\p{L}\p{N}\p{P}\p{S}]/u.test(ch) ? ch : '');
  const wordsWith = (txt, ch) => Array.from(new Set(String(txt).split(/[\s{}]+/).filter((w) => w.includes(ch)))).slice(0, 6);

  /** problems: [{where, missing: [{ch, code, words, standIn}]}] -> the error that says what to do. */
  function missingMessage(problems) {
    const lines = ['Nothing was written: the loaded handwriting has no sample for some of the characters in the text. Characters are never skipped or guessed.'];
    const drawable = new Set();
    const hopeless = new Set();
    for (const p of problems) {
      for (const m of p.missing) {
        (m.standIn ? drawable : hopeless).add(m.ch);
        const w = m.words.map((x) => `"${x}"`).join(', ');
        lines.push(`  ${p.where ? p.where + ': ' : ''}${shown(m.ch) || '(unprintable)'} (${m.code}) is in ${w || 'the text'}${m.standIn ? '  [a clean drawn stand-in exists]' : ''}${m.speck ? '  [they wrote one, but too small to read, so it was left out]' : ''}`);
      }
    }
    const dl = [...drawable].filter((c) => !hopeless.has(c));
    const hl = [...hopeless];
    const fixes = [];
    if (dl.length) fixes.push(`call again with on_missing: "fallback" to draw clean stand-ins for ${dl.join(' ')} (they will not be the person's own handwriting, and the reply will list them)`);
    if (hl.length) fixes.push(`${hl.join(' ')} cannot be drawn (letters and digits cannot be faked): the person has to write them in the Teach tab, or the text has to change`);
    fixes.push('or ask the person to teach the missing ones in the Teach tab');
    lines.push('What to do: ' + fixes.join('; ') + '.');
    return lines.join('\n');
  }

  /** problems: [{where, text, unknown: ['Rightarrow']}] -> the error for TeX commands that are not supported (short: the list is one call away). */
  function texMessage(problems) {
    const lines = ['Nothing was written: the math has TeX commands that are not supported (they are never written out as words).'];
    const names = new Set();
    for (const p of problems) {
      for (const c of p.unknown) names.add(c);
      lines.push(`  ${p.where ? p.where + ': ' : ''}${p.unknown.map((c) => '\\' + c).join(' ')} in "${String(p.text).slice(0, 60)}"`);
    }
    const hints = [...names].map((c) => ({ c, s: Math2.suggestCommands(c) })).filter((h) => h.s.length);
    if (hints.length) lines.push('Did you mean: ' + hints.map((h) => `\\${h.c} -> ${h.s.map((x) => '\\' + x).join(' or ')}`).join('; ') + '?');
    lines.push('The full list of what works: call handwriting_status with math_help: true (or see mcp.txt). Or use plain symbols.');
    return lines.join('\n');
  }

  /** The characters of a plain text with no sample (see Y.checkText), or [] for math (found by laying it out). */
  const checkPlain = (style, a, kind) => (kind === 'math' ? { missing: [], substituted: [], composed: [] } : Y.checkText(style, kind === 'mixed' ? Mixed.plainText(a.text) : a.text, { fallback: fallbackOn(a) })); // mixed: the words only; the math is found by laying it out

  const kindOf = (a) => (a.kind === 'math' ? 'math' : a.kind === 'mixed' ? 'mixed' : 'text');

  /** The missing characters of a math layout, with the words they are in. */
  const mathMissing = (txt, placed) => placed.missing.map((ch) => ({ ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'), words: wordsWith(txt, ch), standIn: false }));

  /** Lines for the reply about characters that were drawn rather than written, and ones composed from the writer's letters. */
  function drawnNotes(chk, placed) {
    const out = [];
    const drawn = new Map();
    for (const m of chk.substituted) drawn.set(m.ch, m);
    for (const ch of placed.substituted || []) if (!drawn.has(ch)) drawn.set(ch, { ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') });
    if (drawn.size) out.push('Drawn as clean stand-ins, not the person\'s own handwriting (they have no sample of them): ' + [...drawn.values()].map((m) => `${shown(m.ch) || m.code} (${m.code})`).join(' ') + '.');
    if (chk.composed.length) out.push('Composed from the person\'s own letter with an accent or mark drawn over it: ' + chk.composed.join(' ') + '.');
    return out;
  }

  /** Check and lay out one piece of writing. Writes nothing. Returns what renderOne needs, and the characters that block it. */
  async function prepare(a) {
    if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('text is required.');
    banEmDash(a.text, '');
    const { style } = await load();
    const format = formatOf(a);
    const kind = kindOf(a);
    // a Notability page is 537.6 units wide (a 612 pt page) with 512 drawable: the text has to fit in about 460 of those units
    const box = { page: 0, x: 0, y: 0, w: clampNum(a.width_pt, 40, 1200, format === 'note' ? 520 : 400), h: 1e4, text: a.text, kind, xhPt: clampNum(a.letter_height_pt, 4, 40, Sheet.DEFAULT_XH_PT), seed: seedOf(a.seed).seed, auto: false };
    if (a.redo !== undefined) box.redo = redoOf(a.redo, '', kind);
    const chk = checkPlain(style, a, kind);
    if (chk.missing.length) return { a, format, chk, missing: chk.missing };
    const placed = Sheet.layoutBox(style, box, Object.assign(lookFrom(a), { fallbackGlyphs: fallbackOn(a) }));
    const missing = kind !== 'text' ? mathMissing(a.text, placed) : placed.missing.map((ch) => ({ ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'), words: wordsWith(a.text, ch), standIn: false }));
    return { a, format, chk, placed, missing, unknown: kind !== 'text' ? placed.unknown : [] };
  }

  async function renderOne(a, prepared) {
    const p = prepared || (await prepare(a));
    if (p.unknown && p.unknown.length) throw new Error(texMessage([{ where: '', text: a.text, unknown: p.unknown }]));
    if (p.missing.length) throw new Error(missingMessage([{ where: '', missing: p.missing }]));
    const { placed, format, chk } = p;
    const ink = inkOf(a);
    const base = safeName(a.text.slice(0, 24)) + '-' + Date.now().toString(36) + (counter++).toString(36);
    const pt = (v) => Math.round(v * placed.K * 100) / 100;
    // the SVG is sized in points, so it comes out at the letter height that was asked for when it is placed at its own size
    const svg = R.toSVG(placed.layout, { ink, pen: 1, constant: true, paper: 'none' }).replace(/ width="[^"]*" height="[^"]*"/, ` width="${pt(placed.layout.width)}pt" height="${pt(Math.ceil(placed.layout.height))}pt"`);
    const svgPath = outPath(base + '.svg');
    fs.writeFileSync(svgPath, svg);
    let png = null;
    let pngPath = null;
    let note = null;
    let notePath = null;
    if (format === 'note') {
      const unit = Notability.PAGE_W / 612; // note units per point of a letter-size page
      note = Notability.noteFromLayout(placed.layout, { name: a.text.slice(0, 30), ink, xhDoc: placed.xhPt * unit, pen: clampNum(a.pen_width, 0.2, 10, 1.05), left: clampNum(a.left, 0, 480, 20), top: clampNum(a.top, 0, 690, 40) });
      notePath = outPath(base + '.note');
      fs.writeFileSync(notePath, note);
    }
    if (format === 'png' || format === 'both') {
      const d = R.layoutToPath(placed.layout, 1, true);
      const rgb = Sheet.hexToRgb(ink).map((v) => Math.round(v * 255));
      png = renderPng(d, placed.layout.width, Math.ceil(placed.layout.height), placed.K * 4, rgb).png; // 4 pixels per point
      pngPath = outPath(base + '.png');
      fs.writeFileSync(pngPath, png);
    }
    const drawn = /width="([\d.]+)pt" height="([\d.]+)pt"/.exec(svg); // the size stated is the size of the SVG that is saved
    const notes = [`Written at letter height ${placed.xhPt} pt, ${drawn ? Math.round(drawn[1]) : Math.round(placed.layout.width * placed.K)} x ${drawn ? Math.round(drawn[2]) : Math.round(placed.layout.height * placed.K)} pt. SVG: ${svgPath}${pngPath ? '  PNG: ' + pngPath : ''}${notePath ? '  Notability note: ' + notePath : ''}`];
    if (seedOf(a.seed).given) notes[0] += `  Seed ${seedOf(a.seed).seed}.`;
    notes.push(...drawnNotes(chk, placed));
    notes.push(...redoLines(placed));
    notes.push(...digitNotes((await load()).style, a.text));
    return { svg, format, b64: png && png.toString('base64'), note: note && { path: notePath, b64: Buffer.from(note).toString('base64') }, notes: notes.join('\n') };
  }

  /** What goes back for one rendered item: the PNG as an image, the SVG as text (MCP has no SVG image type), or both. */
  function blocks(r, label, a, images) {
    const out = [];
    const tag = label ? label + '. ' : '';
    if (r.b64 && images !== false) out.push({ type: 'image', data: r.b64, mimeType: 'image/png' });
    if (r.svg && (r.format === 'svg' || r.format === 'both') && images !== false) out.push(text(r.svg));
    if (r.note && images !== false) out.push({ type: 'resource', resource: { uri: 'file://' + r.note.path, mimeType: 'application/octet-stream', blob: r.note.b64 } });
    out.push(text(tag + r.notes));
    if (r.b64 && a.include_base64) out.push(text(tag + 'image/png base64:\n' + r.b64));
    return out;
  }

  /**
   * A small picture of one answer's ink, cropped to the ink, on white: enough to check a digit without rendering the page. The
   * layout itself is not touched (the ink is placed on the page from it). About 3 pixels per point, less for a very long answer
   * so the picture is never wider than 640 pixels.
   */
  function previewOf(placed, ink) {
    const pad = 3;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const st of placed.layout.strokes) for (const p of st.pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    if (!isFinite(minX)) return null;
    const crop = {
      ...placed.layout,
      strokes: placed.layout.strokes.map((st) => ({ ...st, pts: st.pts.map((p) => ({ ...p, x: p.x - minX + pad, y: p.y - minY + pad })) })),
      width: maxX - minX + 2 * pad,
      height: maxY - minY + 2 * pad,
    };
    const pxPerPt = Math.min(3, 640 / (crop.width * placed.K));
    const rgb = Sheet.hexToRgb(ink).map((v) => Math.round(v * 255));
    const r = renderPng(R.layoutToPath(crop, 1, true), crop.width, Math.ceil(crop.height), pxPerPt * placed.K, rgb);
    return { b64: r.png.toString('base64'), width: r.width, height: r.height, pxPerPt };
  }

  /** One line per answer: how it was fitted (as is, wrapped, box grown, letters shrunk) and anything drawn rather than written. */
  function fitReport(label, box, placed, extra, seed) {
    const r1 = (v) => (Math.round(v * 10) / 10).toString();
    const bits = [`${label}: written at ${placed.xhPt.toFixed(1)} pt${seed === null || seed === undefined ? '' : typeof seed === 'string' ? ' (' + seed + ')' : ' (seed ' + seed + ')'}`];
    if (placed.wrapped) bits.push(`WRAPPED onto ${placed.lines} lines`);
    const stop = box.blocker && box.growTo > box.h - 0.01 ? ` (it may not grow into the printed text "${box.blocker.text.slice(0, 40)}" at y = ${r1(box.blocker.y)})` : '';
    if (placed.grown) bits.push(`box GROWN downward from ${r1(placed.grown.from)} to ${r1(placed.grown.to)} pt (it now ends at y = ${r1(box.y + placed.grown.to)})${placed.grown.to >= box.growTo - 1 ? stop : ''}`);
    if (placed.shrunk && placed.pitch && Math.abs(placed.shrunk.to - placed.pitch.to) < 0.05) bits.push(`SHRUNK from ${r1(placed.shrunk.from)} to ${r1(placed.shrunk.to)} pt (${Math.round((100 * placed.shrunk.to) / placed.shrunk.from)}% of the size asked for) because the printed lines are only ${r1(placed.pitch.step)} pt apart`);
    else if (placed.shrunk) bits.push(`SHRUNK from ${r1(placed.shrunk.from)} to ${r1(placed.shrunk.to)} pt (${Math.round((100 * placed.shrunk.to) / placed.shrunk.from)}% of the size asked for) because wrapping${box.growTo > box.h ? ' and growing' : ''} was not enough${stop}`);
    if (placed.overflow) {
      const need = Math.ceil(placed.bottom - placed.h);
      bits.push(placed.tooWide ? 'DOES NOT FIT: a word is wider than the box. Make the box wider, shorten the text, or lower min_size_ratio' : `DOES NOT FIT: it needs about ${need} pt more height than the box may have${stop}. Make the box taller (height, max_height), shorten the text, or lower min_size_ratio`);
    } else if (!placed.wrapped && !placed.grown && !placed.shrunk) bits.push('fits as it is');
    return [bits.join('; '), ...extra.map((x) => '    ' + x)].join('\n');
  }

  // ---- pen marks (fill_pdf `marks`) ---------------------------------------------------------------
  const MARK_WORD = { circle: 'round', box: 'round', underline: 'under', strike: 'through', tick: 'on', cross: 'on' };
  const r1m = (v) => (Math.round(v * 10) / 10).toFixed(1);

  /** Checks each mark, finds its target, draws it, pushes {box, placed} onto items and returns one report line per mark. Throws before anything is drawn if one is wrong. */
  async function marksFor(a, bytes, sizes, items, known) {
    const list = Array.isArray(a.marks) ? a.marks : [];
    if (!list.length) return [];
    let inspected = known || null; // fill_pdf has already read the page text once: reuse it
    const made = [];
    for (let i = 0; i < list.length; i++) {
      const mk = list[i] || {};
      const where = `mark ${i + 1}`;
      if (!Marks.TYPES.includes(mk.type)) throw new Error(`${where}: type ${JSON.stringify(mk.type)} is not one of ${Marks.TYPES.join(', ')}.`);
      const page = Math.round(Number(mk.page)) - 1;
      if (!(page >= 0 && page < sizes.length)) throw new Error(`${where}: page ${mk.page} does not exist (the PDF has ${sizes.length}).`);
      const sz = sizes[page];
      const num = (k) => Number.isFinite(Number(mk[k])) && mk[k] !== null && mk[k] !== undefined && mk[k] !== '';
      const xh = mk.letter_height_pt ? clampNum(mk.letter_height_pt, 4, 40, Sheet.DEFAULT_XH_PT) : Sheet.DEFAULT_XH_PT;
      const inPage = (x, y, w, h) => x >= -1 && y >= -1 && x + w <= sz.w + 1 && y + h <= sz.h + 1;
      let geo;
      let target;
      let seedAt;
      if (mk.type === 'arrow' || mk.type === 'line') {
        for (const k of ['x1', 'y1', 'x2', 'y2']) if (!num(k)) throw new Error(`${where}: the ${mk.type} needs x1, y1, x2 and y2 (points from the top-left of the page); ${k} is missing.`);
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => Number(mk[k]));
        if (!inPage(x1, y1, 0, 0) || !inPage(x2, y2, 0, 0)) throw new Error(`${where}: the ${mk.type} from (${x1}, ${y1}) to (${x2}, ${y2}) is outside page ${page + 1}, which is ${sz.w} x ${sz.h} pt.`);
        if (Math.hypot(x2 - x1, y2 - y1) < 1) throw new Error(`${where}: the ${mk.type} starts and ends at the same point.`);
        geo = { type: mk.type, x1, y1, x2, y2 };
        target = `${mk.type} from (${r1m(x1)}, ${r1m(y1)}) to (${r1m(x2)}, ${r1m(y2)})`;
        seedAt = [x1 + x2, y1 + y2];
      } else {
        let rect;
        let how = '';
        let mid;
        if (typeof mk.text === 'string' && mk.text.trim()) {
          if (!inspected) {
            try {
              inspected = await inspectPdf(bytes, { minRule: 36 });
            } catch {
              throw new Error(`${where}: cannot read the printed text of this PDF to find ${JSON.stringify(mk.text)}; aim the mark with x, y, width and height instead.`);
            }
          }
          const hit = Anchors.findText(inspected, { page: page + 1, text: mk.text, nth: mk.nth });
          if (!hit) {
            const near = Anchors.closestLines(inspected, page + 1, mk.text, 5);
            throw new Error(`${where}: the text ${JSON.stringify(mk.text)} is not printed on page ${page + 1}. ${near.length ? 'The closest printed lines on that page are:\n' + near.map((l) => `  "${l.slice(0, 90)}"`).join('\n') : 'There is no printed text on that page.'}\nCheck the spelling against inspect_pdf, or aim the mark with x, y, width and height.`);
          }
          if (!hit.rect) throw new Error(`${where}: nth is ${hit.nth} but ${JSON.stringify(mk.text)} is printed only ${hit.matches} time${hit.matches === 1 ? '' : 's'} on page ${page + 1}.`);
          rect = Object.assign({}, hit.rect);
          if (mk.type === 'strike') mid = 0.64; // printed text sits on its baseline: the middle of its letters is lower than the middle of the font's box
          if (hit.matches > 1) how = mk.nth === undefined || mk.nth === null ? ` (first of ${hit.matches} matches)` : ` (match ${hit.nth} of ${hit.matches})`;
          target = `${mk.type} ${MARK_WORD[mk.type]} ${JSON.stringify(mk.text)}`;
        } else {
          for (const k of ['x', 'y']) if (!num(k)) throw new Error(`${where}: aim a ${mk.type} with text (printed text on the page) or with a rectangle: x, y, width, height. ${k} is missing.`);
          const small = mk.type === 'tick' || mk.type === 'cross';
          if (!(num('width') && num('height')) && !small) throw new Error(`${where}: the ${mk.type} needs width and height (the rectangle it goes ${MARK_WORD[mk.type]}), or text to find on the page.`);
          const side = Marks.defaultSquare(xh);
          rect = { page: page + 1, x: Number(mk.x), y: Number(mk.y), w: num('width') ? Number(mk.width) : side, h: num('height') ? Number(mk.height) : side };
          if (!(rect.w > 0 && rect.h > 0)) throw new Error(`${where}: width and height must be above 0.`);
          target = `${mk.type} ${MARK_WORD[mk.type]} the rectangle`;
        }
        if (!inPage(rect.x, rect.y, rect.w, rect.h)) throw new Error(`${where}: the rectangle (x ${r1m(rect.x)}, y ${r1m(rect.y)}, ${r1m(rect.w)} x ${r1m(rect.h)}) is outside page ${page + 1}, which is ${sz.w} x ${sz.h} pt.`);
        geo = { type: mk.type, x: rect.x, y: rect.y, w: rect.w, h: rect.h, mid };
        seedAt = [rect.x + rect.w / 2, rect.y + rect.h / 2];
        target += ` at x ${r1m(rect.x)}, y ${r1m(rect.y)}, ${r1m(rect.w)} x ${r1m(rect.h)} pt${how}`;
      }
      const given = mk.seed !== undefined && mk.seed !== null && mk.seed !== '';
      const seed = given ? seedOf(mk.seed, where).seed : placeSeed(page, seedAt[0], seedAt[1], 'mark ' + mk.type);
      made.push({ page, xh, geo, seed, line: `${where} (page ${page + 1}): ${target}${given ? ` (seed ${seed})` : ''}` });
    }
    // every mark is valid: now draw them
    return made.map((m) => {
      items.push(Marks.toPlaced(Marks.draw(m.geo, { xh: m.xh, seed: m.seed }), { xh: m.xh, page: m.page }));
      return m.line;
    });
  }

  // ---- placing answers (fill_pdf after_text, ruled lines, warnings) -----------------------------------
  const given = (v) => v !== undefined && v !== null && v !== '';

  /**
   * Where one answer goes: its box position and size, from x / y / line_y / width / height as given, or from the printed text
   * `after_text` (anything given explicitly wins over what was found), and the ruled lines it follows. Throws before anything is drawn.
   * printed: the inspect data (or null), size: {w, h} of the page, page: from 0.
   */
  function placeFor(ans, where, printed, size, page) {
    const num = (v) => given(v) && Number.isFinite(Number(v));
    const xhPt = ans.letter_height_pt ? clampNum(ans.letter_height_pt, 4, 40, Sheet.DEFAULT_XH_PT) : Sheet.DEFAULT_XH_PT;
    const pg = printed && printed.find((p) => p.page === page + 1);
    const anchored = given(ans.after_text);
    let r = null;
    if (anchored) {
      if (typeof ans.after_text !== 'string' || !ans.after_text.trim()) throw new Error(`${where}: after_text must be some of the printed text on the page.`);
      if (!pg) throw new Error(`${where}: cannot read the printed text of this PDF to find ${JSON.stringify(ans.after_text)}; give x, line_y (or y) and width instead.`);
      r = Placing.resolve(printed, { where, page: page + 1, text: ans.after_text, nth: ans.nth, place: ans.place, xh: xhPt, size, width: num(ans.width) ? Number(ans.width) : undefined });
      r.nthGiven = given(ans.nth);
    } else {
      for (const k of ['x', 'width']) if (!Number.isFinite(Number(ans[k]))) throw new Error(`${where}: ${k} must be a number.`);
      if (!Number.isFinite(Number(ans.y)) && !Number.isFinite(Number(ans.line_y))) throw new Error(`${where}: give y (top of the box) or line_y (the printed line it sits on), or after_text (printed text to place it by).`);
    }
    const x = num(ans.x) ? Number(ans.x) : r.x;
    const width = num(ans.width) ? Number(ans.width) : r.width;
    const yGiven = num(ans.y);
    let lineY = num(ans.line_y) ? Number(ans.line_y) : yGiven ? undefined : r && r.lineY;
    if (anchored && !(width > 0)) throw new Error(`${where}: the space found for the answer is not wide enough; give width yourself.`);
    const below = r && r.mode === 'below' && lineY === undefined;
    const h = clampNum(ans.height, 8, 800, lineY !== undefined ? 28 : below ? Math.max(8, Math.min(r.avail, 40)) : 40);
    const y = lineY !== undefined ? lineY - h : yGiven ? Number(ans.y) : r.top;
    const out = { x, width, y, h, step: 0, count: 0, explicitStep: false, notes: [], anchored };
    if (r) {
      const own = ['x', 'width', 'y', 'line_y', 'height'].filter((k) => num(ans[k]));
      out.notes.push(Placing.describe(r, { x, width, lineY: lineY === undefined ? y + h : lineY, y, h }) + (own.length ? ` [you set ${own.join(', ')}, which wins]` : ''));
    }
    // the ruled lines under the answer: written on each in turn when the answer wraps
    if (given(ans.line_spacing_pt)) {
      const st = Number(ans.line_spacing_pt);
      if (!(st >= Placing.MIN_PITCH && st <= Placing.MAX_PITCH)) throw new Error(`${where}: line_spacing_pt must be the distance between ruled lines in points, from ${Placing.MIN_PITCH} to ${Placing.MAX_PITCH}.`);
      if (below) throw new Error(`${where}: line_spacing_pt needs the answer to sit on a line (line_y, or after_text with place "line" or "right"); place "below" hangs from the top of the box.`);
      out.step = st;
      out.explicitStep = true;
    } else if (ans.follow_lines !== false && pg && lineY !== undefined) {
      const rule = Placing.ruleAt(pg, x, width, lineY);
      const f = rule && Placing.followFrom(pg, rule);
      if (f) {
        out.step = f.pitch;
        out.count = f.count;
      }
    }
    if (!out.step && r && r.mode === 'line' && lineY !== undefined && ans.follow_lines !== false) {
      // a lone printed rule found by after_text: the first line sits on it, later lines follow below at the writing's usual spacing
      out.step = 2.5 * xhPt;
      out.natural = true;
    }
    return out;
  }

  /** The report lines for the ruled lines an answer follows (nothing for a one-line answer on an automatically found rule, as before). */
  function ruledNotes(pl, placed) {
    if (!placed.ruled) return [];
    const notes = [];
    const loud = !pl.natural && (pl.anchored || pl.explicitStep || placed.lines > 1);
    if (loud) notes.push(pl.explicitStep ? `follows ruled lines ${r1m(pl.step)} pt apart (line_spacing_pt)` : `follows ${pl.count} printed lines, ${r1m(pl.step)} pt apart`);
    if (placed.ruled.off.length) notes.push(`line${placed.ruled.off.length > 1 ? 's' : ''} ${placed.ruled.off.join(', ')} ${placed.ruled.off.length > 1 ? 'are' : 'is'} NOT on the ruled lines${placed.ruled.tall ? ': a line holding tall math (a fraction, an integral with limits) was given extra room, so the lines after it drift off the rules' : ''}; split the answer into one answer per ruled line to keep each on its line`);
    if (placed.pitch && placed.pitch.tight) notes.push(`the letters are taller than lines ${r1m(pl.step)} pt apart allow and min_size_ratio stops them shrinking: lines may touch`);
    return notes;
  }

  const defs = [
    {
      name: 'handwriting_status',
      description: "Says whether the user's handwriting is loaded and which characters it has no sample for yet. write_text, write_batch and fill_pdf refuse to write a character with no sample (they never skip or guess it), so check this first for anything with unusual symbols, digits or accents. Give `check` the exact text you mean to write.",
      inputSchema: { type: 'object', properties: { check: { type: 'string', description: 'Optional text to check: lists the characters in it that have no sample, and which of them could be drawn as a clean stand-in (on_missing: "fallback").' }, math_help: { type: 'boolean', description: 'true: return the list of TeX commands that math mode supports (symbols, words, marks over letters, structure). Anything else is refused, never written out as a word.' } } },
      async run(a) {
        if (a.math_help === true) return [text('TeX commands that work in kind: "math" (anything else is refused, not written out as a word):\n' + Math2.supportedCommands() + '\nGreek letters and similar have no drawing: they are the person\'s own handwriting or reported as missing.')];
        const { style, words } = await load();
        const chk = Y.checkText(style, a.check || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?()+-=/\'"', { fallback: false });
        const letters = [...style.byChar.values()].reduce((n, a) => n + a.length, 0); // style.count is the number of words that aligned, not letters
        const lines = [`Handwriting loaded: ${words} recorded words, ${letters} letters and symbols cut out of them (${style.byChar.size} different characters).`];
        if (chk.missing.length) {
          lines.push('No sample for: ' + chk.missing.map((m) => m.ch + (m.speck ? ' (written too small to read)' : '')).join(' '));
          const drawable = chk.missing.filter((m) => m.standIn);
          if (drawable.length) lines.push(`Of those, ${drawable.map((m) => m.ch).join(' ')} can be drawn as a clean stand-in (not the person's own handwriting) with on_missing: "fallback". The rest must be taught in the Teach tab.`);
        } else lines.push('Every character checked has a sample.');
        if (chk.composed.length) lines.push(`Drawn from the person's own letter with an accent or mark: ${chk.composed.join(' ')}.`);
        return [text(lines.join(' '))];
      },
    },
    {
      name: 'write_text',
      description: "Writes text, TeX-style math, or both together (kind mixed: words with $math$ inside), in the user's own handwriting and returns a picture of it (blue ink on white). It also saves a transparent SVG (and the PNG) and gives their paths; ask for format \"svg\" to get the SVG markup itself back instead of a picture. Use it to check how an answer looks before putting it on a worksheet, or to produce a handwritten snippet. If one word or number came out badly, give redo ([{word, take}]) to draw just that word again with every other word unchanged, instead of another seed.",
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'What to write. For math, TeX-style: x^2, \\frac{a}{b}, \\sqrt{x}, \\int_0^1 f(x)\\,dx.' },
          kind: { type: 'string', enum: ['text', 'math', 'mixed'], description: 'Default text. math: TeX only. mixed: words with math inside $...$ (or \\(...\\)) in one answer that flows and wraps like text, e.g. "The slope is $\\frac{3}{4}$, so $y = 3x + 1$." \\$ is a dollar sign. In text, a $ is just a character.' },
          width_pt: { type: 'number', description: 'Line width in points before it wraps. Default 400.' },
          letter_height_pt: { type: 'number', description: 'Height of a lowercase letter in points. Default 9.5, which looks like handwriting on a letter-size page.' },
          ink: { type: 'string', description: 'Pen colour as #rrggbb. Default #1749b3 (blue).' },
          seed: { type: 'integer', description: 'A whole number from 0 up (default 1). Another number gives another take of the same text: other examples of each letter and digit are chosen, so use it to re-roll a digit that came out badly. The same number always gives the same writing.' },
          neatness: { type: 'number', description: '0 to 1, higher is easier to read. Default 0.5.' },
          bounce: { type: 'number', description: 'Up and down: 0 to 3, default 1.5. A slight slide of each letter and word above or below the line, and a slow wave along it, so the line does not sit on a perfectly straight baseline. 0 is straight across.' },
          messiness: { type: 'number', description: '0 to 1. Default 0.3.' },
          format: { type: 'string', enum: ['png', 'svg', 'both', 'note'], description: 'png (default) comes back as an image. svg comes back as text: the SVG markup itself, transparent, sized in points, ready to save as a .svg file or place on a page. both gives both. note makes a Notability note (.note) whose writing is real pen strokes that can be edited in Notability: it is saved to a file and also returned as an embedded file. width_pt then defaults to 520. Optional for note: pen_width, left, top (in note units; top is measured down from the top of the page). The SVG file is saved either way.' },
          pen_width: { type: 'number', description: 'format note only: the pen width in note units. Default 1.05 (about a Notability pen at thickness 3).' },
          left: { type: 'number', description: 'format note only: where the text starts, in note units from the left edge of the drawable area (512 wide). Default 20.' },
          top: { type: 'number', description: 'format note only: where the text starts, in note units down from the top of the page (about 705 tall). Default 40.' },
          redo: REDO_SCHEMA,
          include_base64: { type: 'boolean', description: 'Also put the PNG, base64 encoded, in the text of the reply (for a client that cannot show images). It is long, so leave it off otherwise.' },
          on_missing: { type: 'string', enum: ['error', 'fallback'], description: 'What to do about a character the handwriting has no sample of (a degree sign, a macron, a symbol they never wrote). error (default): write nothing and say which characters, and which words they are in. fallback: draw a clean vector stand-in for the ones that have one (symbols and punctuation, never letters or digits) and list them in the reply; it still stops if a letter or digit is missing.' },
        },
      },
      async run(a) {
        return blocks(await renderOne(a), '', a);
      },
    },
    {
      name: 'write_batch',
      description: "Writes several pieces of text or math in the user's handwriting in one call, so the handwriting is loaded once. Takes a list of items, each like write_text's arguments (text, kind, seed, ...); options given at the top level are the default for every item. Returns each in order (as a PNG image, SVG text, or both, see format) and saves each as a PNG and SVG. Every item is checked first: if any character in any item has no sample, nothing is written and the reply lists the characters and the words they are in, item by item (see on_missing). An item that fails for another reason is reported by its number and the others still come back. Use this instead of calling write_text many times.",
      inputSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: { type: 'array', maxItems: 100, items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['text', 'math', 'mixed'] }, seed: { type: 'integer' }, width_pt: { type: 'number' }, letter_height_pt: { type: 'number' }, ink: { type: 'string' }, redo: REDO_SCHEMA } } },
          width_pt: { type: 'number' },
          letter_height_pt: { type: 'number' },
          ink: { type: 'string' },
          neatness: { type: 'number' },
          bounce: { type: 'number' },
          messiness: { type: 'number' },
          format: { type: 'string', enum: ['png', 'svg', 'both', 'note'], description: 'As in write_text. Default png.' },
          on_missing: { type: 'string', enum: ['error', 'fallback'], description: 'As in write_text. With the default (error), if ANY character of ANY item has no sample the whole call stops before writing anything and lists them item by item.' },
          return_images: { type: 'boolean', description: 'Default true. False returns only the saved file paths, which is much smaller.' },
          include_base64: { type: 'boolean', description: 'Also give each PNG as base64 text.' },
        },
      },
      async run(a) {
        if (!Array.isArray(a.items) || !a.items.length) throw new Error('items must be a list with at least one item.');
        if (a.items.length > 100) throw new Error('At most 100 items per call.');
        const { items, return_images: images, ...shared } = a;
        // every item is checked and laid out before any is written, so a missing character stops the whole call with nothing half done
        const prepared = [];
        const problems = [];
        const texProblems = [];
        for (const [i, item] of a.items.entries()) {
          const merged = Object.assign({}, shared, item);
          try {
            const p = await prepare(merged);
            prepared.push({ merged, p });
            if (p.missing.length) problems.push({ where: `item ${i + 1}`, missing: p.missing });
            if (p.unknown && p.unknown.length) texProblems.push({ where: `item ${i + 1}`, text: merged.text, unknown: p.unknown });
          } catch (e) {
            prepared.push({ merged, error: e });
          }
        }
        if (problems.length || texProblems.length) throw new Error([texProblems.length ? texMessage(texProblems) : '', problems.length ? missingMessage(problems) : ''].filter(Boolean).join('\n\n'));
        const out = [];
        for (const [i, { merged, p, error }] of prepared.entries()) {
          try {
            if (error) throw error;
            out.push(...blocks(await renderOne(merged, p), String(i + 1), a, images));
          } catch (e) {
            out.push(text(`${i + 1}. FAILED: ${e.message}`));
          }
        }
        return out;
      },
    },
    {
      name: 'inspect_pdf',
      description: 'Reads a PDF and tells you where things are, so you can choose where answers go. For each page: its size in points, the printed text as lines with their position, and the ruled lines (answer lines and box edges), and small squares that look like checkboxes (`box`, both sides 6 to 30 pt; aim a tick or cross at one with fill_pdf marks). All positions are in points from the top-left corner of the page, the same as fill_pdf. A `line` also says the printed text it follows on its row (after "Name:") and, for a run of evenly spaced lines, its place in it (line 2 of 4, 18 pt apart); fill_pdf can then place an answer with after_text instead of x and y. Look at the PDF itself too if you can, since this lists only text and lines, not pictures.',
      inputSchema: { type: 'object', required: ['pdf'], properties: { pdf: { type: 'string', description: 'Path to the PDF.' }, min_rule_pt: { type: 'number', description: 'Shortest line to report, in points. Default 36.' } } },
      async run(a) {
        const bytes = readPdf(a.pdf);
        const pages = await inspectPdf(bytes, { minRule: clampNum(a.min_rule_pt, 5, 600, 36) });
        const lines = [];
        for (const p of pages) {
          lines.push(`Page ${p.page}: ${p.width} x ${p.height} pt${p.rotated ? ' (rotated: fill_pdf cannot write on it)' : ''}`);
          for (const t of p.text) lines.push(`  text  x=${t.x} y=${t.y} w=${t.w} h=${t.h}  "${t.text}"`);
          const labels = Placing.ruleLabels(p); // what each line follows on its row, and its place in a run of evenly spaced lines
          p.rules.forEach((r, i) => lines.push(`  line  x=${r.x} y=${r.y} w=${r.w}${labels[i] ? '  ' + labels[i] : ''}`));
          for (const b of p.boxes || []) lines.push(`  box  x=${b.x} y=${b.y} w=${b.w} h=${b.h}`);
        }
        return [text(lines.join('\n'))];
      },
    },
    {
      name: 'fill_pdf',
      description: "Writes answers in the user's handwriting onto a PDF and saves a new PDF (the original is not changed). Each answer goes in a box: x and y are the box's top-left corner in points from the page's top-left, width is how wide it may be. Give height (the box's height), or line_y instead of y to have the writing sit on a printed line at that y (use the y of a 'line' from inspect_pdf). When an answer does not fit its box at the letter size asked for, it is dealt with in this order: it wraps onto more lines inside the box's width; the box grows downward (up to max_height; by default it stops just above the nearest printed text under it, or at the bottom margin of the page; grow: false turns this off); and only as a last resort is the writing made smaller, never below min_size_ratio (default 0.8) of the size asked for. The report says for each answer whether it was wrapped, grown or shrunk, and says DOES NOT FIT if it still does not. Every character is checked before anything is written: one with no sample stops the call and is listed with the words it is in (see on_missing). You can skip the arithmetic: give after_text (printed text such as 3. or Name:, with place line, right, below or auto) instead of x, y and width, and the answer is put on the printed line after that text or in the blank space next to it; and when an answer sits on a ruled line with more evenly spaced rules under it, a wrapped answer is written on each rule in turn (follow_lines, line_spacing_pt). The report says what was resolved, and WARNING lines say when the writing covers printed text, covers another answer or leaves the page (the file is still saved: look at the page). Pages are numbered from 1. Do not invent answers for the user; write only what you were asked to write. It can also draw pen marks with `marks`: circle (round an option), tick or cross (in a checkbox), underline, strike (cross out), box (round a final answer), arrow and line, aimed at a rectangle or at printed text (`text`), in the same pen as the writing; answers may be left out when there are marks. An answer can take redo ([{word, nth, take}]) to draw one word of it again and keep the others as they were.",
      inputSchema: {
        type: 'object',
        required: ['pdf'],
        properties: {
          pdf: { type: 'string', description: 'Path to the PDF.' },
          out: { type: 'string', description: 'Where to save. Default: <name>-filled.pdf in the output folder.' },
          ink: { type: 'string', description: 'Pen colour as #rrggbb. Default #1749b3.' },
          neatness: { type: 'number' },
          bounce: { type: 'number' },
          notability: { type: 'boolean', description: 'Also save a Notability note (<name>-filled.note) with the PDF as its pages and the answers on top as pen strokes that can be edited in Notability. Default false.' },
          pen_width: { type: 'number', description: 'With notability: the pen width in note units. Default 1.05.' },
          preview: { type: 'string', enum: ['none', 'all', 'digits'], description: 'Return a small picture of each answer\'s ink (cropped to the ink, on white, about 3 pixels per point, at most 640 px wide) with the report, so you can check digits without rendering and cropping whole pages. all: every answer. digits: only the answers that contain a digit. none (default). They show the writing only, not the page behind it, and at most 20 are returned.' },
          on_missing: { type: 'string', enum: ['error', 'fallback'], description: 'What to do about a character the handwriting has no sample of. error (default): write nothing, and list the characters and the words (and answers) they are in. fallback: draw a clean vector stand-in for symbols and punctuation that have one (a degree sign, a macron, brackets, ...) and list them in the report; letters and digits can never be faked, so one of those missing still stops the call.' },
          marks: {
            type: 'array',
            description: 'Pen marks drawn like a hand does: wobbly, in the same pen and ink as the writing, the same every time for the same seed. Aim each at a rectangle (x, y, width, height in points from the top-left of the page) or at printed text (text, optional nth). arrow and line use x1, y1, x2, y2 instead (the arrow head is at x2, y2). tick and cross with only x, y get a square of about 1.4 x the letter height whose top-left corner is x, y. If the text is not printed on that page the call stops before anything is drawn and lists the closest printed lines.',
            items: {
              type: 'object',
              required: ['page', 'type'],
              properties: {
                page: { type: 'integer', description: 'From 1.' },
                type: { type: 'string', enum: Marks.TYPES, description: 'circle: a loop round the target. tick: a check mark inside it. cross: an X inside it. underline: a line under it. strike: a line through it. box: a rectangle round it. arrow, line: from x1,y1 to x2,y2.' },
                text: { type: 'string', description: 'Aim at this printed text (found on that page; exact first, then ignoring case and extra spaces), instead of a rectangle. For example "B)".' },
                nth: { type: 'integer', description: 'With text: which match on the page, from 1 (reading order). Default 1; the report says when there were more matches.' },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                x1: { type: 'number' },
                y1: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
                letter_height_pt: { type: 'number', description: 'The pen is the one answers use at this letter height (default 9.5), and the loop padding, arrow head and default tick size follow it. Give the same value as the writing on the page.' },
                seed: { type: 'integer', description: 'A whole number from 0 up. Without one, the mark gets its own seed from where it sits, so two circles are never identical.' },
              },
            },
          },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['page', 'text'],
              properties: {
                page: { type: 'integer', description: 'From 1.' },
                x: { type: 'number', description: 'Left edge of the box. Needed unless after_text is given (then it overrides the position found).' },
                y: { type: 'number', description: 'Top of the box.' },
                line_y: { type: 'number', description: 'Instead of y: the y of the printed line the writing sits on.' },
                width: { type: 'number', description: 'How wide the writing may be. Needed unless after_text is given (then it overrides the width found).' },
                height: { type: 'number', description: 'Default 28 (one line) when line_y is used, otherwise 40.' },
                after_text: { type: 'string', description: 'Place the answer by printed text instead of x and y/line_y: for example "3." or "Name:". It is found on that page (exact first, then ignoring case and extra spaces); if it is not printed there the call stops before anything is drawn and lists the closest printed lines. Where the answer goes is set by place. Anything you also give (x, width, y, line_y, height) wins over what was found. The report says what was resolved.' },
                nth: { type: 'integer', description: 'With after_text: which match on the page, from 1 (reading order). Default 1; the report says "first of N matches" when there were more.' },
                place: { type: 'string', enum: Placing.PLACES, description: 'With after_text. line: on the printed ruled line that belongs to the text (a rule on its row to the right of it, else the first rule under it before other printed text); x, line_y and width are the rule\'s. right: in the blank space right of the text on its row, sitting on its baseline, up to the next printed text or the margin. below: in the blank space under the text from its left edge, down to the next printed text. auto (default): line if there is one, else right if at least 60 pt are free, else below. line with no line found stops the call.' },
                line_spacing_pt: { type: 'number', description: 'The distance in points between ruled lines the answer is written on, 10 to 60: a wrapped answer puts line 1 on line_y (or the box\'s bottom edge), line 2 one step lower, and so on, and may grow only as far as other printed text allows. Needed only for lined paper the PDF does not expose as rules; rules drawn in the PDF are followed automatically.' },
                follow_lines: { type: 'boolean', description: 'Default true: when the answer sits on a printed rule (line_y or after_text) with more evenly spaced rules under it (same x, 10 to 60 pt apart), its wrapped lines land on those rules, and the box may grow only to the last one; the letters are made smaller (within min_size_ratio) if they are too tall for the spacing. false turns this off.' },
                text: { type: 'string' },
                kind: { type: 'string', enum: ['text', 'math', 'mixed'] },
                letter_height_pt: { type: 'number' },
                seed: { type: 'integer', description: 'A whole number from 0 up. Without one, each answer gets its own seed from where it sits on the page, so no two answers open alike (the report says which). Another number is another take of this answer (other examples of each letter and digit): use it to re-roll a digit that came out badly. If a digit has only one or two clean examples the report says so: another seed can give the same one again.' },
                redo: REDO_SCHEMA,
                stagger: { type: 'boolean', description: 'true: start this answer a little in from the left (differently on every answer, the right edge stays), so answers do not all start on one vertical line.' },
                shrink_to_fit: { type: 'boolean', description: 'Last resort when wrapping and growing are not enough: make the letters smaller, down to min_size_ratio. Default true. false: never shrink (it wraps and grows, and reports DOES NOT FIT if that is not enough).' },
                min_size_ratio: { type: 'number', description: 'The smallest the letters may be made, as a fraction of letter_height_pt (or the default 9.5 pt). Default 0.8, 0.3 at the lowest. Anything smaller than the size asked for is reported.' },
                grow: { type: 'boolean', description: 'May the box grow downward when the text wraps onto more lines than fit? Default true. Set false when something is printed right under the box.' },
                max_height: { type: 'number', description: 'The tallest the box may grow, in points from its top. Default: down to just above the nearest printed text under the box, or to 36 pt above the bottom edge of the page if there is none.' },
              },
            },
          },
        },
      },
      async run(a) {
        const { style } = await load();
        const bytes = readPdf(a.pdf);
        if (a.answers === undefined || a.answers === null) a.answers = [];
        if (!Array.isArray(a.answers)) throw new Error('answers must be a list of answers.');
        if (a.marks !== undefined && a.marks !== null && !Array.isArray(a.marks)) throw new Error('marks must be a list of marks.');
        if (!a.answers.length && !(a.marks && a.marks.length)) throw new Error('Give at least one answer (answers) or one mark (marks).');
        const PDFLib = pdfLib();
        const probe = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const sizes = probe.getPages().map((p) => {
          const v = p.getCropBox ? p.getCropBox() : p.getMediaBox();
          return { w: v.width, h: v.height };
        });
        const look = Object.assign(lookFrom(a), { fallbackGlyphs: fallbackOn(a) });
        const items = [];
        const report = [];
        const problems = [];
        const texProblems = [];
        const previewJobs = [];
        const inks = []; // each answer's ink in page points, for the warnings
        // where the printed text is, so a box that grows stops above it (unless the answer says how far it may grow)
        let printed = null;
        if (a.answers.length) { // also for after_text, the ruled lines and the warnings, which all need to know where the printed text and lines are
          try {
            printed = await inspectPdf(bytes, { minRule: 36 });
          } catch {
            printed = null; // cannot read it: growth is limited by the bottom margin of the page only
          }
        }
        a.answers.forEach((ans, i) => {
          const where = `answer ${i + 1}`;
          const page = Math.round(Number(ans.page)) - 1;
          if (!(page >= 0 && page < sizes.length)) throw new Error(`${where}: page ${ans.page} does not exist (the PDF has ${sizes.length}).`);
          if (typeof ans.text !== 'string' || !ans.text.trim()) throw new Error(`${where}: text is empty.`);
          banEmDash(ans.text, where);
          const pl = placeFor(ans, where, printed, sizes[page], page); // x, y, width, height, from the numbers given or from after_text
          const { h, y } = pl;
          const kind = kindOf(ans);
          const box = { page, x: pl.x, y, w: pl.width, h, lineStep: pl.step || undefined, text: ans.text, kind, xhPt: ans.letter_height_pt ? clampNum(ans.letter_height_pt, 4, 40, Sheet.DEFAULT_XH_PT) : undefined, seed: ans.seed === undefined || ans.seed === null || ans.seed === '' ? placeSeed(page, pl.x, y, ans.text) : seedOf(ans.seed, where).seed, auto: ans.shrink_to_fit !== false, minRatio: clampNum(ans.min_size_ratio, 0.3, 1, 0.8) };
          if (ans.redo !== undefined) box.redo = redoOf(ans.redo, where, kind);
          if (ans.stagger === true || a.stagger === true) {
            // start a little in from the left, differently on every answer, and keep the right edge where it was
            const sh = Math.min(box.w * 0.25, (((Math.imul(box.seed + 1, 2654435761) >>> 8) % 1000) / 1000) * 1.4 * (box.xhPt || Sheet.DEFAULT_XH_PT) * 2);
            box.x += sh;
            box.w -= sh;
          }
          if (box.x < 0 || box.y < -1 || box.x + box.w > sizes[page].w + 1 || box.y + box.h > sizes[page].h + 1) throw new Error(`${where}: the box (x ${box.x}, y ${box.y}, ${box.w} x ${box.h}) is outside page ${page + 1}, which is ${sizes[page].w} x ${sizes[page].h} pt.`);
          // how far down the box may grow: as far as asked, or down to the bottom margin of the page
          let room = sizes[page].h - 36 - box.y;
          let blocker = null;
          if (printed && ans.grow !== false && !(ans.max_height > 0)) {
            // printed text under the box (and overlapping it sideways) is as far as the box may grow, less a small gap
            for (const t of (printed[page] && printed[page].text) || []) {
              if (t.x < box.x + box.w && t.x + t.w > box.x && t.y >= box.y + box.h - 2 && t.y - 4 - box.y < room) {
                room = t.y - 4 - box.y;
                blocker = t;
              }
            }
          }
          box.growTo = ans.grow === false ? box.h : Math.max(box.h, Math.min(ans.max_height > 0 ? Number(ans.max_height) : room, sizes[page].h - box.y));
          if (pl.count) box.growTo = Math.max(box.h, Math.min(box.growTo, box.h + (pl.count - 1) * pl.step + 0.5)); // not past the last rule of the run
          box.blocker = blocker;
          const label = `${where} (page ${page + 1})`;
          let chk;
          try {
            chk = checkPlain(style, { text: ans.text, on_missing: a.on_missing }, kind);
          } catch (e) {
            throw new Error(`${where}: ${e.message}`); // an unclosed $ in mixed text
          }
          if (chk.missing.length) {
            problems.push({ where: label, missing: chk.missing });
            return;
          }
          const placed = layoutWithRedo(where, style, box, look);
          if (kind !== 'text' && placed.unknown.length) texProblems.push({ where: label, text: ans.text, unknown: placed.unknown });
          const gone = kind !== 'text' ? mathMissing(ans.text, placed) : placed.missing.map((ch) => ({ ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'), words: wordsWith(ans.text, ch), standIn: false }));
          if (gone.length) {
            problems.push({ where: label, missing: gone });
            return;
          }
          items.push({ box, placed });
          inks.push({ label, page, boxes: Placing.inkBoxes(box, placed) });
          report.push(fitReport(label, box, placed, pl.notes.concat(ruledNotes(pl, placed), drawnNotes(chk, placed), digitNotes(style, ans.text), redoLines(placed)), seedOf(ans.seed).given ? seedOf(ans.seed).seed : `own seed ${box.seed}`));
          const wantPreview = a.preview === true || a.preview === 'all' || (a.preview === 'digits' && /[0-9]/.test(ans.text));
          if (wantPreview) previewJobs.push({ label, placed });
        });
        if (problems.length || texProblems.length) throw new Error([texProblems.length ? texMessage(texProblems) : '', problems.length ? missingMessage(problems) : ''].filter(Boolean).join('\n\n')); // before a single stroke is drawn
        // pen marks: every one is checked (page, rectangle, text found) before anything is drawn
        report.push(...(await marksFor(a, bytes, sizes, items, printed)));
        report.push(...Placing.warnings(inks, printed, sizes)); // quiet unless the writing covers printed text, another answer, or leaves the page
        const out = await Sheet.writeInk(PDFLib, bytes, items, { ink: inkOf(a), pen: 1, constant: true });
        const dest = a.out ? path.resolve(a.out) : outPath(safeName(path.basename(a.pdf).replace(/\.pdf$/i, '')) + '-filled.pdf');
        if (path.resolve(a.pdf) === dest) throw new Error('out is the same file as pdf. Choose another name; the original is never overwritten.');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, out);
        let noteLine = '';
        if (a.notability) {
          const noteDest = dest.replace(/\.pdf$/i, '') + '.note';
          fs.writeFileSync(noteDest, Notability.noteFromBoxes(bytes, sizes, items, { name: path.basename(noteDest, '.note').slice(0, 30), ink: inkOf(a), pen: clampNum(a.pen_width, 0.2, 10, 1.05) }));
          noteLine = `\nNotability note: ${noteDest}`;
        }
        const reply = [text(`Saved ${dest}${noteLine}\n` + report.join('\n'))];
        for (const job of previewJobs.slice(0, 20)) {
          const pv = previewOf(job.placed, inkOf(a));
          if (!pv) continue;
          reply.push(text(`${job.label} preview (the writing only, ${pv.width} x ${pv.height} px, ${pv.pxPerPt.toFixed(1)} px per pt):`));
          reply.push({ type: 'image', data: pv.b64, mimeType: 'image/png' });
        }
        if (previewJobs.length > 20) reply.push(text(`${previewJobs.length - 20} more answers were not previewed (at most 20 per call).`));
        return reply;
      },
    },
  ];

  const available = PDF ? defs : defs.filter((d) => d.name !== 'inspect_pdf' && d.name !== 'fill_pdf');

  function readPdf(p) {
    if (typeof p !== 'string' || !p) throw new Error('pdf (a path) is required.');
    let b;
    try {
      b = fs.readFileSync(p);
    } catch {
      throw new Error('Cannot read ' + p);
    }
    if (b.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(p + ' is not a PDF.');
    return new Uint8Array(b);
  }

  return {
    list: () => available.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async call(name, args) {
      const t = available.find((d) => d.name === name);
      if (!t) throw new Error('Unknown tool ' + name);
      return t.run(args || {});
    },
  };
}

module.exports = { createTools };
