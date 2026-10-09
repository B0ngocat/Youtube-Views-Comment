/*
 * Putting handwriting onto a sheet (a PDF or a picture of a worksheet). This file is the part that needs no screen:
 * fitting an answer into the box it was given, and writing the ink into the PDF. The screen part is sheetui.js.
 *
 * Boxes are in PDF points, from the top-left corner of the page, the way a person looks at it:
 *   {page, x, y, w, h, text, kind: 'text' | 'math', xhPt, seed, auto}
 */
(function (root) {
  'use strict';

  const Y = typeof require !== 'undefined' ? require('./synth') : root.HW.synth;
  const M = typeof require !== 'undefined' ? require('./math') : root.HW.math;
  const R = typeof require !== 'undefined' ? require('./render') : root.HW.render;

  const ENGINE_XH = 34; // the engine lays out at this x-height in its own pixels; everything is scaled to points afterwards
  const DEFAULT_XH_PT = 9.5; // a lowercase letter this tall looks like handwriting on a letter-size worksheet
  const MIN_XH_PT = 5;

  function inkBounds(strokes) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of strokes) {
      for (const p of s.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  /**
   * Write `box.text` in the writer's hand to fit `box`. When it does not fit at the size asked for, in this order:
   *   1. it is wrapped onto more lines (the engine always wraps words to the box's width);
   *   2. the box grows downward, as far as box.growTo (points, the tallest the box may become; default: it may not grow);
   *   3. only then is the letter size reduced, a little at a time, down to box.minRatio times the size asked for (unless
   *      box.auto === false, which never shrinks). Without minRatio it goes down to MIN_XH_PT, as the Sheet tab always did.
   * look: the sliders of the Write tab (messiness, variation, slantDelta, wordSpacing, neatness, wordReuse), and
   * fallbackGlyphs (draw clean stand-ins for symbols the writer has not written).
   * Returns {layout, K, xhPt, dx, dy, overflow, missing, substituted, standIns} and what was done to make it fit:
   *   wantXh (the size asked for), lines, wrapped (more lines than the text has), h (the box height in the end),
   *   grown ({from, to} or null), shrunk ({from, to} or null), tooWide (a word wider than the box, which only shrinking fixes).
   * K is points per layout pixel, and the layout belongs at (box.x - dx * K, box.y - dy * K) in points.
   */
  function layoutBox(style, box, look) {
    const text = String(box.text || '');
    const wantXh = box.xhPt || DEFAULT_XH_PT;
    const gen = box.kind === 'math' ? M : Y;
    const pad = 0.1 * ENGINE_XH;
    const floor = box.minRatio ? Math.max(MIN_XH_PT, wantXh * box.minRatio) : MIN_XH_PT;
    const explicitLines = text.split('\n').length;

    // the writing at one size, in a box h points tall
    function fitAt(xhPt, h) {
      const K = xhPt / ENGINE_XH;
      const lay = gen.layout(
        style,
        text,
        Object.assign({}, look || {}, {
          xh: ENGINE_XH,
          width: Math.max(60, Math.round(box.w / K)),
          lineHeight: box.kind === 'math' ? 3 : 2.5,
          seed: box.seed === undefined ? 1 : box.seed, // 0 is a seed too
          margin: 8,
        })
      );
      const moved = R.fitLayout(lay, pad);
      const b = inkBounds(lay.strokes);
      // A box about one line tall is an answer line: the writing sits on its bottom edge (descenders cross it, as they
      // do on paper) instead of hanging from the top with a gap above the printed line.
      const oneLine = box.kind !== 'math' && lay.baselines.length === 1 && h <= 3.4 * xhPt;
      let dy = moved.dy; // the layout's origin is box.y - dy * K points from the top of the page
      if (oneLine) {
        const top = b.minY - dy; // ink top, below the box top, in layout px
        const down = h / K - 0.45 * ENGINE_XH - (lay.baselines[0] - dy); // to put the baseline there
        dy -= Math.max(down, -top); // moving up is limited so the tops of the letters stay in the box
      }
      // where the ink ends, measured from the box's own top-left corner
      const right = (b.maxX - moved.dx) * K;
      const bottom = (b.maxY - dy) * K;
      const tooWide = right > box.w + 1;
      const tooTall = bottom > h + (oneLine ? 0.7 * xhPt : 1);
      return { layout: lay, K, xhPt, dx: moved.dx, dy, overflow: tooWide || tooTall, tooWide, tooTall, bottom, h, missing: lay.missing || [], substituted: lay.substituted || lay.standIns || [], unknown: lay.unknown || [] };
    }

    const maxH = Math.max(box.h, box.growTo || 0);
    let xhPt = wantXh;
    let out = null;
    for (let tries = 0; tries < 40; tries++) {
      out = fitAt(xhPt, box.h);
      if (out.tooTall && !out.tooWide && maxH > box.h) {
        // too tall, not too wide: let the box grow down to hold it, if it may grow that far
        const need = Math.ceil(out.bottom + 1);
        if (need <= maxH + 0.5) out = fitAt(xhPt, Math.max(need, box.h));
      }
      if (!out.overflow || box.auto === false || xhPt <= floor + 1e-9) break;
      xhPt = Math.max(floor, xhPt * 0.93);
    }
    const lines = out.layout.baselines.length;
    out.wantXh = wantXh;
    out.lines = lines;
    out.wrapped = box.kind !== 'math' && lines > explicitLines;
    out.grown = out.h > box.h + 0.01 ? { from: box.h, to: out.h } : null;
    out.shrunk = out.xhPt < wantXh - 0.05 ? { from: wantXh, to: out.xhPt } : null;
    return out;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0x1749b3;
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /** The ink of a placed box as SVG path data in layout pixels. */
  function inkPath(placed, look) {
    return R.layoutToPath(placed.layout, look.pen === undefined ? 1 : look.pen, look.constant !== false);
  }

  /**
   * Write the boxes' ink into a PDF as vector shapes, on top of what is already on the pages.
   * PDFLib: the pdf-lib module. bytes: the PDF. items: [{box, placed}] with placed from layoutBox.
   * look: {ink: '#rrggbb', pen, constant}. Returns the new PDF's bytes.
   */
  async function writeInk(PDFLib, bytes, items, look) {
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = doc.getPages();
    const [r, g, b] = hexToRgb(look.ink);
    for (const { box, placed } of items) {
      const page = pages[box.page];
      if (!page) continue;
      if (page.getRotation().angle % 360 !== 0) throw new Error('Page ' + (box.page + 1) + ' is rotated, and rotated pages are not supported yet.');
      const view = page.getCropBox ? page.getCropBox() : page.getMediaBox();
      page.drawSvgPath(inkPath(placed, look), {
        x: view.x + box.x - placed.dx * placed.K,
        y: view.y + view.height - (box.y - placed.dy * placed.K),
        scale: placed.K,
        color: PDFLib.rgb(r, g, b),
        borderWidth: 0,
      });
    }
    return doc.save();
  }

  /** A PDF with one page that is the given picture (PNG or JPEG bytes), 612 pt wide, so a photo of a worksheet works like a PDF. */
  async function pdfFromImage(PDFLib, bytes, mime, width, height) {
    const doc = await PDFLib.PDFDocument.create();
    const img = mime === 'image/jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const w = 612;
    const h = (w * height) / width;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    return doc.save();
  }

  const api = { layoutBox, writeInk, inkPath, pdfFromImage, hexToRgb, DEFAULT_XH_PT, MIN_XH_PT, ENGINE_XH };
  root.HW = root.HW || {};
  root.HW.sheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
