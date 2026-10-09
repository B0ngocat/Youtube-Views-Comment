'use strict';
// What an assistant using the server reported: seeds that did nothing for digits, \Rightarrow written as a word, a prime that floats,
// and no cheap way to check a digit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeWord, GLYPHS } = require('./synth-writer');
const G = require('../src/geometry');
const S = require('../src/style');
const Y = require('../src/synth');
const M = require('../src/math');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { createServer } = require('../mcp/server');

// digits 1 to 3 (1.7 tall), so there are digits to choose between
for (const d of '123') GLYPHS[d] = [0.5, [[0.1, 0.02], [0.25, 1.7], [0.4, 0.02]], null, true];
const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow y'.split(' ').concat(['123', '321', '213', '12', '31']);
const raw = WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 }));
const style = S.buildStyle(raw);

// ---- seeds ----------------------------------------------------------------------------------------------

test('another seed picks another of the good examples of a digit, but never a digit cut out of a word over a clean one', () => {
  const unit = (iso, id, wid) => ({
    ch: '5', iso, id, wid, idx: 0, strokes: [], marks: [], hc: 0, odd: 0, dev: 0,
    entry: { mid: false, x: 0, y: 0.5, dx: 1, dy: 0 }, exit: { mid: false, x: 1, y: 0.5, dx: 1, dy: 0 },
    box: { minX: 0, maxX: 1, minY: 0, maxY: 1.8 }, word: { units: [], suspect: false },
  });
  const a = unit(true, 'single-a', 1);
  const b = unit(true, 'single-b', 2);
  b.odd = 0.4; // a little less like the writer's others: costs 0.8 more, which a nudge of 0.14 could never overcome
  const cut = unit(false, 'cut', 3);
  const st = { byChar: new Map([['5', [cut, a, b]]]), allByChar: new Map() };
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const ctx = { variation: 0.4, messiness: 0, usage: new Map(), missing: new Set() };
    const picked = Y.chooseUnits(st, ['5'], G.mulberry32(seed), ctx);
    seen.add(picked[0].unit.id);
  }
  assert.ok(seen.has('single-a') && seen.has('single-b'), 'both clean examples come up: ' + [...seen]);
  assert.ok(!seen.has('cut'), 'the one cut out of a word never does');
});

