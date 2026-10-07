#!/usr/bin/env node
/*
 * Writes a Notability note to open on the iPad to see whether pen strokes line up with the pages of a PDF in it. The PDF has
 * two pages (letter, then A4) with five grey plus signs on each, lettered A to E; over every arm of every plus there are nine
 * pen lines in different colours. For each plus, say which colour is in the middle of the grey bar, along the horizontal arm
 * and along the vertical arm. Black is exact; each step towards pink is 1.5 points further down (or right), each step towards
 * purple 1.5 points up (or left). The same colour everywhere means a plain shift; colours that change from A to E mean the
 * pen is scaled against the PDF.
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
  const grey = rgb(0.78, 0.78, 0.78);
  const pdfPages = PAGES.map((p) => doc.addPage([p.w, p.h]));
  for (const { page, x, y, label } of N.pdfCalibrationSites(pages)) {
    const pg = pdfPages[page];
    const H = pages[page].h;
    pg.drawRectangle({ x: x - N.ARM, y: H - y - 7.5, width: 2 * N.ARM, height: 15, color: grey }); // the arms: 15 points thick
    pg.drawRectangle({ x: x - 7.5, y: H - y - N.ARM, width: 15, height: 2 * N.ARM, color: grey });
    pg.drawText(label, { x: x + N.ARM + 6, y: H - y - 4, size: 14, font, color: rgb(0.2, 0.2, 0.2) });
  }
  pdfPages.forEach((pg, i) => pg.drawText(PAGES[i].label, { x: 72, y: PAGES[i].h - 60, size: 14, font, color: rgb(0.2, 0.2, 0.2) }));
  const bytes = await doc.save();
  const note = N.buildNote(N.pdfCalibrationCurves(pages), { name: 'Calibration PDF', pdf: { bytes, pages } });
  fs.writeFileSync(out, note);
  console.log('Wrote ' + out);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
