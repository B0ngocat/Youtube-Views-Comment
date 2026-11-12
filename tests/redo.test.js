'use strict';
// "Redo one word": draw one word (or one piece of math) again and keep every other word's examples exactly as they were.
// Engine level (synth.layout / mixed.layout with opts.redo), Sheet.layoutBox, and the tools (write_text, write_batch, fill_pdf,
// the one-file build). The fake writer has no digits, so the words here are plain words; the rules are the same for a "9.81".
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { corpus, CORPUS } = require('./fixtures');
const { writeWord, GLYPHS } = require('./synth-writer');
const S = require('../src/style');
const Y = require('../src/synth');
const X = require('../src/mixed');
const M = require('../src/math');
const Sheet = require('../src/sheet');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { createServer } = require('../mcp/server');
const { build } = require('../scripts/build-mcp');

const style = corpus('print').style;
// Digits for the fake writer (it has none): ten distinct skeletons, 1.7 tall, so numbers in math have something to be written with.
// A separate writer for the math tests: the corpus words, two copies of every single digit, and a few numbers.
for (let d = 0; d < 10; d++) GLYPHS[String(d)] = [0.5, [[0.05 + 0.02 * d, 0.1], [0.1 + 0.03 * d, 0.9], [0.45 - 0.02 * d, 1.7], [0.3, 0.8], [0.1 + 0.04 * ((d * 3) % 7), 0.05], [0.5, 0.1]], null, true];
const digitRaws = () => {
  const words = [];
  for (let rep = 0; rep < 3; rep++) for (const d of '0123456789') words.push(d);
  words.push('9.81', '4.5', '123', '9.8', '1.2', '45', '18', 'a', 'b', 'c', 'd', 'e', 'f', 'x', 'y', 'F', 'F');
  return corpus('print').raws.map((r, i) => writeWord(r.text, { style: 'print', seed: i + 1 })).concat(words.map((w, i) => writeWord(w, { style: 'print', seed: 2000 + i })));
};
const dstyle = S.buildStyle(digitRaws());
const MATH = 'F = 9.81 \\times 4.5 + 9.8 - ab';
const runIds = (lay) => lay.runBoxes[0].map((r) => (r ? r.ids.join(',') : null));
const hash = (l) => crypto.createHash('sha256').update(JSON.stringify(l.strokes)).digest('hex').slice(0, 16);
const TEXT = 'the quick brown fox jumps over the lazy dog, then the lazy dog sleeps and jumps over home';
const idsOf = (lay) => lay.words.map((w) => (w ? w.ids.join(',') : null));
const differing = (a, b) => idsOf(a).map((x, i) => (x !== idsOf(b)[i] ? i : -1)).filter((i) => i >= 0);
const unitsHash = (st) => crypto.createHash('sha256').update(JSON.stringify([...st.byChar].map(([c, l]) => [c, l.map((u) => [u.id, u.strokes, u.box])]))).digest('hex');

test('redo changes the chosen word and no other word keeps anything but its examples', () => {
  const base = Y.layout(style, TEXT, { seed: 3 });
  const r = Y.layout(style, TEXT, { seed: 3, redo: [{ word: 'quick' }] });
  assert.deepEqual(differing(base, r), [1], 'only word 1 (quick) has other examples');
  assert.equal(r.words[1].text, 'quick');
  assert.equal(r.words.length, base.words.length);
  assert.equal(r.redo.length, 1);
  assert.ok(r.redo[0].ok);
  assert.equal(r.redo[0].total, 5);
  assert.ok(r.redo[0].changed >= 1 && r.redo[0].changed <= 5);
  // everything else is the same letters (their compound words: none here), pinned including the whole-word copies that were pasted
  for (let i = 0; i < base.words.length; i++) if (i !== 1) assert.deepEqual(r.words[i].pins, base.words[i].pins, 'word ' + i);
});

