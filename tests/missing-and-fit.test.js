'use strict';
// A character with no sample is never skipped or guessed, and an answer that is too big for its box is wrapped and grown
// before the letters are made smaller.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const Y = require('../src/synth');
const Gl = require('../src/glyphs');
const Sheet = require('../src/sheet');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { createServer } = require('../mcp/server');

const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');
const raw = WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 }));
const style = S.buildStyle(raw);

// ---- the drawings --------------------------------------------------------------------------------

test('there are clean drawings for symbols and punctuation, and none for letters and digits', () => {
  for (const c of '°¯•′~^_\\|[]{}()<>+-=×÷±.,:;!?¿¡') assert.ok(Gl.has(c), c);
  for (const c of 'aZ7éñ') assert.ok(!Gl.has(c), c + ' cannot be faked');
  const ring = Gl.polys('°')[0];
  assert.deepEqual(ring[0].map((v) => Math.round(v * 1000)), ring[ring.length - 1].map((v) => Math.round(v * 1000)), 'a degree sign is a closed ring');
  assert.ok(ring.every(([, y]) => y > 1.2), 'above the line');
  assert.ok(Gl.polys('¯')[0].every(([, y]) => y > 1.5), 'a macron sits high');
  // brackets still stretch to what they hold
  const tall = Gl.polys('(', 3, 1)[0];
  assert.ok(Math.max(...tall.map((p) => p[1])) === 3 && Math.min(...tall.map((p) => p[1])) === -1);
  // an upside-down ? has its dot above its hook
  const q = Gl.polys('?');
  const inv = Gl.polys('¿');
  const dotY = (polys) => polys[1][0][1];
  const hookY = (polys) => polys[0][0][1];
  assert.ok(dotY(q) < hookY(q) && dotY(inv) > hookY(inv));
});

// ---- the check -----------------------------------------------------------------------------------

test('the check lists each missing character once, with its code and the words it is in', () => {
  const r = Y.checkText(style, 'It was 30°C and x¯, then 45° and 7');
  const by = Object.fromEntries(r.missing.map((m) => [m.ch, m]));
  assert.deepEqual(by['°'].words, ['30°C', '45°']);
  assert.equal(by['°'].code, 'U+00B0');
  assert.equal(by['¯'].code, 'U+00AF');
  assert.deepEqual(by['¯'].words, ['x¯,']);
  assert.ok(by['°'].standIn && by['¯'].standIn, 'a drawing exists for both');
  assert.ok(by['7'] && !by['7'].standIn && by['3'] && by['0'], 'digits cannot be drawn');
  assert.equal(r.missing.filter((m) => m.ch === '°').length, 1, 'listed once');
  assert.deepEqual(r.substituted, []);
});

test('with the fallback on, the ones that have a drawing move from missing to substituted', () => {
  const r = Y.checkText(style, 'x¯ 30°', { fallback: true });
  assert.deepEqual(r.substituted.map((m) => m.ch).sort(), ['¯', '°']);
  assert.deepEqual(r.missing.map((m) => m.ch).sort(), ['0', '3']);
});

test('accents are not missing: they are composed from the writer\'s own letter, and the check says so', () => {
  const r = Y.checkText(style, 'C\u00f3mo est\u00e1 Ma\u00f1ana');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.composed.sort(), ['\u00e1', '\u00f1', '\u00f3']);
  // an upside-down ? can only be turned from a ? the writer wrote; this writer wrote none, so both are missing (and can be drawn)
  const q = Y.checkText(style, '\u00bfq?');
  assert.deepEqual(q.missing.map((m) => m.ch).sort(), ['?', '\u00bf']);
  assert.ok(q.missing.every((m) => m.standIn));
});