test('letters keep their small nudge: the same seed is the same writing, another seed another', () => {
  const at = (seed) => JSON.stringify(Y.layout(style, 'quick brown', { xh: 34, width: 900, seed, wordReuse: 0 }).strokes);
  assert.equal(at(5), at(5));
  assert.notEqual(at(5), at(6));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-fb-'));
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
  const p = path.join(tmp, 'sheet.pdf');
  fs.writeFileSync(p, await doc.save());
  return p;
}
const fill = async (answers, extra) => {
  const dest = path.join(tmp, 'f-' + id + '.pdf');
  const r = await call('fill_pdf', Object.assign({ pdf: await sheet(), out: dest, answers }, extra));
  return { r, dest, bytes: fs.existsSync(dest) ? fs.readFileSync(dest) : null };
};

// the writing of one answer, as the preview picture of it (deterministic, unlike a PDF, which carries the time it was made)
async function ink(extra) {
  const { r } = await fill([Object.assign({ page: 1, x: 72, y: 100, width: 400, height: 40, text: 'the quick brown fox' }, extra)], { preview: 'all' });
  return r.result.content.find((c) => c.type === 'image').data;
}

test('fill_pdf honours the seed of each answer, the default is seed 1, and 0 is a seed too', async () => {
  const none = await ink({});
  assert.equal(await ink({ seed: 1 }), none, 'seed 1 is the default, so it is the same as none');
  const seven = await ink({ seed: 7 });
  assert.notEqual(seven, none, 'seed 7 is another take');
  assert.notEqual(await ink({ seed: 0 }), none, 'seed 0 is a seed of its own, not a 1');
  assert.equal(await ink({ seed: 7 }), seven, 'the same seed is the same writing');
  const r = await fill([{ page: 1, x: 72, y: 100, width: 400, height: 40, text: 'the quick brown fox', seed: 7 }]);
  assert.match(textOf(r.r), /written at 9\.5 pt \(seed 7\)/, 'the report says the seed was used');
  const plain = await fill([{ page: 1, x: 72, y: 100, width: 400, height: 40, text: 'the quick brown fox' }]);
  assert.doesNotMatch(textOf(plain.r), /seed/, 'and says nothing when none was given');
});

test('a seed that is not a whole number is refused, not quietly turned into another', async () => {
  for (const bad of [1.5, -3, 'abc', 4e9]) {
    const { r } = await fill([{ page: 1, x: 72, y: 100, width: 300, text: 'the fox', seed: bad }]);
    assert.ok(r.result.isError, String(bad));
    assert.match(textOf(r), /answer 1: seed must be a whole number from 0 to 2147483647/);
  }
  assert.ok((await call('write_text', { text: 'the fox', seed: 2.5 })).result.isError);
  assert.ok(!(await call('write_text', { text: 'the fox', seed: '12' })).result.isError, 'a number sent as text is read as a number');
});

// ---- TeX commands --------------------------------------------------------------------------------------

const names = (src) => M.parse(src)[0].map((n) => (n.t === 'sym' ? n.c : n.t === 'run' ? n.s : n.t));

test('arrows, sets and the rest are commands, and what is not a command is reported instead of written as a word', () => {
  assert.deepEqual(names(String.raw`a \Rightarrow b`), ['a', '\u21d2', 'b']);
  assert.deepEqual(names(String.raw`a \implies b \iff c`), ['a', '\u21d2', 'b', '\u21d4', 'c']);
  assert.deepEqual(names(String.raw`x \in A \cup B \subset C`), ['x', '\u2208', 'A', '\u222a', 'B', '\u2282', 'C']);
  assert.deepEqual(names(String.raw`\forall x \exists y \therefore z`), ['\u2200', 'x', '\u2203', 'y', '\u2234', 'z']);
  const lines = M.parse(String.raw`a \foo b \Rightarow c`);
  assert.deepEqual(lines.unknown, ['foo', 'Rightarow']);
  assert.deepEqual(lines[0].map((n) => n.s || n.c), ['a', 'b', 'c'], 'nothing is made of them');
  assert.deepEqual(M.parse(String.raw`x \to y`).unknown, []);
});

test('a layout with \\Rightarrow draws an arrow, not the letters of its name; one with an unknown command says so', () => {
  const o = { xh: 34, width: 900, seed: 1, messiness: 0, variation: 0, margin: 0 };
  const plain = M.layout(style, 'a b', o);
  const arrow = M.layout(style, String.raw`a \Rightarrow b`, o);
  assert.deepEqual(arrow.standIns, ['\u21d2']);
  assert.equal(arrow.strokes.length, plain.strokes.length + 3, 'two shafts and a head, no letters');
  const bad = M.layout(style, String.raw`a \foo b`, o);
  assert.deepEqual(bad.unknown, ['foo']);
  assert.equal(bad.strokes.length, plain.strokes.length, 'nothing written for it');
});

test('suggestions for a mistyped command are close ones, and nothing for nonsense', () => {
  assert.ok(M.suggestCommands('Rightarow').includes('Rightarrow'));
  assert.ok(M.suggestCommands('hatt').includes('hat'));
  assert.deepEqual(M.suggestCommands('foo'), []);
  assert.match(M.supportedCommands(), /\\Rightarrow \u21d2/);
});

// ---- primes and marks over letters -----------------------------------------------------------------------

test("y' is a y with a small prime over its top right, not a word with a tall apostrophe", () => {
  const l = M.parse("y' = f''(x)")[0];
  assert.equal(l[0].s, 'y');
  assert.equal(l[0].primes, 1);
  assert.equal(l[2].primes, 2, "f'' has two");
  assert.equal(M.parse(String.raw`y\prime`)[0][0].primes, 1);
  const o = { xh: 34, width: 900, seed: 1, messiness: 0, variation: 0, margin: 0 };
  const plain = M.layout(style, 'y', o);
  const primed = M.layout(style, "y'", o);
  assert.equal(primed.strokes.length, plain.strokes.length + 1);
  const mark = primed.strokes[primed.strokes.length - 1].pts;
  const top = (l2) => Math.min(...l2.strokes.flatMap((s) => s.pts.map((p) => p.y)));
  const base = primed.baselines[0];
  const markTop = (base - Math.min(...mark.map((p) => p.y))) / 34; // x-heights above the baseline
  const yTop = (base - Math.min(...plain.strokes.flatMap((s) => s.pts.map((p) => p.y)))) / 34;
  assert.ok(markTop - yTop < 0.5 && markTop - yTop > 0, `the prime tops out ${(markTop - yTop).toFixed(2)} x-heights over the y (it was about a whole line before)`);
  const yRight = Math.max(...plain.strokes.flatMap((s) => s.pts.map((p) => p.x)));
  assert.ok(Math.min(...mark.map((p) => p.x)) > yRight - 10, 'and it is at the right of the y');
  assert.ok(top(primed) <= top(plain));
});

test('a mark over a letter (bar, vec, hat, dot, tilde) is drawn above it', () => {
  const o = { xh: 34, width: 900, seed: 1, messiness: 0, variation: 0, margin: 0 };
  const plain = M.layout(style, 'x', o);
  const yTop = (l) => Math.min(...l.strokes.flatMap((s) => s.pts.map((p) => p.y)));
  for (const [cmd, extra] of [['bar', 1], ['vec', 2], ['hat', 1], ['dot', 1], ['ddot', 2], ['tilde', 1]]) {
    const l = M.layout(style, `\\${cmd}{x}`, o);
    assert.equal(l.strokes.length, plain.strokes.length + extra, cmd);
    assert.ok(yTop(l) < yTop(plain) - 4, cmd + ' sits above the x');
    assert.deepEqual(l.unknown, [], cmd);
  }
});

// ---- through the server ----------------------------------------------------------------------------------

test('write_text refuses an unsupported command with a short message, and handwriting_status gives the list', async () => {
  const before = files();
  const r = await call('write_text', { text: String.raw`a \Rightarow b \foo`, kind: 'math' });
  assert.ok(r.result.isError);
  const t = textOf(r);
  assert.match(t, /\\Rightarow \\foo in/);
  assert.match(t, /Did you mean: \\Rightarow -> .*\\Rightarrow/);
  assert.match(t, /handwriting_status with math_help: true/);
  assert.ok(t.length < 700, 'short: ' + t.length);
  assert.equal(files(), before, 'nothing written');
  const help = textOf(await call('handwriting_status', { math_help: true }));
  assert.match(help, /\\Rightarrow \u21d2/);
  assert.match(help, /\\bar\{x\}/);
  assert.match(help, /\\frac\{a\}\{b\}/);
  const ok = await call('write_text', { text: String.raw`a \Rightarrow b`, kind: 'math', format: 'svg' });
  assert.ok(!ok.result.isError, textOf(ok));
  assert.match(textOf(ok), /Drawn as clean stand-ins.*\u21d2/);
});

test('write_batch and fill_pdf refuse an unsupported command before writing anything', async () => {
  const before = files();
  const b = await call('write_batch', { items: [{ text: 'the fox' }, { text: String.raw`\foo`, kind: 'math' }] });
  assert.ok(b.result.isError);
  assert.match(textOf(b), /item 2: \\foo/);
  assert.equal(files(), before);
  const f = await fill([{ page: 1, x: 72, y: 100, width: 300, text: String.raw`\foo`, kind: 'math' }]);
  assert.ok(f.r.result.isError);
  assert.match(textOf(f.r), /answer 1 \(page 1\): \\foo/);
  assert.equal(f.bytes, null, 'no file');
});

// ---- previews ---------------------------------------------------------------------------------------------

function pngSize(b64) {
  const b = Buffer.from(b64, 'base64');
  assert.equal(b.subarray(1, 4).toString(), 'PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

test('fill_pdf can return a small picture of each answer\'s ink, only of the answers with digits if asked', async () => {
  const answers = [
    { page: 1, x: 72, y: 100, width: 300, height: 40, text: 'the quick fox' },
    { page: 1, x: 72, y: 200, width: 300, height: 40, text: String.raw`1 + 2 = 3`, kind: 'math' },
    { page: 1, x: 72, y: 300, width: 100, height: 20, text: 'the quick brown fox jumps over the lazy dog and the liquor' },
  ];
  const none = await fill(answers);
  assert.ok(!none.r.result.content.some((c) => c.type === 'image'), 'off by default');
  const all = await fill(answers, { preview: 'all' });
  const imgs = all.r.result.content.filter((c) => c.type === 'image');
  assert.equal(imgs.length, 3);
  for (const im of imgs) {
    const s = pngSize(im.data);
    assert.ok(s.w <= 640 && s.w > 20 && s.h > 10, `${s.w} x ${s.h}`);
    assert.ok(s.bytes < 60000, 'small: ' + s.bytes);
  }
  assert.match(textOf(all.r), /answer 2 \(page 1\) preview \(the writing only, \d+ x \d+ px, [\d.]+ px per pt\)/);
  const digits = await fill(answers, { preview: 'digits' });
  assert.equal(digits.r.result.content.filter((c) => c.type === 'image').length, 1, 'only the answer with digits');
  assert.match(textOf(digits.r), /answer 2 \(page 1\) preview/);
  assert.doesNotMatch(textOf(digits.r), /answer 1 \(page 1\) preview/);
});

test('asking for previews changes nothing in the PDF', async () => {
  const answers = [{ page: 1, x: 72, y: 100, width: 300, height: 40, text: String.raw`1 + 2`, kind: 'math', seed: 4 }];
  const strip = (b) => Buffer.from(b).toString('latin1').replace(/D:\d{14}[^)]*/g, '').replace(/\/ID\s*\[[^\]]*\]/g, '');
  const a = await fill(answers);
  const b = await fill(answers, { preview: 'all' });
  assert.equal(strip(a.bytes), strip(b.bytes));
});