test('redo is deterministic, and every take is a different drawing of the word', () => {
  const run = (take) => Y.layout(style, TEXT, { seed: 5, redo: [{ word: 'jumps', nth: 2, take }] });
  assert.equal(hash(run(1)), hash(run(1)), 'same arguments, same strokes');
  const plain = Y.layout(style, TEXT, { seed: 5 });
  const target = 15; // the second "jumps"
  assert.equal(plain.words[target].text, 'jumps');
  const seen = new Set([plain.words[target].ids.join()]);
  for (const take of [1, 2, 3]) {
    const l = run(take);
    assert.deepEqual(differing(plain, l), [target], 'take ' + take + ' only touches the target');
    const key = l.words[target].ids.join();
    assert.ok(!seen.has(key), 'take ' + take + ' differs from the plain drawing and the takes before it');
    seen.add(key);
    assert.equal(l.redo[0].usedTake, take);
  }
  assert.notEqual(hash(run(1)), hash(run(2)));
});

test('without redo (or with an empty list) the output is the plain output', () => {
  const base = Y.layout(style, TEXT, { seed: 3 });
  assert.equal(hash(Y.layout(style, TEXT, { seed: 3, redo: [] })), hash(base));
  assert.equal(base.redo, undefined);
});

test('which word: the whole token first, then without punctuation; nth; first of N; not found', () => {
  const t = 'we saw the dog, and the dog, and a dog';
  const r = Y.layout(style, t, { seed: 2, redo: [{ word: 'dog' }] }); // whole token "dog" is the last word
  assert.equal(r.redo[0].matches, 1);
  const n = r.words.findIndex((w) => w.text === 'dog');
  assert.equal(r.words[n].text, 'dog');
  const base = Y.layout(style, t, { seed: 2 });
  assert.deepEqual(differing(base, r), [n]);
  const p = Y.layout(style, 'we saw the dog, and the dog,', { seed: 2, redo: [{ word: 'dog' }] }); // only "dog," exists: punctuation is ignored
  assert.equal(p.redo[0].text, 'dog,');
  assert.equal(p.redo[0].matches, 2);
  assert.equal(p.redo[0].nth, null, 'no nth was given, so the report says first of 2');
  assert.deepEqual(differing(Y.layout(style, 'we saw the dog, and the dog,', { seed: 2 }), p), [3]);
  const q = Y.layout(style, 'we saw the dog, and the dog,', { seed: 2, redo: [{ word: '(dog)', nth: 2 }] });
  assert.equal(q.redo[0].nth, 2);
  assert.equal(q.words[6].text, 'dog,');
  assert.deepEqual(differing(Y.layout(style, 'we saw the dog, and the dog,', { seed: 2 }), q), [6]);
  assert.throws(() => Y.layout(style, t, { seed: 2, redo: [{ word: 'cat' }] }), (e) => e.redo === true && /"cat" is not in the text\. The words are: "we", "saw", "the", "dog,"/.test(e.message));
  assert.throws(() => Y.layout(style, t, { seed: 2, redo: [{ word: 'saw', nth: 2 }] }), (e) => /has 1 match, so nth 2 does not exist/.test(e.message));
  assert.throws(() => Y.layout(style, t, { seed: 2, redo: [{ word: 'saw' }, { word: 'saw' }] }), (e) => /listed twice/.test(e.message));
});

test('several words in one call: each is redone, nothing else moves', () => {
  const base = Y.layout(style, TEXT, { seed: 4 });
  const r = Y.layout(style, TEXT, { seed: 4, redo: [{ word: 'fox' }, { word: 'sleeps', take: 2 }] });
  assert.deepEqual(differing(base, r), [3, 13]);
  assert.equal(r.redo.length, 2);
  assert.equal(r.redo[1].usedTake, 2);
});

test('a word with only one usable example per letter cannot change: it is drawn as it was, and the report says why', () => {
  // a writer who wrote the letter z once (in "lazy") and no word "z"
  const words = corpus('print', 1).raws.filter((w) => !/z/.test(w.text) || w.text === 'lazy').map((w, i) => writeWord(w.text, { style: 'print', seed: i + 40 }));
  const st = S.buildStyle(words);
  assert.equal(st.byChar.get('z').length, 1);
  const base = Y.layout(st, 'the z fox', { seed: 1 });
  const r = Y.layout(st, 'the z fox', { seed: 1, redo: [{ word: 'z' }] });
  assert.equal(r.redo[0].ok, false);
  assert.equal(r.redo[0].changed, 0);
  assert.match(r.redo[0].reason, /only one usable example of z/);
  assert.equal(hash(r), hash(base), 'the plain drawing');
  assert.deepEqual(differing(base, r), []);
  // asking for a take beyond what exists draws the last one that does
  const two = Y.layout(corpus('print').style, 'the fox', { seed: 1, redo: [{ word: 'the', take: 40 }] });
  assert.ok(two.redo[0].usedTake >= 1);
});

