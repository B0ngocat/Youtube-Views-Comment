/*
 * Hand-drawn marks for a worksheet: a circle round an option, a tick or cross in a checkbox, an underline, a line through
 * a word, a box round an answer, a line or an arrow. This file is only geometry: a description of the mark plus a seed
 * go in, wobbly pen strokes come out, in PDF points from the top-left corner of the page (y down), the same units the
 * answer boxes use. It knows nothing about PDFs or about the writer's samples.
 *
 *   draw(mark, {xh, seed})  ->  {type, strokes: [{pts: [{x, y, w}], taperStart, taperEnd}]}
 *   toPlaced(drawn, {xh, page})  ->  {box, placed}   the same shape Sheet.writeInk / Notability.noteFromBoxes take
 *
 * mark: {type, x, y, w, h} (a rectangle: what is circled, boxed, underlined, struck, ticked or crossed) or
 *       {type: 'arrow' | 'line', x1, y1, x2, y2}. xh is the letter height in points the writing on the page is done at; the
 * pen is the one the answers use at that letter height, because toPlaced gives the strokes the same layout scale (K) a
 * written answer at that xh has, and the pen width comes from layout.xh * K.
 */
(function (root) {
  'use strict';

  const G = typeof require !== 'undefined' ? require('./geometry') : root.HW.geometry;

  const TYPES = ['circle', 'tick', 'cross', 'underline', 'strike', 'box', 'arrow', 'line'];
  const ENGINE_XH = 34; // the engine's own letter height in layout pixels (sheet.js ENGINE_XH): K = xh / ENGINE_XH
  const DEFAULT_XH = 9.5;

  /**
   * A stroke along the control points: densified to about one point per `step`, corners rounded (`round` samples of
   * smoothing), and wobbled sideways by smooth noise of amplitude `amp` points and wavelength `wave` points. With
   * `pin` the wobble dies away at both ends, so a line or arrow still starts and ends where it was told to.
   */
  function shape(ctrl, rng, o) {
    let pts = G.resample(ctrl.map((p) => ({ x: p[0], y: p[1] })), o.step || 1);
    if (o.round) pts = G.smooth(pts, o.round);
    const nx = G.makeNoise(rng);
    const ny = G.makeNoise(rng);
    const px = rng() * 50;
    const py = rng() * 50;
    const total = G.pathLength(pts);
    let s = 0;
    const out = pts.map((p, i) => {
      if (i) s += G.dist(pts[i - 1], p);
      const env = o.pin ? Math.min(1, s / 6, (total - s) / 6) : 1;
      return { x: p.x + o.amp * nx(px + s / o.wave) * env, y: p.y + o.amp * ny(py + s / o.wave) * env, w: 1 };
    });
    return { pts: out, taperStart: 0.1, taperEnd: 0.1 };
  }

  const jit = (rng, a) => (rng() * 2 - 1) * a;
  const need = (m, keys) => {
    for (const k of keys) if (!Number.isFinite(Number(m[k]))) throw new Error(`mark of type ${m.type} needs ${keys.join(', ')} (${k} is missing or not a number)`);
  };

  /** A loop round the rectangle: an ellipse a little bigger than the target, tilted, a bit more than one turn, so the ends overlap off the line. */
  function circle(m, rng, xh) {
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2;
    // an ellipse through the rectangle's corners has radii 1.414 x half the sides; the extra covers the spiral and the wobble
    const rx = (m.w / 2) * 1.5 + 0.45 * xh;
    const ry = (m.h / 2) * 1.5 + 0.38 * xh;
    const tilt = jit(rng, 0.14);
    const dir = rng() < 0.8 ? -1 : 1; // most people go round anticlockwise
    const a0 = -Math.PI / 2 + jit(rng, 0.6);
    const sweep = 2 * Math.PI * (1.04 + 0.1 * rng());
    const k = (rng() < 0.5 ? -1 : 1) * (0.05 + 0.06 * rng()); // the end does not meet the start: it spirals in or out
    const n = Math.ceil((sweep * Math.max(rx, ry)) / 1);
    const nz = G.makeNoise(rng);
    const ph = rng() * 40;
    const ctrl = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = a0 + dir * sweep * t;
      const f = 1 + k * (t - 0.5) + 0.025 * nz(ph + t * 5);
      const ex = rx * f * Math.cos(a);
      const ey = ry * f * Math.sin(a);
      ctrl.push([cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), cy + ex * Math.sin(tilt) + ey * Math.cos(tilt)]);
    }
    return [shape(ctrl, rng, { amp: 0.05 * xh, wave: 9 })];
  }

  /** The unit square's size and place for a tick or cross: inside the rectangle, a little smaller so the wobble stays in. */
  function squareIn(m) {
    const side = 0.88 * Math.min(m.w, m.h);
    return { x: m.x + (m.w - side) / 2, y: m.y + (m.h - side) / 2, s: side };
  }

  /** A check mark: a short stroke down, a long one up and out. One stroke, rounded at the bottom. */
  function tick(m, rng, xh) {
    const q = squareIn(m);
    const u = [[0.08, 0.54], [0.36, 0.9], [0.94, 0.08]].map(([a, b]) => [q.x + (a + jit(rng, 0.03)) * q.s, q.y + (b + jit(rng, 0.03)) * q.s]);
    return [shape(u, rng, { amp: Math.min(0.04 * xh, 0.03 * q.s), wave: 6, round: 2 })];
  }

  /** An X: two strokes, the second drawn from either top corner. */
  function cross(m, rng, xh) {
    const q = squareIn(m);
    const p = (a, b) => [q.x + (a + jit(rng, 0.04)) * q.s, q.y + (b + jit(rng, 0.04)) * q.s];
    const amp = Math.min(0.04 * xh, 0.03 * q.s);
    const one = [p(0.1, 0.1), p(0.9, 0.9)];
    let two = [p(0.9, 0.1), p(0.1, 0.9)];
    if (rng() < 0.4) two = two.reverse();
    return [shape(one, rng, { amp, wave: 7 }), shape(two, rng, { amp, wave: 7 })];
  }

  /** One stroke along a nearly straight line: a little slope, a slow bow, a wobble. Used for underline and strike. */
  function along(x0, y0, x1, y1, rng, xh) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const bow = jit(rng, 0.1) * xh;
    const nx = -(y1 - y0) / len;
    const ny = (x1 - x0) / len;
    const ctrl = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const b = bow * 4 * t * (1 - t);
      ctrl.push([x0 + (x1 - x0) * t + nx * b, y0 + (y1 - y0) * t + ny * b]);
    }
    return shape(ctrl, rng, { amp: 0.07 * xh, wave: 22 });
  }

  /** A line under the rectangle (below its bottom edge, a bit past both ends). */
  function underline(m, rng, xh) {
    const y = m.y + m.h + 0.3 * xh;
    const x0 = m.x - (0.1 + 0.2 * rng()) * xh;
    const x1 = m.x + m.w + (0.1 + 0.25 * rng()) * xh;
    return [along(x0, y + jit(rng, 0.1) * xh, x1, y + jit(rng, 0.2) * xh, rng, xh)];
  }

  /** A line through the rectangle: at `mid` of its height (0.5 unless the caller knows the printed text sits lower). */
  function strike(m, rng, xh) {
    const y = m.y + m.h * (m.mid === undefined ? 0.5 : m.mid);
    const x0 = m.x - (0.1 + 0.2 * rng()) * xh;
    const x1 = m.x + m.w + (0.1 + 0.2 * rng()) * xh;
    return [along(x0, y + jit(rng, 0.08) * xh, x1, y + jit(rng, 0.15) * xh, rng, xh)];
  }

  /** A rectangle drawn round the target in one stroke: the corners are a little off and rounded, and the end overshoots the start. */
  function box(m, rng, xh) {
    const p = 0.3 * xh + 0.5;
    const L = m.x - p;
    const R = m.x + m.w + p;
    const T = m.y - p;
    const B = m.y + m.h + p;
    const j = () => jit(rng, 0.1 * xh);
    const ctrl = [
      [L + j(), T + (0.2 + 0.5 * rng()) * xh],
      [L + j(), T + j()],
      [R + j(), T + j()],
      [R + j(), B + j()],
      [L + j(), B + j()],
      [L + j(), T - (0.02 + 0.1 * rng()) * xh],
    ];
    return [shape(ctrl, rng, { amp: 0.05 * xh, wave: 12, round: 2.5 })];
  }

  /** A line from (x1, y1) to (x2, y2); with `head`, two short strokes back from the tip at (x2, y2). */
  function line(m, rng, xh, head) {
    const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
    const bow = jit(rng, 0.02) * len;
    const nx = -(m.y2 - m.y1) / len;
    const ny = (m.x2 - m.x1) / len;
    const ctrl = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const b = bow * 4 * t * (1 - t);
      ctrl.push([m.x1 + (m.x2 - m.x1) * t + nx * b, m.y1 + (m.y2 - m.y1) * t + ny * b]);
    }
    const out = [shape(ctrl, rng, { amp: 0.1 * xh, wave: 25, pin: true })];
    if (head) {
      const back = Math.atan2(m.y1 - m.y2, m.x1 - m.x2);
      const hl = Math.min(1.3 * xh * (0.9 + 0.2 * rng()), 0.45 * len);
      for (const side of [-1, 1]) {
        const a = back + side * ((24 + 8 * rng()) * Math.PI) / 180;
        const l = hl * (0.92 + 0.16 * rng());
        const tip = [m.x2 + jit(rng, 0.03) * xh, m.y2 + jit(rng, 0.03) * xh];
        out.push(shape([tip, [m.x2 + l * Math.cos(a), m.y2 + l * Math.sin(a)]], rng, { amp: 0.03 * xh, wave: 6 }));
      }
    }
    return out;
  }

  /** The default size of a tick or cross given only a point: a square this many points on a side. */
  const defaultSquare = (xh) => 1.4 * (xh || DEFAULT_XH);

  /**
   * The strokes of one mark. The same mark and seed always give the same strokes; another seed gives another hand.
   * opts: {xh: letter height in points (default 9.5), seed: a whole number (default 1)}.
   */
  function draw(mark, opts) {
    const o = opts || {};
    const xh = o.xh > 0 ? o.xh : DEFAULT_XH;
    const m = Object.assign({}, mark);
    if (!TYPES.includes(m.type)) throw new Error(`mark type ${JSON.stringify(m.type)} is not one of ${TYPES.join(', ')}`);
    const rng = G.mulberry32(o.seed === undefined ? 1 : o.seed);
    if (m.type === 'arrow' || m.type === 'line') {
      need(m, ['x1', 'y1', 'x2', 'y2']);
      if (Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 1) throw new Error(`mark of type ${m.type} starts and ends at the same point`);
      return { type: m.type, strokes: line(m, rng, xh, m.type === 'arrow') };
    }
    if ((m.type === 'tick' || m.type === 'cross') && !(Number(m.w) > 0 && Number(m.h) > 0)) {
      need(m, ['x', 'y']);
      m.w = m.h = defaultSquare(xh);
    }
    need(m, ['x', 'y', 'w', 'h']);
    if (!(m.w > 0 && m.h > 0)) throw new Error(`mark of type ${m.type} needs a width and height above 0`);
    const f = { circle, tick, cross, underline, strike, box }[m.type];
    return { type: m.type, strokes: f(m, rng, xh) };
  }

  /** The bounding box {minX, maxX, minY, maxY} of strokes. */
  function bounds(strokes) {
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
   * The {box, placed} item Sheet.writeInk and Notability.noteFromBoxes take. opts: {xh, page} (page counted from 0, as in
   * a box). The layout is cut down to the ink and sits at the box's corner with dx = dy = 0; K is points per layout pixel,
   * the same xh / 34 a written answer at that letter height has, so the pen is the same width.
   */
  function toPlaced(drawn, opts) {
    const xh = opts.xh > 0 ? opts.xh : DEFAULT_XH;
    const K = xh / ENGINE_XH;
    const b = bounds(drawn.strokes);
    const pad = 2;
    const ox = b.minX - pad;
    const oy = b.minY - pad;
    const strokes = drawn.strokes.map((s) => ({ pts: s.pts.map((p) => ({ x: (p.x - ox) / K, y: (p.y - oy) / K, w: p.w })), taperStart: s.taperStart, taperEnd: s.taperEnd }));
    const w = b.maxX - b.minX + 2 * pad;
    const h = b.maxY - b.minY + 2 * pad;
    const layout = { strokes, xh: ENGINE_XH, width: w / K, height: h / K, baselines: [], lineHeightPx: 2.5 * ENGINE_XH };
    return { box: { page: opts.page, x: ox, y: oy, w, h, text: '', kind: 'mark' }, placed: { layout, K, dx: 0, dy: 0, xhPt: xh } };
  }

  const api = { TYPES, DEFAULT_XH, draw, toPlaced, bounds, defaultSquare };
  root.HW = root.HW || {};
  root.HW.marks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
