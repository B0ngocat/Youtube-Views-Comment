/*
 * Text to pen strokes. A small beam search picks recorded letters for each word (letters that
 * were written side by side get a bonus, repeats a penalty), joins are bridged with a smooth
 * curve, and a slow deformation adds drift. Letters are only moved, never rotated or scaled
 * one by one, so the pen path stays intact.
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? require('./geometry') : root.HW.geometry;
  const S = typeof require !== 'undefined' ? require('./style') : root.HW.style;
  const A = typeof require !== 'undefined' ? require('./align') : root.HW.align;

  const STEP = A.STEP;
  const TRIM = 0.12; // how much of each half-ligature is replaced by the bridge
  const BEAM = 6;

  // ---- unit selection -------------------------------------------------------------------

  const MIN_TURN_RADIUS = 0.06; // x-heights; tightest curve a bridge may make

  function angleBetween(a, b) {
    const dot = Math.max(-1, Math.min(1, a.dx * b.dx + a.dy * b.dy));
    return Math.acos(dot);
  }

  function angleDiff(a, b) {
    let d = Math.abs(Math.atan2(a.dy, a.dx) - Math.atan2(b.dy, b.dx));
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  function transCost(prev, cand) {
    if (!prev) return 0;
    const p = prev.unit;
    const u = cand.unit;
    if (prev.scale === 1 && cand.scale === 1 && p.wid === u.wid && u.idx === p.idx + 1) return -0.5;
    const pm = p.exit.mid && prev.scale === 1;
    const um = u.entry.mid && cand.scale === 1;
    if (pm && um) {
      const dy = Math.abs(p.exit.y - u.entry.y);
      // an end that is heading *down* at the join can't be bridged without a hairpin
      const down = Math.max(0, -p.exit.dy - 0.15) + Math.max(0, -u.entry.dy - 0.15);
      return 1.5 * dy + 0.8 * angleDiff(p.exit, u.entry) + 4 * down + (dy > 0.6 ? 3 : 0);
    }
    if (pm || um) return 0.7;
    return 0.05;
  }

  function pickSubset(list, k, rng) {
    if (list.length <= k) return list;
    const a = list.slice();
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rng() * (a.length - i));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a.slice(0, k);
  }

  /** chars: array of single characters (already normalised). Returns [{unit, scale}] */
  function chooseUnits(style, chars, rng, ctx) {
    const variation = ctx.variation;
    let beams = [{ cost: 0, seq: [] }];
    const n = chars.length;
    for (let j = 0; j < n; j++) {
      const fb = S.fallbackFor(style, chars[j]);
      if (!fb) {
        ctx.missing.add(chars[j]);
        continue;
      }
      const base = pickSubset(style.byChar.get(fb.ch), 24, rng);
      const next = [];
      for (const h of beams) {
        const prev = h.seq.length ? h.seq[h.seq.length - 1] : null;
        let list = base;
        if (prev && prev.scale === 1 && fb.scale === 1) {
          const nat = prev.unit.word.units[prev.unit.idx + 1];
          if (nat && nat.ch === fb.ch && !list.includes(nat)) list = list.concat([nat]);
        }
        for (const unit of list) {
          const cand = { unit, scale: fb.scale };
          let c = h.cost + transCost(prev, cand);
          if (!prev && unit.entry.mid) c += 2;
          if (j === n - 1 && unit.exit.mid) c += 0.6;
          c += 2.5 * Math.min(unit.hc || 0, 3); // implausible shape for this character (mis-cut)
          let rep = 0;
          for (const s of h.seq) if (s.unit === unit) rep++;
          c += variation * 1.2 * rep + variation * 0.12 * (ctx.usage.get(unit.id) || 0);
          c += rng() * 0.35 * variation;
          next.push({ cost: c, seq: h.seq.concat([cand]) });
        }
      }
      next.sort((a, b) => a.cost - b.cost);
      beams = next.slice(0, BEAM);
    }
    const best = beams[0].seq;
    for (const s of best) ctx.usage.set(s.unit.id, (ctx.usage.get(s.unit.id) || 0) + 1);
    return best;
  }

  // ---- assembly -------------------------------------------------------------------------

  function trimEnd(pts, len) {
    let acc = 0;
    while (pts.length > 4) {
      const d = G.dist(pts[pts.length - 1], pts[pts.length - 2]);
      if (acc + d > len) break;
      acc += d;
      pts.pop();
    }
  }

  function trimStart(pts, len) {
    let acc = 0;
    let cut = 0;
    while (pts.length - cut > 4) {
      const d = G.dist(pts[cut], pts[cut + 1]);
      if (acc + d > len) break;
      acc += d;
      cut++;
    }
    if (cut) pts.splice(0, cut);
  }

  function assemble(choices, liftGap) {
    const out = [];
    const joins = []; // where letters were bridged (kept so tests can check the joins are smooth)
    const marks = [];
    let prev = null;
    for (const ch of choices) {
      const u = ch.unit;
      const sc = ch.scale;
      const conn = !!prev && prev.unit.exit.mid && u.entry.mid && prev.sc === 1 && sc === 1;
      const natural = !!prev && prev.sc === 1 && sc === 1 && prev.unit.wid === u.wid && u.idx === prev.unit.idx + 1;
      let tx;
      if (!prev) tx = -u.box.minX * sc;
      else if (natural) tx = prev.tx;
      else if (conn) tx = prev.tx + prev.unit.exit.x - u.entry.x;
      else tx = prev.tx + prev.unit.box.maxX * prev.sc + liftGap - u.box.minX * sc;

      const T = (p) => ({ x: tx + p.x * sc, y: p.y * sc, w: p.w });
      let lastStroke = null;
      for (let pi = 0; pi < u.strokes.length; pi++) {
        const piece = u.strokes[pi];
        const pts = piece.pts.map(T);
        let stroke = null;
        if (pi === 0 && natural && piece.entryMid) {
          stroke = prev.lastStroke;
          for (let k = 1; k < pts.length; k++) stroke.pts.push(pts[k]);
        } else if (pi === 0 && conn) {
          stroke = prev.lastStroke;
          trimEnd(stroke.pts, TRIM);
          trimStart(pts, TRIM);
          // The bridge needs enough length for the pen to make its turn at a sensible radius.
          // If the two ends are too close for the direction change between them, trim further
          // back on both sides until they are not.
          let a;
          let b;
          let t0;
          let t1;
          for (let tries = 0; tries < 10; tries++) {
            a = stroke.pts[stroke.pts.length - 1];
            b = pts[0];
            t0 = G.dirAt(stroke.pts, stroke.pts.length - 1, 3);
            t1 = G.dirAt(pts, 0, 3);
            const d = G.dist(a, b);
            const c = d > 1e-6 ? { dx: (b.x - a.x) / d, dy: (b.y - a.y) / d } : t0;
            const turn = Math.max(angleBetween(t0, c), angleBetween(c, t1));
            if (d >= MIN_TURN_RADIUS * turn || tries === 9) break;
            trimEnd(stroke.pts, 0.05);
            trimStart(pts, 0.05);
          }
          const bridge = G.hermite(a, t0, b, t1, STEP);
          const at = stroke.pts.length - 1;
          for (const q of bridge) stroke.pts.push(q);
          for (const q of pts) stroke.pts.push(q);
          joins.push({ stroke, from: at, to: at + bridge.length + 1 });
        } else {
          stroke = { pts, taperStart: 0, taperEnd: 0 };
          if (pi === 0) {
            if (piece.entryMid) {
              trimStart(stroke.pts, TRIM);
              stroke.taperStart = 0.18;
            }
            if (prev && prev.unit.exit.mid && prev.lastStroke.taperEnd === 0) {
              trimEnd(prev.lastStroke.pts, TRIM);
              prev.lastStroke.taperEnd = 0.18;
            }
          }
          out.push(stroke);
        }
        lastStroke = stroke;
      }
      for (const m of u.marks) marks.push({ pts: m.pts.map(T), taperStart: 0, taperEnd: 0, delayed: true });
      prev = { unit: u, sc, tx, lastStroke };
    }
    // a dangling connected tail at the very end of the word
    if (prev && prev.unit.exit.mid) {
      trimEnd(prev.lastStroke.pts, TRIM);
      prev.lastStroke.taperEnd = 0.18;
    }
    const all = out.concat(marks);
    for (const s of all) {
      if (s.pts.length >= 5) s.pts = G.smooth(s.pts, 1.0, ['w']);
    }
    // safety net: extra smoothing that fades in only around each bridge
    const strokeJoins = new Map();
    for (const j of joins) {
      if (!strokeJoins.has(j.stroke)) strokeJoins.set(j.stroke, []);
      strokeJoins.get(j.stroke).push(j);
    }
    for (const [stroke, list] of strokeJoins) {
      const n = stroke.pts.length;
      if (n < 8) continue;
      const wide = G.smooth(stroke.pts, 3);
      const w = new Float64Array(n);
      const HALF = 7;
      for (const j of list) {
        for (let i = Math.max(0, j.from - HALF); i <= Math.min(n - 1, j.to + HALF); i++) {
          const d = i < j.from ? j.from - i : i > j.to ? i - j.to : 0;
          const v = 0.5 + 0.5 * Math.cos((Math.PI * d) / (HALF + 1));
          if (v > w[i]) w[i] = v;
        }
      }
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        stroke.pts[i].x += (wide[i].x - stroke.pts[i].x) * w[i];
        stroke.pts[i].y += (wide[i].y - stroke.pts[i].y) * w[i];
      }
    }
    all.joins = joins;
    return all;
  }

  // ---- natural imperfection -------------------------------------------------------------

  function deform(strokes, rng, m) {
    if (m <= 0) return;
    const nY = G.makeNoise(rng);
    const nS = G.makeNoise(rng);
    const nT = G.makeNoise(rng);
    const off = (rng() * 2 - 1) * 0.05 * m;
    const gs = 1 + G.gaussian(rng) * 0.025 * m;
    for (const s of strokes) {
      for (const p of s.pts) {
        const u = p.x;
        const size = gs * (1 + 0.035 * m * nS(u / 2.2));
        const dy = 0.05 * m * nY(u / 1.4) + off;
        const sh = 0.06 * m * nT(u / 3);
        const x = p.x;
        const y = p.y;
        p.x = x * gs + y * sh;
        p.y = y * size + dy;
      }
    }
  }

  function bounds(strokes) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const s of strokes) for (const p of s.pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
    return { minX, maxX };
  }

  function expandChars(word) {
    const out = [];
    for (const c of Array.from(word)) for (const d of Array.from(S.normalizeChar(c))) out.push(d);
    return out;
  }

  /** One word -> strokes in engine units (x from 0, baseline 0, x-height 1, no global slant). */
  function synthWord(style, word, rng, ctx) {
    const chars = expandChars(word).filter((c) => !/\s/.test(c));
    if (!chars.length) return null;
    const choices = chooseUnits(style, chars, rng, ctx);
    if (!choices.length) return null;
    const strokes = assemble(choices, style.liftGap);
    deform(strokes, rng, ctx.messiness);
    const b = bounds(strokes);
    for (const s of strokes) for (const p of s.pts) p.x -= b.minX;
    return { strokes, width: b.maxX - b.minX, joins: strokes.joins, choices };
  }

  // ---- page layout ----------------------------------------------------------------------

  /**
   * opts: {xh (px), width (px), lineHeight (x-heights), wordSpacing, messiness 0..1,
   *        variation 0..1, slantDelta (deg), seed, margin (px)}
   * returns {width, height, strokes:[{pts:[{x,y,w}], taperStart, taperEnd}], missing:[...], baselines:[...]}
   */
  function layout(style, text, opts) {
    const o = Object.assign(
      { xh: 34, width: 900, lineHeight: 2.6, wordSpacing: 1, messiness: 0.5, variation: 0.6, slantDelta: 0, seed: 1 },
      opts || {}
    );
    const rng = G.mulberry32(o.seed);
    const ctx = { variation: o.variation, messiness: o.messiness, usage: new Map(), missing: new Set() };
    const xh = o.xh;
    const margin = o.margin != null ? o.margin : xh * 1.2;
    const lineH = o.lineHeight * xh;
    const tanS = Math.tan(style.slant + (o.slantDelta * Math.PI) / 180);
    const spaceW = 0.6 * xh * o.wordSpacing;
    const firstBase = margin + 1.7 * xh;

    const strokesOut = [];
    const baselines = [];
    let line = 0;
    let x = margin;
    let slope = (rng() * 2 - 1) * 0.006 * o.messiness;
    let wordOff = 0;
    baselines.push(firstBase);

    const newLine = () => {
      line++;
      x = margin;
      slope = (rng() * 2 - 1) * 0.006 * o.messiness;
      baselines.push(firstBase + line * lineH);
    };

    const paragraphs = text.replace(/\r/g, '').split('\n');
    paragraphs.forEach((para, pi) => {
      if (pi > 0) newLine();
      const words = para.split(/[ \t]+/).filter(Boolean);
      for (const word of words) {
        const w = synthWord(style, word, rng, ctx);
        if (!w) continue;
        // to pixels, with slant
        const pxStrokes = w.strokes.map((s) => ({
          taperStart: s.taperStart,
          taperEnd: s.taperEnd,
          pts: s.pts.map((p) => ({ x: (p.x + p.y * tanS) * xh, y: -p.y * xh, w: p.w })),
        }));
        const b = bounds(pxStrokes);
        const wpx = b.maxX - b.minX;
        if (x > margin && x + wpx > o.width - margin) newLine();
        wordOff = wordOff * 0.7 + (rng() * 2 - 1) * 0.035 * xh * o.messiness;
        const base = baselines[line] + slope * (x - margin) + wordOff;
        const dx = x - b.minX;
        for (const s of pxStrokes) {
          for (const p of s.pts) {
            p.x += dx;
            p.y += base;
          }
          strokesOut.push(s);
        }
        x += wpx + spaceW * (0.85 + 0.3 * rng());
      }
    });

    const height = baselines[baselines.length - 1] + 1.5 * xh + margin * 0.5;
    return { width: o.width, height, strokes: strokesOut, missing: Array.from(ctx.missing), baselines, xh, lineHeightPx: lineH };
  }

  const api = { layout, synthWord, chooseUnits, assemble, deform };
  root.HW = root.HW || {};
  root.HW.synth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