test('a crossed-out example never comes back, by the redo or by a pin', () => {
  const raws = corpus('print').raws.map((w, i) => writeWord(w.text, { style: 'print', seed: i + 70 }));
  // cross out one letter of every other copy of "quick" and "lazy"
  raws.forEach((w, i) => {
    if (w.text === 'quick' && i % 2 === 0) w.skip = [{ i: 1, ch: 'u' }];
    if (w.text === 'lazy' && i % 2 === 0) w.skip = [{ i: 1, ch: 'a' }];
  });
  const st = S.buildStyle(raws);
  const gone = new Set();
  for (const list of st.allByChar.values()) for (const u of list) if (u.skipped) gone.add(u.id);
  assert.ok(gone.size >= 2, 'the writer crossed some out');
  for (const take of [1, 2, 3, 4]) {
    const r = Y.layout(st, 'quick lazy quick lazy', { seed: 8, redo: [{ word: 'quick', take }, { word: 'lazy', take }] });
    for (const w of r.words) for (const id of w.ids) assert.ok(!gone.has(id), 'a crossed-out example was drawn');
  }
  // a pin that names a crossed-out example is ignored
  const [id] = gone;
  const ch = st.unitById.get(id).ch;
  const pinned = Y.layout(st, ch, { seed: 1, pins: [[id]] });
  assert.ok(!pinned.words[0].ids.includes(id));
});

test('no cached unit is changed by a redo (text, mixed)', () => {
  const st = S.buildStyle(corpus('print').raws.map((w, i) => writeWord(w.text, { style: 'print', seed: i + 300 })));
  const before = unitsHash(st);
  Y.layout(st, TEXT, { seed: 3, redo: [{ word: 'quick', take: 2 }, { word: 'lazy', nth: 2 }] });
  X.layout(st, 'the lazy $\\frac{a}{b}$, and $x$ dog', { seed: 3, redo: [{ math: 1 }, { word: 'lazy' }] });
  assert.equal(unitsHash(st), before);
});

// ---- mixed ----------------------------------------------------------------------------------------

const MIX = 'the lazy $\\frac{a}{b}$, and the dog $x + y$. so $x$, jumps over the quick fox';
// the same writer, who has also written a comma and a full stop at the end of words
const mstyle = S.buildStyle(corpus('print').raws.map((r, i) => writeWord(r.text, { style: 'print', seed: i + 1 })).concat(['dog,', 'fox.', 'cat,', 'hen.', 'jug,', 'box.', 'a,', 'b.'].map((w, i) => writeWord(w, { style: 'print', seed: 900 + i }))));

test('mixed: a plain word is redone, and the words stuck to a piece of math keep their letters', () => {
  const base = X.layout(mstyle, MIX, { seed: 6 });
  const r = X.layout(mstyle, MIX, { seed: 6, redo: [{ word: 'quick' }] });
  const n = base.words.findIndex((w) => w && w.text === 'quick');
  assert.deepEqual(differing(base, r), [n]);
  base.words.forEach((w, i) => {
    if (i === n) return;
    assert.deepEqual(r.words[i].pins, w.pins, 'word ' + i + ' (' + w.text + ')');
  });
  assert.ok(base.words.some((w) => w.compound && w.pins.some((p) => p)), 'there are words stuck to math that hold letters (the comma and the full stop)');
  assert.deepEqual(r.mathIds, base.mathIds, 'the math was not touched');
  assert.equal(hash(X.layout(mstyle, MIX, { seed: 6, redo: [{ word: 'quick' }] })), hash(r), 'deterministic');
});

