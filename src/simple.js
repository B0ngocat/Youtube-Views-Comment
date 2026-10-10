/*
 * The simple part of the site, for a friend who only has to teach the app her handwriting and send it back: which rounds she
 * writes, the words she is asked to write again, and how long is left. No screen in here (app.js draws it), so tests can run it.
 */
(function (root) {
  'use strict';

  /** The rounds that matter, in order: no optional ones, and a division sign is written as the slash everyone uses (the same place in the list, so the keys do not move). */
  function baseRounds(all) {
    return all.filter((r) => !r.optional).map((r) => (r.chars ? Object.assign({}, r, { chars: r.chars.map((c) => (c === '÷' ? '/' : c)) }) : r));
  }

  /** The base rounds, then one more round of words to write again when there are any. */
  function rounds(all, fixWords) {
    const base = baseRounds(all);
    return fixWords && fixWords.length ? base.concat([{ id: 'fix', title: 'Again', blurb: 'A few words did not come out clearly. Write each one again, slowly, on the solid line.', words: fixWords }]) : base;
  }

  /**
   * The words the app could not read, or read with doubt, as [{key, text, iso}] to write again: the unreadable first, then the
   * doubtful ones worst first, at most `limit`. A word that has already been written again `maxTries` times is left alone (it
   * would be asked for for ever), and so is a word inside a sentence (those are for rhythm, and are written as a whole line).
   */
  function troubleWords(style, words, tries, maxTries, limit) {
    const max = maxTries || 2;
    const cap = limit || 25;
    const done = tries || {};
    const out = [];
    const seen = new Set();
    const add = (index, text) => {
      const raw = words[index];
      if (!raw || raw.line || !raw.key || seen.has(raw.key) || (done[raw.key] || 0) >= max) return;
      seen.add(raw.key);
      out.push({ key: raw.key, text: raw.text || text, iso: !!raw.iso });
    };
    for (const f of style.failed || []) add(f.index, f.text);
    for (const s of (style.suspect || []).slice().sort((a, b) => b.quality - a.quality)) add(s.index, s.text);
    return out.slice(0, cap);
  }

  // seconds to write one thing, before there is anything to measure: a word or a letter, and a whole sentence
  const DEFAULT = { w: 9, l: 45 };
  const BREAK = 120; // a longer wait than this was a break, not writing
  const median = (a) => {
    const b = a.slice().sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };

  /** log with one more measurement (kind 'w' or 'l', seconds), the newest 15 of each kind; breaks and instant skips are not measured. */
  function note(log, kind, seconds) {
    if (!(seconds >= 1 && seconds <= BREAK)) return log;
    const same = log.filter((e) => e.k === kind).concat([{ k: kind, s: Math.round(seconds * 10) / 10 }]).slice(-15);
    return log.filter((e) => e.k !== kind).concat(same);
  }

  /** Seconds a thing of this kind takes her: her own median, trusted more with every measurement (fully at five). */
  function pace(log, kind) {
    const v = log.filter((e) => e.k === kind).map((e) => e.s);
    if (!v.length) return DEFAULT[kind];
    const trust = Math.min(1, v.length / 5);
    return trust * median(v) + (1 - trust) * DEFAULT[kind];
  }

  /** Seconds left for remaining = {w, l}: how many words or letters and how many sentences. */
  function eta(remaining, log) {
    return remaining.w * pace(log, 'w') + remaining.l * pace(log, 'l');
  }

  function etaText(seconds) {
    if (seconds < 45) return 'less than a minute left';
    const min = Math.round(seconds / 60);
    if (min < 60) return 'about ' + Math.max(1, min) + ' min left';
    const h = Math.floor(min / 60);
    return 'about ' + h + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '') + ' left';
  }

  /** How many of the tokens in these rounds are written already, and what is left (by kind). keys: the set of written keys. */
  function progress(list, tokensOf, keys) {
    let total = 0;
    let done = 0;
    const left = { w: 0, l: 0 };
    list.forEach((round) => {
      for (const t of tokensOf(round)) {
        total++;
        if (keys.has(t.key) && !t.fix) done++;
        else left[t.kind === 'line' ? 'l' : 'w']++;
      }
    });
    return { total, done, left };
  }

  const api = { baseRounds, rounds, troubleWords, note, pace, eta, etaText, progress, DEFAULT };
  root.HW = root.HW || {};
  root.HW.simple = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
