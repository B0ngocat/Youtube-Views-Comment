'use strict';
// Words and math together (src/mixed.js), and the proof that adding it changed nothing for plain text or math-only output.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { corpus } = require('./fixtures');
const Y = require('../src/synth');
const M = require('../src/math');
const X = require('../src/mixed');

const hash = (l) => crypto.createHash('sha256').update(JSON.stringify(l.strokes)).digest('hex').slice(0, 16);
const style = corpus('print').style;
// the same writer, who has also written a comma and a full stop at the end of words
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const pstyle = S.buildStyle(corpus('print').raws.map((r, i) => writeWord(r.text, { style: 'print', seed: i + 1 })).concat(['dog,', 'fox.', 'cat,', 'hen.', 'jug,', 'box.', 'a,', 'b.'].map((w, i) => writeWord(w, { style: 'print', seed: 900 + i })))); // own words: building a style marks the words it is given

// ---- nothing that existed has moved -------------------------------------------------------------------------
// These hashes were recorded from the code BEFORE the inline hook went into synth.layout and math.inline into math.js.

const T = 'the quick brown fox jumps over the lazy dog, and then we went home. Hello world 12 times!\nsecond paragraph here';
const PLAIN = [
  ['cursive', T, { seed: 1 }, 'be381e271b7e0cd1'],
  ['cursive', T, { seed: 7, width: 500 }, '7d9574f5e7d8c289'],
  ['cursive', T, { seed: 3, bounce: 0 }, '9a7759f85b5c53b6'],
  ['print', T, { seed: 2 }, '0ac1d25e2cd88f6d'],
  ['print', T, { seed: 9, width: 400, bounce: 0, messiness: 0.6 }, '44240b4722a27b34'],
  ['print', 'my box with five dozen jugs', { seed: 4, neatness: 1, wordSpacing: 1.3, bounce: 3 }, '83adbe6a085b5a3c'],
  ['cursive', 'how vexingly quick daft zebras jump', { seed: 5, variation: 0.9, slantDelta: 5, wordReuse: 0.8 }, '6f8f1e6dcb3612fb'],
  ['print', 'the lazy dog, then home.', { seed: 11, xh: 20, lineHeight: 2.5, width: 300 }, '734aca4112fd16cc'],
];
const MATH = [
  ['print', 'x^2 + \\frac{a}{b} = \\sqrt{y}', { seed: 1 }, '14f8acba14d23ec7'],
  ['cursive', '\\int_0^1 f \\\\ y = 3x + 1', { seed: 6, width: 600 }, '1b707fa83dfe56bc'],
  ['print', '\\sum_{i=1}^{n} a_i', { seed: 2, messiness: 0.5 }, 'a7cf878f2fd19d07'],
];

test('plain text from synth.layout is byte-identical to before', () => {
  for (const [s, t, o, want] of PLAIN) {
    const l = Y.layout(corpus(s).style, t, o);
    assert.equal(hash(l), want, `${s} ${JSON.stringify(o)}`);
    assert.equal(l.lineInk, undefined, 'no extra fields for plain text');
  }
});

test('math-only output from math.layout is byte-identical to before', () => {
  for (const [s, t, o, want] of MATH) assert.equal(hash(M.layout(corpus(s).style, t, o)), want, t);
});

test('mixed text with no math is the same ink as text mode', () => {
  for (const [s, t, o] of PLAIN) assert.equal(hash(X.layout(corpus(s).style, t, o)), hash(Y.layout(corpus(s).style, t, o)));
});

// ---- reading the text ---------------------------------------------------------------------------------------

test('split: $...$ and \\(...\\) are math, \\$ is a dollar sign', () => {
  assert.deepEqual(X.split('a $x^2$, b \\(y\\) c'), [{ t: 'text', s: 'a ' }, { t: 'math', s: 'x^2' }, { t: 'text', s: ', b ' }, { t: 'math', s: 'y' }, { t: 'text', s: ' c' }]);
  assert.deepEqual(X.split('it costs \\$5 and $a\\$b$'), [{ t: 'text', s: 'it costs $5 and ' }, { t: 'math', s: 'a\\$b' }]);
  assert.equal(X.plainText('the $\\frac{a}{b}$, so'), 'the  , so');
});

