/*
 * Words and math together: `The slope is $\frac{3}{4}$, so $y = 3x + 1$.`
 *
 * $...$ and \(...\) are math (the dialect of math.js); everything else is plain words, written exactly as text mode writes them.
 * \$ is a dollar sign. Each piece of math is laid out as one box (math.inline) and goes into the text as one unbreakable
 * word that sits on the baseline, slanted and sized like the words next to it: synth.layout does the flowing and wrapping
 * (opts.inline). Punctuation typed against a closing $ is part of the same word, so it never wraps away from the math.
 * Lines holding something tall (a fraction, an integral with limits) get extra room from synth.layout; other lines do not.
 */
(function (root) {
  'use strict';

  const Y = typeof require !== 'undefined' ? require('./synth') : root.HW.synth;
  const M = typeof require !== 'undefined' ? require('./math') : root.HW.math;

  const clip = (s) => (s.length > 40 ? s.slice(0, 40) + '...' : s);

  /**
   * Cut text into segments: [{t: 'text' | 'math', s}]. Throws an Error that says where, for a $ that is never closed
   * (nothing is guessed), a closing $ with nothing in it, or a line break inside math.
   */
  function split(text) {
    const src = String(text);
    const out = [];
    let buf = '';
    let i = 0;
    const flush = () => {
      if (buf) out.push({ t: 'text', s: buf });
      buf = '';
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '\\' && src[i + 1] === '$') {
        buf += '$';
        i += 2;
      } else if (c === '$' || (c === '\\' && src[i + 1] === '(')) {
        const paren = c === '\\';
        const start = i;
        i += paren ? 2 : 1;
        let j = i;
        let end = -1;
        while (j < src.length) {
          if (src[j] === '\\' && j + 1 < src.length) {
            if (paren && src[j + 1] === ')') {
              end = j;
              break;
            }
            j += 2; // \$ and every other TeX command: the backslash goes with the next character
            continue;
          }
          if (!paren && src[j] === '$') {
            end = j;
            break;
          }
          j++;
        }
        if (end < 0) throw new Error(`Unclosed ${paren ? '\\(' : '$'} at character ${start + 1}, before "${clip(src.slice(start + (paren ? 2 : 1)))}". Math in mixed text is written $...$ or \\(...\\); write \\$ for a dollar sign.`);
        const body = src.slice(i, end);
        if (!body.trim()) throw new Error(`Empty math ${paren ? '\\(\\)' : '$$'} at character ${start + 1}. Put the TeX between single dollar signs ($x^2$); display math ($$...$$) is not supported; write \\$ for a dollar sign.`);
        if (/\n/.test(body.trim()) || /(^|[^\\])\\\\/.test(body)) throw new Error(`A line break inside math at character ${start + 1} ("${clip(body.trim())}"). Math in mixed text is one inline piece: end the math, start a new line in the text, and open the math again.`);
        flush();
        out.push({ t: 'math', s: body.trim() });
        i = end + (paren ? 2 : 1);
      } else {
        buf += c;
        i++;
      }
    }
    flush();
    return out;
  }

  /** The text with the math taken out (one space where each piece was), for the pre-flight check of the words. Throws as split does. */
  function plainText(text) {
    return split(text)
      .map((g) => (g.t === 'text' ? g.s : ' '))
      .join('');
  }

  /** Each piece of math has a stream of its own, from the layout's seed and the piece's number: editing one never changes another. */
  // take (redo): 0 is the plain piece; another number gives the piece a stream of its own and nothing else changes
  const segSeed = (seed, n, take) => {
    const s = (Math.imul((Number(seed) | 0) ^ 0x9e3779b9, 2654435761) + Math.imul(n + 1, 0x85ebca6b)) >>> 0;
    return take ? Math.imul(s ^ Math.imul(take, 0x27d4eb2f), 0x85ebca6b) >>> 0 : s;
  };

  /**
   * Same result shape as synth.layout, plus what math.layout reports: unknown (TeX commands that are not supported) and standIns.
   * `missing` holds the characters missing from the words and from the math. opts are synth.layout's.
   */
  function layout(style, text, opts) {
    const o = Object.assign({ messiness: 0.3, variation: 0.4, seed: 1 }, opts || {});
    // opts.redo (see synth.redoLayout): the same text laid out again with the chosen words or pieces of math redrawn and the rest kept
    if (o.redo && o.redo.length) return Y.redoLayout(style, o.redo, (patch) => layout(style, text, Object.assign({}, o, patch, { redo: null })));
    const segs = split(text);
    const boxes = [];
    const unknown = new Set();
    const standIns = new Set();
    const missing = new Set();
    let flow = '';
    for (const g of segs) {
      if (g.t === 'text') {
        flow += g.s;
        continue;
      }
      const n = boxes.length;
      const box = M.inline(style, g.s.replace(/\s+/g, ' '), { seed: segSeed(o.seed, n, o.retakeMath ? o.retakeMath[n] : 0), messiness: o.messiness, variation: o.variation, wordReuse: o.wordReuse });
      box.tex = g.s;
      for (const c of box.unknown) unknown.add(c);
      for (const c of box.standIns) standIns.add(c);
      for (const c of box.missing) missing.add(c);
      boxes.push(box);
      flow += Y.MARK_OPEN + n + Y.MARK_CLOSE;
    }
    const lay = Y.layout(style, flow, Object.assign({}, o, { inline: boxes }));
    for (const c of lay.missing) missing.add(c);
    lay.missing = Array.from(missing);
    lay.unknown = Array.from(unknown);
    lay.standIns = Array.from(standIns);
    lay.substituted = Array.from(new Set([...(lay.substituted || []), ...standIns])); // what the tools list as drawn rather than written
    lay.math = boxes.length;
    lay.mathTex = boxes.map((b) => b.tex); // what each piece of math says, and the examples it was written with (redo)
    lay.mathIds = boxes.map((b) => b.ids);
    return lay;
  }

  const api = { layout, split, plainText };
  root.HW = root.HW || {};
  root.HW.mixed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
