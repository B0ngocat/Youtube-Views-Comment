'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/render');

const stroke = (w, taper) => ({
  taperStart: taper || 0,
  taperEnd: taper || 0,
  pts: Array.from({ length: 30 }, (_, i) => ({ x: i * 2, y: 20 + 6 * Math.sin(i / 4), w: typeof w === 'function' ? w(i) : w })),
});

test('a constant pen ignores the stroke width and the tapers', () => {
  const a = R.strokeToPath(stroke(0.5), 3, 34, true);
  const b = R.strokeToPath(stroke((i) => 0.4 + i * 0.05, 0.3), 3, 34, true);
  assert.equal(a, b);
});

test('the speed-based pen still varies with the stroke width', () => {
  const a = R.strokeToPath(stroke(0.5), 3, 34, false);
  const b = R.strokeToPath(stroke(1.5), 3, 34, false);
  assert.notEqual(a, b);
});

test('a constant pen draws a dot as a disc of the same size as the line is wide', () => {
  const dot = R.strokeToPath({ taperStart: 0, taperEnd: 0, pts: [{ x: 5, y: 5, w: 0.3 }] }, 3, 34, true);
  const other = R.strokeToPath({ taperStart: 0, taperEnd: 0, pts: [{ x: 5, y: 5, w: 2 }] }, 3, 34, true);
  assert.equal(dot, other);
});

test('SVG export carries the constant pen, the ink colour and a white page', () => {
  const layout = { width: 100, height: 60, xh: 34, lineHeightPx: 100, baselines: [40], strokes: [stroke(1)] };
  const svg = R.toSVG(layout, { ink: '#0f55e6', constant: true, paper: 'white' });
  assert.ok(svg.includes('fill="#0f55e6"'));
  assert.ok(svg.includes('fill="#ffffff"'));
  const loose = R.toSVG({ ...layout, strokes: [stroke(2, 0.4)] }, { ink: '#0f55e6', constant: true, paper: 'white' });
  assert.equal(svg, loose, 'with a constant pen the page does not depend on stroke widths');
});
