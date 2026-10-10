'use strict';
// Digits cut out of recorded words are brought to the writer's usual size and baseline, and operators sit in the middle of a digit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWord, GLYPHS } = require('./synth-writer');
const S = require('../src/style');
const Y = require('../src/synth');
const M = require('../src/math');

const pt = (x, y) => ({ x, y, w: 1 });
function unit(ch, minY, maxY, minX = 0, maxX = 0.9) {
  const pts = [pt(minX, minY), pt((minX + maxX) / 2, maxY), pt(maxX, minY + 0.3)];
  return { ch, strokes: [{ pts, taperStart: 0, taperEnd: 0 }], marks: [], entry: { x: minX, y: minY, dx: 1, dy: 0, mid: false }, exit: { x: maxX, y: minY + 0.3, dx: 1, dy: 0, mid: false }, box: { minX, maxX, minY, maxY } };
}
const word = (text, units) => ({ ok: true, text, units, view: { s: 1, dy: 0 } });
const height = (u) => u.box.maxY - u.box.minY;

// four of the writer's single digits, then cut ones in numbers: usual height 1.7, usual baseline 0, but all over the place
const iso = '1234'.split('').map((d) => word(d, [unit(d, 0, 1.75)]));
const cutHeights = [1.2, 1.5, 1.6, 1.7, 1.7, 1.8, 1.9, 2.1, 1.65, 1.75, 1.7, 1.6, 1.8, 1.55];
const cutBottoms = [0.3, -0.25, 0.1, 0, 0.05, -0.1, 0.2, -0.3, 0.15, 0, -0.05, 0.25, 0.1, -0.15];
const cutWords = [];
for (let i = 0; i < cutHeights.length; i += 2) {
  const d1 = String((i % 4) + 1);
  const d2 = String(((i + 1) % 4) + 1);
  cutWords.push(word(d1 + d2, [unit(d1, cutBottoms[i], cutBottoms[i] + cutHeights[i], 0, 0.9), unit(d2, cutBottoms[i + 1], cutBottoms[i + 1] + cutHeights[i + 1], 1.1, 2.0)]));
}
const all = () => iso.concat(cutWords);
const raws = () => all().map((_, i) => ({ iso: i < iso.length }));

test('cut digits end up one height, on the baseline; the writer\'s own single digits are not touched', () => {
  const out = S.digitNormalize(all(), raws());
  const cut = out.slice(iso.length).flatMap((w) => w.units);
  const hs = cut.map(height);
  assert.ok(Math.max(...hs) - Math.min(...hs) < 0.35, 'heights were 1.2 to 2.1, now ' + hs.map((h) => h.toFixed(2)));
  assert.ok(cut.every((u) => Math.abs(u.box.minY) < 0.08), 'on the baseline: ' + cut.map((u) => u.box.minY.toFixed(2)));
  for (let i = 0; i < iso.length; i++) assert.equal(out[i], iso[i], 'a single digit is the same object');
});

test('a digit keeps its place: it grows about its middle, and the ink moves with the box', () => {
  const before = cutWords[0].units[0];
  const after = S.digitNormalize(all(), raws())[iso.length].units[0];
  const mid = (u) => (u.box.minX + u.box.maxX) / 2;
  assert.ok(Math.abs(mid(after) - mid(before)) < 1e-9);
  const ys = after.strokes[0].pts.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...ys) - after.box.minY) < 1e-9 && Math.abs(Math.max(...ys) - after.box.maxY) < 1e-9, 'the box matches the ink');
  assert.ok(Math.abs(after.entry.y - after.strokes[0].pts[0].y) < 1e-9, 'and the entry point');
});

test('nothing recorded is changed in place, and the same input gives the same objects again', () => {
  const a = all();
  const snapshot = JSON.stringify(a);
  const r1 = S.digitNormalize(a, raws());
  assert.equal(JSON.stringify(a), snapshot, 'originals untouched');
  const r2 = S.digitNormalize(a, raws());
  assert.equal(r1[iso.length], r2[iso.length], 'the copy is cached, so unit identity is stable across rebuilds');
});

