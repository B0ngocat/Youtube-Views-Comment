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
        e.aligned = Object.assign({ text: raw.text }, res);
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

  function buildStyle(rawWords) {
    const words = rawWords.filter((w) => w && w.strokes && w.strokes.length && w.text);
    const stats = computeStats(words);
    const { aligned, profile } = alignAll(words, stats);

    const byChar = new Map();
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
        u.dev = A.deviation(u, profile);
        if (!byChar.has(u.ch)) byChar.set(u.ch, []);
        byChar.get(u.ch).push(u);
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

    const liftGap = gaps.length ? Math.min(0.5, Math.max(-0.05, A.median(gaps))) : 0.1;
    return {
      words: aligned,
      byChar,
      profile,
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

  const api = { buildStyle, missingChars, coverage, normalizeChar, fallbackFor, toJSON, fromJSON, computeStats };
  root.HW = root.HW || {};
  root.HW.style = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
