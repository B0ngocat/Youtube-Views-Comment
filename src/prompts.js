/*
 * What gets written while teaching the app. One word at a time, so the aligner always knows
 * which characters it is looking at.
 */
(function (root) {
  'use strict';

  const ROUNDS = [
    {
      id: 'abc',
      title: 'Alphabet',
      blurb: 'Every lowercase letter, plus a few capitals and . , !',
      sentences: [
        'The quick brown fox jumps over the lazy dog.',
        'Pack my box with five dozen liquor jugs.',
        'How vexingly quick daft zebras jump!',
        'Sphinx of black quartz, judge my vow.',
      ],
    },
    {
      id: 'caps',
      title: 'Capitals',
      blurb: 'All 26 capital letters.',
      sentences: [
        'Amy, Ben, Cara, Dan, Eva, Finn, Gus, Hal, Ivy,',
        'Jo, Kim, Leo, Max, Nell, Olga, Pat, Quinn, Rae,',
        'Sam, Tia, Uma, Vic, Wes, Xavi, Yara and Zed.',
      ],
    },
    {
      id: 'num',
      title: 'Numbers',
      blurb: 'Digits 0-9.',
      sentences: ['We counted 1234 birds and 567 bees in room 890.', 'In 2019 there were 40 owls and 36 cats.'],
    },
    {
      id: 'sym',
      title: 'Symbols',
      blurb: 'One mark at a time. Skip any you never use.',
      chars: ['?', "'", '"', '-', ':', ';', '(', ')', '/', '&', '@', '#', '%', '+', '=', '$', '*'],
    },
    {
      id: 'ln',
      title: 'Full lines',
      kind: 'line',
      blurb: 'Write each sentence on one line, at your normal speed and size, with your normal gaps between words. This teaches the app your spacing and rhythm.',
      sentences: [
        'The old house was very quiet.',
        'She said it would rain today.',
        'Bring a pencil and your book.',
        'He walked by the river daily.',
        'My friends are visiting soon.',
        'We finally arrived home late.',
        'They could hardly believe it.',
        'Please call me when you land.',
        'Where is the nearest library?',
        'Our team won the last game.',
      ],
    },
    {
      id: 'more',
      title: 'More variety',
      blurb: 'Common words, so letter pairs look natural. The more you write, the less repetitive the result.',
      sentences: [
        'Dear friend, thank you very much for the lovely gift.',
        'I hope you are doing well and enjoying the summer.',
        'See you soon, and please write back when you can.',
        'Every good story starts with a single word.',
        'We went to the market and bought some fresh bread.',
        'It was a long day, but everything turned out fine.',
      ],
    },
  ];

  /** Flatten a round into the ordered list of things to write. */
  function tokens(round) {
    if (round.chars) return round.chars.map((c, i) => ({ text: c, si: 0, wi: i, key: round.id + '.0.' + i }));
    // a whole sentence is one thing to write; it is split into words afterwards
    if (round.kind === 'line') return round.sentences.map((s, si) => ({ text: s, si, wi: 0, key: round.id + '.' + si, kind: 'line' }));
    const out = [];
    round.sentences.forEach((s, si) => {
      s.split(/\s+/)
        .filter(Boolean)
        .forEach((w, wi) => out.push({ text: w, si, wi, key: round.id + '.' + si + '.' + wi }));
    });
    return out;
  }

  const CHAR_GROUPS = [
    { title: 'Lowercase', chars: 'abcdefghijklmnopqrstuvwxyz' },
    { title: 'Capitals', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    { title: 'Digits', chars: '0123456789' },
    { title: 'Punctuation', chars: '.,!?\'"-:;()/&@#%+=$*' },
  ];

  const api = { ROUNDS, tokens, CHAR_GROUPS };
  root.HW = root.HW || {};
  root.HW.prompts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