test('without enough digits to know what usual is, nothing changes; far-off mis-cuts are left alone', () => {
  const few = iso.concat(cutWords.slice(0, 2));
  assert.deepEqual(S.digitNormalize(few, few.map((_, i) => ({ iso: i < iso.length }))), few);
  const bad = unit('5', 0.9, 1.4); // 0.5 tall: not a digit, a piece of one
  const w = word('5', [bad]);
  const out = S.digitNormalize(all().concat([w]), raws().concat([{}]));
  assert.equal(out[out.length - 1].units[0], bad);
});

test('a decimal point is put on the baseline, and words with letters are left to the letters', () => {
  const dotted = word('1.2', [unit('1', 0, 1.7, 0, 0.5), unit('.', 0.3, 0.45, 0.7, 0.85), unit('2', 0, 1.7, 1.0, 1.8)]);
  const withLetter = word('2x', [unit('2', 0.4, 1.4), { ...unit('x', 0, 0.9), strokes: [{ pts: [pt(0, 0)] }] }]);
  const out = S.digitNormalize(all().concat([dotted, withLetter]), raws().concat([{}, {}]));
  const dot = out[all().length].units[1];
  assert.ok(Math.abs(dot.box.minY - 0.05) < 0.03, 'the dot sits at ' + dot.box.minY);
  const mixed = out[all().length + 1].units[0];
  assert.ok(Math.abs(mixed.box.minY - 0.4) < 0.5, 'a digit next to a letter is still normalised (its own baseline error is as real)');
});

// ---- operators in math -----------------------------------------------------------------------------

