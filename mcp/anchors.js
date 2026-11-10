'use strict';
/*
 * Finding a piece of printed text on a page, so something can be put round it, under it or after it. Pure: it takes the
 * data inspect() in pdfinfo.js returns (no PDF library here, so the build without PDF support can include it).
 *
 *   findText(pages, {page, text, nth})  ->  {rect: {page, x, y, w, h}, matches, nth, line} | null   (see findText)
 *   closestLines(pages, page, text, limit)  ->  [the printed lines of that page most like `text`]
 *
 * pages: [{page: 1, items: [{str, x, y, w, h, baseline}], text: [{text, x, y, w, h}]}], positions in points from the top-left
 * corner of the page (y down), exactly as inspect() reports them. `page` is counted from 1, as everywhere in the tools. Only
 * the page's `items` are used by findText; `text` (the merged lines) is what closestLines lists.
 *
 * Matching is on one printed line (items on the same baseline that follow each other, joined as the lines of inspect_pdf are).
 * Exact text first; only when it occurs nowhere on the page, the same ignoring case and runs of whitespace. A phrase that is
 * split over two lines is not found. rect is the box of the text's own pixels as far as the PDF says: from the top of the
 * font's em box to the baseline (so descenders hang below it), over the x range of the characters matched.
 */

// Rough relative widths of characters in a proportional sans font. Used only to say where inside one text item a substring
// starts and ends: the item's own width is known, the split of it between characters is an estimate.
const NARROW = new Set("iljI.,:;!|'`()[]/\\ t".split(''));
const WIDE = new Set('mwMW@%'.split(''));
function weight(ch) {
  if (ch === ' ') return 0.5;
  if (NARROW.has(ch)) return 0.45;
  if (WIDE.has(ch)) return 1.5;
  if (/[A-Z0-9]/.test(ch)) return 1.1;
  return 1;
}

/** Items on one baseline that follow each other become lines (the rule pdfinfo.textLines uses), keeping the items. */
function buildLines(items) {
  const rows = [];
  for (const it of items || []) {
    if (!it.str || !it.str.trim()) continue;
    const row = rows.find((r) => Math.abs(r.base - it.baseline) < 2.5 && it.x >= r.right - 2 && it.x - r.right < 40);
    if (row) {
      row.items.push({ it, gap: it.x - row.right > 1.5 });
      row.right = it.x + it.w;
    } else rows.push({ base: it.baseline, right: it.x + it.w, items: [{ it, gap: false }] });
  }
  return rows
    .sort((a, b) => a.base - b.base || a.items[0].it.x - b.items[0].it.x)
    .map((r) => {
      // the line as one string, and for every character of it which item it came from (null for a space added between items)
      let s = '';
      const owner = [];
      r.items.forEach(({ it, gap }, k) => {
        if (gap) {
          s += ' ';
          owner.push(null);
        }
        for (let i = 0; i < it.str.length; i++) {
          s += it.str[i];
          owner.push({ k, i });
        }
      });
      return { s, owner, items: r.items.map((e) => e.it) };
    });
}

/** The same text with letters lower-cased and runs of whitespace as one space, and for each kept character the index it had before. */
function normalise(s) {
  let out = '';
  const from = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) {
      if (!space) {
        out += ' ';
        from.push(i);
      }
      space = true;
    } else {
      space = false;
      out += s[i].toLowerCase();
      from.push(i);
    }
  }
  return { s: out, from };
}

function occurrences(hay, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** The rectangle of characters [a, b) of a line: the union of the pieces of the items they come from. */
function rectOf(line, a, b, page) {
  const parts = new Map(); // item index -> [first char, last char + 1]
  for (let c = a; c < b; c++) {
    const o = line.owner[c];
    if (!o) continue;
    const p = parts.get(o.k);
    if (p) p[1] = o.i + 1;
    else parts.set(o.k, [o.i, o.i + 1]);
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [k, [i0, i1]] of parts) {
    const it = line.items[k];
    const ws = Array.from(it.str, weight);
    const total = ws.reduce((s, v) => s + v, 0) || 1;
    // an ESTIMATE: where the characters i0..i1 are inside the item, from their rough widths (the PDF only gives the item's whole width)
    const before = ws.slice(0, i0).reduce((s, v) => s + v, 0);
    const upto = ws.slice(0, i1).reduce((s, v) => s + v, 0);
    x0 = Math.min(x0, it.x + (it.w * before) / total);
    x1 = Math.max(x1, it.x + (it.w * upto) / total);
    top = Math.min(top, it.y);
    bottom = Math.max(bottom, it.baseline);
  }
  const r = (v) => Math.round(v * 10) / 10;
  return { page, x: r(x0), y: r(top), w: r(x1 - x0), h: r(bottom - top) };
}

/**
 * Where `text` is printed on page `page`.
 * nth: which match, counted from 1 in reading order (top to bottom, left to right); default 1.
 * Returns {rect, matches (how many there are on the page), nth (which one rect is), line (the whole printed line it is in)};
 * null when the text is not printed on that page at all; and {rect: null, matches, nth} when it is, but fewer than nth times.
 */
function findText(pages, q) {
  const all = matchesOf(pages, q);
  if (!all.length) return null;
  const nth = q.nth === undefined || q.nth === null ? 1 : Math.round(Number(q.nth));
  if (!(nth >= 1) || nth > all.length) return { rect: null, matches: all.length, nth, line: '' };
  const m = all[nth - 1];
  return { rect: rectOf(m.line, m.a, m.b, q.page), matches: all.length, nth, line: m.line.s };
}

/** How many times `text` is printed on the page (by the same rules as findText). */
function countText(pages, q) {
  return matchesOf(pages, q).length;
}

function matchesOf(pages, q) {
  const pg = (pages || []).find((p) => p.page === q.page);
  const text = String(q.text === undefined ? '' : q.text);
  if (!pg || !text.trim()) return [];
  const lines = buildLines(pg.items);
  const exact = [];
  for (const line of lines) for (const i of occurrences(line.s, text)) exact.push({ line, a: i, b: i + text.length });
  if (exact.length) return exact;
  const want = normalise(text.trim()).s;
  const loose = [];
  for (const line of lines) {
    const n = normalise(line.s);
    for (const i of occurrences(n.s, want)) loose.push({ line, a: n.from[i], b: n.from[i + want.length - 1] + 1 });
  }
  return loose;
}

/** Bigrams of a string, for judging how alike two strings are. */
function bigrams(s) {
  const t = normalise(s).s.trim();
  const m = new Map();
  for (let i = 0; i + 1 < t.length; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) || 0) + 1);
  return { m, n: Math.max(0, t.length - 1), t };
}

/** The printed lines on a page that look most like `text` (best first), at most `limit`; for an error message. */
function closestLines(pages, page, text, limit) {
  const pg = (pages || []).find((p) => p.page === page);
  if (!pg) return [];
  const want = bigrams(text);
  const lines = (pg.text || buildLines(pg.items).map((l) => ({ text: l.s }))).map((l) => l.text);
  const score = (line) => {
    const b = bigrams(line);
    if (b.t.includes(want.t) || want.t.includes(b.t)) return 1;
    let common = 0;
    for (const [k, v] of want.m) common += Math.min(v, b.m.get(k) || 0);
    return want.n + b.n ? (2 * common) / (want.n + b.n) : 0;
  };
  return lines
    .map((l, i) => ({ l, i, sc: score(l) }))
    .sort((a, b) => b.sc - a.sc || a.i - b.i)
    .slice(0, limit || 5)
    .map((e) => e.l);
}

module.exports = { findText, countText, closestLines };