test('mixed: a piece of math is one word; by its TeX or by number', () => {
  const base = X.layout(mstyle, MIX, { seed: 6 });
  const byTex = X.layout(mstyle, MIX, { seed: 6, redo: [{ word: 'x + y' }] });
  const byNum = X.layout(mstyle, MIX, { seed: 6, redo: [{ math: 2 }] });
  for (const r of [byTex, byNum]) {
    assert.deepEqual(differing(base, r), [], 'no plain word changed');
    assert.equal(r.redo[0].text, '$x + y$');
    assert.ok(r.redo[0].ok);
    assert.deepEqual(r.mathIds[0], base.mathIds[0]);
    assert.deepEqual(r.mathIds[2], base.mathIds[2]);
    assert.notDeepEqual(r.mathIds[1], base.mathIds[1]);
  }
  assert.equal(hash(byTex), hash(byNum), 'the same piece, the same take, the same drawing');
  const t2 = X.layout(mstyle, MIX, { seed: 6, redo: [{ math: 2, take: 2 }] });
  assert.notDeepEqual(t2.mathIds[1], byNum.mathIds[1]);
  assert.throws(() => X.layout(mstyle, MIX, { seed: 6, redo: [{ math: 4 }] }), (e) => e.redo && /math piece 4 is not in the text/.test(e.message) && /1: \\frac\{a\}\{b\}/.test(e.message));
  assert.throws(() => X.layout(mstyle, MIX, { seed: 6, redo: [{ word: 'lazyy' }] }), (e) => /The pieces of math are: 1: /.test(e.message));
});

test('mixed: a word with no math in it works like text mode', () => {
  const base = X.layout(style, 'one lazy dog and the lazy fox', { seed: 2 });
  const r = X.layout(style, 'one lazy dog and the lazy fox', { seed: 2, redo: [{ word: 'lazy', nth: 2 }] });
  assert.deepEqual(differing(base, r), [5]);
});

// ---- kind math: a written run (a number, a letter run) ----------------------------------------------

test('math: a run is redone, every other run keeps its examples, whatever the run is', () => {
  const base = M.layout(dstyle, MATH, { seed: 5 });
  const ids = runIds(base);
  assert.equal(ids.length, 5, 'F, 9.81, 4.5, 9.8, ab (the operators are drawn stand-ins, not written runs): ' + ids.length);
  assert.ok(base.runBoxes[0].some((r) => r.text === '9.81'));
  for (const word of ['F', '9.81', '4.5', '9.8', 'ab']) {
    const r = M.layout(dstyle, MATH, { seed: 5, redo: [{ word }] });
    const after = runIds(r);
    assert.equal(after.length, ids.length, 'the same runs are written, in the same order');
    const changed = ids.map((x, i) => (x !== after[i] ? i : -1)).filter((i) => i >= 0);
    assert.ok(changed.length <= 1, word + ' changed runs ' + changed);
    if (changed.length) assert.equal(base.runBoxes[0][changed[0]].text, word);
    assert.ok(r.redo[0].ok || /only one usable|no other example/.test(r.redo[0].reason));
    assert.equal(r.strokes.length > 0, true);
  }
  const r = M.layout(dstyle, MATH, { seed: 5, redo: [{ word: '9.81' }] });
  assert.ok(r.redo[0].ok, '9.81 has other examples');
  assert.ok(r.redo[0].changed >= 1 && r.redo[0].total === 4);
});

test('math: nothing else moves; the redone number is the only different ink and the rest sits where it was', () => {
  const base = M.layout(dstyle, MATH, { seed: 5 });
  const r = M.layout(dstyle, MATH, { seed: 5, redo: [{ word: '4.5' }] });
  // the shared stream is untouched: the runs before the target have exactly the same strokes
  const k = base.runBoxes[0].findIndex((q) => q && q.text === '4.5');
  const ptsBefore = (lay) => lay.strokes.filter((s) => s.pts[0].x < Math.min(...base.strokes.map((q) => q.pts[0].x)) + 1e9);
  assert.equal(ptsBefore(base).length > 0, true);
  assert.deepEqual(runIds(r).slice(0, k), runIds(base).slice(0, k));
  assert.deepEqual(runIds(r).slice(k + 1), runIds(base).slice(k + 1));
  const n = Math.min(base.strokes.length, r.strokes.length);
  let same = 0;
  for (let i = 0; i < n; i++) if (JSON.stringify(base.strokes[i].pts.map((p) => p.y)) === JSON.stringify(r.strokes[i].pts.map((p) => p.y))) same++;
  assert.ok(same >= n - 12, 'most strokes (all but the number\'s) are identical: ' + same + ' of ' + n);
});