test('laying out with the fallback draws the stand-ins; without it the characters are reported and nothing is drawn for them', () => {
  const o = { xh: 34, width: 700, seed: 3, messiness: 0, variation: 0 };
  const plain = Y.layout(style, 'fox', o);
  const without = Y.layout(style, 'fox °', o);
  const withFb = Y.layout(style, 'fox °', Object.assign({ fallbackGlyphs: true }, o));
  assert.deepEqual(without.missing, ['°']);
  assert.equal(without.strokes.length, plain.strokes.length, 'nothing drawn for it');
  assert.deepEqual(withFb.missing, []);
  assert.deepEqual(withFb.substituted, ['°']);
  assert.equal(withFb.strokes.length, plain.strokes.length + 1);
  assert.ok(withFb.strokes.every((s) => s.pts.every((p) => isFinite(p.x) && isFinite(p.y))));
});

// ---- fitting a box ------------------------------------------------------------------------------

const LONG = 'the quick brown fox jumps over the lazy dog and the five dozen liquor jugs';
const fit = (box) => Sheet.layoutBox(style, Object.assign({ page: 0, x: 72, y: 100, w: 150, h: 20, kind: 'text', xhPt: 9.5, seed: 1, auto: true, text: LONG }, box), {});

test('an answer that fits is left alone', () => {
  const r = fit({ text: 'the fox', w: 300, growTo: 100, minRatio: 0.8 });
  assert.ok(!r.overflow && !r.wrapped && !r.grown && !r.shrunk);
  assert.equal(r.xhPt, 9.5);
});

test('too long for the box: it wraps and the box grows, and the letters stay the size asked for', () => {
  const r = fit({ growTo: 300, minRatio: 0.8 });
  assert.equal(r.xhPt, 9.5, 'not shrunk');
  assert.ok(r.wrapped && r.lines >= 3);
  assert.ok(r.grown && r.grown.from === 20 && r.grown.to > 40 && r.grown.to <= 300);
  assert.ok(!r.shrunk && !r.overflow);
});

test('it never grows past the most the box may grow, and then shrinks, but not below the floor', () => {
  const r = fit({ growTo: 70, minRatio: 0.8 });
  assert.ok(!r.grown || r.grown.to <= 70.5);
  assert.ok(r.xhPt >= 9.5 * 0.8 - 1e-9, 'not below 80%: ' + r.xhPt);
  assert.ok(r.shrunk, 'it had to shrink to fit in 70 pt');
  const floor = fit({ growTo: 20, minRatio: 0.8 });
  assert.ok(floor.overflow, 'still too big at the floor, so it says so');
  assert.equal(Math.round(floor.xhPt * 100) / 100, 7.6, 'and stays at the floor');
  assert.ok(floor.lines > 1, 'wrapped');
});

test('with shrinking switched off it wraps and grows but never makes the letters smaller', () => {
  const r = fit({ growTo: 60, auto: false });
  assert.equal(r.xhPt, 9.5);
  assert.ok(r.overflow, 'does not fit in 60 pt, and says so');
});

test('a single word wider than the box cannot wrap: shrinking is all that helps, down to the floor', () => {
  const r = fit({ text: 'extraordinarily', w: 40, h: 20, growTo: 200, minRatio: 0.8 });
  assert.ok(r.tooWide && r.overflow);
  assert.equal(Math.round(r.xhPt * 100) / 100, 7.6);
  assert.equal(r.grown, null, 'growing down cannot make a box wider');
});

test('without the new options it behaves as the Sheet tab always did', () => {
  const r = Sheet.layoutBox(style, { page: 0, x: 0, y: 0, w: 120, h: 20, kind: 'text', xhPt: 9.5, seed: 1, auto: true, text: LONG }, {});
  assert.ok(r.xhPt < 9.5 * 0.8, 'shrinks well below 80%, as before');
  assert.equal(r.grown, null);
});

