/*
 * What the app knows about one person's handwriting: the aligned letters, coverage, slant.
 * It is rebuilt from the raw captured words, so only those need to be saved.
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? require('./geometry') : root.HW.geometry;
  const A = typeof require !== 'undefined' ? require('./align') : root.HW.align;

  /** Pressure / speed statistics over every captured point. */
  function computeStats(rawWords) {
    const ps = [];
    const speeds = [];
    for (const w of rawWords) {
      for (const s of w.strokes) {
        for (let i = 0; i < s.length; i++) {
          if (s[i][3] != null) ps.push(s[i][3]);
          if (i > 0) {
            const dt = s[i][2] - s[i - 1][2];
            if (dt > 0) {
              const d = Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]) / w.xh;
              speeds.push((d / dt) * 1000);
            }
          }
        }
      }
    }
    let hasPressure = false;
    let pMean = 0.5;
    if (ps.length > 20) {
      const m = ps.reduce((a, b) => a + b, 0) / ps.length;
      const v = ps.reduce((a, b) => a + (b - m) * (b - m), 0) / ps.length;
      const distinct = new Set(ps.map((p) => Math.round(p * 50))).size;
      hasPressure = v > 0.003 && distinct > 5;
      pMean = m || 0.5;
    }
    const vMed = speeds.length ? A.median(speeds) : 1;
    return { hasPressure, pMean, vMed };
  }

  // Per-word work is cached (keyed by the raw word object) so adding one word to a large set
  // only costs one alignment. The cache is invalidated when the pressure / speed statistics
  // or the writer's overall slant move noticeably.
  const cache = new WeakMap();

  function statsKey(stats) {
    return [stats.hasPressure ? 1 : 0, Math.round((stats.pMean || 0.5) * 20), Math.round(Math.log(stats.vMed || 1) * 5)].join('|');
  }

  // Words that use none of the writer's ascender / descender proportions (only a, c, e, m, n, o,
  // r, s, u, v, w, x, z) are sized from their own x-height alone, so a new profile can't change them.
  const needsProfile = (text) => /[^acemnorsuvwxz\s.,]/.test(text);

  function alignAll(rawWords, stats) {
    const sk = statsKey(stats);
    const entries = rawWords.map((raw) => {
      let e = cache.get(raw);
      if (!e) {
        e = {};
        cache.set(raw, e);
      }
      if (e.sk !== sk) {
        e.sk = sk;
        e.fit1 = null;
        e.pk = null;
        e.aligned = null;
      }
      return e;
    });

    // Pass 1: size each word from its own letters, then learn this writer's proportions
    // (how tall their b/d/h/k/l are, how deep their descenders go).
    entries.forEach((e, i) => {
      if (!e.fit1) e.fit1 = A.fitView(rawWords[i], stats);
    });
    const profile = A.learnProfile(entries.map((e) => e.fit1.res));
    // coarse key, so adding one word doesn't re-size every word that was already done
    const pk = [profile.asc, profile.tee, profile.tall, profile.desc].map((v) => v.toFixed(1)).join('|');

    // Pass 2: re-size words that depend on those proportions.
    entries.forEach((e, i) => {
      if (e.pk !== pk) {
        e.fit2 = needsProfile(rawWords[i].text) ? A.fitView(rawWords[i], stats, profile) : e.fit1;
        e.pk = pk;
        e.aligned = null;
      }
    });

    const slants = entries.filter((e) => e.fit2.prep.slant !== null).map((e) => e.fit2.prep.slant);
    const slantHint = slants.length >= 3 ? A.median(slants) : undefined;
    const hk = slantHint === undefined ? 'none' : Math.round(slantHint / 0.02);
    const aligned = rawWords.map((raw, i) => {
      const e = entries[i];
      if (!e.aligned || e.hk !== hk) {
        const own = e.fit2.prep.slant;
        const sameAsFit = e.fit2.res && e.fit2.res.ok && own !== null && (slantHint === undefined || Math.abs(own - slantHint) <= 0.1);
        let res = e.fit2.res;
        if (!sameAsFit) {
          try {
            res = A.alignWord(raw, { stats, slantHint, prepared: e.fit2.prep });
          } catch (err) {
            res = { ok: false, reason: String(err && err.message ? err.message : err) };
          }
        }
        e.aligned = Object.assign({ text: raw.text, ownSlant: own }, res);
        e.hk = hk;
      }
      return e.aligned;
    });
    return { aligned, profile };
  }

  /** ~20 points spread along all of a unit's ink, left edge at x = 0 (baseline stays at y = 0). */
  function shapeSample(u) {
    if (u._shape) return u._shape;
    const strokes = u.strokes.map((s) => s.pts).concat(u.marks.map((m) => m.pts));
    const lens = strokes.map((pts) => G.pathLength(pts));
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    const out = [];
    strokes.forEach((pts, i) => {
      const n = Math.max(2, Math.round((20 * lens[i]) / total));
      for (const p of G.resample(pts, Math.max(lens[i] / n, 1e-3))) out.push([p.x - u.box.minX, p.y]);
    });
    u._shape = out;
    return out;
  }

  /** Mean nearest-point distance both ways between two point sets. */
  function shapeDistance(a, b) {
    const oneWay = (p, q) => {
      let sum = 0;
      for (const [x, y] of p) {
        let best = Infinity;
        for (const [u, v] of q) {
          const d = (x - u) * (x - u) + (y - v) * (y - v);
          if (d < best) best = d;
        }
        sum += Math.sqrt(best);
      }
      return sum / p.length;
    };
    return 0.5 * (oneWay(a, b) + oneWay(b, a));
  }

  /** The shape of a unit alone: its ink stretched to fill a 1 x 1 box, so size doesn't matter. */
  function shapeOnly(u) {
    if (u._shapeOnly) return u._shapeOnly;
    const pts = shapeSample(u);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = Math.max(maxX - minX, 0.15);
    const h = Math.max(maxY - minY, 0.15);
    u._shapeOnly = pts.map(([x, y]) => [(x - minX) / w, (y - minY) / h]);
    return u._shapeOnly;
  }

  /** How different two units look: shape first, then how far apart their sizes are. */
  function lookDistance(a, b) {
    const ha = Math.max(a.box.maxY - a.box.minY, 0.15);
    const hb = Math.max(b.box.maxY - b.box.minY, 0.15);
    const wa = Math.max(a.box.maxX - a.box.minX, 0.15);
    const wb = Math.max(b.box.maxX - b.box.minX, 0.15);
    return shapeDistance(shapeOnly(a), shapeOnly(b)) + 0.1 * Math.abs(Math.log(ha / hb)) + 0.06 * Math.abs(Math.log(wa / wb));
  }

  /**
   * Letters written on their own are always cut correctly, so they are a clean reference for what
   * each letter looks like. A cut-out letter (from a word) that looks clearly more like a
   * *different* letter's reference than its own was probably cut in the wrong place, and gets
   * u.wrong = 1. Only letters with at least two references can be judged.
   */
  function markWrongOnes(byChar) {
    const refs = [];
    for (const [ch, list] of byChar) {
      const iso = list.filter((u) => u.iso);
      if (iso.length >= 2) refs.push({ ch, units: iso });
    }
    // recompute only when a new letter gets references, or every few more references, not for each one added
    const sig = refs.map((r) => r.ch).join('') + ':' + Math.floor(refs.reduce((n, r) => n + r.units.length, 0) / 6);
    if (refs.length < 6) {
      for (const list of byChar.values()) for (const u of list) u.wrong = 0;
      return;
    }
    for (const [ch, list] of byChar) {
      const own = refs.find((r) => r.ch === ch);
      for (const u of list) {
        if (u.iso || !own) {
          u.wrong = 0;
          continue;
        }
        if (u._wrongSig === sig) continue;
        u._wrongSig = sig;
        const dist = (units) => (units.length ? Math.min(...units.map((v) => lookDistance(u, v))) : Infinity);
        const dOwn = dist(own.units);
        let dOther = Infinity;
        for (const r of refs) if (r.ch !== ch) dOther = Math.min(dOther, dist(r.units));
        u.wrong = dOther < 0.6 * dOwn && dOwn - dOther > 0.03 ? 1 : 0;
      }
    }
    // Safety valve: if this would call more than one letter in ten wrong, the references and the
    // words probably look too different (neat single letters against quick writing) for the
    // comparison to mean anything for this writer, so don't act on it.
    const cut = [];
    for (const list of byChar.values()) for (const u of list) if (!u.iso) cut.push(u);
    if (cut.length >= 30 && cut.filter((u) => u.wrong).length > 0.1 * cut.length) for (const u of cut) u.wrong = 0;
  }

  const oddCache = new Map(); // char -> the units it was last computed for

  /**
   * Flag examples of a letter that look unlike the writer's other examples of it. A letter that
   * was cut in the wrong place (half of a neighbour, a stray loop) differs from its siblings, so
   * u.odd gets large and the synthesizer avoids it. Needs a few examples of the letter. Groups
   * that haven't changed since the last build are skipped.
   */
  function markOddOnes(byChar) {
    for (const [ch, list] of byChar) {
      const prev = oddCache.get(ch);
      if (prev && prev.length === list.length && prev.every((u, i) => u === list[i])) continue;
      oddCache.set(ch, list.slice());
      for (const u of list) u.odd = 0;
      if (list.length < 4) continue;
      const shapes = list.map(shapeSample);
      // compare each example with at most 14 others, evenly spread
      const step = Math.max(1, Math.floor(list.length / 14));
      const score = list.map((_, i) => {
        const d = [];
        for (let j = 0; j < list.length; j += step) if (j !== i) d.push(shapeDistance(shapes[i], shapes[j]));
        return A.median(d);
      });
      const med = A.median(score);
      const mad = A.median(score.map((v) => Math.abs(v - med)));
      list.forEach((u, i) => {
        u.odd = Math.min(4, Math.max(0, (score[i] - med) / (mad * 1.5 + 0.03)));
      });
    }
  }

  // ---- rhythm: how this writer's lines behave -------------------------------------------

  /** Robust standard deviation (median absolute deviation), 0 for fewer than 3 values. */
  function robustSd(v) {
    if (v.length < 3) return 0;
    const m = A.median(v);
    return 1.4826 * A.median(v.map((x) => Math.abs(x - m)));
  }

  /** Lag-1 correlation within lines, pooled; series is a list of arrays. */
  function pooledRho(series) {
    let num = 0;
    let den = 0;
    for (const s of series) {
      for (let i = 0; i < s.length; i++) den += s[i] * s[i];
      for (let i = 1; i < s.length; i++) num += s[i] * s[i - 1];
    }
    return den > 1e-12 ? Math.max(0, Math.min(0.9, num / den)) : 0;
  }

  /**
   * Measure how the writer's full lines behave, from words written as part of a line:
   * gaps between words, how the baseline wanders and slopes, how size and slant drift.
   * Distances are in the writer's own x-heights. Returns {learned: false} until there are
   * enough lines, in which case the synthesizer uses generic values.
   */
  function computeRhythm(rawWords, aligned) {
    const lines = new Map();
    rawWords.forEach((raw, i) => {
      const a = aligned[i];
      if (!raw.line || !a || !a.ok || !a.view) return;
      let left = Infinity;
      let right = -Infinity;
      for (const st of raw.strokes) for (const p of st) {
        if (p[0] < left) left = p[0];
        if (p[0] > right) right = p[0];
      }
      if (!lines.has(raw.line)) lines.set(raw.line, []);
      lines.get(raw.line).push({
        pos: raw.pos || 0,
        left,
        right,
        xh: raw.xh * a.view.s,
        base: raw.baseline + a.view.dy * raw.xh,
        slant: a.ownSlant,
      });
    });
    const gaps = [];
    const baseSeries = [];
    const sizeSeries = [];
    const slopes = [];
    const slantDev = [];
    let nLines = 0;
    for (const words of lines.values()) {
      if (words.length < 3) continue;
      words.sort((p, q) => p.pos - q.pos);
      nLines++;
      const xhLine = A.median(words.map((w) => w.xh));
      for (let k = 1; k < words.length; k++) gaps.push((words[k].left - words[k - 1].right) / xhLine);
      // baseline: straight-line fit across the line, then what is left over
      const cx = words.map((w) => (w.left + w.right) / 2);
      const n = words.length;
      const mx = cx.reduce((a, b) => a + b, 0) / n;
      const my = words.reduce((a, w) => a + w.base, 0) / n;
      let sxx = 0;
      let sxy = 0;
      cx.forEach((x, i) => {
        sxx += (x - mx) * (x - mx);
        sxy += (x - mx) * (words[i].base - my);
      });
      const slope = sxx > 1e-9 ? sxy / sxx : 0;
      slopes.push(Math.atan(slope));
      baseSeries.push(words.map((w, i) => (w.base - (my + slope * (cx[i] - mx))) / xhLine));
      const logs = words.map((w) => Math.log(w.xh / xhLine));
      const lm = logs.reduce((a, b) => a + b, 0) / n;
      sizeSeries.push(logs.map((v) => v - lm));
      const sl = words.filter((w) => w.slant !== null && w.slant !== undefined).map((w) => w.slant);
      if (sl.length >= 3) {
        const med = A.median(sl);
        sl.forEach((v) => slantDev.push(v - med));
      }
    }
    if (nLines < 3 || gaps.length < 10) return { learned: false, lines: nLines };
    // Each word's size / baseline / slant is itself an estimate, and a noisy one for short words
    // or ambiguous letters, so measured drift is partly measurement noise (on real handwriting it
    // comes out several times larger than people actually vary). Keep it within human ranges,
    // and assume drift is smooth along a line, since noise also hides the correlation.
    const gapMean = Math.max(0.2, A.median(gaps));
    return {
      learned: true,
      lines: nLines,
      gapMean,
      gapSd: Math.min(robustSd(gaps), 0.35 * gapMean),
      baseSd: Math.min(robustSd(baseSeries.flat()), 0.1),
      baseRho: Math.max(0.4, pooledRho(baseSeries)),
      sizeSd: Math.min(robustSd(sizeSeries.flat()), 0.1),
      sizeRho: Math.max(0.4, pooledRho(sizeSeries)),
      slopeSd: Math.min(robustSd(slopes), 0.03),
      slantSd: Math.min(robustSd(slantDev), 0.07),
    };
  }

  function buildStyle(rawWords) {
    const words = rawWords.filter((w) => w && w.strokes && w.strokes.length && w.text);
    const stats = computeStats(words);
    const { aligned, profile } = alignAll(words, stats);

    const byChar = new Map();
    const allByChar = new Map();
    const slants = [];
    const gaps = [];
    let joinsMid = 0;
    let joins = 0;
    const failed = [];
    const suspect = [];

    aligned.forEach((w, wi) => {
      if (!w.ok) {
        failed.push({ index: wi, text: w.text, reason: w.reason });
        return;
      }
      slants.push(w.slant);
      w.units.forEach((u, idx) => {
        u.wid = wi;
        u.idx = idx;
        u.id = wi + ':' + idx;
        u.word = w;
        u.iso = !!(words[wi] && words[wi].iso); // written on its own, so never mis-cut
        u.dev = A.deviation(u, profile);
        // letters the writer has crossed out in the letter check stay out of the pool
        const crossed = words[wi] && words[wi].skip;
        u.skipped = !!(crossed && crossed.some((c) => c.i === idx && c.ch === u.ch));
        if (!allByChar.has(u.ch)) allByChar.set(u.ch, []);
        allByChar.get(u.ch).push(u);
        if (!u.skipped) {
          if (!byChar.has(u.ch)) byChar.set(u.ch, []);
          byChar.get(u.ch).push(u);
        }
        if (idx > 0) {
          const p = w.units[idx - 1];
          joins++;
          if (p.exit.mid && u.entry.mid) joinsMid++;
          else if (!p.exit.mid && !u.entry.mid) gaps.push(u.box.minX - p.box.maxX);
        }
      });
    });

    // Words worth a second look: alignment cost that is an outlier against this writer's own
    // words, or a letter whose shape contradicts its character (e.g. a descender on an "s").
    const qs = aligned.filter((w) => w.ok && w.units.length > 1).map((w) => w.quality);
    const qMed = A.median(qs);
    const qMad = A.median(qs.map((q) => Math.abs(q - qMed)));
    const qLimit = Math.max(qMed + 4 * qMad, qMed * 2, 0.8);
    aligned.forEach((w, wi) => {
      if (!w.ok) return;
      const badShape = w.units.some((u) => u.hc > 0.8);
      if ((w.units.length > 1 && qs.length >= 5 && w.quality > qLimit) || badShape) {
        suspect.push({ index: wi, text: w.text, quality: w.quality });
        w.suspect = true;
      }
    });

    markOddOnes(byChar);
    markWrongOnes(byChar);

    // how close this writer lets neighbouring (unjoined) letters get, by nearest ink
    const clears = [];
    for (const w of aligned) {
      if (!w.ok) continue;
      for (let i = 1; i < w.units.length; i++) {
        const p = w.units[i - 1];
        const u = w.units[i];
        if (p.exit.mid || u.entry.mid || /[^a-zA-Z]/.test(p.ch + u.ch)) continue;
        const c = A.inkBase(p, u);
        if (c !== null) clears.push(c);
      }
    }
    const clearance = clears.length >= 20 ? { median: A.median(clears), sd: robustSd(clears) } : null;

    const liftGap = gaps.length ? Math.min(0.5, Math.max(-0.05, A.median(gaps))) : 0.1;
    return {
      words: aligned,
      byChar,
      allByChar,
      profile,
      clearance,
      rhythm: computeRhythm(words, aligned),
      slant: slants.length ? A.median(slants) : 0,
      liftGap,
      connectivity: joins ? joinsMid / joins : 0,
      hasPressure: stats.hasPressure,
      stats,
      failed,
      suspect,
      count: aligned.filter((w) => w.ok).length,
    };
  }

  /** Characters (from `text`) we have no sample for. */
  function missingChars(style, text) {
    const miss = new Set();
    for (const ch of Array.from(text)) {
      if (/\s/.test(ch)) continue;
      if (!style.byChar.has(normalizeChar(ch)) && !fallbackFor(style, normalizeChar(ch))) miss.add(ch);
    }
    return Array.from(miss);
  }

  const CHAR_MAP = {
    '‘': "'", '’': "'", '‚': ',', '‛': "'", '“': '"', '”': '"',
    '„': '"', '–': '-', '—': '-', '−': '-', '…': '...', ' ': ' ',
  };

  function normalizeChar(ch) {
    return CHAR_MAP[ch] || ch;
  }

  /** {ch, scale} to use when there is no sample for `ch`, or null. */
  function fallbackFor(style, ch) {
    if (style.byChar.has(ch)) return { ch, scale: 1 };
    if (ch >= 'A' && ch <= 'Z' && style.byChar.has(ch.toLowerCase())) return { ch: ch.toLowerCase(), scale: 1.55 };
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base !== ch && base.length === 1) return fallbackFor(style, base);
    return null;
  }

  function coverage(style) {
    const out = {};
    for (const [ch, list] of style.byChar) out[ch] = list.length;
    return out;
  }

  function toJSON(rawWords) {
    return JSON.stringify({ version: 1, words: rawWords });
  }

  function fromJSON(str) {
    const o = JSON.parse(str);
    if (!o || !Array.isArray(o.words)) throw new Error('Not a handwriting style file');
    return o.words;
  }

  const api = { buildStyle, computeRhythm, missingChars, coverage, normalizeChar, fallbackFor, toJSON, fromJSON, computeStats };
  root.HW = root.HW || {};
  root.HW.style = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