test('math: deterministic, take 2 is another drawing than take 1 and the plain one, nth picks one run', () => {
  const run = (o) => M.layout(dstyle, MATH, Object.assign({ seed: 5 }, o));
  assert.equal(hash(run({ redo: [{ word: '9.81' }] })), hash(run({ redo: [{ word: '9.81' }] })));
  const plain = runIds(run({}));
  const k = run({}).runBoxes[0].findIndex((q) => q && q.text === '9.81');
  const t1 = runIds(run({ redo: [{ word: '9.81', take: 1 }] }))[k];
  const t2 = runIds(run({ redo: [{ word: '9.81', take: 2 }] }))[k];
  assert.notEqual(t1, plain[k]);
  assert.notEqual(t2, plain[k]);
  assert.notEqual(t2, t1);
  // 9.8 matches "9.8" exactly; "9.81" is not 9.8. A word with punctuation round it finds the run, and two matches say first of N
  const twice = M.layout(dstyle, '1 + 1 + 1', { seed: 2, redo: [{ word: '1', nth: 2 }] });
  assert.equal(twice.redo[0].matches, 3);
  assert.equal(twice.redo[0].nth, 2);
  const first = M.layout(dstyle, '1 + 1 + 1', { seed: 2, redo: [{ word: '1' }] });
  assert.equal(first.redo[0].nth, null);
  const base = M.layout(dstyle, '1 + 1 + 1', { seed: 2 });
  const diff = (a) => runIds(a).map((x, i) => (x !== runIds(base)[i] ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(diff(first), [0]);
  assert.deepEqual(diff(twice), [1]);
});

test('math: a run that is not there lists the runs; a run with one example cannot change', () => {
  assert.throws(() => M.layout(dstyle, MATH, { seed: 5, redo: [{ word: '7.7' }] }), (e) => e.redo && /"7\.7" is not in the text\. The written runs of the math are: "F", "9\.81", "4\.5"/.test(e.message));
  // a writer with one 8 only
  const raws = digitRaws().filter((w) => !/8/.test(w.text));
  raws.push(writeWord('8', { style: 'print', seed: 3001 }));
  const st = S.buildStyle(raws);
  assert.equal(st.byChar.get('8').length, 1);
  const base = M.layout(st, '8 + a', { seed: 1 });
  const r = M.layout(st, '8 + a', { seed: 1, redo: [{ word: '8' }] });
  assert.equal(r.redo[0].ok, false);
  assert.match(r.redo[0].reason, /only one usable example of 8/);
  assert.equal(hash(r), hash(base), 'drawn as it was');
});

test('math: no cached unit is changed; without redo the output is the plain output', () => {
  const st = S.buildStyle(digitRaws());
  const before = unitsHash(st);
  M.layout(st, MATH, { seed: 5, redo: [{ word: '9.81', take: 2 }, { word: 'F' }] });
  X.layout(st, 'so $F = 9.81 + 4.5$ and $9.8$ ok', { seed: 5, redo: [{ math: 1, word: '4.5' }, { math: 2 }] });
  assert.equal(unitsHash(st), before);
  assert.equal(hash(M.layout(st, MATH, { seed: 5, redo: [] })), hash(M.layout(st, MATH, { seed: 5 })));
  assert.equal(M.layout(st, MATH, { seed: 5 }).redo, undefined);
});

test('mixed: a run inside a piece of math, and the other pieces and words stay', () => {
  const T = 'so $F = 9.81 + 4.5$ and $9.8 - 1.2$ over the lazy dog';
  const base = X.layout(dstyle, T, { seed: 4 });
  const r = X.layout(dstyle, T, { seed: 4, redo: [{ math: 1, word: '4.5' }] });
  assert.deepEqual(differing(base, r), []);
  assert.deepEqual(r.mathIds[1], base.mathIds[1], 'the second piece is untouched');
  assert.notDeepEqual(r.mathIds[0], base.mathIds[0]);
  const a = base.runBoxes[0].map((q) => (q ? q.ids.join() : null));
  const b = r.runBoxes[0].map((q) => (q ? q.ids.join() : null));
  assert.equal(a.filter((x, i) => x !== b[i]).length, 1, 'one run of the first piece changed');
  assert.equal(r.redo[0].type, 'run');
  assert.throws(() => X.layout(dstyle, T, { seed: 4, redo: [{ math: 2, word: '4.5' }] }), (e) => /"4\.5" is not in the text.*written runs of the math are: "9\.8", "1\.2"/.test(e.message));
  // a word redone after a piece of math keeps the math as it was
  const w = X.layout(dstyle, T, { seed: 4, redo: [{ word: 'lazy' }] });
  assert.deepEqual(w.mathIds, base.mathIds);
});

test('write_text kind math: redo reports the run; kind math with redo is deterministic; not found stops before drawing', async () => {
  const a = await callD('write_text', { text: MATH, kind: 'math', format: 'svg', seed: 5, redo: [{ word: '9.81', take: 2 }] });
  const b = await callD('write_text', { text: MATH, kind: 'math', format: 'svg', seed: 5, redo: [{ word: '9.81', take: 2 }] });
  const plain = await callD('write_text', { text: MATH, kind: 'math', format: 'svg', seed: 5 });
  assert.ok(!a.result.isError, textOf(a));
  assert.match(textOf(a), /redo "9\.81" \(take 2\): \d of 4 characters changed\./);
  assert.equal(svgOf(a), svgOf(b));
  assert.notEqual(svgOf(a), svgOf(plain));
  const miss = await callD('write_text', { text: MATH, kind: 'math', redo: [{ word: '3.14' }] });
  assert.ok(miss.result.isError);
  assert.match(textOf(miss), /redo 1: "3\.14" is not in the text\. The written runs of the math are: "F"/);
  const mix = await callD('write_text', { text: 'so $F = 9.81 \\times 4.5$ ok', kind: 'mixed', format: 'svg', on_missing: 'fallback', redo: [{ math: 1, word: '9.81' }] });
  assert.ok(!mix.result.isError, textOf(mix));
  assert.match(textOf(mix), /redo "9\.81" \(in math piece 1, take 1\): \d of 4 characters changed\./);
});

test('the one-file build redoes a number in math', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-redo-math-bundle-'));
  fs.writeFileSync(path.join(dir, 'handwriting-mcp.js'), build({}));
  fs.copyFileSync(samplesD, path.join(dir, 'my-handwriting.json'));
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reply = await new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]));
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_text', arguments: { text: MATH, kind: 'math', format: 'svg', redo: [{ word: '9.81' }] } } }) + '\n');
    });
    assert.ok(!reply.result.isError, JSON.stringify(reply).slice(0, 300));
    assert.match(reply.result.content.map((c) => c.text || '').join(''), /redo "9\.81" \(take 1\): \d of 4 characters changed/);
  } finally {
    child.kill();
  }
});

