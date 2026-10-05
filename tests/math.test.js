'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const M = require('../src/math');

const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');
const style = S.buildStyle(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));

const inkBox = (strokes) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s.pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY, h: maxY - minY, w: maxX - minX };
};
const lay = (t, o) => M.layout(style, t, Object.assign({ xh: 34, width: 900, seed: 2 }, o));

test('input is read into scripts, fractions, roots and big operators', () => {
  const [l] = M.parse(String.raw`x^2 + \frac{a}{b} \sqrt{y} \int_0^1 f`);
  assert.equal(l[0].t, 'run');
  assert.equal(l[0].sup[0].s, '2');
  assert.ok(l.some((n) => n.t === 'frac' && n.a[0].s === 'a' && n.b[0].s === 'b'));
  assert.ok(l.some((n) => n.t === 'sqrt'));
  const big = l.find((n) => n.t === 'big');
  assert.equal(big.c, '∫');
  assert.equal(big.sub[0].s, '0', 'lower limit');
  assert.equal(big.sup[0].s, '1', 'upper limit is not swallowed by the lower one');
});

test('ASCII shorthand becomes the real symbols', () => {
  const [l] = M.parse('x -> 0, a <= b, c >= d, e != f');
  const syms = l.filter((n) => n.t === 'sym').map((n) => n.c);
  for (const c of ['→', '≤', '≥', '≠']) assert.ok(syms.includes(c), c);
});

test('an exponent is smaller than its base and sits higher', () => {
  const one = lay('b');
  const two = lay('b^b');
  const topAbove = (l) => l.baselines[0] - inkBox(l.strokes).minY; // how far the ink reaches above the baseline
  assert.ok(topAbove(two) > topAbove(one) + 10, 'the exponent reaches above the base');
  assert.ok(inkBox(two.strokes).w > inkBox(one.strokes).w * 1.4);
});

test('a fraction stacks the numerator over the denominator with a bar between', () => {
  const l = lay(String.raw`\frac{b}{b}`);
  const single = inkBox(lay('b').strokes);
  const all = inkBox(l.strokes);
  assert.ok(all.h > single.h * 1.9, 'two letters tall plus the bar');
  const bar = l.strokes.find((s) => inkBox([s]).w > 0.8 * all.w && inkBox([s]).h < 6);
  assert.ok(bar, 'a long, nearly flat bar stroke');
});

test('brackets stretch to cover what is inside them', () => {
  const small = inkBox(lay('(b)').strokes);
  const tall = inkBox(lay(String.raw`(\frac{b}{b})`).strokes);
  assert.ok(tall.h > small.h * 1.4, 'bracket around a fraction is taller than around a letter');
});

test('symbols that were never written are drawn rather than dropped, and nothing is NaN', () => {
  const l = lay(String.raw`a \le b \to c \pm d \sqrt{a} \sum_{i=j}^{n} \int_a^b`);
  assert.deepEqual(l.missing, [], 'nothing missing: every stand-in exists');
  for (const s of l.strokes) for (const p of s.pts) assert.ok(isFinite(p.x) && isFinite(p.y) && isFinite(p.w));
  assert.ok(l.strokes.length > 10);
});

test('characters with no sample and no drawing are reported', () => {
  const l = lay(String.raw`a \theta b`);
  assert.ok(l.missing.includes('θ'));
});

test('a new line starts a new row and the same seed gives the same page', () => {
  const a = lay('b\nb', { seed: 5 });
  assert.equal(a.baselines.length, 2);
  assert.ok(a.baselines[1] > a.baselines[0]);
  const sig = (l) => l.strokes.map((s) => s.pts.length + ':' + s.pts[0].x.toFixed(2)).join(',');
  assert.equal(sig(lay('b^b', { seed: 9 })), sig(lay('b^b', { seed: 9 })));
});

test('without a written "=" a drawn one is used', () => {
  const l = lay('b = b');
  assert.deepEqual(l.missing, []);
  assert.ok(l.strokes.length >= 3, 'two letters plus the strokes of the sign');
});
