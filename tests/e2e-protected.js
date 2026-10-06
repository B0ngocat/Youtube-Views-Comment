/*
 * Browser test of the password-protected build: wrong password, right password, remember on
 * this device, lock. Serves the page from localhost because WebCrypto needs a secure context.
 *
 *   npm run e2e:protected
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { buildProtected } = require('../scripts/build-protected');

const PASSWORD = 'e2e-password-correct-horse';
let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (!ok && detail ? '  -> ' + detail : ''));
  if (!ok) failed++;
};

(async () => {
  const page = buildProtected(PASSWORD);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const tab = await ctx.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(e.message));

  await tab.goto(url);
  await tab.waitForSelector('#pw');
  check('login form is shown, app is not', (await tab.locator('#pad').count()) === 0);
  const shot = process.argv[2];
  if (shot) {
    fs.mkdirSync(shot, { recursive: true });
    await tab.screenshot({ path: path.join(shot, 'login.png') });
  }

  await tab.fill('#pw', 'not the password');
  await tab.click('#go');
  await tab.waitForFunction(() => document.querySelector('#err').textContent.length > 0);
  check('wrong password is rejected', /Wrong password/.test(await tab.textContent('#err')));
  check('still no app after a wrong password', (await tab.locator('#pad').count()) === 0);

  await tab.fill('#pw', PASSWORD);
  await tab.click('#go');
  await tab.waitForSelector('#pad', { timeout: 15000 });
  check('right password opens the app', true);
  check('the app works after decrypting (state, tabs)', await tab.evaluate(() => !!window.HW_APP && !document.querySelector('#teach').hidden));
  check('Lock button is offered on the protected site', await tab.isVisible('#btnLock'));

  // the Download button, bottom left, gives one zip of everything
  const { readZip } = require('./zip-reader');
  const box = await tab.locator('#btnDownloadAll').boundingBox();
  const vp = tab.viewportSize();
  check('a Download button sits at the bottom left', !!box && box.x < 40 && box.y + box.height > vp.height - 40 && box.y + box.height <= vp.height, JSON.stringify(box));
  await tab.click('#btnDownloadAll');
  check('it opens a small panel with the handwriting option off', (await tab.isVisible('#dlPanel')) && !(await tab.isChecked('#dlSamples')));
  check('and the handwriting option is unavailable when nothing has been taught', await tab.isDisabled('#dlSamples'));
  const [dl] = await Promise.all([tab.waitForEvent('download'), tab.click('#dlGo')]);
  check('the file is a zip with a plain name', dl.suggestedFilename() === 'handwriting-engine.zip', dl.suggestedFilename());
  const zipPath = path.join(shot || require('os').tmpdir(), 'handwriting-engine.zip');
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await dl.saveAs(zipPath);
  let files;
  try {
    files = readZip(fs.readFileSync(zipPath));
  } catch (e) {
    files = new Map();
    check('the zip opens and every file checks out', false, e.message);
  }
  const top = 'handwriting-engine/';
  for (const need of ['README.md', 'CLAUDE.md', 'index.html', 'src/synth.js', 'handwriting-mcp.js', 'handwriting-mcp-pdf.js', 'docs/handwriting-engine-guide.pdf']) check('the zip has ' + need, files.has(top + need));
  check('the PDF guide is a real PDF', !!files.get(top + 'docs/handwriting-engine-guide.pdf') && files.get(top + 'docs/handwriting-engine-guide.pdf').subarray(0, 5).toString() === '%PDF-');
  check('without asking, none of the user\'s handwriting is in it', ![...files.keys()].some((n) => /my-handwriting/.test(n)));
  // with the option: give the app some handwriting first, then the file is in the zip
  await tab.evaluate(() => window.HW_APP.words.push({ text: 'hi', xh: 30, baseline: 0, strokes: [[[0, 0, 0, 0.5], [5, 5, 10, 0.5]]] }));
  await tab.click('#btnDownloadAll');
  check('the handwriting option works once something is taught', !(await tab.isDisabled('#dlSamples')));
  await tab.check('#dlSamples');
  const [dl2] = await Promise.all([tab.waitForEvent('download'), tab.click('#dlGo')]);
  await dl2.saveAs(zipPath);
  const withHand = readZip(fs.readFileSync(zipPath));
  const mine = withHand.get(top + 'my-handwriting.json');
  check('ticking it adds my-handwriting.json with the words', !!mine && JSON.parse(mine.toString()).words[0].text === 'hi');
  await tab.evaluate(() => window.HW_APP.words.pop());

  // the Sheet tab's libraries travel inside the encrypted page and load from there, not from the network
  const requested = [];
  tab.on('request', (r) => requested.push(r.url()));
  const PDFLib = require('../vendor/pdf-lib.min.js');
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage([612, 792]);
  const pdfBytes = Buffer.from(await doc.save());
  await tab.click('#tab-sheet');
  await tab.setInputFiles('#sheetFile', { name: 'blank.pdf', mimeType: 'application/pdf', buffer: pdfBytes });
  await tab.waitForFunction(() => /Page 1 of 1/.test(document.querySelector('#sheetPageNo').textContent), null, { timeout: 30000 });
  check('the Sheet tab opens a PDF on the protected site', true);
  check('without fetching anything from the server', !requested.some((u) => /vendor|\.js$/.test(u)), requested.join(' '));
  await tab.click('#tab-teach');

  await tab.reload();
  await tab.waitForSelector('#pad', { timeout: 15000 });
  check('"Remember on this device" skips the login next time', true);

  await tab.click('#btnLock');
  await tab.waitForSelector('#pw');
  check('Lock returns to the login form', true);
  await tab.reload();
  await tab.waitForSelector('#pw');
  check('after locking, a reload asks for the password again', (await tab.locator('#pad').count()) === 0);

  // not remembered when the box is unticked
  await tab.uncheck('#rem');
  await tab.fill('#pw', PASSWORD);
  await tab.click('#go');
  await tab.waitForSelector('#pad', { timeout: 15000 });
  await tab.reload();
  await tab.waitForSelector('#pw');
  check('unticking "Remember" means it asks again', true);

  check('no script errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.close();
  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nProtected-site checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