// ---- Sheet.layoutBox ----------------------------------------------------------------------------

test('layoutBox carries box.redo through every pass of its fitting', () => {
  const box = (redo) => ({ page: 0, x: 0, y: 0, w: 120, h: 20, text: TEXT, kind: 'text', seed: 2, auto: true, minRatio: 0.5, growTo: 20, redo });
  const plain = Sheet.layoutBox(style, box(undefined), {});
  const red = Sheet.layoutBox(style, box([{ word: 'brown' }]), {});
  assert.ok(plain.shrunk, 'the box is too small, so the fit loop ran more than once');
  assert.equal(red.xhPt, plain.xhPt, 'the same size in the end');
  assert.equal(red.redo.length, 1);
  assert.ok(red.redo[0].ok);
  assert.deepEqual(differing(plain.layout, red.layout), [2]);
  assert.equal(plain.redo, null);
  assert.equal(Sheet.layoutBox(style, box(undefined), {}).layout.strokes.length, plain.layout.strokes.length, 'unchanged without redo');
  const tex = Sheet.layoutBox(dstyle, { page: 0, x: 0, y: 0, w: 300, h: 30, text: MATH, kind: 'math', seed: 1, redo: [{ word: '9.81' }] }, {});
  assert.equal(tex.redo.length, 1, 'kind math carries it too');
  assert.ok(tex.redo[0].ok);
});