// ---- through the MCP server -------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-miss-'));
const samples = path.join(tmp, 'my-handwriting.json');
fs.writeFileSync(samples, S.toJSON(raw));
const out = path.join(tmp, 'out');
const server = createServer({ samples, out });
let id = 1;
const call = (name, args) => server({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
const textOf = (r) => r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const files = () => (fs.existsSync(out) ? fs.readdirSync(out).length : 0);

async function sheet() {
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  const p = path.join(tmp, 'sheet.pdf');
  fs.writeFileSync(p, await doc.save());
  return p;
}

test('write_text stops before drawing anything and says exactly which characters and words', async () => {
  const before = files();
  const r = await call('write_text', { text: 'the fox is 30° and x¯ in room 7' });
  assert.ok(r.result.isError);
  const t = textOf(r);
  assert.match(t, /Nothing was written/);
  assert.match(t, /° \(U\+00B0\) is in "30°"\s+\[a clean drawn stand-in exists\]/);
  assert.match(t, /¯ \(U\+00AF\) is in "x¯"/);
  assert.match(t, /7 \(U\+0037\) is in "7"/);
  assert.match(t, /on_missing: "fallback" to draw clean stand-ins for ° ¯/);
  assert.match(t, /3 0 7|7 3 0|3 0 7|cannot be drawn/);
  assert.equal(files(), before, 'no file was written');
});

test('on_missing "fallback" draws the stand-ins, and lists them in the reply', async () => {
  const r = await call('write_text', { text: 'the fox x¯ 20°'.replace('20', 'the'), on_missing: 'fallback', format: 'svg' });
  assert.ok(!r.result.isError, textOf(r));
  assert.match(textOf(r), /Drawn as clean stand-ins, not the person's own handwriting.*¯ \(U\+00AF\).*° \(U\+00B0\)/);
  const hard = await call('write_text', { text: 'the fox 7°', on_missing: 'fallback' });
  assert.ok(hard.result.isError, 'a digit can never be faked');
  assert.match(textOf(hard), /7 \(U\+0037\)/);
  assert.doesNotMatch(textOf(hard), /° \(U\+00B0\)/, 'only what is still missing is listed');
});

test('write_batch checks every item first and stops the whole call, item by item', async () => {
  const before = files();
  const r = await call('write_batch', { items: [{ text: 'the fox' }, { text: 'a° b' }, { text: 'quick x¯' }] });
  assert.ok(r.result.isError);
  const t = textOf(r);
  assert.match(t, /item 2: ° \(U\+00B0\) is in "a°"/);
  assert.match(t, /item 3: ¯ \(U\+00AF\) is in "x¯"/);
  assert.doesNotMatch(t, /item 1/);
  assert.equal(files(), before, 'the good item was not written either');
});

test('fill_pdf checks every answer first, names the answer and page, and writes no file', async () => {
  const pdf = await sheet();
  const dest = path.join(tmp, 'never.pdf');
  const r = await call('fill_pdf', { pdf, out: dest, answers: [{ page: 1, x: 72, y: 100, width: 300, text: 'the fox' }, { page: 2, x: 72, y: 100, width: 300, text: 'it is 5°' }] });
  assert.ok(r.result.isError);
  assert.match(textOf(r), /answer 2 \(page 2\): 5 \(U\+0035\) is in "5°"/);
  assert.match(textOf(r), /answer 2 \(page 2\): ° \(U\+00B0\) is in "5°"/);
  assert.ok(!fs.existsSync(dest), 'nothing was written');
});

test('math with a symbol nobody can draw is refused too, and one that has a drawing is drawn and reported', async () => {
  const ok = await call('write_text', { text: String.raw`x \times y`, kind: 'math' });
  assert.ok(!ok.result.isError, textOf(ok));
  assert.match(textOf(ok), /Drawn as clean stand-ins.*×/);
  const bad = await call('write_text', { text: String.raw`x + 9`, kind: 'math' });
  assert.ok(bad.result.isError);
  assert.match(textOf(bad), /9 \(U\+0039\)/);
});

test('handwriting_status says which missing characters could be drawn', async () => {
  const t = textOf(await call('handwriting_status', { check: 'the fox 30° 7' }));
  assert.match(t, /No sample for: .*°/);
  assert.match(t, /° can be drawn as a clean stand-in.*on_missing: "fallback"/);
  assert.match(t, /The rest must be taught/);
});

test('fill_pdf reports whether each answer was fitted as it is, wrapped, grown or shrunk', async () => {
  const pdf = await sheet();
  const r = await call('fill_pdf', {
    pdf,
    answers: [
      { page: 1, x: 72, y: 100, width: 300, height: 30, text: 'the fox' },
      { page: 1, x: 72, y: 200, width: 150, height: 20, text: LONG },
      { page: 1, x: 72, y: 400, width: 150, height: 20, text: LONG, max_height: 60 },
      { page: 1, x: 72, y: 500, width: 150, height: 20, text: LONG, grow: false, min_size_ratio: 0.8 },
      { page: 2, x: 72, y: 100, width: 40, height: 20, text: 'extraordinarily' },
    ],
  });
  assert.ok(!r.result.isError, textOf(r));
  const t = textOf(r).split('\n').filter((l) => /^answer/.test(l));
  assert.match(t[0], /^answer 1 \(page 1\): written at 9\.5 pt; fits as it is$/);
  assert.match(t[1], /^answer 2 \(page 1\): written at 9\.5 pt; WRAPPED onto \d+ lines; box GROWN downward from 20 to \d+(\.\d)? pt \(it now ends at y = \d+/);
  assert.doesNotMatch(t[1], /SHRUNK|DOES NOT FIT/);
  assert.match(t[2], /WRAPPED onto \d+ lines/);
  assert.match(t[2], /SHRUNK from 9\.5 to [\d.]+ pt \((8\d|9\d)% of the size asked for\) because wrapping and growing was not enough/);
  assert.match(t[3], /written at 7\.6 pt.*SHRUNK from 9\.5 to 7\.6 pt \(80% of the size asked for\) because wrapping was not enough; DOES NOT FIT: it needs about \d+ pt more height/);
  assert.match(t[4], /DOES NOT FIT: a word is wider than the box/);
  assert.ok(!/made smaller/.test(textOf(r)), 'the old wording is gone');
});

test('a box that grows stops above the printed text under it, and the report says what stopped it', async () => {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  pg.drawText('Next question: explain why.', { x: 72, y: 792 - 250, size: 12, font }); // its top is about 238 pt from the top
  const pdf = path.join(tmp, 'blocked.pdf');
  fs.writeFileSync(pdf, await doc.save());
  const r = await call('fill_pdf', { pdf, out: path.join(tmp, 'blocked-out.pdf'), answers: [{ page: 1, x: 72, y: 200, width: 150, height: 20, text: LONG }] });
  assert.ok(!r.result.isError, textOf(r));
  const t = textOf(r);
  assert.match(t, /printed text "Next question: explain why\."/);
  // it did not grow into that text: the box ends above it, so the writing was made smaller (down to the floor) or does not fit
  assert.match(t, /SHRUNK|DOES NOT FIT/);
  const grown = t.match(/GROWN downward from 20 to ([\d.]+) pt/);
  assert.ok(!grown || 200 + Number(grown[1]) <= 238, 'ends above the text: ' + (grown && grown[1]));
  // with room under it the same answer just grows
  const free = await call('fill_pdf', { pdf, out: path.join(tmp, 'free-out.pdf'), answers: [{ page: 1, x: 72, y: 400, width: 150, height: 20, text: LONG }] });
  assert.match(textOf(free), /WRAPPED onto \d+ lines; box GROWN/);
  assert.doesNotMatch(textOf(free), /printed text/);
  // an explicit max_height is believed, whatever is printed there
  const forced = await call('fill_pdf', { pdf, out: path.join(tmp, 'forced-out.pdf'), answers: [{ page: 1, x: 72, y: 200, width: 150, height: 20, text: LONG, max_height: 120 }] });
  assert.match(textOf(forced), /WRAPPED onto \d+ lines; box GROWN downward from 20 to/);
});
