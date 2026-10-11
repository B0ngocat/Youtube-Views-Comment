'use strict';
// The climb back across the stem at the end of a y, g, j or q hangs in the air as a diagonal line when nothing is joined after it.
const test = require('node:test');
const assert = require('node:assert/strict');
const Y = require('../src/synth');

/** Dense points along a polyline through the given corners, one every 0.05. */
function along(corners) {
  const out = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.05));
    for (let k = 0; k < n; k++) out.push({ x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n, w: 1 });
  }
  const last = corners[corners.length - 1];
  out.push({ x: last[0], y: last[1], w: 1 });
  return out;
}
// the stem of a y: down from the top right to the bottom, then the hook to the left
const stem = [[0.6, 1], [0.35, -0.8], [-0.2, -0.6]];

test('a looped y with a long straight tail climbing back across its stem is cut where the climb starts', () => {
  const pts = along(stem.concat([[0.9, 0.6]])); // from (-0.2, -0.6) straight up to (0.9, 0.6): 1.6 long, crossing the stem
  const n = pts.length;
  assert.equal(Y.cutReturnStroke(pts, 'y'), true);
  assert.ok(pts.length < n - 20, 'the climb is gone');
  const last = pts[pts.length - 1];
  assert.ok(Math.hypot(last.x + 0.2, last.y + 0.6) < 0.12, 'it ends where the hook ends: ' + last.x.toFixed(2) + ', ' + last.y.toFixed(2));
  for (const ch of ['g', 'j', 'q']) assert.equal(Y.cutReturnStroke(along(stem.concat([[0.9, 0.6]])), ch), true, ch);
});

test('a tail that does not cross the letter is left alone', () => {
  const pts = along([[0.6, 1], [0.35, -0.8], [-0.2, -0.6], [-0.4, 0.5]]); // climbs on the left of the stem
  const n = pts.length;
  assert.equal(Y.cutReturnStroke(pts, 'y'), false);
  assert.equal(pts.length, n);
});

test('a short tail, a letter that is not g j q y, and a stub are left alone', () => {
  const short = along([[0.6, 1], [0.35, -0.8], [0.1, -0.4], [0.5, -0.1]]); // crosses, but only 0.5 long
  const sn = short.length;
  assert.equal(Y.cutReturnStroke(short, 'y'), false);
  assert.equal(short.length, sn);
  const a = along(stem.concat([[0.9, 0.6]]));
  const an = a.length;
  assert.equal(Y.cutReturnStroke(a, 'a'), false, 'not a descender letter');
  assert.equal(a.length, an);
  const stub = [{ x: 0.6, y: 1, w: 1 }, { x: 0.35, y: -0.8, w: 1 }, { x: -0.2, y: -0.6, w: 1 }, { x: 0.3, y: 0, w: 1 }, { x: 0.9, y: 0.6, w: 1 }];
  assert.equal(Y.cutReturnStroke(stub, 'y'), false, 'under 14 points');
  assert.equal(stub.length, 5);
});

// ---- in assemble ------------------------------------------------------------------------------------------

const unit = (ch, pts, joinsOn) => ({
  ch,
  strokes: [{ pts: pts.map((p) => ({ ...p })), taperStart: 0, taperEnd: 0 }],
  marks: [],
  entry: { x: pts[0].x, y: pts[0].y, dx: 0, dy: -1, mid: false },
  exit: { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, dx: 1, dy: 1, mid: !!joinsOn },
  box: { minX: -0.2, maxX: 0.9, minY: -0.8, maxY: 1 },
  wid: -1,
  idx: 0,
});
const G = require('../src/geometry');

test('at the end of a word and before a pen lift, the climb is cut; the original unit is not touched', () => {
  const tail = along(stem.concat([[0.9, 0.6]]));
  const y = unit('y', tail);
  const a = { ...unit('a', along([[0, 0], [0.3, 0.8], [0.6, 0]])), wid: -2 };
  const rng = G.mulberry32(1);
  const alone = Y.assemble([{ unit: y, scale: 1 }], 0.1, null, rng);
  assert.ok(alone[0].pts.length < tail.length - 20, 'cut at the end of the word');
  assert.equal(alone[0].taperEnd, 0.18);
  assert.equal(y.strokes[0].pts.length, tail.length, 'the unit itself is whole');
  const before = Y.assemble([{ unit: y, scale: 1 }, { unit: a, scale: 1 }], 0.1, null, G.mulberry32(1));
  assert.ok(before[0].pts.length < tail.length - 20, 'cut before a pen lift');
  assert.equal(before.length, 2);
});