// ---- tools --------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-redo-'));
const samples = path.join(tmp, 'my-handwriting.json');
fs.writeFileSync(samples, S.toJSON(corpus('print').raws.map((r, i) => writeWord(r.text, { style: 'print', seed: i + 1 }))));
const server = createServer({ samples, out: path.join(tmp, 'out') });
const samples1 = path.join(tmp, 'one-z', 'my-handwriting.json'); // z written once, in "lazy"
fs.mkdirSync(path.dirname(samples1));
fs.writeFileSync(samples1, S.toJSON(corpus('print', 1).raws.filter((w) => !/z/.test(w.text) || w.text === 'lazy').map((r, i) => writeWord(r.text, { style: 'print', seed: i + 40 }))));
const server1 = createServer({ samples: samples1, out: path.join(tmp, 'out1') });
const samplesD = path.join(tmp, 'digits', 'my-handwriting.json');
fs.mkdirSync(path.dirname(samplesD));
fs.writeFileSync(samplesD, S.toJSON(digitRaws()));
const serverD = createServer({ samples: samplesD, out: path.join(tmp, 'outD') });
let nextId = 1;
const callOn = (srv) => (name, args) => srv({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
const call = callOn(server);
const call1 = callOn(server1);
const callD = callOn(serverD);
const textOf = (r) => r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const svgOf = (r) => r.result.content.find((c) => c.type === 'text' && c.text.startsWith('<svg')).text;
const T2 = 'the lazy dog and the lazy fox jumps over a quick brown box';

test('write_text: redo reports each word, is deterministic, and changes the picture', async () => {
  const plain = await call('write_text', { text: T2, format: 'svg', seed: 4 });
  const a = await call('write_text', { text: T2, format: 'svg', seed: 4, redo: [{ word: 'lazy', nth: 2, take: 2 }] });
  const b = await call('write_text', { text: T2, format: 'svg', seed: 4, redo: [{ word: 'lazy', nth: 2, take: 2 }] });
  assert.ok(!a.result.isError, textOf(a));
  assert.match(textOf(a), /redo "lazy" \(nth 2, take 2\): \d of 4 characters changed\./);
  assert.equal(svgOf(a), svgOf(b));
  assert.notEqual(svgOf(a), svgOf(plain));
  const first = await call('write_text', { text: T2, format: 'svg', seed: 4, redo: [{ word: 'the', take: 1 }] });
  assert.match(textOf(first), /redo "the" \(take 1, first of 2\): \d of 3 characters changed\./);
  const punct = await call('write_text', { text: 'we saw (9.81), then 4', format: 'svg', redo: [{ word: 'saw' }] });
  assert.ok(!punct.result.isError || /no sample/.test(textOf(punct)));
});

test('write_text: a word that is not there stops before drawing, and says which words are', async () => {
  const r = await call('write_text', { text: T2, redo: [{ word: 'cat' }] });
  assert.ok(r.result.isError);
  assert.match(textOf(r), /redo 1: "cat" is not in the text\. The words are: "the", "lazy"/);
  const n = await call('write_text', { text: T2, redo: [{ word: 'dog', nth: 3 }] });
  assert.match(textOf(n), /has 1 match, so nth 3 does not exist/);
  const bad = await call('write_text', { text: T2, redo: [{ word: 'dog', take: 0 }] });
  assert.match(textOf(bad), /take must be a whole number from 1/);
  const none = await call('write_text', { text: T2, redo: [{ nth: 1 }] });
  assert.match(textOf(none), /redo 1: word is required/);
});

test('write_text: kind mixed takes a piece of math, or a run inside one', async () => {
  const ok = await call('write_text', { text: 'the lazy $\\frac{a}{b}$ dog', kind: 'mixed', format: 'svg', on_missing: 'fallback', redo: [{ word: '\\frac{a}{b}' }, { word: 'lazy' }] });
  assert.ok(!ok.result.isError, textOf(ok));
  assert.match(textOf(ok), /redo math "\$\\frac\{a\}\{b\}\$" \(take 1\)/);
  assert.match(textOf(ok), /redo "lazy" \(take 1\)/);
  const mm = await call('write_text', { text: 'the lazy dog', redo: [{ math: 1 }] });
  assert.match(textOf(mm), /math is only for kind mixed/);
});

test('write_text: when no other example exists the report says so plainly and the writing is the plain one', async () => {
  const plain = await call1('write_text', { text: 'the z fox', format: 'svg', seed: 1 });
  const r = await call1('write_text', { text: 'the z fox', format: 'svg', seed: 1, redo: [{ word: 'z' }] });
  assert.ok(!r.result.isError, textOf(r));
  assert.match(textOf(r), /redo "z" \(take 1\): could not change "z": only one usable example of z; it is drawn as it is without redo\./);
  assert.equal(svgOf(r), svgOf(plain));
});

test('write_batch: redo per item; a word that is not there fails only that item', async () => {
  const r = await call('write_batch', { items: [{ text: T2, redo: [{ word: 'brown' }] }, { text: T2, redo: [{ word: 'nope' }] }, { text: 'the fox' }], format: 'svg' });
  const t = textOf(r);
  assert.match(t, /1\. Written at letter height[^]*redo "brown" \(take 1\)/);
  assert.match(t, /2\. FAILED: redo 1: "nope" is not in the text/);
  assert.match(t, /3\. Written at letter height/);
});

test('fill_pdf: redo per answer, in the report, and a word that is not there stops the call before anything is written', async () => {
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage([612, 792]);
  const pdf = path.join(tmp, 'sheet.pdf');
  fs.writeFileSync(pdf, await doc.save());
  const dest = path.join(tmp, 'filled.pdf');
  const ans = (redo, extra) => [Object.assign({ page: 1, x: 72, y: 100, width: 200, height: 60, text: T2, seed: 3, redo }, extra)];
  const ok = await call('fill_pdf', { pdf, out: dest, answers: ans([{ word: 'quick', take: 2 }]) });
  assert.ok(!ok.result.isError, textOf(ok));
  assert.match(textOf(ok), /redo "quick" \(take 2\): \d of 5 characters changed\./);
  assert.ok(fs.existsSync(dest));
  fs.unlinkSync(dest);
  const again = await call('fill_pdf', { pdf, out: dest, answers: ans([{ word: 'quick', take: 2 }]) });
  assert.ok(!again.result.isError);
  assert.equal(textOf(again).replace(/Saved .*\n/, ''), textOf(ok).replace(/Saved .*\n/, ''), 'the same call gives the same report (the ink is deterministic: see the write_text test)');
  fs.unlinkSync(dest);
  const miss = await call('fill_pdf', { pdf, out: dest, answers: ans([{ word: 'zebra' }]) });
  assert.ok(miss.result.isError);
  assert.match(textOf(miss), /answer 1: redo 1: "zebra" is not in the text/);
  assert.ok(!fs.existsSync(dest), 'nothing written');
  const math = await callD('fill_pdf', { pdf, out: dest, answers: ans([{ word: '9.81' }], { text: MATH, kind: 'math', width: 300 }) });
  assert.ok(!math.result.isError, textOf(math));
  assert.match(textOf(math), /redo "9\.81" \(take 1\): \d of 4 characters changed\./);
  const mathMiss = await callD('fill_pdf', { pdf, out: dest + '2', answers: ans([{ word: '7.7' }], { text: MATH, kind: 'math', width: 300 }) });
  assert.match(textOf(mathMiss), /answer 1: redo 1: "7\.7" is not in the text\. The written runs of the math are: /);
  // a box too small for the text wraps and shrinks, and the redone word is still redone
  const tight = await call('fill_pdf', { pdf, out: dest, answers: ans([{ word: 'brown' }], { width: 90, height: 14 }) });
  assert.ok(!tight.result.isError, textOf(tight));
  assert.match(textOf(tight), /redo "brown" \(take 1\)/);
});

test('the one-file build carries redo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-redo-bundle-'));
  fs.writeFileSync(path.join(dir, 'handwriting-mcp.js'), build({}));
  fs.copyFileSync(samples, path.join(dir, 'my-handwriting.json'));
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reply = await new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]));
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_text', arguments: { text: T2, format: 'svg', redo: [{ word: 'quick' }] } } }) + '\n');
    });
    assert.ok(!reply.result.isError, JSON.stringify(reply).slice(0, 300));
    assert.match(reply.result.content.map((c) => c.text || '').join(''), /redo "quick" \(take 1\): \d of 5 characters changed/);
  } finally {
    child.kill();
  }
});

test('the tool schemas describe redo', async () => {
  const list = (await server({ jsonrpc: '2.0', id: 999, method: 'tools/list' })).result.tools;
  const by = (n) => list.find((t) => t.name === n);
  assert.ok(by('write_text').inputSchema.properties.redo);
  assert.ok(by('write_batch').inputSchema.properties.items.items.properties.redo);
  assert.ok(by('fill_pdf').inputSchema.properties.answers.items.properties.redo);
  assert.match(by('write_text').inputSchema.properties.redo.description, /take/);
  assert.ok(CORPUS.length && M.layout, 'fixtures loaded');
});
