'use strict';
// The simple part of the site: which rounds, which words to write again, how long is left.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/prompts');
const Sm = require('../src/simple');

test('the simple rounds leave out the optional ones, and a division sign becomes a slash in the same place', () => {
  const base = Sm.baseRounds(P.ROUNDS);
  assert.ok(base.length > 8 && base.length < P.ROUNDS.length, 'the optional rounds are gone');
  assert.ok(base.every((r) => !r.optional));
  const orig = P.ROUNDS.find((r) => r.id === 'math');
  const math = base.find((r) => r.id === 'math');
  assert.ok(orig.chars.includes('÷') && !math.chars.includes('÷'));
  assert.equal(math.chars.length, orig.chars.length, 'nothing moves, so the keys stay the same');
  assert.equal(math.chars[orig.chars.indexOf('÷')], '/');
  assert.ok(orig.chars.includes('÷'), 'the original list is not changed');
  assert.ok(base.every((r) => !(r.chars || []).includes('÷')));
});

test('a round of words to write again keeps each word\'s own key', () => {
  const fix = [{ key: 'abc.0.3', text: 'quick', iso: false }, { key: 'iso.0.4', text: 'e', iso: true }];
  const list = Sm.rounds(P.ROUNDS, fix);
  assert.equal(list.length, Sm.baseRounds(P.ROUNDS).length + 1);
  const toks = P.tokens(list[list.length - 1]);
  assert.deepEqual(toks.map((t) => [t.key, t.text, t.iso, t.fix]), [['abc.0.3', 'quick', false, true], ['iso.0.4', 'e', true, true]]);
  assert.equal(Sm.rounds(P.ROUNDS, []).length, Sm.baseRounds(P.ROUNDS).length, 'no extra round when nothing needs redoing');
});

test('words to write again: the unreadable first, then the doubtful worst first; none from a line, none asked for too often', () => {
  const words = [
    { key: 'a.0.0', text: 'one' },
    { key: 'a.0.1', text: 'two', iso: true },
    { key: 'a.0.2', text: 'three' },
    { key: 'ln.0.w0', text: 'four', line: 'ln.0' },
    { key: 'a.0.4', text: 'five' },
  ];
  const style = { failed: [{ index: 2, text: 'three' }], suspect: [{ index: 0, text: 'one', quality: 1.5 }, { index: 1, text: 'two', quality: 3 }, { index: 3, text: 'four', quality: 9 }, { index: 4, text: 'five', quality: 2 }] };
  assert.deepEqual(Sm.troubleWords(style, words, {}).map((w) => w.text), ['three', 'two', 'five', 'one']);
  assert.equal(Sm.troubleWords(style, words, {}).find((w) => w.text === 'two').iso, true);
  assert.deepEqual(Sm.troubleWords(style, words, { 'a.0.2': 2, 'a.0.4': 1 }).map((w) => w.text), ['two', 'five', 'one'], 'asked for twice already: left alone');
  assert.equal(Sm.troubleWords(style, words, {}, 2, 2).length, 2, 'a limit');
  assert.deepEqual(Sm.troubleWords({}, words, {}), []);
});

test('time left follows her own pace, trusted more with every measurement', () => {
  assert.equal(Sm.pace([], 'w'), Sm.DEFAULT.w, 'nothing measured: the usual');
  let log = [];
  for (const s of [4, 5, 6, 5, 4]) log = Sm.note(log, 'w', s);
  assert.equal(Sm.pace(log, 'w'), 5, 'five measurements: hers alone');
  const one = Sm.note([], 'w', 3);
  assert.ok(Sm.pace(one, 'w') > 3 && Sm.pace(one, 'w') < Sm.DEFAULT.w, 'one measurement is mixed with the usual');
  assert.equal(Sm.eta({ w: 100, l: 2 }, log), 100 * 5 + 2 * Sm.DEFAULT.l);
  assert.equal(Sm.note(log, 'w', 600), log, 'a ten minute break is not writing');
  assert.equal(Sm.note(log, 'w', 0.2), log, 'nor is a tap');
  let many = [];
  for (let i = 0; i < 40; i++) many = Sm.note(many, 'w', 10);
  assert.equal(many.length, 15, 'only the newest are kept');
});

test('the time left is said plainly', () => {
  assert.equal(Sm.etaText(20), 'less than a minute left');
  assert.equal(Sm.etaText(14 * 60 + 10), 'about 14 min left');
  assert.equal(Sm.etaText(60 * 60), 'about 1 h left');
  assert.equal(Sm.etaText(75 * 60), 'about 1 h 15 min left');
});

test('progress counts what is written and what is left, words apart from sentences; a word to write again is not counted as done', () => {
  const rounds = [{ id: 'r', sentences: ['one two three'] }, { id: 'l', kind: 'line', sentences: ['a whole line', 'another line'] }, { id: 'fix', words: [{ key: 'r.0.0', text: 'one' }] }];
  const keys = new Set(['r.0.0', 'r.0.1', 'l.0']);
  const p = Sm.progress(rounds, P.tokens, keys);
  assert.deepEqual(p, { total: 6, done: 3, left: { w: 2, l: 1 } }, 'r.0.2 and the second line are left, and the word to write again');
});

test('sentences are cut into pieces that fit the pad at the size of the band, between words', () => {
  const t = 'The quick brown fox jumps over the lazy dog.';
  const parts = Sm.chunkLine(t, 18);
  assert.equal(parts.join(' '), t, 'nothing lost, nothing added');
  assert.ok(parts.every((x) => x.length <= 24 && /\s/.test(x)), JSON.stringify(parts)); // at most 18, or 24 when a lone last word is joined on
  assert.deepEqual(Sm.chunkLine('Hi there', 18), ['Hi there']);
  assert.deepEqual(Sm.chunkLine('Extraordinarily long', 10), ['Extraordinarily', 'long'].length === 2 ? ['Extraordinarily', 'long'] : []);
  const base = Sm.baseRounds(P.ROUNDS).find((r) => r.kind === 'line');
  const orig = P.ROUNDS.find((r) => r.kind === 'line' && !r.optional);
  assert.ok(base.sentences.length > orig.sentences.length && base.sentences.every((x) => x.length <= 24), 'her lines are short');
  assert.ok(orig.sentences.some((x) => x.length > 26), 'the original sentences are not changed');
});

test('the time left on screen glides: no jump when the estimate does, and it still counts down', () => {
  let shown = 1800;
  for (let i = 0; i < 20; i++) shown = Sm.ease(shown, 1800 - 10 + 600, 0.5); // the estimate suddenly 10 minutes longer
  assert.ok(shown > 1800 - 10 && shown < 1800 + 20 * 0.5 * 0.03 * 1800, 'moved by ' + (shown - 1790).toFixed(0) + ' s in 10 s');
  let calm = 600;
  for (let i = 0; i < 20; i++) calm = Sm.ease(calm, calm - 0.5, 0.5);
  assert.ok(calm < 600 && calm > 585, 'counts down by itself');
  assert.equal(Sm.ease(0.2, 0, 0.5), 0, 'never below zero');
});
