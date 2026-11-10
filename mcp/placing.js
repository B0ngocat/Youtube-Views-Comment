'use strict';
/*
 * Placing answers on a worksheet without arithmetic: find the printed text an answer belongs to (after_text), the ruled line
 * or blank space next to it, the run of evenly spaced rules under it (so a wrapped answer lands on each rule), and say when
 * the writing ends up over printed text, over another answer, or off the page. Pure: it works on the data pdfinfo.inspect()
 * returns (pages: [{page, width, height, text, items, rules, boxes}]) and on layouts from sheet.layoutBox, so the build
 * without PDF support can carry it. Positions are points from the page's top-left corner, y down, as everywhere in the tools.
 */
const Anchors = require('./anchors');

const GAP = 4; // pt between printed text and an answer placed next to it
const MARGIN = 36; // the page margin an answer may not enter
const LIFT = 0.45; // x-heights an answer's baseline sits above its line (sheet.layoutBox does the same)
const TOUCH = 1.5; // pt of overlap that is not worth a warning
const PLACES = ['auto', 'line', 'right', 'below'];
const MIN_PITCH = 10;
const MAX_PITCH = 60;

const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

// ---- runs of evenly spaced rules --------------------------------------------------------------------

/**
 * Splits the rules of a page into runs: rules with the same x (within 3 pt) and about the same width, one under the other at a
 * regular spacing (equal within 1 pt, between 10 and 60 pt). Every rule is in exactly one run; a lone rule is a run of one.
 * Returns [{rules: [...], pitch}] (pitch is null for a run of one).
 */
function ruleRuns(rules) {
  const sorted = (rules || []).slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const used = new Set();
  const runs = [];
  for (const first of sorted) {
    if (used.has(first)) continue;
    used.add(first);
    const run = [first];
    let pitch = null;
    for (;;) {
      const cur = run[run.length - 1];
      const like = (c) => !used.has(c) && Math.abs(c.x - cur.x) <= 3 && Math.abs(c.w - cur.w) <= Math.max(3, 0.04 * cur.w);
      let next;
      if (pitch === null) {
        next = sorted.filter((c) => like(c) && c.y - cur.y >= MIN_PITCH && c.y - cur.y <= MAX_PITCH).sort((a, b) => a.y - b.y)[0];
        if (next) pitch = next.y - cur.y;
      } else next = sorted.find((c) => like(c) && Math.abs(c.y - cur.y - pitch) <= 1);
      if (!next) break;
      used.add(next);
      run.push(next);
    }
    runs.push({ rules: run, pitch: run.length > 1 ? (run[run.length - 1].y - run[0].y) / (run.length - 1) : null });
  }
  return runs;
}

/** The rules of a page's run that a rule is in, from that rule down: {count, pitch, index (from 0), total}, or null for a lone rule. */
function followFrom(pg, rule) {
  for (const run of ruleRuns(pg.rules)) {
    const index = run.rules.indexOf(rule);
    if (index < 0) continue;
    if (run.rules.length < 2) return null;
    return { count: run.rules.length - index, pitch: run.pitch, index, total: run.rules.length };
  }
  return null;
}

/** The printed rule an answer box sits on (its line_y within 1.5 pt, overlapping it sideways), or null. */
function ruleAt(pg, x, width, lineY) {
  let best = null;
  for (const r of (pg && pg.rules) || []) {
    if (Math.abs(r.y - lineY) > 1.5 || r.x > x + width + 2 || r.x + r.w < x - 2) continue;
    if (!best || Math.abs(r.y - lineY) < Math.abs(best.y - lineY)) best = r;
  }
  return best;
}

// ---- inspect_pdf: what a rule follows -----------------------------------------------------------------

