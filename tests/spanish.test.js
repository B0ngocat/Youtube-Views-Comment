'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWord, GLYPHS } = require('./synth-writer');
const S = require('../src/style');
const Y = require('../src/synth');
const A = require('../src/align');
const P = require('../src/prompts');

// the test writer has no ? or !, so give it simple ones: a hook and a dot, and a stem and a dot
GLYPHS['?'] = [0.5, [[0, 1.4], [0.15, 1.8], [0.4, 1.8], [0.5, 1.5], [0.25, 1.1], [0.22, 0.6]], [[[0.22, 0.05], [0.23, 0.07]]], true];
GLYPHS['!'] = [0.3, [[0.1, 1.9], [0.12, 0.5]], [[[0.11, 0.05], [0.12, 0.07]]], true];

const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ').concat(['why?', 'no!']);
const style = S.buildStyle(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
const opts = { xh: 34, width: 900, seed: 5, variation: 0, messiness: 0 };
const lay = (text) => Y.layout(style, text, opts);
const top = (l) => Math.min(...l.strokes.flatMap((s) => s.pts.map((p) => p.y))); // pixels, y goes down

test('an accented letter the writer has not written is their plain letter with a mark over it', () => {
  assert.deepEqual(S.fallbackFor(style, 'ñ'), { ch: 'n', scale: 1, accent: 'tilde' });
  assert.deepEqual(S.fallbackFor(style, 'á'), { ch: 'a', scale: 1, accent: 'acute' });
  assert.equal(S.fallbackFor(style, 'ü').accent, 'diaer');
  assert.equal(S.fallbackFor(style, 'è').accent, 'grave');
  const cap = S.fallbackFor(style, 'Ñ');
  assert.equal(cap.ch, 'n');
  assert.ok(cap.scale > 1.3 && cap.accent === 'tilde', 'a capital is the small letter, larger, with the mark');
  assert.deepEqual(S.fallbackFor(style, 'ç'), { ch: 'c', scale: 1 }, 'other marks (a cedilla) are still just left off');
});

test('a letter the writer wrote with its accent is used as it is', () => {
  const own = { byChar: new Map([['n', [{}]], ['ñ', [{}]], ['?', [{}]], ['¿', [{}]]]) };
  assert.deepEqual(S.fallbackFor(own, 'ñ'), { ch: 'ñ', scale: 1 });
  assert.deepEqual(S.fallbackFor(own, '¿'), { ch: '¿', scale: 1 });
});

test('an upside-down ? or ! is the writer\'s own, turned round', () => {
  assert.deepEqual(S.fallbackFor(style, '¿'), { ch: '?', scale: 1, flip: true });
  assert.deepEqual(S.fallbackFor(style, '¡'), { ch: '!', scale: 1, flip: true });
  const q = lay('?');
  const inv = lay('¿');
  assert.deepEqual(inv.missing, []);
  assert.equal(inv.strokes.length, q.strokes.length);
  // the hook is at the top of ? and the dot at the bottom; turned round, the dot is above the hook
  const dotY = (l) => l.strokes.slice().sort((a, b) => a.pts.length - b.pts.length)[0].pts[0].y;
  const hookY = (l) => l.strokes.slice().sort((a, b) => b.pts.length - a.pts.length)[0].pts[0].y;
  assert.ok(dotY(q) > hookY(q), '? has its dot below the hook');
  assert.ok(dotY(inv) < hookY(inv), '¿ has its dot above the hook');
  const width = (l) => Math.max(...l.strokes.flatMap((s) => s.pts.map((p) => p.x))) - Math.min(...l.strokes.flatMap((s) => s.pts.map((p) => p.x)));
  assert.ok(Math.abs(width(q) - width(inv)) < 1, 'the same size');
});

test('ñ is an n with a tilde above it, and nothing is reported missing', () => {
  const n = lay('n');
  const nt = lay('ñ');
  assert.deepEqual(nt.missing, []);
  assert.equal(nt.strokes.length, n.strokes.length + 1);
  assert.ok(top(nt) < top(n) - 3, 'the tilde is above the letter: ' + top(nt) + ' vs ' + top(n));
  // the tilde sits over the letter, not beside it (the page slant moves it along with the top of the letter, so allow for that)
  const letter = n.strokes.flatMap((s) => s.pts.map((p) => p.x));
  const tilde = nt.strokes[nt.strokes.length - 1].pts.map((p) => p.x);
  assert.ok(Math.min(...tilde) >= Math.min(...letter) - 2 && Math.max(...tilde) <= Math.max(...letter) + 0.3 * 34, 'over the letter');
});

test('á é í ó ú each get one mark; ü gets two dots; í loses its own dot', () => {
  for (const v of 'aeou') {
    assert.equal(lay(v + '́'.normalize('NFC')).strokes.length, lay(v).strokes.length + 1, v);
  }
  assert.equal(lay('ü').strokes.length, lay('u').strokes.length + 2);
  const i = lay('i');
  const iAcute = lay('í');
  assert.equal(iAcute.strokes.length, i.strokes.length, 'the accent takes the dot\'s place');
  assert.deepEqual(iAcute.missing, []);
});

test('the same word typed with a combining mark is the same word', () => {
  const nfc = lay('mañana');
  const nfd = lay('mañana');
  assert.equal(nfd.strokes.length, nfc.strokes.length);
  assert.deepEqual(nfd.missing, []);
  assert.deepEqual(S.missingChars(style, 'mañana está ¿qué?'), []);
  assert.deepEqual(S.missingChars(style, 'mañana'), []);
});

test('capitals with a mark are bigger than the letter and the mark clears them', () => {
  const small = lay('á');
  const big = lay('Á');
  assert.ok(top(big) < top(small) - 5, 'the capital with its accent is taller');
  assert.deepEqual(big.missing, []);
});

test('a page of Spanish lays out whole, with nothing skipped', () => {
  const text = '¿Cómo estás? ¡Qué día! Mañana vamos al pingüino señor Ángel y Íñigo';
  const l = lay(text);
  assert.deepEqual(l.missing, []);
  assert.ok(l.strokes.every((s) => s.pts.every((p) => isFinite(p.x) && isFinite(p.y))), 'no NaN');
  // the same text with the same seed gives the same page
  assert.equal(JSON.stringify(lay(text).strokes), JSON.stringify(l.strokes));
});

test('an accented letter is measured and sized as its plain letter when the aligner reads it', () => {
  assert.equal(A.defaultWidth('á'), A.defaultWidth('a'));
  assert.equal(A.defaultWidth('Ñ'), A.defaultWidth('N'));
  const b = { minY: -0.1, maxY: 1.0 };
  assert.equal(A.heightCost('ñ', b), A.heightCost('n', b));
  assert.equal(A.heightCost('ú', { minY: 0, maxY: 2.2 }), A.heightCost('u', { minY: 0, maxY: 2.2 }));
});

test('the Spanish rounds are optional and cover every Spanish letter', () => {
  const rounds = P.ROUNDS.filter((r) => /^es/.test(r.id));
  assert.deepEqual(rounds.map((r) => r.id), ['es', 'esiso', 'esln']);
  assert.ok(rounds.every((r) => r.optional), 'each is marked optional');
  assert.ok(P.ROUNDS.filter((r) => !/^es/.test(r.id)).every((r) => !r.optional), 'the others are not');
  const written = rounds.flatMap((r) => P.tokens(r).map((t) => t.text)).join('');
  for (const ch of 'áéíóúüñÁÉÍÓÚÑ¿¡') assert.ok(written.includes(ch), ch + ' is in a Spanish round');
  const keys = P.ROUNDS.flatMap((r) => P.tokens(r).map((t) => t.key));
  assert.equal(new Set(keys).size, keys.length, 'every thing to write has its own key');
  assert.ok(P.CHAR_GROUPS.some((g) => g.title === 'Spanish' && g.chars.includes('ñ') && g.chars.includes('¿')));
});

test('a letter the writer writes with its accent is learned with the accent, and used instead of the drawn one', () => {
  // a writer who puts a tilde over the n of "mañana", "niño" and "año"
  GLYPHS['ñ'] = [0.95, GLYPHS.n[1], [[[0.25, 1.45], [0.4, 1.6], [0.55, 1.45], [0.7, 1.6]]]];
  const taught = ['mañana', 'niño', 'año', 'mañana', 'señor'];
  const own = S.buildStyle(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })).concat(taught.map((w, i) => writeWord(w, { style: 'print', seed: 90 + i }))));
  const units = own.byChar.get('ñ');
  assert.ok(units && units.length >= 3, 'the aligner learned ñ as a letter of its own');
  const inks = (u) => u.strokes.length + u.marks.length; // the tilde is an extra stroke of the letter, or a mark attached to it
  assert.ok(units.every((u) => inks(u) === 2), 'each carries its own tilde: ' + units.map(inks));
  assert.ok(own.byChar.get('a').concat(own.byChar.get('o')).every((u) => inks(u) === 1), 'no neighbour took a tilde');
  assert.deepEqual(S.fallbackFor(own, 'ñ'), { ch: 'ñ', scale: 1 }, 'a written ñ beats a drawn one');
  const l = Y.layout(own, 'mañana', Object.assign({}, opts, { wordReuse: 0 }));
  assert.deepEqual(l.missing, []);
  assert.ok(l.strokes.length >= 6);
});
