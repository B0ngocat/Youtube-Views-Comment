#!/usr/bin/env node
/*
 * Writes a Notability note to open on the iPad to see whether pen strokes line up with the pages of a PDF in it: a two page
 * PDF (letter, then A4) with a red frame, a cross in the middle and a 100 point ruler drawn on it, and blue pen strokes
 * drawn at the same places. If the blue lies on the red, the page layout in src/notability.js is right. If it does not,
 * note which way and how far each is off (page 1 and page 2 separately, left and top), and the scale.
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
  const red = rgb(0.85, 0.1, 0.1);
  for (const p of PAGES) {
    const page = doc.addPage([p.w, p.h]);
    const line = (a, b) => page.drawLine({ start: { x: a[0], y: p.h - a[1] }, end: { x: b[0], y: p.h - b[1] }, thickness: 1.2, color: red });
    const m = 36; // the same marks as pdfCalibrationCurves
    line([m, m], [p.w - m, m]);
    line([p.w - m, m], [p.w - m, p.h - m]);
    line([p.w - m, p.h - m], [m, p.h - m]);
    line([m, p.h - m], [m, m]);
    line([p.w / 2 - 20, p.h / 2], [p.w / 2 + 20, p.h / 2]);
    line([p.w / 2, p.h / 2 - 20], [p.w / 2, p.h / 2 + 20]);
    line([72, 100], [172, 100]);
    page.drawText(p.label + ': red is the PDF, blue is pen', { x: 72, y: p.h - 70, size: 12, font, color: red });
  }
  const bytes = await doc.save();
  const pages = PAGES.map(({ w, h }) => ({ w, h }));
  const note = N.buildNote(N.pdfCalibrationCurves(pages, '#1749b3'), { name: 'Calibration PDF', pdf: { bytes, pages } });
  fs.writeFileSync(out, note);
  console.log('Wrote ' + out);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
