/*
 * Cuts one captured word into letters.
 * Coordinates: y up, baseline at 0, x-height = 1, slant removed.
 * The cuts follow the pen path instead of a vertical line, so loops and joins stay with the
 * right letter. It is a small DP over candidate cut points, using how cheap a place is to cut,
 * the expected letter widths, and whether a letter's height fits (ascender, x-height, descender).
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? require('./geometry') : root.HW.geometry;

  const STEP = 0.03; // resampling step, in x-heights

  // ---- priors ---------------------------------------------------------------------------

  const LOWER = {
    a: 0.95, b: 0.9, c: 0.8, d: 0.95, e: 0.85, f: 0.7, g: 0.95, h: 0.95, i: 0.45, j: 0.5,
    k: 0.9, l: 0.5, m: 1.4, n: 0.95, o: 0.9, p: 0.95, q: 0.95, r: 0.75, s: 0.75, t: 0.7,
    u: 0.95, v: 0.85, w: 1.3, x: 0.9, y: 0.9, z: 0.8,
  };
  const PUNCT = {
    '.': 0.3, ',': 0.3, "'": 0.25, '"': 0.5, '-': 0.6, '!': 0.3, '?': 0.75, ':': 0.3, ';': 0.35,
    '(': 0.45, ')': 0.45, '/': 0.6, '&': 1.1, '@': 1.3, '#': 1.0, '%': 1.3, '+': 0.8, '=': 0.8,
    '*': 0.6, $: 0.8,
  };

  function defaultWidth(ch) {
    if (LOWER[ch] !== undefined) return LOWER[ch];
    if (PUNCT[ch] !== undefined) return PUNCT[ch];
    if (ch >= 'A' && ch <= 'Z') {
      if (ch === 'M') return 1.6;
      if (ch === 'W') return 1.7;
      if (ch === 'I') return 0.45;
      if (ch === 'J') return 0.8;
      return 1.2;
    }
    if (ch >= '0' && ch <= '9') return ch === '1' ? 0.6 : 0.9;
    return 0.9;
  }

  const classCache = new Map();
  function heightClass(ch) {
    let c = classCache.get(ch);
    if (!c) {
      c = {
        asc: 'bdfhkl'.includes(ch),
        tee: ch === 't',
        tall: /[A-Z0-9]/.test(ch),
        low: 'acemnorsuvwxz'.includes(ch),
        desc: 'gjpqy'.includes(ch),
        noDesc: 'abcdehiklmnorstuvwx'.includes(ch),
      };
      classCache.set(ch, c);
    }
    return c;
  }

  let boxBuf = new Float64Array(0);

  function heightCostK(k, minY, maxY) {
    let c = 0;
    if (k.asc) c += Math.max(0, 1.4 - maxY) * 2;
    else if (k.tee) c += Math.max(0, 1.0 - maxY) * 2;
    else if (k.tall) c += Math.max(0, 1.35 - maxY) * 2;
    else if (k.low) c += Math.max(0, maxY - 1.6) * 1.5;
    if (k.desc) c += Math.max(0, minY + 0.25) * 2;
    else if (k.noDesc) c += Math.max(0, -0.5 - minY) * 1.5;
    return c;
  }

  /** How badly a letter's vertical extent contradicts what the character should look like. */
  function heightCost(ch, b) {
    return heightCostK(heightClass(ch), b.minY, b.maxY);
  }

  // ---- normalisation --------------------------------------------------------------------

  /** raw = {text, strokes:[[ [x,y,t,p], ... ]], xh, baseline}; canvas pixels, y down. */
  function normalize(raw) {
    const xh = raw.xh;
    let minX = Infinity;
    for (const s of raw.strokes) for (const pt of s) minX = Math.min(minX, pt[0]);
    const out = [];
    for (const s of raw.strokes) {
      const pts = [];
      for (const pt of s) {
        const q = {
          x: (pt[0] - minX) / xh,
          y: (raw.baseline - pt[1]) / xh,
          t: pt[2] || 0,
          p: pt[3] == null ? 0.5 : pt[3],
        };
        const last = pts[pts.length - 1];
        if (last && Math.abs(last.x - q.x) < 1e-9 && Math.abs(last.y - q.y) < 1e-9) continue;
        pts.push(q);
      }
      if (pts.length) out.push(pts);
    }
    return out;
  }

  function median(a) {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /** Resample + smooth one stroke and attach a width factor `w` per point. */
  function cleanStroke(s, stats) {
    const rs = G.resample(s, STEP);
    const sm = rs.length >= 8 ? G.smooth(rs, 1.5, ['p']) : rs;
    if (stats && stats.hasPressure) {
      const pm = stats.pMean || 0.5;
      for (const pt of sm) pt.w = clamp(0.5 + 0.5 * (pt.p / pm), 0.4, 1.8);
    } else {
      // speed based: faster -> thinner, like a real pen
      const v = [];
      for (let i = 0; i < sm.length; i++) {
        const a = sm[Math.max(0, i - 1)];
        const b = sm[Math.min(sm.length - 1, i + 1)];
        const dt = Math.max(1, b.t - a.t);
        v.push((G.dist(a, b) / dt) * 1000);
      }
      const vs = sm.length >= 8 ? G.smooth(v.map((x) => ({ x, y: 0 })), 3).map((q) => q.x) : v;
      const vm = (stats && stats.vMed) || median(vs) || 1;
      for (let i = 0; i < sm.length; i++) sm[i].w = clamp(1.12 - 0.2 * (vs[i] / vm - 1), 0.7, 1.3);
    }
    return sm;
  }

  function estimateSlant(strokes) {
    const sx = [];
    const sy = [];
    const sw = [];
    let total = 0;
    for (const s of strokes) {
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1];
        const b = s[i];
        const ym = (a.y + b.y) / 2;
        if (ym < 0.05 || ym > 1.25) continue;
        const dy = Math.abs(b.y - a.y);
        sx.push((a.x + b.x) / 2);
        sy.push(ym);
        sw.push(dy);
        total += dy;
      }
    }
    if (total < 0.8) return null;
    const BINS = 512;
    const hist = new Float64Array(BINS);
    let best = 0;
    let bestScore = -1;
    for (let th = -0.45; th <= 0.65; th += 0.025) {
      const tn = Math.tan(th);
      hist.fill(0);
      for (let i = 0; i < sx.length; i++) {
        const bin = Math.floor((sx[i] - sy[i] * tn) / 0.05) + 64;
        if (bin >= 0 && bin < BINS) hist[bin] += sw[i];
      }
      let score = 0;
      for (let i = 0; i < BINS; i++) score += hist[i] * hist[i];
      score *= 1 - 0.15 * Math.abs(th); // mild preference for upright on ties
      if (score > bestScore) {
        bestScore = score;
        best = th;
      }
    }
    return best;
  }

  /** Clean strokes + raw slant estimate (null when there is too little to judge from). */
  function preprocess(raw, stats) {
    const strokes = normalize(raw).map((s) => cleanStroke(s, stats));
    return { strokes, slant: strokes.length ? estimateSlant(strokes) : null };
  }

  function strokeInfo(s) {
    let minX = Infinity;
    let maxX = -Infinity;
    let sx = 0;
    let sy = 0;
    for (const p of s) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      sx += p.x;
      sy += p.y;
    }
    return { minX, maxX, cx: sx / s.length, cy: sy / s.length, len: G.pathLength(s) };
  }

  /** Small strokes written *after* something further right (i-dots, t-bars written late). */
  function splitDelayed(strokes) {
    const primary = [];
    const delayed = [];
    let maxX = -Infinity;
    for (const s of strokes) {
      const info = strokeInfo(s);
      if (primary.length && info.len < 2.2 && info.cy > 0.25 && info.cx < maxX - 0.4) delayed.push(s);
      else {
        primary.push(s);
        maxX = Math.max(maxX, info.maxX);
      }
    }
    return { primary, delayed };
  }

  // ---- cut costs ------------------------------------------------------------------------

  function computeCutCosts(P, first, sStart, sEnd, sId, strokeMaxX, strokeDot) {
    const N = P.length;
    const cost = new Float64Array(N + 1).fill(Infinity);
    const W = 4;
    for (let k = 1; k < N; k++) {
      if (first[k]) {
        const prevMax = strokeMaxX[sId[k] - 1];
        const over = prevMax - P[k].x;
        cost[k] = clamp((over - 0.25) * 1.5, 0, 2) + (strokeDot[sId[k]] ? 2.5 : 0); // a dot belongs to the letter before it
        continue;
      }
      const si = sId[k];
      if (k - sStart[si] < W || sEnd[si] - k < W) continue;
      const a = P[k - W];
      const b = P[k + W];
      const m = P[k];
      const v1x = m.x - a.x;
      const v1y = m.y - a.y;
      const v2x = b.x - m.x;
      const v2y = b.y - m.y;
      const turn = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
      const cx = b.x - a.x;
      const cl = Math.hypot(cx, b.y - a.y) || 1e-9;
      const dxn = cx / cl;
      let c = 0.5;
      const y = m.y;
      if (y >= -0.05 && y <= 0.6) c += 0;
      else if (y > 0.6 && y <= 1.15) c += 0.4;
      else c += 3;
      c += 2.5 * Math.max(0, 0.15 - dxn) * 4;
      c += 1.5 * (turn / (Math.PI / 2));
      cost[k] = c;
    }
    return cost;
  }

  // ---- main entry -----------------------------------------------------------------------

  /**
   * @param raw   {text, strokes, xh, baseline}
   * @param opts  {stats: {hasPressure, pMean, vMed}, slantHint (rad), prepared (from preprocess), widths}
   * @returns {ok, units, slant, quality, reason}
   */
  function alignWord(raw, opts) {
    opts = opts || {};
    const chars = Array.from(raw.text);
    const n = chars.length;
    const prep = opts.prepared || preprocess(raw, opts.stats);
    const strokes = prep.strokes.map((s) => s.map(G.copyPt)); // deslanting below edits in place
    if (!strokes.length || n === 0) return { ok: false, reason: 'empty' };

    // de-slant. A single short word has too few upright strokes to judge slant from, so when
    // the caller knows the writer's overall slant, a word may only deviate a little from it.
    const hint = opts.slantHint;
    let slant = prep.slant;
    if (slant === null) slant = hint !== undefined ? hint : 0;
    else if (hint !== undefined) slant = clamp(slant, hint - 0.1, hint + 0.1);
    const tn = Math.tan(slant);
    for (const s of strokes) for (const p of s) p.x -= p.y * tn;
    // shift so the word starts at x = 0
    let minX = Infinity;
    for (const s of strokes) for (const p of s) minX = Math.min(minX, p.x);
    for (const s of strokes) for (const p of s) p.x -= minX;

    if (n === 1) {
      const unit = buildUnit(chars[0], strokes.map((pts) => ({ pts, entryMid: false, exitMid: false })), []);
      return { ok: true, units: [unit], slant, quality: 0 };
    }

    const { primary, delayed } = splitDelayed(strokes);

    // path
    const P = [];
    const sId = [];
    const first = [];
    const sStart = [];
    const sEnd = [];
    const strokeMaxX = [];
    const strokeDot = [];
    primary.forEach((s, si) => {
      sStart.push(P.length);
      let mx = -Infinity;
      s.forEach((pt, k) => {
        P.push(pt);
        sId.push(si);
        first.push(k === 0);
        mx = Math.max(mx, pt.x);
      });
      sEnd.push(P.length - 1);
      strokeMaxX.push(mx);
      const inf = strokeInfo(s);
      strokeDot.push(inf.len < 0.35 && inf.cy > 1.0);
    });
    const N = P.length;
    if (N < n * 3) return { ok: false, reason: 'too short' };

    const cutCost = computeCutCosts(P, first, sStart, sEnd, sId, strokeMaxX, strokeDot);
    const isMid = (c) => c > 0 && c < N && !first[c];

    // expected widths
    const widths = opts.widths || {};
    const prior = chars.map((c) => (widths[c] !== undefined ? widths[c] : defaultWidth(c)));
    const priorSum = prior.reduce((a, b) => a + b, 0);
    let allMin = Infinity;
    let allMax = -Infinity;
    for (const p of P) {
      allMin = Math.min(allMin, p.x);
      allMax = Math.max(allMax, p.x);
    }
    const alpha = clamp((allMax - allMin) / priorSum, 0.6, 1.8);
    const LW = 2.0; // weight of the width term
    const HW = 2.0; // weight of the ascender / descender term
    const hk = chars.map(heightClass);
    const wMaxAll = 3 * alpha * Math.max.apply(null, prior) + 0.8;

    // candidate nodes
    const nodes = [0];
    for (let k = 1; k < N; k++) {
      if (first[k]) nodes.push(k);
      else if (k % 2 === 0 && cutCost[k] < 3.0) nodes.push(k);
    }
    nodes.push(N);
    const M = nodes.length;
    if (M - 1 < n) return { ok: false, reason: 'too few cut points' };

    // extents of every node pair, only while a segment can still have a plausible width
    const need = M * M * 4;
    if (boxBuf.length < need) boxBuf = new Float64Array(need);
    const bb = boxBuf;
    const jEnd = new Int32Array(M);
    for (let i = 0; i < M - 1; i++) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      let k = nodes[i];
      jEnd[i] = i;
      for (let j = i + 1; j < M; j++) {
        const c = nodes[j];
        while (k < c) {
          const p = P[k];
          if (p.x < x0) x0 = p.x;
          if (p.x > x1) x1 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.y > y1) y1 = p.y;
          k++;
        }
        let bx0 = x0;
        let bx1 = x1;
        let by0 = y0;
        let by1 = y1;
        if (isMid(c)) {
          const p = P[c];
          if (p.x < bx0) bx0 = p.x;
          if (p.x > bx1) bx1 = p.x;
          if (p.y < by0) by0 = p.y;
          if (p.y > by1) by1 = p.y;
        }
        if (bx1 - bx0 > wMaxAll) break;
        const o = (i * M + j) * 4;
        bb[o] = bx0;
        bb[o + 1] = bx1;
        bb[o + 2] = by0;
        bb[o + 3] = by1;
        jEnd[i] = j;
      }
    }

    const segCost = (l, o) => {
      const e = alpha * prior[l];
      const r = (bb[o + 1] - bb[o] - e) / Math.max(e, 0.35);
      return LW * r * r + HW * heightCostK(hk[l], bb[o + 2], bb[o + 3]);
    };

    // DP
    const INF = 1e18;
    let prev = new Float64Array(M).fill(INF);
    prev[0] = 0;
    const back = [];
    for (let l = 0; l < n; l++) {
      const cur = new Float64Array(M).fill(INF);
      const bk = new Int32Array(M).fill(-1);
      const e = alpha * prior[l];
      const wLimit = 3 * e + 0.8; // beyond this the width term alone is > 8: never optimal
      for (let j = 1; j < M; j++) {
        const last = j === M - 1;
        if (l < n - 1 && last) continue;
        if (l === n - 1 && !last) continue;
        const cj = last ? 0 : cutCost[nodes[j]];
        if (l === 0) {
          if (jEnd[0] >= j) {
            cur[j] = segCost(l, j * 4) + cj; // starts at node 0
            bk[j] = 0;
          }
          continue;
        }
        for (let i = j - 1; i >= 1; i--) {
          if (jEnd[i] < j) break;
          const o = (i * M + j) * 4;
          if (bb[o + 1] - bb[o] > wLimit) break;
          if (prev[i] >= INF) continue;
          const v = prev[i] + segCost(l, o) + cj;
          if (v < cur[j]) {
            cur[j] = v;
            bk[j] = i;
          }
        }
      }
      back.push(bk);
      prev = cur;
    }
    if (prev[M - 1] >= INF) return { ok: false, reason: 'no alignment' };
    const seq = [M - 1];
    for (let l = n - 1; l >= 0; l--) seq.push(back[l][seq[seq.length - 1]]);
    seq.reverse(); // node indices: 0 .. M-1, length n+1
    const quality = prev[M - 1] / n;

    // units
    const units = [];
    for (let l = 0; l < n; l++) {
      const a = nodes[seq[l]];
      const c = nodes[seq[l + 1]];
      const lastIdx = isMid(c) ? c : c - 1;
      const pieces = [];
      let curPiece = null;
      for (let k = a; k <= lastIdx; k++) {
        if (!curPiece || curPiece.sid !== sId[k] || (first[k] && k !== a)) {
          curPiece = { sid: sId[k], pts: [] };
          pieces.push(curPiece);
        }
        curPiece.pts.push(G.copyPt(P[k]));
      }
      const entryMid = a > 0 && !first[a];
      const exitMid = isMid(c);
      const strokesOut = pieces.map((pc, idx) => ({
        pts: pc.pts,
        entryMid: idx === 0 ? entryMid : false,
        exitMid: idx === pieces.length - 1 ? exitMid : false,
      }));
      units.push(buildUnit(chars[l], strokesOut, []));
    }

    // attach delayed strokes (i-dots, t-bars, ...)
    for (const d of delayed) assignMark(units, d);

    return { ok: true, units, slant, quality };
  }

  function boxOf(pieces) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pc of pieces) {
      for (const p of pc.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  function buildUnit(ch, strokesOut, marks) {
    const firstPiece = strokesOut[0];
    const lastPiece = strokesOut[strokesOut.length - 1];
    const f = firstPiece.pts[0];
    const l = lastPiece.pts[lastPiece.pts.length - 1];
    const fd = G.dirAt(firstPiece.pts, 0, 4);
    const ld = G.dirAt(lastPiece.pts, lastPiece.pts.length - 1, 4);
    return {
      ch,
      strokes: strokesOut,
      marks,
      entry: { x: f.x, y: f.y, dx: fd.dx, dy: fd.dy, mid: firstPiece.entryMid },
      exit: { x: l.x, y: l.y, dx: ld.dx, dy: ld.dy, mid: lastPiece.exitMid },
      box: boxOf(strokesOut),
      hc: heightCost(ch, boxOf(strokesOut)),
    };
  }

  function assignMark(units, stroke) {
    const info = strokeInfo(stroke);
    const owners = 'ijtf:;!?"\'';
    const score = (u) => {
      const lo = u.box.minX - 0.1;
      const hi = u.box.maxX + 0.1;
      let d = 0;
      if (info.cx < lo) d = lo - info.cx;
      else if (info.cx > hi) d = info.cx - hi;
      if (owners.includes(u.ch)) d -= 0.15;
      return d + 0.001 * Math.abs(info.cx - (u.box.minX + u.box.maxX) / 2);
    };
    // a long bar spanning several t/f letters is cut between them
    if (info.len > 0.9 && info.maxX - info.minX > 0.8) {
      const tu = units.filter((u) => 'tf'.includes(u.ch) && (u.box.minX + u.box.maxX) / 2 > info.minX && (u.box.minX + u.box.maxX) / 2 < info.maxX);
      if (tu.length >= 2) {
        const centers = tu.map((u) => (u.box.minX + u.box.maxX) / 2);
        const cuts = [];
        for (let i = 0; i < centers.length - 1; i++) cuts.push((centers[i] + centers[i + 1]) / 2);
        let pieces = [[]];
        let ci = 0;
        for (const p of stroke) {
          if (ci < cuts.length && p.x > cuts[ci]) {
            const prevPt = pieces[pieces.length - 1].slice(-1)[0];
            const shared = G.copyPt(p);
            if (prevPt) pieces[pieces.length - 1].push(shared);
            pieces.push([G.copyPt(p)]);
            ci++;
          } else pieces[pieces.length - 1].push(p);
        }
        pieces.forEach((pts, i) => {
          if (pts.length >= 2 && tu[i]) tu[i].marks.push({ pts });
        });
        return;
      }
    }
    let best = units[0];
    let bs = Infinity;
    for (const u of units) {
      const s = score(u);
      if (s < bs) {
        bs = s;
        best = u;
      }
    }
    best.marks.push({ pts: stroke });
  }

  const api = { alignWord, preprocess, heightCost, defaultWidth, normalize, cleanStroke, estimateSlant, splitDelayed, median, STEP };
  root.HW = root.HW || {};
  root.HW.align = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