/** For every rule of a page, text to append to its `line` row in inspect_pdf ('' when there is nothing to say). */
function ruleLabels(pg) {
  const runs = ruleRuns(pg.rules);
  return (pg.rules || []).map((rule) => {
    const bits = [];
    const row = (pg.text || []).filter((t) => rule.y >= t.y - 0.5 && rule.y <= t.baseline + 6 && t.x + t.w <= rule.x + 2).sort((a, b) => b.x + b.w - (a.x + a.w))[0];
    if (row) bits.push(`after "${row.text.length > 40 ? '...' + row.text.slice(-37) : row.text}"`);
    for (const run of runs) {
      const index = run.rules.indexOf(rule);
      if (index >= 0 && run.rules.length > 1) bits.push(`line ${index + 1} of ${run.rules.length}, ${Math.round(run.pitch * 10) / 10} pt apart`);
    }
    return bits.join(', ');
  });
}

// ---- after_text -------------------------------------------------------------------------------------------

/** The printed rule that belongs to the text at rect: on its row to the right, else the first one under it before other printed text. */
function findRule(pg, rect) {
  const rules = pg.rules || [];
  const base = rect.y + rect.h;
  const right = rect.x + rect.w;
  const row = rules.filter((r) => r.y >= rect.y - 0.5 && r.y <= base + 6 && r.x >= right - 2).sort((a, b) => a.x - b.x)[0];
  if (row) return { rule: row, below: false };
  const under = rules.filter((r) => r.y > base + 6 && r.x <= right + 40 && r.x + r.w >= rect.x).sort((a, b) => a.y - b.y);
  for (const r of under) {
    // printed text between the anchor and this rule means the rule belongs to that text, and so does every rule further down
    const between = (pg.text || []).some((t) => t.baseline > base + 2 && t.y < r.y - 1 && t.x < r.x + r.w && t.x + t.w > r.x);
    if (between) return null;
    return { rule: r, below: true };
  }
  return null;
}

/** The blank space to the right of the text at rect on its row: {x, width} from a small gap after the text to the next printed text or the margin. */
function rightSpace(pg, rect, size) {
  const base = rect.y + rect.h;
  let right = rect.x + rect.w;
  const onRow = (it) => it.y < base - 1 && it.baseline > rect.y + 0.5 * rect.h;
  // the rest of the item the match is inside ("3." of "3. Solve x") is still printed text: the space starts after it
  for (const it of pg.items || []) if (onRow(it) && it.x < right - 0.5 && it.x + it.w > rect.x) right = Math.max(right, it.x + it.w);
  let limit = size.w - MARGIN;
  for (const it of pg.items || []) if (onRow(it) && it.x >= right - 1 && it.x - GAP < limit) limit = it.x - GAP;
  const x = right + GAP;
  return { x, width: limit - x, baseline: base };
}

/** The blank space under the text at rect, from its left edge to the next printed text under it: {x, top, avail}. */
function belowSpace(pg, rect, size, width) {
  const base = rect.y + rect.h;
  const x = rect.x;
  const w = width > 0 ? width : size.w - MARGIN - x;
  const top = base + GAP;
  let limit = size.h - MARGIN;
  for (const it of pg.items || []) if (it.y > base + 1 && it.x < x + w && it.x + it.w > x && it.y - 3 < limit) limit = it.y - 3;
  return { x, top, avail: limit - top, width: w };
}

/**
 * Where an answer goes, from printed text. q: {page (from 1), text, nth, place, xh, size: {w, h}, width (explicit, optional), where}.
 * Throws an Error an assistant can act on when the text is not printed, or when `place` finds nothing.
 * Returns {mode: 'line'|'right'|'below', x, width, lineY (line and right) or top and avail (below), rule, ruleBelow, matches, nth, text}.
 */
