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
      id: 'iso',
      title: 'Single letters',
      kind: 'letter',
      blurb: 'Write each letter on its own, a little bigger and clearer than usual. These need no cutting, so they are the cleanest examples the app gets, and it uses them to catch letters it cut out wrongly.',
      chars: ('abcdefghijklmnopqrstuvwxyz' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz').split(''),
    },
    {
      id: 'math',
      title: 'Math',
      kind: 'letter',
      blurb: 'Write each symbol and digit on its own, the way you write it in math. Digits and operators come twice, the rest once. Brackets stretch to fit what is inside them, so write them at normal height. Skip any you never use.',
      chars: [
        ...'0123456789',
        ...'+-=×÷±<>≤≥≠≈→',
        ...'()[]{}|',
        ...'∫∑∞',
        ...'πθΔαβλμσ∂',
        ...'0123456789',
        ...'+-=×÷±<>≤≥≠≈→',
      ],
    },
    {
      id: 'tricky',
      title: 'Tricky letters',
      blurb: 'Words with a, e, o, r or u at the start, in the middle and at the end, two words for each. These are the letters that are hardest to cut out of your words cleanly, so write them at your normal speed and size.',
      sentences: [
        'ask arm cat map soda tuna',
        'end egg pen red the time',
        'on old dog top go two',
        'run rib park word car her',
        'up us cup sun menu you',
      ],
    },
    {
      id: 'nums2',
      title: 'Numbers in a row',
      blurb: 'Numbers with decimal points, written the way you would on a worksheet. Every digit shows up several times.',
      sentences: ['1.74 2.36 5.89 0.45', '37.06 92.18 10.50 68.23', '529.25 4507.75 36.805 98.25'],
    },
    {
      id: 'xy',
      title: 'x and y',
      blurb: 'The letters math uses most, on their own, next to numbers and in short equations. Write each one the way you do in your notes, at your normal speed and size. A word you write here is used as it is when you type it in math mode.',
      sentences: [
        'x y x y z x y',
        'xy yx xz yz xyz',
        '2x 3x 5x 4y 6y 8y',
        'x2 y2 x3 y3 x1 y1',
        'x=2 y=3 x=5 y=7',
        'x+y x-y 2x+y x+3',
        '(x) (y) (x+1) (y-2)',
        'y=mx+b y=2x+1 y=3x-4',
      ],
    },
    {
      id: 'calc',
      title: 'dy/dx and calculus',
      blurb: 'd, y and x side by side, the way derivatives and integrals look. Write dy/dx on one line with the slash, like in your notes. Use your usual size for the d, the y and the x.',
      sentences: [
        'dy dx dy dx dy dx',
        'dy/dx dy/dx dx/dy',
        'dy/dx=2x dy/dx=3x dy/dx=y',
        'dx/dt dv/dt dy/dt',
        'd/dx f(x) f(x) g(x) h(x)',
        "f'(x) g'(x) y' f'(2)",
        'sin cos tan ln',
        'lim dx dt du',
      ],
    },
    {
      id: 'nums3',
      title: 'More numbers',
      blurb: 'More numbers as they show up in problems: whole numbers, negatives, fractions and equations with numbers in them. Digits are the weakest part of the app, and a number you write here is used whole when you type it, so extra examples help a lot.',
      sentences: [
        '12 34 56 78 90 21 43 65 87',
        '100 250 1000 4096 3600',
        '3.14 2.71 1.41 0.5 0.25 0.75',
        '-3 -7 +2 -10 +15',
        '1/2 3/4 5/8 7/10',
        '2x+3=11 3x-4=8 5+7=12',
        '9 8 7 6 5 4 3 2 1 0',
        '15 28 49 63 87 91',
      ],
    },
    {
      id: 'math2',
      title: 'x, y and digits again',
      kind: 'letter',
      blurb: 'The same single letters and digits again, each on its own, a little bigger and clearer than usual. These need no cutting, so they are the cleanest examples the app gets, and it prefers them for digits and for x and y.',
      chars: [...'xyxyxyxy', ...'dfgntu', ...'0123456789', ...'0123456789', ...'+-=()/'],
    },
    {
      id: 'common',
      title: 'Common words',
      blurb: 'Everyday words you have not written yet. A word you write here can be put back exactly as you wrote it, so the more of these you do, the less the app has to build letter by letter, and the better every page looks.',
      sentences: [
        "be that have not as do this his",
        "from say or an one all their what",
        "so if about who get which make like",
        "no just him know take into year them",
        "other than then now look only come its",
        "think also after use work first way even",
        "new want because any these give most has",
        "had did been made may find down more",
        "part still here going really thing things something",
        "someone always never again little school tomorrow yesterday",
        "night morning week love need feel through great",
        "before right too does"
],
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
      id: 'es',
      title: 'Spanish words',
      optional: true,
      blurb: 'Optional. Spanish words with \u00f1 and the accented vowels. Without this the app already draws your own plain letter with an accent over it. Write these to give it your own accents. Put each accent in with the word, the way you normally write it.',
      sentences: [
        'ma\u00f1ana ni\u00f1o a\u00f1o se\u00f1or Espa\u00f1a',
        'est\u00e1 m\u00e1s pap\u00e1 all\u00e1 tambi\u00e9n',
        'qu\u00e9 caf\u00e9 aqu\u00ed s\u00ed d\u00eda',
        'c\u00f3mo adi\u00f3s canci\u00f3n tel\u00e9fono',
        't\u00fa men\u00fa \u00fanico \u00fatil',
        'ping\u00fcino verg\u00fcenza',
        '\u00c1ngela \u00c9dgar \u00cd\u00f1igo \u00d3scar \u00darsula',
      ],
    },
    {
      id: 'esiso',
      title: 'Spanish letters',
      optional: true,
      kind: 'letter',
      blurb: 'Optional. Each Spanish letter on its own, with its accent, a little bigger and clearer than usual, then the upside-down ? and !. Skip any you do not need.',
      chars: [...'\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1', ...'\u00c1\u00c9\u00cd\u00d3\u00da\u00d1', '\u00bf', '\u00a1', ...'\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1'],
    },
    {
      id: 'esln',
      title: 'Spanish lines',
      optional: true,
      kind: 'line',
      blurb: 'Optional. Whole Spanish sentences on one line, at your normal speed and size.',
      sentences: ['\u00bfC\u00f3mo est\u00e1s? Muy bien, gracias.', '\u00a1Qu\u00e9 d\u00eda tan bonito!', 'Ma\u00f1ana vamos a la escuela.'],
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
    if (round.chars) return round.chars.map((c, i) => ({ text: c, si: 0, wi: i, key: round.id + '.0.' + i, iso: round.kind === 'letter' }));
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
    { title: 'Spanish', chars: '\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00bf\u00a1' },
    { title: 'Math', chars: '×÷±<>≤≥≠≈→[]{}|∫∑∞πθΔαβλμσφω∂' },
  ];

  const api = { ROUNDS, tokens, CHAR_GROUPS };
  root.HW = root.HW || {};
  root.HW.prompts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
