#!/usr/bin/env node
/*
 * Step 1 of a held-out likeness test: does the engine write words the way the writer really does?
 *
 *   node tools/likeness.js my-handwriting.json strokes.json [folds=5] [seeds=4]
 *   python3 tools/likeness.py strokes.json            (needs numpy, pillow, scikit-learn)
 *
 * The recorded words are split into folds by their text. For each fold a style is built WITHOUT those words, the engine writes
 * them back (seeds times each, the Write tab's default look unless HW_OPTS holds JSON overrides), and the strokes of the real
 * word and of every rendering go to the output file for likeness.py. A word that is also inside a recorded line is not held
 * out (its letters would leak). The output holds the writer's own strokes: it is private, like the samples.
 */
'use strict';
const fs = require('fs');
const St = require('../src/style');
const Y = require('../src/synth');
const G = require('../src/geometry');
const Al = require('../src/align');

const [samples, out, foldsArg, seedsArg] = process.argv.slice(2);
if (!samples || !out) {
  console.error('usage: node tools/likeness.js my-handwriting.json strokes.json [folds=5] [seeds=4]');
  process.exit(1);
}
const FOLDS = +foldsArg || 5;
const SEEDS = +seedsArg || 4;
const OPTS = Object.assign({ xh: 34, width: 900, messiness: 0.3, variation: 0.4, neatness: 0.5, wordReuse: 0.25, margin: 10 }, JSON.parse(process.env.HW_OPTS || '{}'));

const raw = St.fromJSON(fs.readFileSync(samples, 'utf8'));
const lineTokens = new Set();
for (const w of raw) if (w.line) for (const t of w.text.toLowerCase().split(/[^a-z0-9]+/)) if (t) lineTokens.add(t);
const isLetters = (w) => !w.iso && !w.line && /^[A-Za-z]{2,}$/.test(w.text) && !lineTokens.has(w.text.toLowerCase());
const isDigits = (w) => !w.iso && !w.line && /^[0-9][0-9.]*$/.test(w.text) && w.text.length >= 2;
const evalWords = raw.filter((w) => isLetters(w) || isDigits(w));

// a deterministic fold for each distinct text
const texts = [...new Set(evalWords.map((w) => w.text))].sort();
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const order = texts.map((t) => [rnd(), t]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const foldOf = new Map(order.map((t, i) => [t, i % FOLDS]));

/** The real word, cleaned the way the engine cleans a recorded stroke (resample and smooth), in pixels. */
function realStrokes(w) {
  const step = Al.STEP * w.xh;
  return w.strokes.map((st) => {
    const pts = st.map((p) => ({ x: p[0], y: p[1], t: p[2], p: p[3] }));
    const rs = G.resample(pts, step);
    const sm = rs.length >= 8 ? G.smooth(rs, 2.4, ['p']) : rs;
    return sm.map((p) => [p.x, p.y]);
  });
}

const items = [];
for (let f = 0; f < FOLDS; f++) {
  const held = new Set(texts.filter((t) => foldOf.get(t) === f));
  const style = St.buildStyle(raw.filter((w) => !(held.has(w.text) && !w.line && !w.iso)));
  console.error('fold ' + (f + 1) + '/' + FOLDS + ': ' + held.size + ' words held out');
  for (const w of evalWords.filter((x) => held.has(x.text))) items.push({ text: w.text, kind: isDigits(w) ? 'digits' : 'letters', label: 'real', seed: 0, strokes: realStrokes(w) });
  for (const t of held) {
    for (let s = 1; s <= SEEDS; s++) {
      const lay = Y.layout(style, t, Object.assign({}, OPTS, { seed: s }));
      if (lay.missing && lay.missing.length) continue;
      items.push({ text: t, kind: /^[0-9]/.test(t) ? 'digits' : 'letters', label: 'gen', seed: s, strokes: lay.strokes.map((st) => st.pts.map((p) => [p.x, p.y])) });
    }
  }
}
fs.writeFileSync(out, JSON.stringify({ folds: FOLDS, seeds: SEEDS, items }));
const n = (k, l) => items.filter((i) => i.kind === k && i.label === l).length;
console.error(`written ${out}: letters ${n('letters', 'real')} real / ${n('letters', 'gen')} generated, digits ${n('digits', 'real')} real / ${n('digits', 'gen')} generated`);
