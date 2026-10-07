#!/usr/bin/env node
/*
 * Writes a Notability note to open on the iPad to see whether pen strokes line up with the pages of a PDF in it. The PDF has
 * two pages (letter, then A4). In each corner of each page there are two rows of seven small grey corner pieces numbered 1
 * to 7, each with a thin blue pen L drawn in it. Row 1 moves the pen sideways from piece to piece, row 2 up and down, in steps
 * of 1.5 points; piece 4 is not moved. For each corner and row, say which number has the blue line in the middle of the grey.
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
  const grey = rgb(0.8, 0.8, 0.8);
  const ink = rgb(0.2, 0.2, 0.2);
  const pdfPages = PAGES.map((p) => doc.addPage([p.w, p.h]));
  for (const c of N.pdfCalibrationPieces(pages)) {
    const pg = pdfPages[c.page];
    const H = pages[c.page].h;
    const T = 8; // the grey is 8 points thick, the pen line 1
    const box = (x0, y0, x1, y1) => pg.drawRectangle({ x: Math.min(x0, x1), y: H - Math.max(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), color: grey }); // y down in, as everywhere else
    box(c.x - (c.sx * T) / 2, c.y - T / 2, c.x + c.sx * N.PIECE_ARM, c.y + T / 2);
    box(c.x - T / 2, c.y - (c.sy * T) / 2, c.x + T / 2, c.y + c.sy * N.PIECE_ARM);
    pg.drawText(String(c.n), { x: c.x + c.sx * 4 - 2, y: H - (c.y - c.sy * 16) - 3, size: 8, font, color: ink }); // outside the L, away from the page
  }
  pdfPages.forEach((pg, i) => pg.drawText(PAGES[i].label, { x: 72, y: PAGES[i].h / 2, size: 14, font, color: ink }));
  const bytes = await doc.save();
  const note = N.buildNote(N.pdfCalibrationCurves(pages, '#1749b3'), { name: 'Calibration PDF', pdf: { bytes, pages } });
  fs.writeFileSync(out, note);
  console.log('Wrote ' + out);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
