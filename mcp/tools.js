'use strict';
/*
 * The tools the MCP server offers. Each one takes the arguments object from the model and returns MCP content:
 * a list of {type: 'text', text} and {type: 'image', data, mimeType}. A thrown Error becomes a tool error the model
 * can read and act on, so messages say what to do next.
 */
const fs = require('fs');
const path = require('path');
// Plain relative requires, so scripts/build-mcp.js can fold everything into one file. The PDF parts are required only
// when a PDF tool is used, and a build without PDF support (globalThis.__HW_NO_PDF__) leaves them out altogether.
const S = require('../src/style');
const R = require('../src/render');
const Sheet = require('../src/sheet');
const { renderPng } = require('./raster');
const PDF = !globalThis.__HW_NO_PDF__;
const pdfLib = () => require('../vendor/pdf-lib.min.js');
const inspectPdf = (bytes, o) => require('./pdfinfo').inspect(bytes, o);

const LOOK = { messiness: 0.3, variation: 0.4, neatness: 0.5, wordReuse: 0.25, slantDelta: 0, wordSpacing: 1 }; // the Write tab's defaults
const DEFAULT_INK = '#1749b3';

function createTools(config) {
  const samplesFile = config.samples;
  const outDir = path.resolve(config.out || 'handwriting-out');
  let cache = null; // {mtime, style, words}

  function load() {
    if (!samplesFile) throw new Error('No handwriting file is set. Start the server with --samples /path/to/my-handwriting.json (the file the Export button in the Teach tab saves), or set HANDWRITING_FILE.');
    let st;
    try {
      st = fs.statSync(samplesFile);
    } catch {
      throw new Error('Cannot read the handwriting file at ' + samplesFile + '. Check the path.');
    }
    if (!cache || cache.mtime !== st.mtimeMs) {
      const words = S.fromJSON(fs.readFileSync(samplesFile, 'utf8'));
      cache = { mtime: st.mtimeMs, style: S.buildStyle(words), words: words.length };
    }
    return cache;
  }

  const clampNum = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Math.max(lo, Math.min(hi, Number(v))) : d);
  const lookFrom = (a) => ({
    messiness: clampNum(a.messiness, 0, 1, LOOK.messiness),
    variation: clampNum(a.variation, 0, 1, LOOK.variation),
    neatness: clampNum(a.neatness, 0, 1, LOOK.neatness),
    wordReuse: clampNum(a.word_reuse, 0, 1, LOOK.wordReuse),
    slantDelta: LOOK.slantDelta,
    wordSpacing: LOOK.wordSpacing,
  });
  const inkOf = (a) => (/^#[0-9a-f]{6}$/i.test(a.ink || '') ? a.ink : DEFAULT_INK);
  const text = (t) => ({ type: 'text', text: t });
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'out';
  function outPath(name) {
    fs.mkdirSync(outDir, { recursive: true });
    return path.join(outDir, name);
  }

  const defs = [
    {
      name: 'handwriting_status',
      description: "Says whether the user's handwriting is loaded and which characters it has no sample for yet. Characters without a sample are skipped when writing, so check this before writing anything with unusual symbols or digits.",
      inputSchema: { type: 'object', properties: { check: { type: 'string', description: 'Optional text to check: lists the characters in it that have no sample.' } } },
      run(a) {
        const { style, words } = load();
        const missing = S.missingChars(style, a.check || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?()+-=/\'"');
        return [text(`Handwriting loaded: ${words} recorded words, ${style.count} letters and symbols cut out. ${missing.length ? 'No sample for: ' + missing.join(' ') : 'Every character checked has a sample.'}`)];
      },
    },
    {
      name: 'write_text',
      description: "Writes text, or TeX-style math, in the user's own handwriting and returns a picture of it (blue ink on white). It also saves a PNG and a transparent SVG and gives their paths. Use it to check how an answer looks before putting it on a worksheet, or to produce a handwritten snippet.",
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'What to write. For math, TeX-style: x^2, \\frac{a}{b}, \\sqrt{x}, \\int_0^1 f(x)\\,dx.' },
          kind: { type: 'string', enum: ['text', 'math'], description: 'Default text.' },
          width_pt: { type: 'number', description: 'Line width in points before it wraps. Default 400.' },
          letter_height_pt: { type: 'number', description: 'Height of a lowercase letter in points. Default 9.5, which looks like handwriting on a letter-size page.' },
          ink: { type: 'string', description: 'Pen colour as #rrggbb. Default #1749b3 (blue).' },
          seed: { type: 'integer', description: 'Another number gives another take of the same text.' },
          neatness: { type: 'number', description: '0 to 1, higher is easier to read. Default 0.5.' },
          messiness: { type: 'number', description: '0 to 1. Default 0.3.' },
          include_base64: { type: 'boolean', description: 'Also put the PNG, base64 encoded, in the text of the reply (for a client that cannot show images). It is long, so leave it off otherwise.' },
        },
      },
      run(a) {
        if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('text is required.');
        const { style } = load();
        const box = { page: 0, x: 0, y: 0, w: clampNum(a.width_pt, 40, 1200, 400), h: 1e4, text: a.text, kind: a.kind === 'math' ? 'math' : 'text', xhPt: clampNum(a.letter_height_pt, 4, 40, Sheet.DEFAULT_XH_PT), seed: Math.round(clampNum(a.seed, 1, 1e6, 1)), auto: false };
        const placed = Sheet.layoutBox(style, box, lookFrom(a));
        const ink = inkOf(a);
        const d = R.layoutToPath(placed.layout, 1, true);
        const rgb = Sheet.hexToRgb(ink).map((v) => Math.round(v * 255));
        const pxPerPt = 4;
        const { png } = renderPng(d, placed.layout.width, Math.ceil(placed.layout.height), placed.K * pxPerPt, rgb);
        const base = safeName(a.text.slice(0, 24)) + '-' + Date.now().toString(36);
        const pngPath = outPath(base + '.png');
        const svgPath = outPath(base + '.svg');
        fs.writeFileSync(pngPath, png);
        fs.writeFileSync(svgPath, R.toSVG(placed.layout, { ink, pen: 1, constant: true, paper: 'none' }));
        const notes = [`Written at letter height ${placed.xhPt} pt, ${Math.round(placed.layout.width * placed.K)} x ${Math.round(placed.layout.height * placed.K)} pt. PNG: ${pngPath}  SVG: ${svgPath}`];
        if (placed.missing.length) notes.push('No sample for: ' + placed.missing.join(' ') + ' (skipped or drawn as a stand-in).');
        const b64 = png.toString('base64');
        return [{ type: 'image', data: b64, mimeType: 'image/png' }, text(notes.join('\n')), ...(a.include_base64 ? [text('image/png base64:\n' + b64)] : [])];
      },
    },
    {
      name: 'inspect_pdf',
      description: 'Reads a PDF and tells you where things are, so you can choose where answers go. For each page: its size in points, the printed text as lines with their position, and the ruled lines (answer lines and box edges). All positions are in points from the top-left corner of the page, the same as fill_pdf. Look at the PDF itself too if you can, since this lists only text and lines, not pictures.',
      inputSchema: { type: 'object', required: ['pdf'], properties: { pdf: { type: 'string', description: 'Path to the PDF.' }, min_rule_pt: { type: 'number', description: 'Shortest line to report, in points. Default 36.' } } },
      async run(a) {
        const bytes = readPdf(a.pdf);
        const pages = await inspectPdf(bytes, { minRule: clampNum(a.min_rule_pt, 5, 600, 36) });
        const lines = [];
        for (const p of pages) {
          lines.push(`Page ${p.page}: ${p.width} x ${p.height} pt${p.rotated ? ' (rotated: fill_pdf cannot write on it)' : ''}`);
          for (const t of p.text) lines.push(`  text  x=${t.x} y=${t.y} w=${t.w} h=${t.h}  "${t.text}"`);
          for (const r of p.rules) lines.push(`  line  x=${r.x} y=${r.y} w=${r.w}`);
        }
        return [text(lines.join('\n'))];
      },
    },
    {
      name: 'fill_pdf',
      description: "Writes answers in the user's handwriting onto a PDF and saves a new PDF (the original is not changed). Each answer goes in a box: x and y are the box's top-left corner in points from the page's top-left, width is how wide it may be. Give height (the box's height), or line_y instead of y to have the writing sit on a printed line at that y (use the y of a 'line' from inspect_pdf). An answer too long for its box is written smaller, down to 5 pt letters, and the report says so. Pages are numbered from 1. Do not invent answers for the user; write only what you were asked to write.",
      inputSchema: {
        type: 'object',
        required: ['pdf', 'answers'],
        properties: {
          pdf: { type: 'string', description: 'Path to the PDF.' },
          out: { type: 'string', description: 'Where to save. Default: <name>-filled.pdf in the output folder.' },
          ink: { type: 'string', description: 'Pen colour as #rrggbb. Default #1749b3.' },
          neatness: { type: 'number' },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['page', 'x', 'width', 'text'],
              properties: {
                page: { type: 'integer', description: 'From 1.' },
                x: { type: 'number' },
                y: { type: 'number', description: 'Top of the box.' },
                line_y: { type: 'number', description: 'Instead of y: the y of the printed line the writing sits on.' },
                width: { type: 'number' },
                height: { type: 'number', description: 'Default 28 (one line) when line_y is used, otherwise 40.' },
                text: { type: 'string' },
                kind: { type: 'string', enum: ['text', 'math'] },
                letter_height_pt: { type: 'number' },
                seed: { type: 'integer' },
                shrink_to_fit: { type: 'boolean', description: 'Default true.' },
              },
            },
          },
        },
      },
      async run(a) {
        const { style } = load();
        const bytes = readPdf(a.pdf);
        if (!Array.isArray(a.answers) || !a.answers.length) throw new Error('answers must be a list with at least one answer.');
        const PDFLib = pdfLib();
        const probe = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const sizes = probe.getPages().map((p) => {
          const v = p.getCropBox ? p.getCropBox() : p.getMediaBox();
          return { w: v.width, h: v.height };
        });
        const look = lookFrom(a);
        const items = [];
        const report = [];
        a.answers.forEach((ans, i) => {
          const where = `answer ${i + 1}`;
          const page = Math.round(Number(ans.page)) - 1;
          if (!(page >= 0 && page < sizes.length)) throw new Error(`${where}: page ${ans.page} does not exist (the PDF has ${sizes.length}).`);
          if (typeof ans.text !== 'string' || !ans.text.trim()) throw new Error(`${where}: text is empty.`);
          for (const k of ['x', 'width']) if (!Number.isFinite(Number(ans[k]))) throw new Error(`${where}: ${k} must be a number.`);
          if (!Number.isFinite(Number(ans.y)) && !Number.isFinite(Number(ans.line_y))) throw new Error(`${where}: give y (top of the box) or line_y (the printed line it sits on).`);
          const h = clampNum(ans.height, 8, 800, Number.isFinite(Number(ans.line_y)) ? 28 : 40);
          const y = Number.isFinite(Number(ans.line_y)) ? Number(ans.line_y) - h : Number(ans.y);
          const box = { page, x: Number(ans.x), y, w: Number(ans.width), h, text: ans.text, kind: ans.kind === 'math' ? 'math' : 'text', xhPt: ans.letter_height_pt ? clampNum(ans.letter_height_pt, 4, 40, Sheet.DEFAULT_XH_PT) : undefined, seed: Math.round(clampNum(ans.seed, 1, 1e6, 1)), auto: ans.shrink_to_fit !== false };
          if (box.x < 0 || box.y < -1 || box.x + box.w > sizes[page].w + 1 || box.y + box.h > sizes[page].h + 1) throw new Error(`${where}: the box (x ${box.x}, y ${box.y}, ${box.w} x ${box.h}) is outside page ${page + 1}, which is ${sizes[page].w} x ${sizes[page].h} pt.`);
          const placed = Sheet.layoutBox(style, box, look);
          items.push({ box, placed });
          const bits = [`answer ${i + 1} (page ${page + 1}): written at ${placed.xhPt.toFixed(1)} pt`];
          if (placed.overflow) bits.push('DOES NOT FIT the box, make it bigger or shorten the text');
          else if (placed.xhPt < (box.xhPt || Sheet.DEFAULT_XH_PT) - 0.05) bits.push('made smaller to fit');
          if (placed.missing.length) bits.push('no sample for ' + placed.missing.join(' '));
          report.push(bits.join('; '));
        });
        const out = await Sheet.writeInk(PDFLib, bytes, items, { ink: inkOf(a), pen: 1, constant: true });
        const dest = a.out ? path.resolve(a.out) : outPath(safeName(path.basename(a.pdf).replace(/\.pdf$/i, '')) + '-filled.pdf');
        if (path.resolve(a.pdf) === dest) throw new Error('out is the same file as pdf. Choose another name; the original is never overwritten.');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, out);
        return [text(`Saved ${dest}\n` + report.join('\n'))];
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
