#!/usr/bin/env node
/*
 * Writes a Notability note to open on the iPad to see whether pen strokes line up with the pages of a PDF in it. The PDF has
 * two pages (letter, then A4). Right on each page corner there is a grey L flush with the page edges, with nine coloured pen
 * lines over each of its two arms: purple, blue, cyan, green, black, yellow, orange, red, pink. Purple is furthest left (or up),
 * pink furthest right (or down), black is where the page layout puts the pen. For each corner say which colour is in the middle
 * of the grey bar on the arm along the top or bottom edge (it shows up and down, 1 point per step) and on the arm down the side
 * (it shows left and right, 2 points per step).
 *
 *   node scripts/make-calibration-pdf-note.js [Calibration-PDF.note]
 */
'use strict';
const fs = require('fs');
const N = require('../src/notability');
const { PDFDocument, rgb, StandardFonts } = require('../vendor/pdf-lib.min.js');

const PAGES = [
  { w: 612, h: 792, label: 'Page 1 (letter)' },
  { w: 595.28, h: 841.89, label: 'Page 2 (A4)' },
];

async function main() {
  const out = process.argv[2] || 'Calibration-PDF.note';
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = PAGES.map(({ w, h }) => ({ w, h }));
  const pdfPages = PAGES.map((p) => doc.addPage([p.w, p.h]));
  for (const b of N.pdfCalibrationBars(pages)) {
    pdfPages[b.page].drawRectangle({ x: b.x, y: pages[b.page].h - b.y - b.h, width: b.w, height: b.h, color: rgb(0.8, 0.8, 0.8) }); // y down in
  }
  pdfPages.forEach((pg, i) => pg.drawText(PAGES[i].label, { x: 72, y: PAGES[i].h / 2, size: 14, font, color: rgb(0.2, 0.2, 0.2) }));
  const bytes = await doc.save();
  fs.writeFileSync(out, N.buildNote(N.pdfCalibrationCurves(pages), { name: 'Calibration PDF', pdf: { bytes, pages } }));
  console.log('Wrote ' + out);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
