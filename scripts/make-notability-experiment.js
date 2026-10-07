#!/usr/bin/env node
/*
 * A Notability note with the same words written several ways, one per row, to find out which way Notability draws all
 * of them. Used when handwriting notes open but only some of the strokes show.
 *
 *   node scripts/make-notability-experiment.js my-handwriting.json Experiment.note
 *
 * Row k has k small tick marks at its left. Rows: 1 the normal way; 2 and 3 fewer points per stroke; 4 every point;
 * 5 a thicker pen; 6 fewer points and varying width fractions like a real pen stroke; 7 every stroke cut into pieces of
 * at most 12 points. Below them, circles of 8, 24, 80 and 240 points.
 */
'use strict';
const fs = require('fs');
const S = require('../src/style');
const Y = require('../src/synth');
const N = require('../src/notability');

const [, , samples, out] = process.argv;
if (!samples || !out) {
  console.error('usage: node scripts/make-notability-experiment.js <my-handwriting.json> <out.note>');
  process.exit(2);
}
const style = S.buildStyle(S.fromJSON(fs.readFileSync(samples, 'utf8')));
const lay = Y.layout(style, 'the quick fox', { xh: 34, width: 900, seed: 3 });
const ink = '#1749b3';
const wobble = (n) => Array.from({ length: n }, (_, i) => 0.85 + 0.15 * Math.sin(i * 0.9)); // like a pen's pressure: between 0.7 and 1.0

const rows = [
  { spacing: 0.8 },
  { spacing: 2 },
  { spacing: 4 },
  { spacing: 0 },
  { spacing: 0.8, pen: 2.8 },
  { spacing: 2, fractions: wobble },
  { spacing: 0.8, chunk: 12 },
];
const curves = [];
rows.forEach((r, k) => {
  const top = 40 + k * 70;
  let cs = N.curvesFromLayout(lay, { ink, xhDoc: 11, left: 40, top, spacing: r.spacing, pen: r.pen, fractions: r.fractions });
  if (r.chunk) cs = cs.flatMap((c) => (c.pts.length <= r.chunk ? [c] : Array.from({ length: Math.ceil((c.pts.length - 1) / (r.chunk - 1)) }, (_, i) => Object.assign({}, c, { pts: N.lengthen(c.pts.slice(i * (r.chunk - 1), i * (r.chunk - 1) + r.chunk)) }))));
  curves.push(...cs);
  for (let t = 0; t <= k; t++) curves.push({ pts: N.lengthen([[6 + t * 5, top], [6 + t * 5, top + 22]]), width: 1.05, color: cs[0].color });
});
[8, 24, 80, 240].forEach((n, k) => {
  const cx = 60 + k * 110;
  const cy = 40 + rows.length * 70 + 30;
  const pts = Array.from({ length: n + 1 }, (_, i) => [cx + 30 * Math.cos((2 * Math.PI * i) / n), cy + 30 * Math.sin((2 * Math.PI * i) / n)]);
  curves.push({ pts, width: 1.05, color: curves[0].color });
});
fs.writeFileSync(out, N.buildNote(curves, { name: 'Experiment' }));
console.log(`Wrote ${out}: ${curves.length} strokes`);
