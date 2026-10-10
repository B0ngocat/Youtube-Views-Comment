/*
 * Browser test of the simple part of the site (?simple): no tabs, the important rounds only, progress and time left, words
 * written again without anyone scrolling to them, and sending the handwriting back.
 *
 *   npm run e2e:simple
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { writeWord } = require('./synth-writer');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-e2e-simple-'));
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html') + '?simple';
const failures = [];
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail && !ok ? '  -> ' + detail : ''));
  if (!ok) failures.push(name);
}

async function drawOnPad(page, raw) {
  await page.evaluate((strokes) => {
    const c = document.querySelector('#pad');
    const r = c.getBoundingClientRect();
    const fire = (type, p) => {
      const ev = new PointerEvent(type, { pointerId: 7, pointerType: 'pen', isPrimary: true, pressure: type === 'pointerup' ? 0 : 0.5, clientX: r.left + p[0], clientY: r.top + p[1], bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'timeStamp', { value: 1000 + p[2] });
      c.dispatchEvent(ev);
    };
    for (const s of strokes) {
      fire('pointerdown', s[0]);
      for (let k = 1; k < s.length - 1; k++) fire('pointermove', s[k]);
      fire('pointerup', s[s.length - 1]);
    }
  }, raw.strokes);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1.5, hasTouch: true, acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.__t = 0; // a clock the test moves by hand, so the pace is known
    const real = Date.now.bind(Date);
    const base = real();
    Date.now = () => base + window.__t;
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + ' ' + (e.stack || '').split('\n').slice(0, 4).join(' / ')));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.goto(URL);
  await page.waitForSelector('#pad');
  const g = await page.evaluate(() => window.HW_APP.pad.guides);

  console.log('The screen');
  const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
  check('the simple screen is on', (await page.evaluate(() => document.body.classList.contains('simple'))) && (await visible('#simpleBar')));
  check('no tabs, no round buttons, no side panel', !(await visible('.tabs')) && !(await visible('#rounds')) && !(await visible('.teach-side')));
  const shape = await page.evaluate(() => {
    const rs = window.HW_APP.rounds();
    return { n: rs.length, optional: rs.filter((r) => r.optional).length, division: rs.some((r) => (r.chars || []).includes('÷')), slash: rs.find((r) => r.id === 'math').chars.includes('/'), total: rs.reduce((n, r, i) => n + window.HW_APP.tokensOf(i).length, 0) };
  });
  check('only the important rounds, and a slash where the division sign was', shape.optional === 0 && !shape.division && shape.slash, JSON.stringify(shape));
  const count0 = await page.textContent('#spCount');
  check('progress starts at zero', count0.startsWith('0 of ' + shape.total) && count0.includes('(0%)'), count0);
  check('no time is promised before a pace is known', /working out/.test(await page.textContent('#spEta')), await page.textContent('#spEta'));

  console.log('Writing: progress and the time left follow her pace');
  const toks = await page.evaluate(() => window.HW_APP.tokensOf(0).map((t) => ({ text: t.text, key: t.key })));
  const PACE = 3; // seconds a word
  for (let i = 0; i < 4; i++) {
    await page.evaluate((s) => (window.__t += s * 1000), PACE);
    await drawOnPad(page, writeWord(toks[i].text.replace(/[^a-zA-Z]/g, ''), { style: 'print', seed: i + 1, xh: g.xh, baseline: g.baseline, x0: 24 }));
    await page.click('#btnNext');
  }
  const count1 = await page.textContent('#spCount');
  check('the count moves with each word', count1.startsWith('4 of ' + shape.total), count1);
  const pct = await page.evaluate(() => document.querySelector('#spFill').style.width);
  check('and so does the bar', /^\d+%$/.test(pct) && parseInt(pct, 10) <= 2, pct);
  const eta = await page.textContent('#spEta');
  const m = /about (?:(\d+) h)?\s*(?:(\d+) min)? left/.exec(eta);
  const minutes = m ? (+m[1] || 0) * 60 + (+m[2] || 0) : -1;
  const lines = await page.evaluate(() => window.HW_APP.rounds().reduce((n, r, i) => n + window.HW_APP.tokensOf(i).filter((t) => t.kind === 'line').length, 0));
  const pace = 0.6 * PACE + 0.4 * 9; // three measurements are trusted 3/5, the rest is the usual 9 s
  const expected = ((shape.total - 4 - lines) * pace + lines * 45) / 60;
  check('the time left comes from her pace (3 s a word, and the usual for a sentence)', minutes > 0.8 * expected && minutes < 1.2 * expected, eta + ' (expected about ' + Math.round(expected) + ' min)');
  const wordCount = await page.textContent('#wordCount');
  check('the word counter still works', /Word 5 of/.test(wordCount), wordCount);

  console.log('Three seconds without touching anything moves on');
  const at = () => page.evaluate(() => window.HW_APP.cur.i);
  const i0 = await at();
  await drawOnPad(page, writeWord(toks[4].text.replace(/[^a-zA-Z]/g, ''), { style: 'print', seed: 5, xh: g.xh, baseline: g.baseline, x0: 24 }));
  await page.waitForTimeout(1500);
  check('not after one and a half seconds', (await at()) === i0 && (await page.evaluate(() => window.HW_APP.pad.strokes.length)) > 0);
  await page.waitForTimeout(2200);
  check('after three it has saved the word and moved on, with no tap', (await at()) === i0 + 1 && (await page.textContent('#spCount')).startsWith('5 of '), (await at()) + ' ' + (await page.textContent('#spCount')));
  await page.waitForTimeout(3600);
  check('an empty pad never moves on by itself', (await at()) === i0 + 1);
  await page.click('#btnPrev');
  check('Back shows the word she wrote', (await at()) === i0 && (await page.evaluate(() => window.HW_APP.pad.strokes.length)) > 0);
  await page.waitForTimeout(3600);
  check('and looking at it does not move her on', (await at()) === i0);
  await drawOnPad(page, writeWord(toks[4].text.replace(/[^a-zA-Z]/g, ''), { style: 'print', seed: 6, xh: g.xh, baseline: g.baseline, x0: 24 }));
  await page.waitForTimeout(1500);
  await page.click('#btnUndo');
  await page.waitForTimeout(2600);
  check('touching a button cancels the wait', (await at()) === i0);
  await page.click('#btnNext');

  console.log('Words that came out unclearly are asked for again, with no scrolling');
  await page.evaluate(() => {
    // a scribble that cannot be read as "jumps", saved under the key of the word it stands for
    const t = window.HW_APP.tokensOf(0)[5];
    const scribble = [[[10, 10, 0, 0.5], [60, 30, 20, 0.5], [20, 40, 40, 0.5], [70, 10, 60, 0.5], [30, 50, 80, 0.5]]];
    window.HW_APP.words.push({ text: t.text, key: t.key, xh: 52, baseline: 189, strokes: scribble, pen: 'pen' });
    window.HW_APP.finishSimple();
  });
  const fix = await page.evaluate(() => ({ fixWords: window.HW_APP.fixWords.map((w) => w.text), round: window.HW_APP.rounds().slice(-1)[0].title, prompt: document.querySelector('#prompt').textContent, ink: window.HW_APP.pad.strokes.length }));
  check('the word is put in front of her as the next thing to write', fix.fixWords.includes(toks[5].text) && fix.round === 'Again' && fix.prompt.includes(fix.fixWords[0]), JSON.stringify(fix));
  check('on a clean pad', fix.ink === 0);
  check('the screen says what she is doing', /again/i.test(await page.textContent('#spStep')), await page.textContent('#spStep'));
  // write each asked-for word again (the fake writer's first word may be flagged too: any word is fair)
  for (let k = 0; k < 4 && (await page.evaluate(() => document.querySelector('#simpleDone').hidden)); k++) {
    const asked = (await page.textContent('#prompt .big')).replace(/[^a-zA-Z]/g, '');
    await drawOnPad(page, writeWord(asked, { style: 'print', seed: 99 + k, xh: g.xh, baseline: g.baseline, x0: 24 }));
    await page.click('#btnNext');
    await page.waitForTimeout(300);
  }
  const done = await page.evaluate(() => ({ card: !document.querySelector('#simpleDone').hidden, pad: document.querySelector('.prompt-card').hidden, again: window.HW_APP.fixWords.length }));
  check('written again, nothing is left to redo: the finished card shows', done.card && done.pad && done.again === 0, JSON.stringify(done));

  console.log('Sending it back');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#spSend')]);
  const file = path.join(OUT, 'sent.json');
  await dl.saveAs(file);
  const sent = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('a handwriting file with her words is saved', dl.suggestedFilename() === 'my-handwriting-friend.json' && Array.isArray(sent.words) && sent.words.length >= 5, dl.suggestedFilename() + ' ' + (sent.words || []).length);
  check('and the message says where it went', /my-handwriting-friend\.json/.test(await page.textContent('#spSent')));
  await page.screenshot({ path: path.join(OUT, 'simple-done.png') });

  check('no errors in the page', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
