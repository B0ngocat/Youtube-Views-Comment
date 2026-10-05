'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const P = require('../src/prompts');
const Y = require('../src/synth');
const G = require('../src/geometry');

const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');
const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');

function wordsAndLetters(opts) {
  const words = WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 }));
  const letters = [];
  for (let rep = 0; rep < 2; rep++) {
    LOWER.forEach((c, i) => {
      const r = writeWord(c, { style: 'print', seed: 500 + rep * 50 + i });
      r.iso = true;
      letters.push(r);
    });
  }
  return { words, letters };
}

test('the Single letters round asks for every letter, lowercase twice', () => {
  const round = P.ROUNDS.find((r) => r.id === 'iso');
  const toks = P.tokens(round);
  assert.equal(toks.length, 26 * 3);
  assert.ok(toks.every((t) => t.iso === true && t.text.length === 1));
  assert.equal(new Set(toks.map((t) => t.key)).size, toks.length, 'every key is unique');
  for (const c of LOWER) assert.ok(toks.filter((t) => t.text === c).length >= 2);
});

test('letters written on their own are stored as clean one-letter examples', () => {
  const { words, letters } = wordsAndLetters();
  const st = S.buildStyle(words.concat(letters));
  assert.equal(st.failed.length, 0);
  const isoUnits = [...st.byChar.values()].flat().filter((u) => u.iso);
  assert.equal(isoUnits.length, letters.length);
  assert.ok(isoUnits.every((u) => u.strokes.length >= 1));
});

test('a letter that was cut wrongly is flagged; correctly cut letters mostly are not', () => {
  const { words, letters } = wordsAndLetters();
  // mislabel a word so one of its letters has the shape of another letter: written "ox", labelled "ex"
  const bad = writeWord('ox', { style: 'print', seed: 77 });
  bad.text = 'ex';
  const st = S.buildStyle(words.concat(letters, [bad]));
  const wrongE = (st.byChar.get('e') || []).filter((u) => u.word.text === 'ex');
  assert.equal(wrongE.length, 1);
  assert.equal(wrongE[0].wrong, 1, 'an o labelled e is flagged');
  const cut = [...st.byChar.values()].flat().filter((u) => !u.iso && u.word.text !== 'ex');
  const flagged = cut.filter((u) => u.wrong).length;
  assert.ok(flagged / cut.length < 0.15, `${flagged} of ${cut.length} correctly cut letters flagged`);
});

test('without enough single letters nothing is flagged', () => {
  const { words } = wordsAndLetters();
  const st = S.buildStyle(words);
  const all = [...st.byChar.values()].flat();
  assert.ok(all.every((u) => !u.wrong));
});

test('if the comparison would call lots of letters wrong, it switches itself off', () => {
  const { words } = wordsAndLetters();
  // references that look nothing like the writer's real letters: every letter looks "wrong"
  const letters = [];
  for (let rep = 0; rep < 2; rep++) {
    LOWER.forEach((c, i) => {
      const other = LOWER[(i + 7) % 26]; // draw a different letter than the one labelled
      const r = writeWord(other, { style: 'print', seed: 700 + rep * 50 + i });
      r.text = c;
      r.iso = true;
      letters.push(r);
    });
  }
  const st = S.buildStyle(words.concat(letters));
  const cut = [...st.byChar.values()].flat().filter((u) => !u.iso);
  assert.ok(cut.length >= 30);
  assert.ok(cut.filter((u) => u.wrong).length === 0, 'nothing is acted on when the references are unreliable');
});

test('a letter crossed out in the letter check stays out of the pool but can be listed', () => {
  const { words } = wordsAndLetters();
  const before = S.buildStyle(words);
  const nBefore = before.byChar.get('o').length;
  const u = before.byChar.get('o')[0];
  words[u.wid].skip = [{ i: u.idx, ch: 'o' }];
  const after = S.buildStyle(words);
  assert.equal(after.byChar.get('o').length, nBefore - 1);
  assert.equal(after.allByChar.get('o').length, nBefore, 'still listed so it can be restored');
  assert.equal(after.allByChar.get('o').filter((x) => x.skipped).length, 1);
  // a stale mark (wrong letter at that position) is ignored
  words[u.wid].skip = [{ i: u.idx, ch: 'z' }];
  assert.equal(S.buildStyle(words).byChar.get('o').length, nBefore);
});

test('stems and punctuation are never called wrong by shape, and look-alike letters do not flag each other', () => {
  const { words, letters } = wordsAndLetters();
  const st = S.buildStyle(words.concat(letters));
  for (const ch of 'il1|!jI.,\'`:;') {
    for (const u of st.byChar.get(ch) || []) assert.equal(u.wrong, 0, ch + ' must not be flagged');
  }
});

test('single letters are only used to start a word when the word letters exist, and are never enlarged', () => {
  const { words, letters } = wordsAndLetters();
  const st = S.buildStyle(words.concat(letters));
  const width = (u) => u.box.maxX - u.box.minX;
  // rebuilding must not compound the shrinking
  const again = S.buildStyle(words.concat(letters));
  const isoW = (style, c) => style.byChar.get(c).filter((u) => u.iso).map(width);
  assert.deepEqual(isoW(st, 'o'), isoW(again, 'o'));
  const raw = letters.filter((l) => l.text === 'o').length;
  assert.ok(raw >= 2);
  // mid-word the cut-out letters win over single letters for letters that have enough of them
  const ctx = { variation: 0.4, messiness: 0, usage: new Map(), missing: new Set() };
  let midIso = 0;
  let mid = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const w = Y.synthWord(st, 'ohoho', G.mulberry32(seed), ctx);
    w.choices.slice(1).forEach((c) => {
      mid++;
      if (c.unit.iso) midIso++;
    });
  }
  assert.ok(midIso <= 0.1 * mid, midIso + ' of ' + mid + ' mid-word letters were single letters');
});
