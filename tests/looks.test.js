'use strict';
// Things that made a filled worksheet look generated next to the writer's own pages (a friend's chain-rule homework against a page
// the tools wrote for him): exponents lost on stretched brackets, equations packed tighter than the writer packs them, every row of
// a worked answer starting on one ruler-straight edge, a pen that thinned with the letters, and f'' that read as "fi".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeWord } = require('./synth-writer');
const { corpus } = require('./fixtures');
const S = require('../src/style');
const M = require('../src/math');
const Y = require('../src/synth');
const Sheet = require('../src/sheet');
const { createServer } = require('../mcp/server');

// fake handwriting that also wrote the equations of the math rounds; gap: room the fake hand leaves after each symbol
const EQUATIONS = ['x=2', 'y=3', 'x=5', 'y=7', 'x+y', 'x-y', '2x+y', 'x+3', '(x)', '(y)', '(x+1)', '(y-2)', 'y=mx+b', 'y=2x+1', 'y=3x-4', 'f(x)', 'g(x)', 'h(x)', "f'(x)", '2x+3=11', '3x-4=8', '5+7=12'];
const SINGLES = [...'0123456789', ...'0123456789', ...'+-=()/'];
function writer(gap) {
  const raws = corpus('print').raws.map((r, i) => writeWord(r.text, { style: 'print', seed: i + 1 }));
  let n = 9000;
  for (const t of EQUATIONS) for (let k = 0; k < 2; k++) raws.push(writeWord(t, { style: 'print', seed: n++, gap }));
  for (const c of SINGLES) {
    const w = writeWord(c, { style: 'print', seed: n++, gap });
    w.iso = true;
    raws.push(w);
  }
  return raws;
}
const tightRaws = writer(0.18);
const airyRaws = writer(0.6);
const tight = S.buildStyle(tightRaws);
const airy = S.buildStyle(airyRaws);
const plainStyle = corpus('print').style;

const O = { xh: 34, width: 2000, seed: 3, messiness: 0, variation: 0, margin: 0 };
const xs = (strokes) => strokes.flatMap((s) => s.pts.map((p) => p.x));
const ys = (strokes) => strokes.flatMap((s) => s.pts.map((p) => p.y));

test('a bracket stretched round x^2 keeps its exponent: (4x^2 - x)^{1/5} lost the 1/5', () => {
  const bare = M.layout(tight, '(4x^2-x)', O);
  const pow = M.layout(tight, '(4x^2-x)^{1/5}', O);
  const extra = pow.strokes.slice(bare.strokes.length);
  assert.ok(extra.length >= 3, 'the 1, the / and the 5 are drawn');
  const right = Math.max(...xs(bare.strokes));
  assert.ok(Math.min(...xs(extra)) > right - 6, 'to the right of the closing bracket');
  assert.ok(Math.max(...ys(extra)) < pow.baselines[0] - 34, 'and raised above the x-height');
  // a bracket that does not stretch was always fine, and still is
  const small = M.layout(tight, '(x)^2', O);
  assert.equal(small.strokes.length, M.layout(tight, '(x)', O).strokes.length + 1);
});

test("the writer's own room round =, + and brackets is measured from the equations they wrote", () => {
  assert.equal(plainStyle.mathGaps, null, 'no equations written, nothing measured');
  for (const k of ['rel', 'bin', 'inner', 'outer']) {
    assert.ok(tight.mathGaps[k] !== undefined && airy.mathGaps[k] !== undefined, k);
    assert.ok(airy.mathGaps[k] > tight.mathGaps[k] + 0.15, `${k}: the airy hand leaves more room (${airy.mathGaps[k].toFixed(2)} against ${tight.mathGaps[k].toFixed(2)})`);
  }
  assert.ok(airy.mathGaps.rel <= 1.6 && tight.mathGaps.inner >= 0.02, 'clamped');
});