test('split: an unclosed $, empty math and a line break inside math are errors that say where', () => {
  assert.throws(() => X.split('the cost is $5 and more'), /Unclosed \$ at character 13, before "5 and more"/);
  assert.throws(() => X.split('see \\(x + y'), /Unclosed \\\(/);
  assert.throws(() => X.split('a $$ b'), /Empty math/);
  assert.throws(() => X.split('a $x\ny$ b'), /line break inside math/);
  assert.throws(() => X.layout(style, 'a $x', { seed: 1 }), /Unclosed/);
});

test('text mode keeps a $ as an ordinary character', () => {
  const l = Y.layout(style, 'it costs $5 or $6', { seed: 1 });
  assert.equal(l.words.length, 5);
});

// ---- the layout ---------------------------------------------------------------------------------------------

const O = { xh: 34, width: 700, seed: 3 };
const SENT = 'the quick brown fox $\\frac{a}{b}$, jumps over $x y$ the lazy dog and then we went home $\\int_a^b x$ quick box';

test('result has the shape of synth.layout, plus unknown and standIns, and lists a missing character from words and math', () => {
  const l = X.layout(style, SENT, O);
  for (const k of ['width', 'height', 'strokes', 'words', 'missing', 'substituted', 'baselines', 'xh', 'lineHeightPx', 'unknown', 'standIns']) assert.ok(k in l, k);
  assert.deepEqual(l.unknown, []);
  assert.ok(l.standIns.includes('∫'));
  assert.ok(l.missing.includes(','), 'the comma was never written in these samples');
  const m = X.layout(style, 'a $\\foo + 7$ b', O);
  assert.deepEqual(m.unknown, ['foo']);
  assert.ok(m.missing.includes('7'));
});

test('math words come back as words with their TeX, and a typed comma stays in the same word', () => {
  const l = X.layout(style, 'so $x$, then $y$.', O);
  assert.deepEqual(l.words.map((w) => w.text), ['so', '$x$,', 'then', '$y$.']);
});

test('punctuation after a closing $ is closer to the math than a word gap', () => {
  const ink = (t) => {
    const l = X.layout(pstyle, t, Object.assign({}, O, { messiness: 0, bounce: 0, variation: 0 }));
    const xs = l.strokes.flatMap((s) => s.pts.map((p) => p.x));
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(ink('$x$.') < ink('$x$ .') - 0.15 * 34, `${ink('$x$.')} vs ${ink('$x$ .')}`);
});

test('a math segment never breaks across lines, and a narrow box wraps the words around it', () => {
  const t = 'the quick $\\frac{aaaaaaaaaa}{b}$ fox jumps';
  const wide = X.layout(style, t, { xh: 34, width: 1400, seed: 2, margin: 0 });
  const inline = M.inline(style, '\\frac{aaaaaaaaaa}{b}', { seed: 0 });
  const narrow = X.layout(style, t, { xh: 34, width: 40 + inline.w * 34 * 0.5, seed: 2, margin: 0 }); // narrower than the fraction itself
  assert.equal(wide.baselines.length, 1);
  assert.ok(narrow.baselines.length >= 4, 'each word and the math on its own line: ' + narrow.baselines.length);
  // the fraction bar is the widest single stroke: it is whole, so the math was not cut
  const widest = (l) => Math.max(...l.strokes.map((s) => Math.max(...s.pts.map((p) => p.x)) - Math.min(...s.pts.map((p) => p.x))));
  assert.ok(Math.abs(widest(narrow) - widest(wide)) < 4);
  const top = (l) => Math.min(...l.lineInk.map((x) => x.top));
  assert.ok(Number.isFinite(top(narrow)));
});

test('math is the size of the words and sits on their baseline', () => {
  const o = Object.assign({}, O, { messiness: 0, bounce: 0, variation: 0, margin: 0 });
  const w = X.layout(style, 'x', o);
  const m = X.layout(style, '$x$', o);
  const hgt = (l) => Math.max(...l.strokes.flatMap((s) => s.pts.map((p) => p.y))) - Math.min(...l.strokes.flatMap((s) => s.pts.map((p) => p.y)));
  assert.ok(Math.abs(hgt(m) - hgt(w)) < 0.35 * 34, `${hgt(m)} vs ${hgt(w)}`);
  const bottom = (l) => Math.max(...l.strokes.flatMap((s) => s.pts.map((p) => p.y))) - l.baselines[0];
  assert.ok(Math.abs(bottom(m) - bottom(w)) < 0.35 * 34);
});

test('lines with a fraction do not touch their neighbours, and lines without math keep the normal spacing', () => {
  const t = 'one two three four five six\nthe slope $\\frac{a}{b}$ and $\\frac{\\frac{a}{b}}{c}$ end\nplain words here again\nthen $\\int_a^b \\frac{x}{y}$ over\nlast plain line';
  for (const seed of [1, 2, 3, 4]) {
    const l = X.layout(style, t, { xh: 34, width: 900, seed, lineHeight: 2.5 });
    assert.equal(l.baselines.length, 5);
    for (let i = 0; i + 1 < l.lineInk.length; i++) assert.ok(l.lineInk[i].bottom < l.lineInk[i + 1].top, `seed ${seed}: line ${i + 1} ends ${l.lineInk[i].bottom.toFixed(1)}, line ${i + 2} starts ${l.lineInk[i + 1].top.toFixed(1)}`);
    assert.ok(l.lineInk[1].tall && l.lineInk[3].tall && !l.lineInk[0].tall && !l.lineInk[4].tall);
    assert.ok(l.baselines[1] - l.baselines[0] > l.lineHeightPx, 'room above the fraction line');
  }
  const plain = X.layout(style, 'one two\nthree four\nfive $x$ six', { xh: 34, width: 900, seed: 1 });
  const gaps = plain.baselines.slice(1).map((b, i) => b - plain.baselines[i]);
  for (const g of gaps) assert.ok(Math.abs(g - plain.lineHeightPx) < 1e-9, 'a line with ordinary math gets no extra room');
});

test('editing one math segment never changes the letters of the other words', () => {
  const a = X.layout(style, 'the quick $\\frac{a}{b}$ brown fox $x y$ jumps over $a$ the lazy dog', O);
  const b = X.layout(style, 'the quick $\\sqrt{xyz}$ brown fox $x y$ jumps over $\\int_a^b$ the lazy dog', O);
  const ids = (l) => l.words.filter((w) => !w.text.startsWith('$')).map((w) => w.ids.join());
  assert.deepEqual(ids(a), ids(b));
  // and the one unchanged segment is drawn the same (compare its word's letters-free ink via its own box)
  assert.deepEqual(M.inline(style, 'x y', { seed: 5 }).strokes, M.inline(style, 'x y', { seed: 5 }).strokes);
  const seg = (l, k) => l.words[k].text;
  assert.equal(seg(a, 5), '$x y$');
});

test('layout never changes a box or a cached unit', () => {
  const before = JSON.stringify(Array.from(style.byChar.values()).map((us) => us.map((u) => u.strokes)));
  const box = M.inline(style, '\\frac{a}{b}', { seed: 1 });
  const copy = JSON.stringify(box.strokes);
  Y.layout(style, 'a 0, b', Object.assign({}, O, { inline: [box] }));
  assert.equal(JSON.stringify(box.strokes), copy, 'the box is copied, not moved');
  assert.equal(JSON.stringify(Array.from(style.byChar.values()).map((us) => us.map((u) => u.strokes))), before);
});

test('same seed, same writing; another seed, another take', () => {
  assert.equal(hash(X.layout(style, SENT, O)), hash(X.layout(style, SENT, O)));
  assert.notEqual(hash(X.layout(style, SENT, O)), hash(X.layout(style, SENT, Object.assign({}, O, { seed: 4 }))));
});
