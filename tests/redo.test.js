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
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const Y = require('../src/synth');
const X = require('../src/mixed');
const M = require('../src/math');
const Sheet = require('../src/sheet');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { createServer } = require('../mcp/server');
const { build } = require('../scripts/build-mcp');

const style = corpus('print').style;
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
  const tex = Sheet.layoutBox(style, { page: 0, x: 0, y: 0, w: 200, h: 30, text: 'x^2', kind: 'math', seed: 1, redo: [{ word: 'x' }] }, {});
  assert.equal(tex.redo, null, 'kind math ignores it (the tools refuse it before this)');
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
let nextId = 1;
const callOn = (srv) => (name, args) => srv({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
const call = callOn(server);
const call1 = callOn(server1);
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

test('write_text: redo for kind math says it is not there yet, and for kind mixed it takes a piece of math', async () => {
  const m = await call('write_text', { text: 'x^2 + 3', kind: 'math', redo: [{ word: 'x' }] });
  assert.ok(m.result.isError);
  assert.match(textOf(m), /redo is not available for kind math yet/);
  assert.match(textOf(m), /kind mixed answer/);
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
  const math = await call('fill_pdf', { pdf, out: dest, answers: ans([{ word: 'x' }], { text: 'x^2', kind: 'math' }) });
  assert.match(textOf(math), /answer 1: redo is not available for kind math yet/);
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