test('math is spaced as the writer spaces it, and the letters it writes do not change', () => {
  const t = '3(1/5)(2x-1)=y';
  const a = M.layout(airy, t, O);
  const none = M.layout(Object.assign({}, airy, { mathGaps: null }), t, O);
  assert.equal(a.strokes.length, none.strokes.length);
  assert.ok(Math.max(...xs(a.strokes)) > Math.max(...xs(none.strokes)) + 0.5 * 34, 'wider by the room the writer leaves');
  // the same symbols, only moved sideways: every stroke has the same shape
  a.strokes.forEach((s, i) => {
    const dx = s.pts[0].x - none.strokes[i].pts[0].x;
    s.pts.forEach((p, j) => assert.ok(Math.abs(p.x - dx - none.strokes[i].pts[j].x) < 1e-6 && Math.abs(p.y - none.strokes[i].pts[j].y) < 1e-6));
  });
  assert.deepEqual(M.layout(airy, t, O).strokes, a.strokes, 'the same every time');
});

test('& lines rows up: the = of every step under the one before', () => {
  const t = 'f(x) &= 3(x+1) \\\\ f(x) &= 3x+3 \\\\ &= 2';
  const lay = M.layout(tight, t, O);
  // the first stroke of each = : find the = by laying the rows out alone and counting strokes before it
  const eqX = [];
  let k = 0;
  for (const [rowText, before] of [['f(x)=3(x+1)', 'f(x)'], ['f(x)=3x+3', 'f(x)'], ['=2', '']]) {
    const n = before ? M.layout(tight, before, O).strokes.length : 0;
    eqX.push(Math.min(...lay.strokes[k + n].pts.map((p) => p.x)));
    k += M.layout(tight, rowText, O).strokes.length;
  }
  assert.ok(Math.abs(eqX[0] - eqX[1]) < 0.05 * 34 && Math.abs(eqX[0] - eqX[2]) < 0.05 * 34, 'lined up: ' + eqX.map((v) => (v / 34).toFixed(2)).join(' '));
  const unmarked = M.layout(tight, 'f(x) = 3(x+1) \\\\ = 2', O);
  assert.ok(Math.min(...xs(unmarked.strokes.slice(-2))) < eqX[2] - 0.5 * 34, 'without & the last row starts at the margin');
  assert.equal(M.parse('a &= b')[0].filter((n) => n.t === 'align').length, 1, '& is not a character that has to be written');
});

test('hand: rows of math start and line up a little off and lean a little, and the letters stay the same', () => {
  const t = 'f(x) &= 3(x+1) \\\\ &= 3x+3 \\\\ y = 2 \\\\ y = 5';
  const ruler = M.layout(tight, t, O);
  const hand = M.layout(tight, t, Object.assign({}, O, { hand: true }));
  assert.equal(hand.strokes.length, ruler.strokes.length);
  assert.deepEqual(M.layout(tight, t, Object.assign({}, O, { hand: true })).strokes, hand.strokes, 'deterministic');
  assert.notDeepEqual(hand.strokes, ruler.strokes);
  // the first row is where it was
  const firstRow = M.layout(tight, 'f(x) = 3(x+1)', O).strokes.length;
  assert.ok(Math.abs(Math.min(...xs(hand.strokes.slice(0, firstRow))) - Math.min(...xs(ruler.strokes.slice(0, firstRow)))) < 1e-6);
  // every other row moved by no more than 0.4 x-heights sideways
  const moved = hand.strokes.map((s, i) => s.pts[0].x - ruler.strokes[i].pts[0].x);
  assert.ok(moved.every((d) => Math.abs(d) <= 0.45 * 34), 'small: ' + Math.max(...moved.map(Math.abs)).toFixed(1));
  assert.ok(moved.some((d) => Math.abs(d) > 0.02 * 34), 'but some');
});

