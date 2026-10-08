/*
 * Clean vector drawings for characters, as lists of polylines in engine units (x from 0, baseline 0, x-height 1, y up).
 * They are what gets drawn when the writer has no sample of a symbol (math mode always, plain text when asked), and the
 * writing engine turns them into hand-wobbled strokes. There are none for letters and digits: those cannot be faked, so a
 * letter the writer never wrote is reported, not drawn.
 */
(function (root) {
  'use strict';

  const line = (x0, y0, x1, y1) => [[x0, y0], [x1, y1]];
  const dot = (x, y) => [[x, y], [x + 0.01, y + 0.02]];
  const ring = (cx, cy, r, n) => {
    const p = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      p.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
    return p;
  };
  const wave = (x0, x1, y, amp) => Array.from({ length: 12 }, (_, i) => [x0 + ((x1 - x0) * i) / 11, y + amp * Math.sin((2 * Math.PI * i) / 11)]);
  const question = () => [[[0.05, 1.4], [0.12, 1.75], [0.38, 1.75], [0.45, 1.45], [0.25, 1.1], [0.22, 0.65]], dot(0.22, 0.05)];

  /**
   * The polylines for `c`, or null when there is no drawing for it. up and down (in x-heights) are how far a bracket reaches
   * above the baseline and below it; they only matter for brackets, bars and the integral and sum signs.
   */
  function polys(c, up, down) {
    const U = up === undefined ? 1.8 : up;
    const D = down === undefined ? 0.4 : down;
    const mid = (U - D) / 2;
    switch (c) {
      case '[': return [[[0.35, U], [0, U], [0, -D], [0.35, -D]]];
      case ']': return [[[0, U], [0.35, U], [0.35, -D], [0, -D]]];
      case '{': return [[[0.4, U], [0.2, U - 0.1], [0.2, mid + 0.15], [0, mid], [0.2, mid - 0.15], [0.2, -D + 0.1], [0.4, -D]]];
      case '}': return [[[0, U], [0.2, U - 0.1], [0.2, mid + 0.15], [0.4, mid], [0.2, mid - 0.15], [0.2, -D + 0.1], [0, -D]]];
      case '(': return [[[0.35, U], [0.08, mid + 0.4], [0.08, mid - 0.4], [0.35, -D]]];
      case ')': return [[[0, U], [0.27, mid + 0.4], [0.27, mid - 0.4], [0, -D]]];
      case '|': return [[[0, U], [0.02, -D]]];
      case '<': return [[[0.55, 0.95], [0, 0.5], [0.55, 0.05]]];
      case '>': return [[[0, 0.95], [0.55, 0.5], [0, 0.05]]];
      case '≤': return [[[0.55, 1.0], [0, 0.6], [0.55, 0.2]], line(0, -0.05, 0.55, -0.05)];
      case '≥': return [[[0, 1.0], [0.55, 0.6], [0, 0.2]], line(0, -0.05, 0.55, -0.05)];
      case '=': return [line(0, 0.35, 0.7, 0.35), line(0, 0.7, 0.7, 0.7)];
      case '≠': return [line(0, 0.3, 0.7, 0.3), line(0, 0.65, 0.7, 0.65), line(0.5, 0.95, 0.2, 0.0)];
      case '≈': return [[[0, 0.3], [0.2, 0.45], [0.45, 0.2], [0.7, 0.35]], [[0, 0.65], [0.2, 0.8], [0.45, 0.55], [0.7, 0.7]]];
      case '+': return [line(0, 0.5, 0.7, 0.5), line(0.35, 0.85, 0.35, 0.15)];
      case '-': return [line(0, 0.45, 0.6, 0.45)];
      case '±': return [line(0, 0.7, 0.7, 0.7), line(0.35, 1.05, 0.35, 0.35), line(0, 0.05, 0.7, 0.05)];
      case '×': return [line(0, 0.15, 0.6, 0.85), line(0, 0.85, 0.6, 0.15)];
      case '÷': return [line(0, 0.5, 0.7, 0.5), [[0.35, 0.9], [0.36, 0.92]], [[0.35, 0.1], [0.36, 0.12]]];
      case '·': return [[[0, 0.5], [0.02, 0.52]]];
      case '→': return [line(0, 0.5, 1.0, 0.5), [[0.75, 0.8], [1.0, 0.5], [0.75, 0.2]]];
      case '∞': return [ring(0.5, 0.5, 1, 40).map((_, i) => {
        const t = (i / 40) * 2 * Math.PI;
        return [0.5 + 0.5 * Math.sin(t), 0.5 + 0.3 * Math.sin(t) * Math.cos(t)];
      })];
      case '∫': return [[[0.5, 1.9], [0.38, 2.0], [0.28, 1.85], [0.25, 1.4], [0.2, 0.5], [0.15, -0.2], [0.05, -0.65], [-0.08, -0.55]]];
      case '∑': return [[[1.0, 1.5], [0.1, 1.5], [0.7, 0.5], [0.0, -0.45], [1.0, -0.45]]];
      case '∏': return [line(0, 1.5, 1.0, 1.5), line(0.15, 1.5, 0.12, -0.45), line(0.85, 1.5, 0.88, -0.45)];
      // marks that sit above the line
      case '°': return [ring(0.18, 1.5, 0.17, 14)];
      case '¯': case '‾': case 'ˉ': return [line(0.02, 1.75, 0.62, 1.75)];
      case '′': return [line(0.12, 1.8, 0.06, 1.4)];
      case '″': return [line(0.08, 1.8, 0.02, 1.4), line(0.26, 1.8, 0.2, 1.4)];
      case '´': return [[[0.05, 1.45], [0.25, 1.8]]];
      case '`': return [[[0.25, 1.45], [0.05, 1.8]]];
      case '¨': return [dot(0.05, 1.55), dot(0.3, 1.55)];
      case '^': return [[[0, 1.3], [0.2, 1.75], [0.4, 1.3]]];
      case '~': case '˜': return [wave(0, 0.7, 0.6, 0.1)];
      case '•': return [ring(0.1, 0.5, 0.09, 8)];
      // marks on the line
      case '_': return [line(0, -0.15, 0.7, -0.15)];
      case '\\': return [line(0, 1.7, 0.5, -0.2)];
      case '/': return [line(0.5, 1.7, 0, -0.2)];
      case '*': return [line(0.35, 0.95, 0.35, 1.65), line(0.05, 1.1, 0.65, 1.5), line(0.05, 1.5, 0.65, 1.1)];
      case '.': return [dot(0.1, 0.05)];
      case ',': return [[[0.1, 0.05], [0.12, -0.1], [0.08, -0.3]]];
      case ':': return [dot(0.1, 0.05), dot(0.1, 0.65)];
      case ';': return [[[0.1, 0.05], [0.12, -0.1], [0.08, -0.3]], dot(0.1, 0.65)];
      case '!': return [line(0.1, 1.8, 0.12, 0.5), dot(0.12, 0.05)];
      case "'": return [line(0.1, 1.8, 0.07, 1.4)];
      case '"': return [line(0.08, 1.8, 0.05, 1.4), line(0.26, 1.8, 0.23, 1.4)];
      case '?': return question();
      // the Spanish marks are the same marks turned upside down
      case '¿': case '¡': {
        const base = polys(c === '¿' ? '?' : '!');
        const cx = 0.25;
        const cy = 0.925;
        return base.map((poly) => poly.map(([x, y]) => [2 * cx - x, 2 * cy - y]));
      }
      default: return null;
    }
  }

  const has = (c) => polys(c) !== null;

  const api = { polys, has };
  root.HW = root.HW || {};
  root.HW.glyphs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
