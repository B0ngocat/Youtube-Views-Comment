/*
 * Browser test (Chromium via Playwright). Replays fake pen strokes on the pad as pen pointer
 * events, then checks capture, learning, writing, palm rejection, saving and layout on iPad
 * sized screens.
 *
 *   npm install && npx playwright install chromium
 *   npm run e2e [outputDir]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { writeWord } = require('./synth-writer');

const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'hw-e2e-'));
fs.mkdirSync(OUT, { recursive: true });
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail && !ok ? '  -> ' + detail : ''));
  if (!ok) failures.push(name);
}

/** Replay a synthetic word on the pad as pointer events of the given type. */
async function drawOnPad(page, raw, pointerType) {
  await page.evaluate(
    ({ strokes, pointerType }) => {
      const c = document.querySelector('#pad');
      const r = c.getBoundingClientRect();
      const fire = (type, p) => {
        const ev = new PointerEvent(type, {
          pointerId: pointerType === 'pen' ? 7 : 3,
          pointerType,
          isPrimary: true,
          pressure: type === 'pointerup' ? 0 : 0.5,
          clientX: r.left + p[0],
          clientY: r.top + p[1],
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(ev, 'timeStamp', { value: 1000 + p[2] });
        c.dispatchEvent(ev);
      };
      for (const s of strokes) {
        fire('pointerdown', s[0]);
        for (let k = 1; k < s.length - 1; k++) fire('pointermove', s[k]);
        fire('pointerup', s[s.length - 1]);
      }
    },
    { strokes: raw.strokes, pointerType }
  );
}

async function inkPixels(page, selector) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 120) n++;
    return n;
  }, selector);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1.5, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  page.on('dialog', (d) => d.accept());

  console.log('Teach: capture round 1 with Apple-Pencil-style pen events');
  await page.goto(URL);
  await page.waitForSelector('#pad');
  const g = await page.evaluate(() => window.HW_APP.pad.guides);
  const tokens = await page.evaluate(() => window.HW_APP.tokensOf(0).map((t) => t.text));
  check('round 1 has the four pangram sentences', tokens.length === 30, String(tokens.length));

  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i].replace(/[^a-zA-Z.,]/g, ''); // the synthetic pen only knows these
    if (text) {
      const raw = writeWord(text, { style: 'cursive', seed: i + 11, xh: g.xh, baseline: g.baseline, x0: 24 });
      await drawOnPad(page, raw, 'pen');
    }
    if (i === 12) await page.screenshot({ path: path.join(OUT, '1-teach-midway.png') });
    await page.click('#btnNext');
  }
  await page.waitForTimeout(400);

  const state = await page.evaluate(() => ({
    words: window.HW_APP.words.length,
    chars: window.HW_APP.style.byChar.size,
    failed: window.HW_APP.style.failed.length,
    lower: 'abcdefghijklmnopqrstuvwxyz'.split('').filter((c) => !window.HW_APP.style.byChar.has(c)),
    pen: document.querySelector('#penState').textContent,
    status: document.querySelector('#status').textContent,
  }));
  check('30 words captured', state.words === 30, JSON.stringify(state));
  check('every lowercase letter learned', state.lower.length === 0, state.lower.join(''));
  check('no word failed to align', state.failed === 0);
  check('Pencil detected, and told it has no pressure sensor', /Apple Pencil detected/.test(state.pen) && /no pressure sensor/.test(state.pen), state.pen);
  await page.screenshot({ path: path.join(OUT, '2-teach-done.png'), fullPage: true });

  console.log('Palm rejection');
  await page.evaluate(() => window.HW_APP.pad.clear());
  const probe = writeWord('the', { style: 'print', seed: 2, xh: g.xh, baseline: g.baseline, x0: 24 });
  await drawOnPad(page, probe, 'touch');
  check('finger/palm ignored once the Pencil has been used', (await page.evaluate(() => window.HW_APP.pad.strokes.length)) === 0);
  await page.uncheck('#palm');
  await drawOnPad(page, probe, 'touch');
  check('touch drawing works when palm rejection is off', (await page.evaluate(() => window.HW_APP.pad.strokes.length)) > 0);
  await page.check('#palm');
  await page.evaluate(() => window.HW_APP.pad.clear());
  await page.click('#btnUndo', { force: true }).catch(() => {});

  console.log('Write');
  await page.click('#tab-write');
  await page.waitForTimeout(400);
  const ink1 = await inkPixels(page, '#paper');
  check('handwriting was drawn on the paper', ink1 > 3000, String(ink1));
  const sig1 = await page.evaluate(() => JSON.stringify(window.HW_APP.layout.strokes[3].pts.slice(0, 20)));
  await page.click('#btnAgain');
  await page.waitForTimeout(300);
  const sig2 = await page.evaluate(() => JSON.stringify(window.HW_APP.layout.strokes[3].pts.slice(0, 20)));
  check('"Write it again" produces a different take', sig1 !== sig2);
  await page.screenshot({ path: path.join(OUT, '3-write.png'), fullPage: true });

  await page.fill('#text', 'The quick brown fox # 7');
  await page.waitForTimeout(300);
  const warn = await page.textContent('#warn');
  check('characters with no sample are called out', /#/.test(warn) && /7/.test(warn), warn);
  await page.fill('#text', 'the quick brown fox jumps over the lazy dog.\nPack my box with five dozen liquor jugs.');
  await page.selectOption('#paperKind', 'grid');
  await page.fill('#xh', '44').catch(() => {});
  await page.evaluate(() => {
    const el = document.querySelector('#xh');
    el.value = 44;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '4-write-grid-large.png'), fullPage: true });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSVG')]);
  const svg = fs.readFileSync(await dl.path(), 'utf8');
  check('SVG export is a real SVG with ink', svg.startsWith('<svg') && svg.includes('<path d="M') && !/NaN/.test(svg), svg.slice(0, 60));

  console.log('Persistence and backup');
  await page.reload();
  await page.waitForSelector('#pad', { state: 'attached' }); // it reopens on the Write tab
  await page.waitForTimeout(400);
  check('samples survive a reload', (await page.evaluate(() => window.HW_APP.words.length)) === 30);
  check('opens on the Write tab once it has learned enough', await page.evaluate(() => !document.querySelector('#write').hidden));
  await page.click('#tab-teach');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const exported = JSON.parse(fs.readFileSync(await dl2.path(), 'utf8'));
  check('export contains every word', exported.words.length === 30);
  await page.click('#btnReset');
  await page.waitForTimeout(300);
  check('reset clears everything', (await page.evaluate(() => window.HW_APP.words.length)) === 0);
  const file = path.join(OUT, 'backup.json');
  fs.writeFileSync(file, JSON.stringify(exported));
  await page.setInputFiles('#fileImport', file);
  await page.waitForTimeout(600);
  check('import brings the samples back', (await page.evaluate(() => window.HW_APP.words.length)) === 30);

  console.log('Layout on iPad and phone sized screens');
  for (const [name, w, h] of [['ipad-portrait', 820, 1180], ['ipad-landscape', 1180, 820], ['phone', 390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const tab of ['#tab-teach', '#tab-write']) {
      await page.click(tab);
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${name} ${tab.slice(5)}: no sideways scrolling`, overflow <= 1, String(overflow));
    }
    await page.click('#tab-teach');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, `5-${name}-teach.png`) });
  }

  check('no errors in the page console', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\nScreenshots: ${OUT}`);
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll end-to-end checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
