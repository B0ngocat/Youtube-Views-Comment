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
          c += 2 * (unit.odd || 0); // looks unlike the writer's other examples of this letter
          if (unit.word.suspect) c += 1.5; // taken from a word the aligner was unsure about
          if (unit.wrong) c += 2; // looks more like a different letter than this one (probably cut in the wrong place)
          // A letter written on its own is clean, but it carries the little run-in stroke the writer
          // only makes when a letter stands alone, so keep it to the start of a word.
          if (unit.iso) c += j === 0 || n === 1 ? -0.5 : /[a-z]/.test(chars[j]) ? 1.5 : 0;
          if (unit.open) c += 2.5; // the writer closes this letter, this copy stays open (cut wrongly?)
          c += 1.5 * (unit.far || 0); // unlike the writer's own single-letter version of it
          c += 4 * Math.min(Math.max(0, (unit.dev || 0) - 0.25), 1.5); // much taller / deeper than this writer usually writes it
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

  const MAX_JOIN_TURN = 60; // degrees; a bridge that bends more than this becomes a pen lift instead

  /**
   * Join the end of stroke `aIn` to the start of `bIn` with a smooth bridge. Works on copies.
   * Returns {a, b, bridge} or null when the join would bend sharply (then the caller lifts the
   * pen, as a real writer would, instead of drawing a kink).
   */
  function bridgeJoin(aIn, bIn) {
    const a = aIn.slice();
    const b = bIn.slice();
    trimEnd(a, TRIM);
    trimStart(b, TRIM);
    // The bridge needs enough length for the pen to make its turn at a sensible radius.
    // If the two ends are too close for the direction change between them, trim further
    // back on both sides until they are not.
    let p0;
    let p1;
    let t0;
    let t1;
    for (let tries = 0; tries < 10; tries++) {
      p0 = a[a.length - 1];
      p1 = b[0];
      t0 = G.dirAt(a, a.length - 1, 3);
      t1 = G.dirAt(b, 0, 3);
      const d = G.dist(p0, p1);
      const c = d > 1e-6 ? { dx: (p1.x - p0.x) / d, dy: (p1.y - p0.y) / d } : t0;
      const turn = Math.max(angleBetween(t0, c), angleBetween(c, t1));
      if (d >= MIN_TURN_RADIUS * turn || tries === 9) break;
      trimEnd(a, 0.05);
      trimStart(b, 0.05);
    }
    const bridge = G.hermite(p0, t0, p1, t1, STEP);
    if (G.maxTurnDeg(a.slice(-2).concat(bridge, b.slice(0, 2))) > MAX_JOIN_TURN) return null;
    return { a, b, bridge };
  }

  function assemble(choices, liftGap, clearance, rng) {
    const out = [];
    const joins = []; // where letters were bridged (kept so tests can check the joins are smooth)
    const marks = [];
    let prev = null;
    for (const ch of choices) {
      const u = ch.unit;
      const sc = ch.scale;
      let conn = !!prev && prev.unit.exit.mid && u.entry.mid && prev.sc === 1 && sc === 1;
      const natural = !!prev && prev.sc === 1 && sc === 1 && prev.unit.wid === u.wid && u.idx === prev.unit.idx + 1;
      let tx;
      let bridged = null;
      if (!prev) tx = -u.box.minX * sc;
      else if (natural) tx = prev.tx;
      else {
        if (conn) {
          tx = prev.tx + prev.unit.exit.x - u.entry.x;
          bridged = bridgeJoin(prev.lastStroke.pts, u.strokes[0].pts.map((p) => ({ x: tx + p.x * sc, y: p.y * sc, w: p.w })));
          if (!bridged) conn = false; // no clean join between these two: lift the pen
        }
        if (!conn) {
          const base = prev.sc === 1 && sc === 1 ? A.inkBase(prev.unit, u) : null;
          const byBox = prev.tx + prev.unit.box.maxX * prev.sc + liftGap - u.box.minX * sc;
          if (clearance && base !== null) {
            // nearest ink of the two letters ends up `want` apart, which varies a little like the writer's does
            const want = Math.max(0.02, clearance.median + clearance.sd * 0.5 * G.gaussian(rng));
            tx = prev.tx + want - base;
          } else tx = byBox;
        }
      }

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
          const at = bridged.a.length - 1;
          stroke.pts = bridged.a.concat(bridged.bridge, bridged.b);
          joins.push({ stroke, from: at, to: at + bridged.bridge.length + 1 });
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
      if (s.pts.length >= 5) s.pts = G.smooth(s.pts, 1.6, ['w']);
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

  function deform(strokes, rng, m, wordLevel) {
    if (m <= 0) return;
    const nY = G.makeNoise(rng);
    const nS = G.makeNoise(rng);
    const nT = G.makeNoise(rng);
    // per-word offset and size are replaced by the writer's measured line rhythm when we have it
    const off = wordLevel === false ? 0 : (rng() * 2 - 1) * 0.05 * m;
    const gs = wordLevel === false ? 1 : 1 + G.gaussian(rng) * 0.025 * m;
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
    const strokes = assemble(choices, style.liftGap, style.clearance, rng);
    deform(strokes, rng, ctx.messiness, !ctx.rhythm);
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
      { xh: 34, width: 900, lineHeight: 3.1, wordSpacing: 1, messiness: 0.3, variation: 0.4, slantDelta: 0, seed: 1 },
      opts || {}
    );
    const rng = G.mulberry32(o.seed);
    // The writer's own line rhythm (word gaps, baseline / size / slant drift), when they have
    // written full lines. The Natural variation slider scales it: 30% (the default) is exactly as
    // measured, 0 is none, above 30% exaggerates.
    const R = style.rhythm && style.rhythm.learned ? style.rhythm : null;
    const k = R ? Math.min(3.5, Math.max(0, o.messiness / 0.3)) : 0;
    const ctx = { variation: o.variation, messiness: o.messiness, usage: new Map(), missing: new Set(), rhythm: !!R };
    const xh = o.xh;
    const margin = o.margin != null ? o.margin : xh * 1.2;
    const lineH = o.lineHeight * xh;
    const tanS = Math.tan(style.slant + (o.slantDelta * Math.PI) / 180);
    const spaceW = 0.6 * xh * o.wordSpacing;
    const firstBase = margin + 1.7 * xh;

    const strokesOut = [];
    const wordsOut = [];
    const baselines = [];
    let line = 0;
    let x = margin;
    const pickSlope = () => (R ? Math.tan(R.slopeSd * k * G.gaussian(rng)) : (rng() * 2 - 1) * 0.006 * o.messiness);
    let slope = pickSlope();
    let wordOff = 0;
    let sizeState = 0; // log scale of the current word, drifts like the writer's does
    baselines.push(firstBase);
    // AR(1): next = rho * previous + noise, so drift is smooth along the line instead of jumping
    const ar = (prev, rho, sd) => rho * prev + Math.sqrt(1 - rho * rho) * sd * G.gaussian(rng);

    const newLine = () => {
      line++;
      x = margin;
      slope = pickSlope();
      wordOff = 0;
      sizeState = 0;
      baselines.push(firstBase + line * lineH);
    };

    const paragraphs = text.replace(/\r/g, '').split('\n');
    paragraphs.forEach((para, pi) => {
      if (pi > 0) newLine();
      const words = para.split(/[ \t]+/).filter(Boolean);
      for (const word of words) {
        const w = synthWord(style, word, rng, ctx);
        if (!w) continue;
        wordsOut.push({ text: word, choices: w.choices.map((c) => c.unit) }); // which examples were used (for inspection)
        // to pixels, with slant (and, from the writer's rhythm, this word's own size and slant)
        let sc = 1;
        let tanW = tanS;
        if (R) {
          sizeState = ar(sizeState, R.sizeRho, R.sizeSd * k);
          sc = Math.exp(sizeState);
          tanW = Math.tan(style.slant + (o.slantDelta * Math.PI) / 180 + R.slantSd * k * G.gaussian(rng));
        }
        const pxStrokes = w.strokes.map((s) => ({
          taperStart: s.taperStart,
          taperEnd: s.taperEnd,
          pts: s.pts.map((p) => ({ x: (p.x + p.y * tanW) * xh * sc, y: -p.y * xh * sc, w: p.w })),
        }));
        const b = bounds(pxStrokes);
        const wpx = b.maxX - b.minX;
        if (x > margin && x + wpx > o.width - margin) newLine();
        if (R) wordOff = ar(wordOff / xh, R.baseRho, R.baseSd * k) * xh;
        else wordOff = wordOff * 0.7 + (rng() * 2 - 1) * 0.035 * xh * o.messiness;
        const base = baselines[line] + slope * (x - margin) + wordOff;
        const dx = x - b.minX;
        for (const s of pxStrokes) {
          for (const p of s.pts) {
            p.x += dx;
            p.y += base;
          }
          strokesOut.push(s);
        }
        const gap = R ? Math.max(0.15, R.gapMean + R.gapSd * k * G.gaussian(rng)) * xh * o.wordSpacing : spaceW * (0.85 + 0.3 * rng());
        x += wpx + gap;
      }
    });

    const height = baselines[baselines.length - 1] + 1.5 * xh + margin * 0.5;
    return { width: o.width, height, strokes: strokesOut, words: wordsOut, missing: Array.from(ctx.missing), baselines, xh, lineHeightPx: lineH };
  }

  const api = { layout, synthWord, chooseUnits, assemble, deform };
  root.HW = root.HW || {};
  root.HW.synth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