test('math mode puts the writer\'s + and - in the middle of their digits, whatever height they wrote them at', () => {
  // digits 1.7 tall, and a minus and a plus written far too high (centred at 1.5)
  for (const d of '123') GLYPHS[d] = [0.5, [[0.1, 0.02], [0.25, 1.7], [0.4, 0.02]], null, true];
  GLYPHS['-'] = [0.6, [[0, 1.5], [0.6, 1.5]], null, true];
  GLYPHS['+'] = [0.6, [[0, 1.5], [0.6, 1.5]], [[[0.3, 1.2], [0.3, 1.8]]], true];
  const words = 'the quick brown fox jumps over lazy dog pack my box'.split(' ').concat(['123', '321', '213', '-', '-', '-', '+', '+', '+']);
  const style = S.buildStyle(words.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
  const lay = M.layout(style, '1 - 2', { xh: 34, width: 900, seed: 2, messiness: 0, variation: 0, margin: 0 });
  const base = lay.baselines[0];
  const strokes = lay.strokes.map((s) => ({ s, ys: s.pts.map((p) => (base - p.y) / 34), xs: s.pts.map((p) => p.x / 34) }));
  const minus = strokes.filter(({ ys }) => Math.max(...ys) - Math.min(...ys) < 0.25).sort((a, b) => b.xs.length - a.xs.length)[0];
  assert.ok(minus, 'found the minus');
  const centre = (Math.min(...minus.ys) + Math.max(...minus.ys)) / 2;
  assert.ok(Math.abs(centre - 0.45 * 1.7) < 0.12, 'the minus is centred at ' + centre.toFixed(2) + ', the middle of a 1.7 digit is 0.85');
  // the same for a symbol drawn for the writer because they never wrote it
  const times = M.layout(style, String.raw`1 \times 2`, { xh: 34, width: 900, seed: 2, messiness: 0, variation: 0, margin: 0 });
  assert.deepEqual(times.standIns, ['\u00d7']);
  const small = times.strokes.map((s) => s.pts.map((p) => (times.baselines[0] - p.y) / 34)).filter((ys) => Math.max(...ys) - Math.min(...ys) < 1.2);
  const lo = Math.min(...small.flat());
  const hi = Math.max(...small.flat());
  assert.ok(Math.abs((lo + hi) / 2 - 0.45 * 1.7) < 0.15, 'the drawn \u00d7 is centred at ' + ((lo + hi) / 2).toFixed(2));
});

test('a decimal point keeps a gap from the digit next to it, even one that overhangs it', () => {
  // a 7 whose bar reaches out to the left over the point: nearest-ink spacing alone would tuck the point under it
  GLYPHS['7'] = [0.6, [[0, 1.7], [0.6, 1.7], [0.25, 0.02]], null, true];
  const words = 'the quick brown fox jumps over lazy dog'.split(' ').concat(['7', '7', '.', '.']); // the point and the 7 recorded apart, so the engine has to place them
  const style = S.buildStyle(words.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
  for (const seed of [1, 2, 3, 4]) {
    const l = Y.layout(style, '.7', { xh: 34, width: 900, seed, messiness: 0, variation: 0, wordReuse: 0 });
    const sp = l.words[0].spans;
    assert.equal(sp.length, 2);
    assert.ok(sp[1][0] - sp[0][1] >= 0.1 * 34, 'seed ' + seed + ': gap ' + (sp[1][0] - sp[0][1]).toFixed(1) + ' px');
  }
});

// ---- spacing between digits ------------------------------------------------------------------------------

// stems with room beside them: neighbouring digits are 0.9 x-heights apart in the writer's numbers, letters about 0.2
const stem = (adv) => [adv, [[0.3, 0.02], [0.3, 1.7]], null, true];
const gapOf = (l) => {
  const sp = l.words[0].spans;
  return sp[1][0] - sp[0][1];
};

test('digits keep the distance the writer leaves between digits in their numbers, not the closer one between letters', () => {
  for (const d of '123') GLYPHS[d] = stem(0.9);
  const numbers = ['12', '23', '31', '21', '32', '12', '23', '31', '21', '32']; // 1 next to 3 is never recorded, so the engine has to place it
  const words = 'the quick brown fox jumps over lazy dog pack my box'.split(' ').concat(numbers);
  const style = S.buildStyle(words.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
  assert.ok(style.digitClearance, 'learned from the writer\'s numbers');
  assert.ok(style.digitClearance.median > style.clearance.median + 0.5, 'digits ' + style.digitClearance.median.toFixed(2) + ' against letters ' + style.clearance.median.toFixed(2));
  for (const seed of [1, 2, 3, 4, 5]) {
    const l = Y.layout(style, '13', { xh: 34, width: 900, seed, messiness: 0, variation: 0, wordReuse: 0 });
    assert.ok(gapOf(l) >= 0.7 * 34, 'seed ' + seed + ': gap ' + (gapOf(l) / 34).toFixed(2) + ' x-heights');
  }
});

test('with too few numbers to learn from, digits still never touch', () => {
  for (const d of '123') GLYPHS[d] = stem(0.35);
  const words = 'the quick brown fox jumps over lazy dog pack my box'.split(' ').concat(['1', '2', '3', '12']);
  const style = S.buildStyle(words.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
  assert.equal(style.digitClearance, null, 'one number is not enough to know their spacing');
  style.clearance = { median: 0.02, sd: 0 }; // a writer who packs their letters: nearest-ink spacing alone would put digits 0.02 apart
  for (const seed of [1, 2, 3, 4, 5]) {
    const l = Y.layout(style, '13', { xh: 34, width: 900, seed, messiness: 0, variation: 0, wordReuse: 0 });
    assert.ok(gapOf(l) >= 0.14 * 34, 'seed ' + seed + ': gap ' + (gapOf(l) / 34).toFixed(2) + ' x-heights');
  }
});

// ---- a multiplication sign written as a speck ------------------------------------------------------------

test('a \u00d7 the writer made a fraction of the size of their + is left out, so a clean one is drawn instead of a second decimal point', () => {
  GLYPHS['+'] = [1.0, [[0.05, 0.85], [0.95, 0.85]], [[[0.5, 0.4], [0.5, 1.3]]], true];
  GLYPHS['\u00d7'] = [0.1, [[0.02, 0.45], [0.06, 0.49]], [[[0.02, 0.49], [0.06, 0.45]]], true]; // 0.04 across (the aligner scales it up to about 0.16): a dot to the eye
  const words = 'the quick brown fox jumps over lazy dog pack my box'.split(' ').concat(['+', '+', '\u00d7', '\u00d7', '2', '3']);
  const style = S.buildStyle(words.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
  assert.deepEqual(style.specks, ['\u00d7'], 'the app says which');
  assert.equal(style.byChar.has('\u00d7'), false, 'not in the pools');
  assert.ok(style.allByChar.get('\u00d7').every((u) => u.speck), 'still listed, marked');
  assert.ok(S.missingChars(style, '2 \u00d7 3').includes('\u00d7'), 'counted as not written yet');
  const chk = Y.checkText(style, '2 \u00d7 3', { fallback: false });
  assert.deepEqual(chk.missing.map((m) => [m.ch, m.speck, m.standIn]), [['\u00d7', true, true]], 'the check says it was written too small, and that a clean one can be drawn');
  const lay = M.layout(style, String.raw`2 \times 3`, { xh: 34, width: 900, seed: 2, messiness: 0, variation: 0, margin: 0 });
  assert.deepEqual(lay.standIns, ['\u00d7']);
  assert.deepEqual(lay.missing, []);
});

test('a \u00d7 of a proper size is the writer\'s own', () => {
  GLYPHS['\u00d7'] = [1.0, [[0.1, 0.3], [0.9, 1.1]], [[[0.1, 1.1], [0.9, 0.3]]], true];
  const words = 'the quick brown fox jumps over lazy dog pack my box'.split(' ').concat(['+', '+', '\u00d7', '\u00d7', '2', '3']);
  const style = S.buildStyle(words.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
  assert.deepEqual(style.specks, []);
  assert.equal(style.byChar.get('\u00d7').length, 2);
  const lay = M.layout(style, String.raw`2 \times 3`, { xh: 34, width: 900, seed: 2, messiness: 0, variation: 0, margin: 0 });
  assert.deepEqual(lay.standIns, []);
});

// ---- room round operators in math ------------------------------------------------------------------------

test('math leaves room round + and =, so "4+2" and "5=5" do not run together', () => {
  for (const d of '12') GLYPHS[d] = stem(0.5);
  GLYPHS['+'] = [1.0, [[0.05, 0.85], [0.95, 0.85]], [[[0.5, 0.4], [0.5, 1.3]]], true];
  GLYPHS['='] = [1.0, [[0.05, 0.6], [0.95, 0.6]], [[[0.05, 1.1], [0.95, 1.1]]], true];
  const words = 'the quick brown fox jumps over lazy dog pack my box'.split(' ').concat(['1', '2', '+', '+', '=', '=']);
  const style = S.buildStyle(words.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
  style.slant = 0; // so the ink of a stem is where its box is
  for (const [tex, kind, want] of [['1+2', 'plus', 0.44], ['1=2', 'equals', 0.69]]) {
    const lay = M.layout(style, tex, { xh: 34, width: 900, seed: 2, messiness: 0, variation: 0, margin: 0 });
    const ext = lay.strokes.map((s) => [Math.min(...s.pts.map((p) => p.x)), Math.max(...s.pts.map((p) => p.x))]).sort((a, b) => a[0] - b[0]);
    const left = ext[0]; // the 1
    const right = ext[ext.length - 1]; // the 2
    const mid = ext.slice(1, -1); // the operator's strokes
    const gapL = Math.min(...mid.map((e) => e[0])) - left[1];
    const gapR = right[0] - Math.max(...mid.map((e) => e[1]));
    assert.ok(gapL >= want * 34 && gapR >= want * 34, kind + ': ' + (gapL / 34).toFixed(2) + ' and ' + (gapR / 34).toFixed(2) + ' x-heights, wanted ' + want);
  }
});

// ---- an apostrophe written on its own ---------------------------------------------------------------------

test('an apostrophe written far above the letters is brought down to the tops of the ascenders, and the original is left alone', () => {
  const high = unit("'", 3.2, 3.7, 0, 0.12); // 3.2 to 3.7 x-heights up: a line and a half above the letters
  const fine = unit('"', 1.2, 1.7, 0, 0.5);
  const list = [high];
  const quotes = [fine];
  const byChar = new Map([["'", list.slice()], ['"', quotes.slice()]]);
  const allByChar = new Map([["'", list], ['"', quotes]]);
  const before = JSON.stringify(high);
  S.lowerHighMarks(byChar, allByChar, { asc: 1.75 });
  const mark = byChar.get("'")[0];
  assert.ok(Math.abs(mark.box.maxY - 1.75) < 1e-9, 'top at ' + mark.box.maxY.toFixed(2));
  assert.ok(Math.abs(mark.box.maxY - mark.box.minY - 0.5) < 1e-9, 'its length is kept');
  assert.ok(mark.strokes[0].pts.every((p) => p.y <= 1.75 + 1e-9 && p.y >= 1.25 - 1e-9), 'the ink moved with the box');
  assert.equal(allByChar.get("'")[0], mark, 'the list of every example holds the copy too');
  assert.equal(JSON.stringify(high), before, 'the original is untouched');
  assert.equal(byChar.get('"')[0], fine, 'a mark that is already at a sensible height is not touched');
});
