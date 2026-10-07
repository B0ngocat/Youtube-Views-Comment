#!/usr/bin/env node
/*
 * A Notability note with the same words at several sizes and pen widths, one row each, to pick the ones that look like the
 * person's own writing in Notability.
 *
 *   node scripts/make-notability-sample.js my-handwriting.json Sample.note
 *
 * Row k has k small tick marks at its left. Rows 1 to 3 are the normal letter height with a thin, medium and thick pen; rows 4
 * and 5 are larger, with the medium pen.
 */
'use strict';
const fs = require('fs');
const S = require('../src/style');
const Y = require('../src/synth');
const N = require('../src/notability');

const [, , samples, out] = process.argv;
if (!samples || !out) {
  console.error('usage: node scripts/make-notability-sample.js <my-handwriting.json> <out.note>');
  process.exit(2);
}
const style = S.buildStyle(S.fromJSON(fs.readFileSync(samples, 'utf8')));
const lay = Y.layout(style, 'The quick brown fox jumps over 12.4', { xh: 34, width: 1400, seed: 3 });
const ink = '#1749b3';
const rows = [
  { xhDoc: 8.8, pen: 1.05 },
  { xhDoc: 8.8, pen: 1.6 },
  { xhDoc: 8.8, pen: 2.4 },
  { xhDoc: 11, pen: 1.6 },
  { xhDoc: 14, pen: 1.6 },
];
const curves = [];
rows.forEach((r, k) => {
  const top = 40 + k * 70;
  curves.push(...N.curvesFromLayout(lay, { ink, xhDoc: r.xhDoc, pen: r.pen, left: 40, top }));
  for (let t = 0; t <= k; t++) curves.push({ pts: N.toChain([[6 + t * 5, top], [6 + t * 5, top + 22]]), width: 1.05, color: curves[0].color });
});
fs.writeFileSync(out, N.buildNote(curves, { name: 'Sample' }));
console.log(`Wrote ${out}: ${curves.length} strokes`);