function resolve(pages, q) {
  const where = q.where;
  const place = q.place === undefined || q.place === null || q.place === '' ? 'auto' : q.place;
  if (!PLACES.includes(place)) throw new Error(`${where}: place ${JSON.stringify(q.place)} is not one of ${PLACES.join(', ')}.`);
  const hit = Anchors.findText(pages, { page: q.page, text: q.text, nth: q.nth });
  if (!hit) {
    const near = Anchors.closestLines(pages, q.page, q.text, 5);
    throw new Error(`${where}: the text ${JSON.stringify(q.text)} is not printed on page ${q.page}. ${near.length ? 'The closest printed lines on that page are:\n' + near.map((l) => `  "${l.slice(0, 90)}"`).join('\n') : 'There is no printed text on that page.'}\nCheck the spelling against inspect_pdf, or place the answer with x, line_y (or y) and width instead of after_text.`);
  }
  if (!hit.rect) throw new Error(`${where}: nth is ${hit.nth} but ${JSON.stringify(q.text)} is printed only ${hit.matches} time${hit.matches === 1 ? '' : 's'} on page ${q.page}.`);
  const pg = pages.find((p) => p.page === q.page);
  const rect = hit.rect;
  const base = { rect, matches: hit.matches, nth: hit.nth, text: q.text };
  const line = () => {
    const f = findRule(pg, rect);
    return f && { mode: 'line', x: f.rule.x, width: f.rule.w, lineY: f.rule.y, rule: f.rule, ruleBelow: f.below };
  };
  const right = () => {
    const s = rightSpace(pg, rect, q.size);
    return { mode: 'right', x: s.x, width: s.width, lineY: s.baseline + LIFT * q.xh };
  };
  const below = () => {
    const s = belowSpace(pg, rect, q.size, q.width);
    return { mode: 'below', x: s.x, width: s.width, top: s.top, avail: s.avail };
  };
  let out;
  if (place === 'line') {
    out = line();
    if (!out) throw new Error(`${where}: place "line" found no printed ruled line for ${JSON.stringify(q.text)} on page ${q.page}: none on its row to the right of it, and none under it before the next printed text (inspect_pdf only lists rules of 36 pt or more; min_rule_pt lowers that). What to do: use place "right" (the blank space on its row) or "below", or give x, line_y and width yourself.`);
  } else if (place === 'right') {
    out = right();
    if (out.width < 20) throw new Error(`${where}: place "right" has no room: only ${r1(Math.max(0, out.width))} pt are free to the right of ${JSON.stringify(q.text)} before the next printed text or the margin. Use place "below" or give x, y and width yourself.`);
  } else if (place === 'below') {
    out = below();
    if (out.avail < 12) throw new Error(`${where}: place "below" has no room: only ${r1(Math.max(0, out.avail))} pt are free under ${JSON.stringify(q.text)} before the next printed text. Give x, y and width yourself.`);
  } else {
    out = line();
    if (!out) {
      const r = right();
      out = r.width >= 60 ? r : below();
      if (out.mode === 'below' && out.avail < 12) throw new Error(`${where}: no printed line, no room to the right (${r1(Math.max(0, r.width))} pt) and no room under ${JSON.stringify(q.text)} (${r1(Math.max(0, out.avail))} pt) before the next printed text. Give x, y and width yourself.`);
    }
  }
  return Object.assign(base, out);
}

/** The words that say what after_text resolved to, for the answer's report line. */
function describe(r, final) {
  const t = JSON.stringify(r.text);
  const more = r.matches > 1 ? (r.nthGiven ? ` (match ${r.nth} of ${r.matches})` : ` (first of ${r.matches} matches)`) : '';
  if (r.mode === 'line') return `placed on the printed line ${r.ruleBelow ? 'below' : 'after'} ${t} (x ${r1(final.x)}, line_y ${r1(final.lineY)}, width ${r1(final.width)})${more}`;
  if (r.mode === 'right') return `placed to the right of ${t} on its baseline (x ${r1(final.x)}, line_y ${r1(final.lineY)}, width ${r1(final.width)})${more}`;
  return `placed below ${t} (x ${r1(final.x)}, y ${r1(final.y)}, width ${r1(final.width)}, height ${r1(final.h)})${more}`;
}

// ---- warnings ---------------------------------------------------------------------------------------------

/**
 * The ink of a placed answer as boxes in page points, one per line of writing: [{x0, y0, x1, y1}]. A stroke belongs to the line
 * whose baseline is nearest its middle. Same mapping as sheet.writeInk: layout px -> box.x + (px - dx) * K.
 */