test('hand: a wrapped line of text starts a little off the margin, the letters are the same', () => {
  const t = 'the quick brown fox jumps over the lazy dog and then the quick fox jumps home again';
  const o = { xh: 34, width: 500, seed: 2, bounce: 0 };
  const ruler = Y.layout(plainStyle, t, o);
  const hand = Y.layout(plainStyle, t, Object.assign({}, o, { hand: true }));
  assert.deepEqual(hand.words.map((w) => w && w.ids), ruler.words.map((w) => w && w.ids));
  assert.ok(hand.baselines.length >= 3);
  // where each line starts: the first letter of every word that begins a line (words go left to right, so a step back is a new line)
  const starts = (lay) => {
    const out = [];
    let prev = Infinity;
    for (const w of lay.words) {
      if (!w) continue;
      const x = w.spans[0][0];
      if (x < prev) out.push(x);
      prev = x;
    }
    return out;
  };
  const a = starts(ruler);
  const b = starts(hand);
  assert.ok(Math.abs(a[0] - b[0]) < 1e-6, 'the first line is where it was');
  assert.ok(b.slice(1).some((v, i) => Math.abs(v - a[i + 1]) > 1), 'later lines start a little off');
  assert.ok(b.every((v, i) => Math.abs(v - a[i]) <= 0.36 * 34));
});

test("f'' is two clear primes over the f, not a dot and a tick that read as fi", () => {
  const f = M.layout(tight, 'f', O);
  const ff = M.layout(tight, "f''", O);
  const [p1, p2] = ff.strokes.slice(f.strokes.length).map((s) => s.pts);
  const fRight = Math.max(...xs(f.strokes));
  const lo = (p) => Math.min(...p.map((q) => q.x));
  const hi = (p) => Math.max(...p.map((q) => q.x));
  assert.ok(lo(p1) > fRight + 0.03 * 34, 'clear of the f');
  const mid = (p) => p.reduce((t, q) => t + q.x, 0) / p.length;
  assert.ok(lo(p2) > hi(p1) - 0.1 * 34 && mid(p2) - mid(p1) > 0.18 * 34, 'clear of each other: ' + ((mid(p2) - mid(p1)) / 34).toFixed(2));
  for (const p of [p1, p2]) {
    const len = Math.max(...p.map((q) => q.y)) - Math.min(...p.map((q) => q.y));
    assert.ok(len > 0.45 * 34, 'long enough to read as a prime, not a dot');
  }
});

test('the pen is given in points and does not thin when the letters are smaller', () => {
  const style = tight;
  const at = (xhPt) => Sheet.layoutBox(style, { page: 0, x: 0, y: 0, w: 300, h: 60, text: 'the box', kind: 'text', xhPt, seed: 1, auto: false }, {});
  assert.equal(Sheet.penFor(at(9.5), { penPt: 1.14 }), 1, 'the old pen at the old default size');
  assert.equal(Sheet.penFor(at(4.75), { penPt: 1.14 }), 2, 'twice the old multiplier at half the size: the same width on paper');
  assert.equal(Sheet.penFor(at(4.75), { pen: 1 }), 1, 'without penPt it scales with the letters, as before (the Sheet tab)');
});

test('the server can be told the person’s own letter height and pen; every call then uses them', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-looks-'));
  const samples = path.join(tmp, 'my-handwriting.json');
  fs.writeFileSync(samples, S.toJSON(tightRaws));
  let id = 1;
  const textOf = (r) => r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const own = createServer({ samples, out: path.join(tmp, 'out'), letterPt: '6.5', penPt: '1.1' });
  const call = (srv, name, args) => srv({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
  assert.match(textOf(await call(own, 'handwriting_status', {})), /Defaults: letter height 6\.5 pt, pen 1\.1 pt \(set when the server was started\)/);
  assert.match(textOf(await call(own, 'write_text', { text: 'the box', format: 'svg' })), /Written at letter height 6\.5 pt/);
  assert.match(textOf(await call(own, 'write_text', { text: 'the box', format: 'svg', letter_height_pt: 8 })), /Written at letter height 8 pt/);
  const plain = createServer({ samples, out: path.join(tmp, 'out2') });
  assert.match(textOf(await call(plain, 'handwriting_status', {})), /Defaults: letter height 9\.5 pt, pen 1\.14 pt \(the built-in ones/);
  // a thicker pen is more ink in the same place
  const svgOf = async (args) => textOf(await call(plain, 'write_text', Object.assign({ text: 'the box', format: 'svg', letter_height_pt: 6 }, args)));
  assert.notEqual(await svgOf({ pen_pt: 1.4 }), await svgOf({ pen_pt: 0.7 }));
});
