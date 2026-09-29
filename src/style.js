/*
 * What the app knows about one person's handwriting: the aligned letters, coverage, slant.
 * It is rebuilt from the raw captured words, so only those need to be saved.
 */
(function (root) {
  'use strict';
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
        e.prepared = A.preprocess(raw, stats);
        e.aligned = null;
      }
      return e;
    });
    // slant is a property of the writer: judge it from all words, then keep each word close to it
    const slants = entries.filter((e) => e.prepared.slant !== null).map((e) => e.prepared.slant);
    const slantHint = slants.length >= 3 ? A.median(slants) : undefined;
    const hk = slantHint === undefined ? 'none' : Math.round(slantHint / 0.02);
    return rawWords.map((raw, i) => {
      const e = entries[i];
      if (!e.aligned || e.hk !== hk) {
        let res;
        try {
          res = A.alignWord(raw, { stats, slantHint, prepared: e.prepared });
        } catch (err) {
          res = { ok: false, reason: String(err && err.message ? err.message : err) };
        }
        e.aligned = Object.assign({ text: raw.text }, res);
        e.hk = hk;
      }
      return e.aligned;
    });
  }

  function buildStyle(rawWords) {
    const words = rawWords.filter((w) => w && w.strokes && w.strokes.length && w.text);
    const stats = computeStats(words);
    const aligned = alignAll(words, stats);

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

    const liftGap = gaps.length ? Math.min(0.5, Math.max(-0.05, A.median(gaps))) : 0.1;
    return {
      words: aligned,
      byChar,
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