function inkBoxes(box, placed) {
  const lay = placed.layout;
  const bases = lay.baselines && lay.baselines.length ? lay.baselines : [0];
  const pen = 0.06 * placed.xhPt; // half the constant pen
  const boxes = bases.map(() => null);
  for (const st of lay.strokes) {
    if (!st.pts || !st.pts.length) continue;
    const mid = st.pts.reduce((s, p) => s + p.y, 0) / st.pts.length;
    let li = 0;
    for (let i = 1; i < bases.length; i++) if (Math.abs(bases[i] - mid) < Math.abs(bases[li] - mid)) li = i;
    let b = boxes[li];
    if (!b) b = boxes[li] = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of st.pts) {
      const X = box.x + (p.x - placed.dx) * placed.K;
      const Y = box.y + (p.y - placed.dy) * placed.K;
      if (X - pen < b.x0) b.x0 = X - pen;
      if (X + pen > b.x1) b.x1 = X + pen;
      if (Y - pen < b.y0) b.y0 = Y - pen;
      if (Y + pen > b.y1) b.y1 = Y + pen;
    }
  }
  return boxes.filter(Boolean);
}

const overlap = (a, b) => ({ dx: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), dy: Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) });

/**
 * WARNING lines for what is wrong with the finished placement. answers: [{label, page (from 0), boxes: inkBoxes(...)}].
 * printed: inspect() data (or null: then only the other answers and the page edge are checked). sizes: [{w, h}] per page.
 * Quiet (an empty list) when nothing is wrong. The printed line boxes are shrunk by 1.5 pt and a touch under 1.5 pt is ignored,
 * so an answer on the line beside its label does not warn.
 */
function warnings(answers, printed, sizes) {
  const out = [];
  for (const a of answers) {
    const sz = sizes[a.page];
    const tot = a.boxes.reduce((t, b) => ({ x0: Math.min(t.x0, b.x0), y0: Math.min(t.y0, b.y0), x1: Math.max(t.x1, b.x1), y1: Math.max(t.y1, b.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const off = [];
    if (tot.x0 < -0.5) off.push(`${r1(-tot.x0)} pt past the left edge`);
    if (tot.y0 < -0.5) off.push(`${r1(-tot.y0)} pt past the top edge`);
    if (sz && tot.x1 > sz.w + 0.5) off.push(`${r1(tot.x1 - sz.w)} pt past the right edge`);
    if (sz && tot.y1 > sz.h + 0.5) off.push(`${r1(tot.y1 - sz.h)} pt past the bottom edge`);
    if (off.length) out.push(`WARNING: ${a.label}: the writing leaves the page: ${off.join(', ')}. Move or narrow the box, or write less.`);
    const pg = printed && printed[a.page];
    if (pg) {
      for (const t of pg.text || []) {
        const tb = { x0: t.x + TOUCH, y0: t.y + TOUCH, x1: t.x + t.w - TOUCH, y1: t.y + t.h - TOUCH };
        let best = null;
        for (const b of a.boxes) {
          const o = overlap(b, tb);
          if (o.dx > TOUCH && o.dy > TOUCH && (!best || o.dx * o.dy > best.dx * best.dy)) best = o;
        }
        if (best) out.push(`WARNING: ${a.label}: the writing covers the printed text "${clip(t.text, 50)}" (x ${r1(t.x)}, y ${r1(t.y)}) by ${r1(best.dx)} x ${r1(best.dy)} pt. Move the answer, or use after_text to place it.`);
      }
    }
  }
  for (let i = 0; i < answers.length; i++) {
    for (let j = i + 1; j < answers.length; j++) {
      if (answers[i].page !== answers[j].page) continue;
      let best = null;
      for (const a of answers[i].boxes) for (const b of answers[j].boxes) {
        const o = overlap(a, b);
        if (o.dx > TOUCH && o.dy > TOUCH && (!best || o.dx * o.dy > best.dx * best.dy)) best = o;
      }
      if (best) out.push(`WARNING: ${answers[i].label} and ${answers[j].label} overlap by ${r1(best.dx)} x ${r1(best.dy)} pt. Move one of them.`);
    }
  }
  return out;
}

module.exports = { ruleRuns, followFrom, ruleAt, ruleLabels, resolve, describe, inkBoxes, warnings, PLACES, LIFT, MIN_PITCH, MAX_PITCH };
