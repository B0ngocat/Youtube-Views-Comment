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
  const Gl = typeof require !== 'undefined' ? require('./glyphs') : root.HW.glyphs;

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

  // ---- drawn stand-ins ---------------------------------------------------------------------------

  const penCache = new WeakMap();
  /** The writer's usual pen width, from the strokes they recorded. */
  function penWidth(style) {
    if (penCache.has(style)) return penCache.get(style);
    const ws = [];
    for (const list of style.byChar.values()) {
      for (const u of list.slice(0, 2)) for (const st of u.strokes) for (let i = 0; i < st.pts.length; i += 3) if (st.pts[i].w > 0) ws.push(st.pts[i].w);
      if (ws.length > 400) break;
    }
    ws.sort((a, b) => a - b);
    const w = ws.length ? ws[ws.length >> 1] : 1.2;
    penCache.set(style, w);
    return w;
  }

  const glyphCache = new WeakMap();
  /**
   * A unit (shaped like a letter cut out of a recorded word) for a character the writer has no sample of but that has a clean
   * drawing in glyphs.js, or null. Made once per style and character. It is a drawing, not their writing, so callers say so.
   */
  function glyphUnit(style, ch) {
    let cache = glyphCache.get(style);
    if (!cache) glyphCache.set(style, (cache = new Map()));
    if (cache.has(ch)) return cache.get(ch);
    const polys = Gl.polys(ch);
    let unit = null;
    if (polys) {
      const w = penWidth(style);
      const strokes = polys.map((poly) => {
        const pts = [];
        for (let i = 0; i < poly.length - 1; i++) {
          const a = poly[i];
          const b = poly[i + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.04));
          for (let k = 0; k < n; k++) pts.push({ x: a[0] + ((b[0] - a[0]) * k) / n, y: a[1] + ((b[1] - a[1]) * k) / n, w });
        }
        const last = poly[poly.length - 1];
        pts.push({ x: last[0], y: last[1], w });
        return { pts: pts.length >= 5 ? G.smooth(pts, 2, ['w']) : pts, taperStart: 0.12, taperEnd: 0.12, entryMid: false, exitMid: false };
      });
      const all = strokes.flatMap((s) => s.pts);
      const first = strokes[0].pts;
      const lastPts = strokes[strokes.length - 1].pts;
      const fd = G.dirAt(first, 0, 4);
      const ld = G.dirAt(lastPts, lastPts.length - 1, 4);
      unit = {
        ch,
        id: 'glyph:' + ch,
        glyph: true,
        strokes,
        marks: [],
        entry: { x: first[0].x, y: first[0].y, dx: fd.dx, dy: fd.dy, mid: false },
        exit: { x: lastPts[lastPts.length - 1].x, y: lastPts[lastPts.length - 1].y, dx: ld.dx, dy: ld.dy, mid: false },
        box: {
          minX: Math.min(...all.map((p) => p.x)),
          maxX: Math.max(...all.map((p) => p.x)),
          minY: Math.min(...all.map((p) => p.y)),
          maxY: Math.max(...all.map((p) => p.y)),
        },
        hc: 0,
        word: { suspect: false, units: [] },
        wid: 'glyph:' + ch,
        idx: 0,
      };
    }
    cache.set(ch, unit);
    return unit;
  }

  /** chars: array of single characters (already normalised). Returns [{unit, scale}] */
  /**
   * pins (optional): one unit id (or null) per character. A pinned character uses exactly that
   * example, which is how a page keeps every letter it had when only one letter is replaced.
   */
  function chooseUnits(style, chars, rng, ctx, pins) {
    const variation = ctx.variation;
    let beams = [{ cost: 0, seq: [] }];
    const n = chars.length;
    for (let j = 0; j < n; j++) {
      let fb = S.fallbackFor(style, chars[j]);
      if (!fb && ctx.glyphs) {
        const g = glyphUnit(style, chars[j]);
        if (g) {
          fb = { ch: chars[j], scale: 1, glyph: g };
          ctx.substituted.add(chars[j]);
        }
      }
      if (!fb) {
        ctx.missing.add(chars[j]);
        continue;
      }
      const pinned = pins && pins[j] && style.unitById ? style.unitById.get(pins[j]) : null;
      const usePin = !!pinned && pinned.ch === fb.ch && !pinned.skipped;
      const base = usePin ? [pinned] : fb.glyph ? [fb.glyph] : pickSubset(style.byChar.get(fb.ch), 24, rng);
      const next = [];
      for (const h of beams) {
        const prev = h.seq.length ? h.seq[h.seq.length - 1] : null;
        let list = base;
        if (!usePin && prev && prev.scale === 1 && fb.scale === 1) {
          const nat = prev.unit.word.units[prev.unit.idx + 1];
          if (nat && nat.ch === fb.ch && !nat.skipped && !list.includes(nat)) list = list.concat([nat]); // never one the writer crossed out
        }
        for (const unit of list) {
          const cand = { unit, scale: fb.scale, accent: fb.accent, flip: fb.flip, j };
          let c = h.cost + transCost(prev, cand);
          if (!prev && unit.entry.mid) c += 2;
          if (j === n - 1 && unit.exit.mid) c += 0.6;
          c += 2.5 * Math.min(unit.hc || 0, 3); // implausible shape for this character (mis-cut)
          c += 2 * (unit.odd || 0); // looks unlike the writer's other examples of this letter
          if (unit.word.suspect) c += 1.5; // taken from a word the aligner was unsure about
          if (unit.wrong) c += 2; // looks more like a different letter than this one (probably cut in the wrong place)
          if (unit.iso) {
            // Written on its own, so never mis-cut. Digits and symbols cut out of words are mis-cut far more often
            // than letters (a 9 comes out as a hook, a 1 picks up a stroke from its neighbour) and a single digit has
            // no run-in stroke to give it away, so the writer's own are strongly preferred. A lowercase letter carries
            // a run-in stroke the writer only makes when it stands alone, so it is kept to the start of a word.
            const neat = ctx.neat || 0; // 0..3: how much cleaner single letters are preferred over cut-out ones
            if (!/[A-Za-z]/.test(chars[j])) c -= 2.5;
            else if (j === 0 || n === 1) c -= 0.5 + 0.3 * neat;
            else if (/[a-z]/.test(chars[j])) c += 1.5 - neat;
          }
          if (unit.stray) c += 3; // carries a scrap of a neighbouring letter
          if (unit.open) c += 2.5; // the writer closes this letter, this copy stays open (cut wrongly?)
          c += 1.5 * (unit.far || 0); // unlike the writer's own single-letter version of it
          c += 4 * Math.min(Math.max(0, (unit.dev || 0) - 0.25), 1.5); // much taller / deeper than this writer usually writes it
          let rep = 0;
          for (const s of h.seq) if (s.unit === unit) rep++;
          c += variation * 1.2 * rep + variation * 0.12 * (ctx.usage.get(unit.id) || 0);
          // Letters have plenty of near-equal examples, so a little noise is enough to give another take. A digit or symbol has a few
          // clean examples and a strong preference for them (above): a nudge of 0.14 never made another seed pick another one, so for those
          // the noise is wider, +-1.0 at the default variation. That is still less than half that preference (2.5, less the repeat penalty),
          // so another seed swaps between the good examples but never puts a digit cut out of a word in front of a clean one.
          c += /[A-Za-z]/.test(chars[j]) ? rng() * 0.35 * variation : (rng() * 2 - 1) * 2.5 * variation;
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

  /** Do the segments a-b and c-d cross each other? (proper crossings only) */
  function segmentsCross(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = side(a, b, c);
    const d2 = side(a, b, d);
    const d3 = side(c, d, a);
    const d4 = side(c, d, b);
    return d1 * d2 < 0 && d3 * d4 < 0;
  }

  /**
   * A y (g, j, q) written in one go ends with the pen climbing back up across its own stem, towards the next letter. That
   * straight climb is part of the cut-out unit, so where nothing is joined after the letter (the end of a word, or a pen lift)
   * it hangs in the air as a diagonal line through the letter. Cut it off: walk back from the end while the stretch to the end
   * is still nearly straight (path <= 1.07 x chord), and if that run is at least 0.55 long, climbs at least 0.2 (y is up) and
   * crosses the letter's own earlier ink, truncate the stroke where the run starts. Returns whether it cut.
   */
  function cutReturnStroke(pts, ch) {
    const n = pts.length;
    if (!/^[gjqy]$/.test(ch) || n < 14) return false;
    const end = pts[n - 1];
    let path = 0;
    let start = -1;
    for (let i = n - 2; i >= 0; i--) {
      path += G.dist(pts[i], pts[i + 1]);
      const chord = G.dist(pts[i], end);
      if (chord < 0.2) continue; // too close to the end to say whether it is straight
      if (path > 1.07 * chord) break;
      start = i;
    }
    if (start < 0 || G.dist(pts[start], end) < 0.55 || end.y - pts[start].y < 0.2) return false;
    for (let j = 0; j + 1 <= start - 3; j++) {
      if (segmentsCross(pts[start], end, pts[j], pts[j + 1])) {
        pts.length = start + 1;
        return true;
      }
    }
    return false;
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

  // ---- accents and upside-down marks ----------------------------------------------------

  // The strokes of an accent, in units of the x-height, centred on x = 0 and sitting on y = 0.
  const ACCENT_SHAPES = {
    acute: [[[-0.09, 0], [0.02, 0.13], [0.13, 0.3]]],
    grave: [[[0.09, 0], [-0.02, 0.13], [-0.13, 0.3]]],
    circ: [[[-0.14, 0], [0, 0.26], [0.14, 0]]],
    tilde: [], // drawn by tildePoly: never the same twice
    diaer: [[[-0.14, 0.2], [-0.125, 0.1]], [[0.12, 0.2], [0.135, 0.1]]],
  };

  /**
   * The strokes of an accent drawn over a letter: kind, where its middle is (cx), where it sits (y0), how big (k) and the
   * pen width of the letter under it. A little different every time, like a hand's.
   */
  /** One smooth wave, a single stroke: its length, height, where the wave starts and which hump is bigger are all different every time. */
  function tildePoly(rng) {
    const len = 0.42 + rng() * 0.22;
    const amp = 0.065 + rng() * 0.065;
    const phase = (rng() - 0.5) * 0.9;
    const skew = (rng() - 0.5) * 0.7;
    const n = 16;
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      return [(t - 0.5) * len, 0.15 + amp * (1 + skew * (t - 0.5) * 2) * Math.sin(2 * Math.PI * t + phase)];
    });
  }

  function accentStrokes(kind, cx, y0, k, w, rng) {
    const dx = (rng() - 0.5) * 0.06;
    const dy = (rng() - 0.5) * 0.05;
    const tilt = (rng() - 0.5) * 0.25;
    const rot = (rng() - 0.5) * 0.4; // turned a little, either way
    const len = 1 + (rng() - 0.5) * 0.3; // and longer or shorter
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    return (kind === 'tilde' ? [tildePoly(rng)] : ACCENT_SHAPES[kind] || []).map((poly) => {
      const pts = [];
      const at = (p) => {
        const px = p[0] * cr - (p[1] - 0.15) * sr;
        const py = (p[1] - 0.15) * cr + p[0] * sr + 0.15;
        return { x: cx + dx + (px * len + tilt * py) * k, y: y0 + dy + py * len * k, w };
      };
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        const n = Math.max(1, Math.ceil((Math.hypot(b[0] - a[0], b[1] - a[1]) * k) / 0.04));
        for (let j = 0; j < n; j++) pts.push(at([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]));
      }
      pts.push(at(poly[poly.length - 1]));
      return { pts, taperStart: 0.12, taperEnd: 0.12, delayed: true };
    });
  }

  /** A stroke that is only a dot: small, and above the x-height. */
  function isDot(piece) {
    let lo = Infinity;
    let hi = -Infinity;
    let l = Infinity;
    let r = -Infinity;
    for (const p of piece.pts) {
      lo = Math.min(lo, p.y);
      hi = Math.max(hi, p.y);
      l = Math.min(l, p.x);
      r = Math.max(r, p.x);
    }
    return hi - lo < 0.3 && r - l < 0.3 && lo > 0.9;
  }

  // a copy of a unit turned half way round about the middle of its box (an inverted ? or !), made once per unit
  const turned = new WeakMap();
  function turnedUnit(u) {
    let t = turned.get(u);
    if (t) return t;
    const cx = (u.box.minX + u.box.maxX) / 2;
    const cy = (u.box.minY + u.box.maxY) / 2;
    const turn = (p) => ({ ...p, x: 2 * cx - p.x, y: 2 * cy - p.y });
    const strokes = u.strokes.map((st) => ({ ...st, pts: st.pts.map(turn), entryMid: false, exitMid: false }));
    const first = strokes[0].pts[0];
    const lastPts = strokes[strokes.length - 1].pts;
    const last = lastPts[lastPts.length - 1];
    t = {
      ...u,
      _prof: undefined, // the spacing profile is of the letter the right way up
      strokes,
      marks: u.marks.map((m) => ({ ...m, pts: m.pts.map(turn) })),
      entry: { x: first.x, y: first.y, dx: -u.entry.dx, dy: -u.entry.dy, mid: false },
      exit: { x: last.x, y: last.y, dx: -u.exit.dx, dy: -u.exit.dy, mid: false },
      turned: true,
    };
    turned.set(u, t);
    return t;
  }

  /**
   * A letter the writer has only a few examples of (a capital X, the E and L that open a line) comes out the same every time, whatever the
   * seed. A copy a little turned, stretched and sheared makes each use its own. Never the original (units are cached).
   */
  function jitterUnit(u, rng) {
    const rot = (rng() - 0.5) * 0.22;
    const sx = 1 + (rng() - 0.5) * 0.12;
    const sy = 1 + (rng() - 0.5) * 0.1;
    const sh = (rng() - 0.5) * 0.12;
    const cx = (u.box.minX + u.box.maxX) / 2;
    const cy = (u.box.minY + u.box.maxY) / 2;
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const map = (p) => {
      const x = (p.x - cx) * sx;
      const y = (p.y - cy) * sy;
      return { ...p, x: cx + x * c - y * sn + sh * y, y: cy + y * c + x * sn };
    };
    const dir = (e) => {
      const m = map({ x: e.x, y: e.y });
      const dx = e.dx * c - e.dy * sn;
      const dy = e.dy * c + e.dx * sn;
      return { ...e, x: m.x, y: m.y, dx, dy };
    };
    const strokes = u.strokes.map((st) => ({ ...st, pts: st.pts.map(map) }));
    const marks = u.marks.map((m) => ({ ...m, pts: m.pts.map(map) }));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const piece of strokes.concat(marks)) {
      for (const p of piece.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { ...u, _prof: undefined, strokes, marks, entry: dir(u.entry), exit: dir(u.exit), box: { minX, maxX, minY, maxY }, jittered: true };
  }

  function assemble(choices, liftGap, clearance, rng, gaps) {
    const out = [];
    const joins = []; // where letters were bridged (kept so tests can check the joins are smooth)
    const marks = [];
    let prev = null;
    const spans = []; // where each letter's ink starts and ends, along the word
    for (const ch of choices) {
      const u = ch.thin && !ch.flip && !ch.accent ? jitterUnit(ch.unit, rng) : ch.flip ? turnedUnit(ch.unit) : ch.unit;
      const sc = ch.scale;
      let conn = !!prev && prev.unit.exit.mid && u.entry.mid && prev.sc === 1 && sc === 1;
      // a little up and down from letter to letter (opts.bounce); a letter that carries on a recorded one keeps its lift
      const ly = !gaps || !gaps.bounce ? 0 : prev && prev.sc === 1 && sc === 1 && !u.turned && !prev.unit.turned && !u.jittered && !prev.unit.jittered && prev.unit.wid === u.wid && u.idx === prev.unit.idx + 1 ? prev.ly : (gaps.brng() * 2 - 1) * 0.03 * gaps.bounce;
      const natural = !!prev && prev.sc === 1 && sc === 1 && !u.turned && !prev.unit.turned && !u.jittered && !prev.unit.jittered && prev.unit.wid === u.wid && u.idx === prev.unit.idx + 1;
      let tx;
      let bridged = null;
      if (!prev) tx = -u.box.minX * sc;
      else if (natural) tx = prev.tx;
      else {
        if (conn) {
          tx = prev.tx + prev.unit.exit.x - u.entry.x;
          bridged = bridgeJoin(prev.lastStroke.pts, u.strokes[0].pts.map((p) => ({ x: tx + p.x * sc, y: p.y * sc + ly, w: p.w })));
          if (!bridged) conn = false; // no clean join between these two: lift the pen
        }
        if (!conn) {
          const base = prev.sc === 1 && sc === 1 ? A.inkBase(prev.unit, u) : null;
          const byBox = prev.tx + prev.unit.box.maxX * prev.sc + liftGap - u.box.minX * sc;
          const dotPair = (prev.unit.ch === '.' && /[0-9]/.test(u.ch)) || (u.ch === '.' && /[0-9]/.test(prev.unit.ch));
          const digitPair = /[0-9]/.test(prev.unit.ch) && /[0-9]/.test(u.ch);
          // digits and decimal points keep the distance the writer leaves in their numbers, when they have written enough of them
          const clear = (digitPair && gaps && gaps.digit) || (dotPair && gaps && gaps.dot) || clearance;
          if (clear && base !== null) {
            // nearest ink of the two letters ends up `want` apart, which varies a little like the writer's does
            let want = Math.max(0.02, clear.median + clear.sd * 0.5 * G.gaussian(rng));
            // a decimal point squeezed against its digits turns 71.45 into 7145, and digits that touch read as one
            if (dotPair) want = Math.max(want, 0.2);
            if (digitPair) want = Math.max(want, 0.15);
            tx = prev.tx + want - base;
            // a decimal point is tiny: whatever the nearest ink says, its digit neighbours keep a small gap from its own box
            if (dotPair) {
              const gap = tx + u.box.minX * sc - (prev.tx + prev.unit.box.maxX * prev.sc);
              if (gap < 0.12) tx += 0.12 - gap;
            }
          } else tx = byBox;
        }
      }

      const T = (p) => ({ x: tx + p.x * sc, y: p.y * sc + ly, w: p.w });
      let lastStroke = null;
      for (let pi = 0; pi < u.strokes.length; pi++) {
        const piece = u.strokes[pi];
        if (pi > 0 && ch.accent && u.ch === 'i' && isDot(piece)) continue; // the accent takes the dot's place (an i written on its own has its dot as a stroke)
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
            if (prev && cutReturnStroke(prev.lastStroke.pts, prev.unit.ch)) prev.lastStroke.taperEnd = 0.18; // the climb back over a y's stem hangs in the air once nothing is joined after it
          }
          out.push(stroke);
        }
        lastStroke = stroke;
      }
      // an i that carries an accent has no dot: the accent takes its place
      if (!(ch.accent && u.ch === 'i')) for (const m of u.marks) marks.push({ pts: m.pts.map(T), taperStart: 0, taperEnd: 0, delayed: true });
      if (ch.accent) {
        const mid = tx + ((u.box.minX + u.box.maxX) / 2) * sc;
        const w = u.strokes[0].pts[u.strokes[0].pts.length >> 1].w;
        for (const m of accentStrokes(ch.accent, mid, u.box.maxY * sc + (u.ch === 'i' ? 0.2 : 0.14), 1 + (sc - 1) * 0.5, w, rng)) marks.push(m);
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const piece of u.strokes.concat(u.marks)) {
        for (const p of piece.pts) {
          const x = tx + p.x * sc;
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      }
      spans.push([lo, hi]);
      prev = { unit: u, sc, tx, lastStroke, ly };
    }
    // a dangling connected tail at the very end of the word
    if (prev && prev.unit.exit.mid) {
      trimEnd(prev.lastStroke.pts, TRIM);
      prev.lastStroke.taperEnd = 0.18;
    }
    if (prev && cutReturnStroke(prev.lastStroke.pts, prev.unit.ch)) prev.lastStroke.taperEnd = 0.18;
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
    all.spans = spans;
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
    for (const c of Array.from(word.normalize('NFC'))) for (const d of Array.from(S.normalizeChar(c))) out.push(d); // n + a combining tilde is the same as one n with a tilde
    return out;
  }

  const codeOf = (ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

  /**
   * Before writing anything: which characters of `text` can the writer's handwriting not produce? Returns
   *   missing:     [{ch, code, words, standIn, speck}]  nothing can draw these (or, without opts.fallback, only a drawing could:
   *                                              standIn is true then, so the caller can offer it; speck: the writer did write
   *                                              one, too small to read, and it was left out)
   *   substituted: [{ch, code, words}]           drawn from glyphs.js because opts.fallback is on
   *   composed:    [ch]                          drawn from the writer's own letter and a mark (an accent, or a turned ? or !)
   * words are the words of the text each character is in, as typed (up to 6).
   */
  function checkText(style, text, opts) {
    const fallback = !!(opts && opts.fallback);
    const missing = new Map();
    const substituted = new Map();
    const composed = new Set();
    const note = (map, ch, word, standIn) => {
      if (!map.has(ch)) map.set(ch, { ch, code: codeOf(ch), words: [], standIn, speck: !!(style.specks && style.specks.includes(ch)) });
      const e = map.get(ch);
      if (!e.words.includes(word) && e.words.length < 6) e.words.push(word);
    };
    for (const word of String(text).normalize('NFC').split(/\s+/).filter(Boolean)) {
      for (const typed of Array.from(word)) {
        for (const c of Array.from(S.normalizeChar(typed))) {
          const fb = S.fallbackFor(style, c);
          if (fb) {
            if (fb.accent || fb.flip) composed.add(typed);
            continue;
          }
          const drawable = Gl.has(c);
          note(drawable && fallback ? substituted : missing, typed, word, drawable);
        }
      }
    }
    return { missing: Array.from(missing.values()), substituted: Array.from(substituted.values()), composed: Array.from(composed) };
  }

  /**
   * If the writer wrote this very word, pins for its letters so it is written back from their real strokes (the
   * letters of a recorded word fit each other, and none of them can have been cut wrongly out of a *different*
   * word). A word is pasted less and less willingly the more it has already been used on the page, and the
   * least-used recorded copy goes first, so a page does not repeat itself. Returns null to write the word fresh.
   */
  function wholeWordPins(style, chars, rng, ctx) {
    const reuse = ctx.wordReuse || 0;
    if (!reuse || !style.wholeWords) return null;
    const core = chars.join('').replace(/[.,!?;:]+$/, '');
    const found = style.wholeWords.get(core);
    if (!found || !found.length) return null;
    if (!ctx.wordUse) ctx.wordUse = new Map();
    let best = null;
    for (const w of found) {
      const used = ctx.wordUse.get(w) || 0;
      if (!best || used < best.used || (used === best.used && rng() < 0.5)) best = { w, used };
    }
    if (rng() >= reuse * Math.pow(0.55, best.used)) return null;
    ctx.wordUse.set(best.w, best.used + 1);
    return chars.map((_, i) => (i < core.length ? best.w.units[i].id : null));
  }

  /**
   * One word -> strokes in engine units (x from 0, baseline 0, x-height 1, no global slant).
   * A word takes one number from `rng` and makes its own streams from it, one for picking letters and
   * one for everything after (spacing, wobble), so what happens to one word cannot change another.
   * pins: see chooseUnits.
   * take (redo): 0 is the plain word. Another number mixes itself into this word's seed, so it gets streams of its own (other
   * examples, other spacing) and nothing else on the page notices: the number taken from `rng` is the same either way.
   * The result's `pins` are the examples it used, one id (or null) per character, ready to be given back as pins.
   */
  function synthWord(style, word, rng, ctx, pins, take) {
    const chars = expandChars(word).filter((c) => !/\s/.test(c));
    let seed = Math.floor(rng() * 4294967296) >>> 0;
    if (take) seed = takeSeed(seed, take);
    if (!chars.length) return null;
    const crng = G.mulberry32(seed);
    // a word the writer wrote is written back as they wrote it, unless the page has asked for specific letters
    const use = pins || wholeWordPins(style, chars, crng, ctx);
    const choices = chooseUnits(style, chars, crng, ctx, use);
    if (!choices.length) return null;
    // a letter with only a few examples gets a little turn and stretch each time it is used
    for (const c of choices) if (!c.flip && !c.accent && (style.byChar.get(c.unit.ch) || []).length <= 4 && /[A-Za-z]/.test(c.unit.ch)) c.thin = true;
    const arng = G.mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const strokes = assemble(choices, style.liftGap, style.clearance, arng, { digit: style.digitClearance, dot: style.dotClearance, bounce: ctx.bounce, brng: ctx.bounce > 0 ? G.mulberry32((seed ^ 0x5bd1e995) >>> 0) : null });
    const spans = strokes.spans;
    deform(strokes, arng, ctx.messiness, !ctx.rhythm);
    const b = bounds(strokes);
    for (const s of strokes) for (const p of s.pts) p.x -= b.minX;
    const used = chars.map(() => null);
    for (const c of choices) if (c.j !== undefined) used[c.j] = c.unit.id;
    return { strokes, width: b.maxX - b.minX, joins: strokes.joins, choices, spans: spans.map(([lo, hi]) => [lo - b.minX, hi - b.minX]), pins: used };
  }

  /** A word's seed for take number `take` (1, 2, ...): a different seed for each, the same every time. */
  const takeSeed = (seed, take) => (Math.imul(seed ^ Math.imul(take, 0x27d4eb2f), 0x85ebca6b) + Math.imul(take, 0x9e3779b1)) >>> 0;

  // ---- inline boxes (mixed.js) -----------------------------------------------------------

  // mixed.js puts a marker for each inline box (a piece of math, laid out already) into the text: MARK_OPEN, the box's number, MARK_CLOSE.
  // Characters from the private use area, which nobody types.
  const MARK_OPEN = '\uE000';
  const MARK_CLOSE = '\uE001';
  const MARK_RE = /\uE000(\d+)\uE001/;

  const cloneStrokes = (strokes, dx) => strokes.map((s) => ({ taperStart: s.taperStart, taperEnd: s.taperEnd, pts: s.pts.map((p) => ({ x: p.x + dx, y: p.y, w: p.w })) }));

  /**
   * A "word" that holds inline boxes, with or without plain text stuck to them ("(", then a box, then ","), as one unbreakable
   * piece in engine units like synthWord's. It takes ONE number from `rng` however many parts it has and whatever is in them,
   * and gives each text part a stream of its own, so editing a box never changes the letters of any other word.
   * The boxes are never changed (they are copied). Returns what synthWord returns plus up and down (x-heights of the boxes).
   */
  function synthCompound(style, word, rng, ctx, boxes, pinsParts) {
    const seed = Math.floor(rng() * 4294967296) >>> 0;
    const parts = word.split(/(\uE000\d+\uE001)/).filter(Boolean);
    const strokes = [];
    const choices = [];
    const spans = [];
    let x = 0;
    let up = 0;
    let down = 0;
    let prev = null;
    const partPins = []; // per part: the examples a text part used (null for a box), to give back as pins
    parts.forEach((part, j) => {
      const m = MARK_RE.exec(part);
      let piece = null;
      let w = 0;
      let t = null;
      if (m) {
        const box = boxes[Number(m[1])];
        if (!box) return;
        piece = cloneStrokes(box.strokes, 0);
        w = box.w;
        up = Math.max(up, box.up);
        down = Math.max(down, box.down);
      } else {
        t = synthWord(style, part, G.mulberry32((seed + 7919 * (j + 1)) >>> 0), ctx, pinsParts ? pinsParts[j] : null);
        if (!t) return;
        partPins[j] = t.pins;
        piece = t.strokes;
        w = t.width;
      }
      // a mark of punctuation stays close to the box before it, anything else gets the gap of a letter pair
      if (prev) x += prev.math && !m && /^[.,;:!?)\]]/.test(part) ? 0.08 : 0.25;
      if (t) {
        for (const c of t.choices) choices.push(c);
        for (const sp of t.spans) spans.push([sp[0] + x, sp[1] + x]);
      }
      for (const s of piece) {
        for (const p of s.pts) p.x += x;
        strokes.push(s);
      }
      x += w;
      prev = { math: !!m };
    });
    if (!strokes.length) return null;
    return { strokes, width: x, joins: [], choices, spans, up, down, pins: partPins };
  }

  // ---- redo one word ----------------------------------------------------------------------

  const stripPunct = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const sameIds = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const REDO_TRIES = 12; // other streams tried for each take that is asked for

  function redoError(msg) {
    const e = new Error(msg);
    e.redo = true;
    return e;
  }

  /**
   * Which word (or piece of math) does a redo request mean? `entries` are what the layout holds: {type: 'word', n, text} (n is the
   * layout's own word number) and {type: 'math', k, text} (k counts the pieces of math). The whole token is matched first, then the
   * TeX of a piece of math, then tokens with leading and trailing punctuation taken off ("9.81" finds "9.81," and "(9.81)").
   */
  function redoMatches(entries, req) {
    const words = entries.filter((e) => e.type === 'word');
    const maths = entries.filter((e) => e.type === 'math');
    const runs = entries.filter((e) => e.type === 'run');
    const hasMath = req.math !== undefined && req.math !== null;
    // a written run (digits with their point, a letter run) of a kind math answer, or of piece `math` of a kind mixed one
    if ((hasMath && req.word) || (!words.length && !maths.length)) {
      const pool = hasMath ? runs.filter((e) => e.box === req.math - 1) : runs;
      const w = String(req.word);
      const exact = pool.filter((e) => e.text === w);
      if (exact.length) return { list: exact };
      const core = stripPunct(w);
      return { list: core ? pool.filter((e) => stripPunct(e.text) === core) : [] };
    }
    if (hasMath) return { list: maths.slice(req.math - 1, req.math) };
    const w = String(req.word);
    const squash = (t) => t.replace(/\s+/g, ' ').trim();
    const exact = words.filter((e) => e.text === w);
    if (exact.length) return { list: exact };
    const tex = maths.filter((e) => squash(e.text) === squash(w) || '$' + squash(e.text) + '$' === squash(w));
    if (tex.length) return { list: tex };
    const core = stripPunct(w);
    return { list: core ? words.filter((e) => stripPunct(e.text) === core) : [] };
  }

  /** The distinct characters of a word the writer has at most one usable example of, for the report. */
  function fewExamples(style, text) {
    const few = [];
    for (const ch of new Set(expandChars(text))) {
      if (/\s/.test(ch)) continue;
      const fb = S.fallbackFor(style, ch);
      if (fb && (style.byChar.get(fb.ch) || []).length <= 1 && !few.includes(ch)) few.push(ch);
    }
    return few;
  }

  /**
   * Redraws chosen words of a layout and keeps every other word as it was. `run(patch)` lays the text out once with `patch` merged into
   * the options. The page picks each word's letters from state it shares with the words before it (which examples were used, which
   * recorded words were pasted), so simply drawing one word again would change all the words after it. Instead: lay the text out as it
   * is (that tells every word's examples), then lay it out again with every other word pinned to those examples (`pins`) and the chosen
   * word on a stream of its own (`retake`: the take number is mixed into that word's seed). Every other word keeps its examples;
   * positions may shift a little because the redone word has another width.
   *
   * requests: [{word, nth, take, math}]. Take 1 is a different drawing than the plain one, take 2 another, and so on: each take is the
   * next stream (at most REDO_TRIES of them for each) whose examples differ from the plain drawing and from the earlier takes. If there
   * is none (a digit with one clean example) the word stays as it was and the report says so. Throws (error.redo) when a word is not in
   * the text. Returns the layout, with `redo`: one report per request {word, math, text, nth, take, usedTake, matches, ok, changed, total, reason}.
   */
  function redoLayout(style, requests, run) {
    const first = run({});
    const entries = [];
    first.words.forEach((w, n) => {
      if (w && !w.compound) entries.push({ type: 'word', n, text: w.text });
    });
    (first.mathTex || []).forEach((tex, k) => entries.push({ type: 'math', k, text: tex }));
    // the written runs of every piece of math (kind math: one piece), in the order they were drawn: what redo of a run points at
    (first.runBoxes || []).forEach((runs, box) => runs.forEach((r, k) => entries.push({ type: 'run', box, k, text: r.text })));
    const nameOf = (req) => (req.math !== undefined && req.math !== null && !req.word ? 'math piece ' + req.math : '"' + req.word + '"');
    const slots = requests.map((req, i) => {
      const m = redoMatches(entries, req);
      if (!m.list.length || (req.nth && req.nth > m.list.length)) {
        const have = entries.filter((e) => e.type === 'word').map((e) => '"' + e.text + '"');
        const why = m.list.length ? `has ${m.list.length} match${m.list.length === 1 ? '' : 'es'}, so nth ${req.nth} does not exist` : 'is not in the text';
        const maths = (first.mathTex || []).map((t, k) => `${k + 1}: ${t}`);
        const runs = entries.filter((e) => e.type === 'run' && (req.math == null || e.box === req.math - 1)).map((e) => '"' + e.text + '"');
        throw redoError(`redo ${i + 1}: ${nameOf(req)} ${why}.${have.length || !runs.length ? ' The words are: ' + (have.join(', ') || '(none)') + '.' : ''}${maths.length ? ' The pieces of math are: ' + maths.join(' | ') + '.' : ''}${runs.length ? ' The written runs of the math are: ' + runs.join(', ') + '.' : ''}`);
      }
      return { req, entry: m.list[req.nth ? req.nth - 1 : 0], matches: m.list.length, nth: req.nth || null };
    });
    const seen = new Set();
    for (const sl of slots) {
      const key = sl.entry.type + (sl.entry.type === 'word' ? sl.entry.n : sl.entry.type === 'run' ? sl.entry.box + ':' + sl.entry.k : sl.entry.k);
      if (seen.has(key)) throw redoError(`redo: ${nameOf(sl.req)} is listed twice (it is the same place in the text). List each word once.`);
      seen.add(key);
    }
    // runs: per piece of math {pins: {run number: pins}, take: {run number: take}}; every run starts pinned to what the plain drawing used
    const runsOf = (lay) => (lay.runBoxes || []).map((rs) => { const pins = {}; rs.forEach((r, k) => { if (r.pins) pins[k] = r.pins; }); return { pins, take: {} }; });
    const state = { pins: first.words.map((w) => (w ? w.pins : null)), retake: {}, retakeMath: {}, runs: runsOf(first) };
    const idsOf = (lay, e) => (e.type === 'word' ? (lay.words[e.n] ? lay.words[e.n].ids : []) : e.type === 'run' ? ((lay.runBoxes[e.box] || [])[e.k] || { ids: [] }).ids : (lay.mathIds || [])[e.k] || []);
    let cur = first;
    const reports = [];
    for (const sl of slots) {
      const e = sl.entry;
      const take = sl.req.take || 1;
      const base = idsOf(first, e);
      const seenIds = [base];
      let accepted = null; // {s, lay, ids}
      const patchFor = (s) => {
        if (e.type === 'word') {
          const pins = state.pins.slice();
          pins[e.n] = null; // this word is drawn afresh, on its own stream
          return { pins, retake: Object.assign({}, state.retake, { [e.n]: s }), retakeMath: state.retakeMath, runs: state.runs };
        }
        const runs = state.runs.slice();
        if (e.type === 'run') {
          const b = runs[e.box];
          const pins = Object.assign({}, b.pins);
          delete pins[e.k]; // this run is drawn afresh, on its own stream
          runs[e.box] = { pins, take: Object.assign({}, b.take, { [e.k]: s }) };
          return { pins: state.pins, retake: state.retake, retakeMath: state.retakeMath, runs };
        }
        runs[e.k] = null; // a whole piece of math redone: none of its runs is pinned
        return { pins: state.pins, retake: state.retake, retakeMath: Object.assign({}, state.retakeMath, { [e.k]: s }), runs };
      };
      let got = 0;
      for (let s = 1; s <= REDO_TRIES * take && got < take; s++) {
        const lay = run(patchFor(s));
        const ids = idsOf(lay, e);
        if (seenIds.some((q) => sameIds(q, ids))) continue;
        seenIds.push(ids);
        got++;
        accepted = { s, lay, ids };
      }
      const report = { type: e.type, word: sl.req.word !== undefined ? sl.req.word : null, math: sl.req.math || null, text: e.type === 'math' ? '$' + e.text + '$' : e.text, box: e.box, nth: sl.nth, take, usedTake: got, matches: sl.matches, ok: got > 0, changed: 0, total: base.length, reason: '' };
      if (accepted) {
        report.changed = accepted.ids.reduce((n, id, i) => n + (id === base[i] ? 0 : 1), 0);
        if (e.type === 'word') {
          state.pins[e.n] = accepted.lay.words[e.n].pins;
          state.retake[e.n] = accepted.s;
        } else if (e.type === 'math') state.retakeMath[e.k] = accepted.s;
        if (e.type !== 'word') {
          // the piece of math now draws what the accepted layout drew: keep its other runs (and a run just redone) pinned to that
          const box = e.type === 'run' ? e.box : e.k;
          const was = state.runs[box] || { pins: {}, take: {} };
          const fresh = runsOf(accepted.lay)[box];
          state.runs[box] = { pins: fresh.pins, take: e.type === 'run' ? Object.assign({}, was.take, { [e.k]: accepted.s }) : {} };
        }
        cur = accepted.lay;
      } else {
        const few = e.type !== 'math' ? fewExamples(style, e.text) : [];
        report.reason = few.length ? `only one usable example of ${few.join(' and ')}` : `no other example fits (${REDO_TRIES} streams were tried and all gave the same examples)`;
      }
      reports.push(report);
    }
    cur.redo = reports;
    return cur;
  }

  // ---- page layout ----------------------------------------------------------------------

  /**
   * opts: {xh (px), width (px), lineHeight (x-heights), wordSpacing, messiness 0..1,
   *        neatness 0..1 (how much the writer's clean single letters are preferred over letters cut out of words),
   *        wordReuse 0..1 (how willingly a word the writer wrote is written back from their real strokes), variation 0..1, slantDelta (deg), seed, margin (px)}
   * returns {width, height, strokes:[{pts:[{x,y,w}], taperStart, taperEnd}], missing:[...], baselines:[...]}
   */
  function layout(style, text, opts) {
    const o = Object.assign(
      { xh: 34, width: 900, lineHeight: 3.1, wordSpacing: 1, messiness: 0.3, variation: 0.4, slantDelta: 0, seed: 1, wordReuse: 0.25, neatness: 0.5, bounce: 1.5 },
      opts || {}
    );
    if (o.bounce === undefined) o.bounce = 1.5; // a caller that passes the key with nothing in it gets the default
    if (o.redo && o.redo.length) return redoLayout(style, o.redo, (patch) => layout(style, text, Object.assign({}, o, patch, { redo: null })));
    const rng = G.mulberry32(o.seed);
    // The writer's own line rhythm (word gaps, baseline / size / slant drift), when they have
    // written full lines. The Natural variation slider scales it: 30% (the default) is exactly as
    // measured, 0 is none, above 30% exaggerates.
    const R = style.rhythm && style.rhythm.learned ? style.rhythm : null;
    const k = R ? Math.min(3.5, Math.max(0, o.messiness / 0.3)) : 0;
    const ctx = { variation: o.variation, messiness: o.messiness, usage: new Map(), missing: new Set(), substituted: new Set(), glyphs: !!o.fallbackGlyphs, rhythm: !!R, wordReuse: o.wordReuse, wordUse: new Map(), neat: 4 * o.neatness, bounce: o.bounce };
    const xh = o.xh;
    const margin = o.margin != null ? o.margin : xh * 1.2;
    const lineH = o.lineHeight * xh;
    const tanS = Math.tan(style.slant + (o.slantDelta * Math.PI) / 180);
    const spaceW = 0.6 * xh * o.wordSpacing;
    const firstBase = margin + 1.7 * xh;

    const strokesOut = [];
    const wordsOut = [];
    const baselines = [];
    // opts.inline (mixed.js): boxes of laid-out math. Which line each stroke and word is on, and how far each line's boxes reach up and down
    // (x-heights), so lines holding tall boxes can be given room once all words are placed
    const boxes = o.inline || null;
    const strokeLine = [];
    const wordLine = [];
    const reachUp = [];
    const reachDown = [];
    let line = 0;
    let x = margin;
    const pickSlope = () => (R ? Math.tan(R.slopeSd * k * G.gaussian(rng)) : (rng() * 2 - 1) * 0.006 * o.messiness);
    let slope = pickSlope();
    let wordOff = 0;
    let liftState = 0; // opts.bounce: how far this word sits above or below the line, in x-heights
    // its own random stream: how much bounce there is never changes which letters are chosen or how they are spaced
    const brng = o.bounce > 0 ? G.mulberry32((o.seed * 2654435761 + 12345) >>> 0) : null;
    const wavePhase = brng ? brng() * 6.283 : 0;
    let sizeState = 0; // log scale of the current word, drifts like the writer's does
    baselines.push(firstBase);
    // AR(1): next = rho * previous + noise, so drift is smooth along the line instead of jumping
    const ar = (prev, rho, sd) => rho * prev + Math.sqrt(1 - rho * rho) * sd * G.gaussian(rng);

    const newLine = () => {
      line++;
      x = margin;
      slope = pickSlope();
      wordOff = 0;
      liftState = 0;
      sizeState = 0;
      baselines.push(firstBase + line * lineH);
    };

    let wordNo = 0;
    const paragraphs = text.replace(/\r/g, '').split('\n');
    paragraphs.forEach((para, pi) => {
      if (pi > 0) newLine();
      const words = para.split(/[ \t]+/).filter(Boolean);
      for (const word of words) {
        const pinsForWord = o.pins ? o.pins[wordNo] : null;
        const takeForWord = o.retake ? o.retake[wordNo] : 0; // redo: this word's take (see redoLayout)
        wordNo++;
        const compound = !!boxes && word.includes(MARK_OPEN);
        const w = compound ? synthCompound(style, word, rng, ctx, boxes, pinsForWord) : synthWord(style, word, rng, ctx, pinsForWord, takeForWord);
        if (!w) {
          wordsOut.push(null); // keeps the numbering of words, so pins stay lined up
          wordLine.push(line);
          continue;
        }
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
        if (w.up !== undefined) {
          reachUp[line] = Math.max(reachUp[line] || 0, w.up * sc);
          reachDown[line] = Math.max(reachDown[line] || 0, w.down * sc);
        }
        if (R) wordOff = ar(wordOff / xh, R.baseRho, R.baseSd * k) * xh;
        else wordOff = wordOff * 0.7 + (rng() * 2 - 1) * 0.035 * xh * o.messiness;
        // opts.bounce: a small up and down, on top of the writer's own drift: a slow wave along the line, each word a little above or
        // below its neighbours, and a slight tilt of each word (nothing is drawn from the random stream when it is 0)
        let lift = 0;
        let tilt = 0;
        if (o.bounce > 0) {
          liftState = 0.4 * liftState + Math.sqrt(1 - 0.16) * 0.06 * o.bounce * G.gaussian(brng);
          lift = (liftState + 0.05 * o.bounce * Math.sin(wavePhase + (6.283 * (x - margin)) / (14 * xh))) * xh;
          tilt = G.gaussian(brng) * 0.018 * o.bounce;
        }
        const base = baselines[line] + slope * (x - margin) + wordOff + lift;
        const dx = x - b.minX;
        for (const s of pxStrokes) {
          for (const p of s.pts) {
            p.y += base + (p.x - b.minX) * tilt;
            p.x += dx;
          }
          strokesOut.push(s);
          strokeLine.push(line);
        }
        wordLine.push(line);
        // where each letter ended up on the page, so a tap can be traced back to the example that drew it
        wordsOut.push({
          text: boxes ? word.replace(/\uE000(\d+)\uE001/g, (_, n) => '$' + (boxes[Number(n)] ? boxes[Number(n)].tex : '') + '$') : word,
          choices: w.choices.map((c) => c.unit),
          ids: w.choices.map((c) => c.unit.id),
          pins: w.pins, // the same examples as ids, but one per character (a plain word) or per part (a word with math): what `pins` takes
          compound,
          spans: w.spans.map(([lo, hi]) => [(lo + 0.5 * tanW) * xh * sc + dx, (hi + 0.5 * tanW) * xh * sc + dx]),
          top: base - 2.7 * xh * sc,
          bottom: base + 1.3 * xh * sc,
        });
        // a gap is never tiny (it would read as one word), and a little wider after . , ! ? ; :
        const floor = /[.,!?;:]$/.test(word) ? 0.4 : 0.28;
        const gap = R ? Math.max(floor, R.gapMean + R.gapSd * k * G.gaussian(rng)) * xh * o.wordSpacing : spaceW * (0.85 + 0.3 * rng());
        x += wpx + gap;
      }
    });

    let height = baselines[baselines.length - 1] + 1.5 * xh + margin * 0.5;
    // Lines with tall boxes (a fraction, an integral with limits) get room so they do not touch the lines around them. A line with
    // nothing beyond the usual reach (ascenders up to 1.9 x-heights, descenders down to 0.9) gets none, so plain text is unchanged.
    const NORMAL_UP = 1.9;
    const NORMAL_DOWN = 0.9;
    const GAP = 0.35;
    let lineInk = null;
    if (reachUp.length || reachDown.length) {
      const shift = [];
      let total = 0;
      for (let i = 0; i < baselines.length; i++) {
        const tallUp = (reachUp[i] || 0) > NORMAL_UP;
        const tallDownAbove = i > 0 && (reachDown[i - 1] || 0) > NORMAL_DOWN;
        // opts.snapLines (the caller writes on ruled lines): the room is a whole number of line heights, so every line stays on a
        // rule. A tall piece that pokes into the next line's band by no more than about 0.45 x-heights beyond the usual gap
        // gets no room (it just pokes over, as in handwriting); more than that skips whole lines. The first line moves nothing.
        if (i === 0) total += tallUp && !o.snapLines ? Math.max(0, reachUp[0] - 1.7) * xh : 0;
        else if (tallUp || tallDownAbove) {
          const need = Math.max(reachDown[i - 1] || 0, NORMAL_DOWN) + Math.max(reachUp[i] || 0, NORMAL_UP) + GAP;
          let add = Math.max(0, need * xh - lineH);
          if (o.snapLines) add = add <= (GAP + 0.45) * xh ? 0 : Math.ceil(add / lineH - 1e-6) * lineH;
          total += add;
        }
        shift.push(total);
      }
      strokesOut.forEach((s, i) => {
        const d = shift[strokeLine[i]];
        if (d) for (const p of s.pts) p.y += d;
      });
      wordsOut.forEach((wd, i) => {
        const d = shift[wordLine[i]];
        if (wd && d) {
          wd.top += d;
          wd.bottom += d;
        }
      });
      baselines.forEach((b, i) => (baselines[i] = b + shift[i]));
      const last = baselines.length - 1;
      height += shift[last] + Math.max(0, (reachDown[last] || 0) - 1.3) * xh;
      // what each line really covers (px), and whether it holds something tall: for a caller (or a test) checking lines do not touch
      lineInk = baselines.map((_, i) => ({ top: Infinity, bottom: -Infinity, tall: (reachUp[i] || 0) > NORMAL_UP || (reachDown[i] || 0) > NORMAL_DOWN }));
      strokesOut.forEach((s, i) => {
        const L = lineInk[strokeLine[i]];
        for (const p of s.pts) {
          if (p.y < L.top) L.top = p.y;
          if (p.y > L.bottom) L.bottom = p.y;
        }
      });
    }
    const result = { width: o.width, height, strokes: strokesOut, words: wordsOut, missing: Array.from(ctx.missing), substituted: Array.from(ctx.substituted), baselines, xh, lineHeightPx: lineH };
    if (lineInk) result.lineInk = lineInk;
    return result;
  }

  const api = { layout, redoLayout, MARK_OPEN, MARK_CLOSE, synthWord, chooseUnits, assemble, deform, checkText, glyphUnit, cutReturnStroke, accentStrokes };
  root.HW = root.HW || {};
  root.HW.synth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
