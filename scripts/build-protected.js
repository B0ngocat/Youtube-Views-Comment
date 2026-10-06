#!/usr/bin/env node
/*
 * Builds the password-protected site for GitHub Pages.
 *
 * Pages has no server, so the app is encrypted (PBKDF2-SHA256 + AES-256-GCM) and the login page
 * decrypts it in the browser. Only the login page and the ciphertext get published.
 *
 *   SITE_PASSWORD='...' node scripts/build-protected.js [outDir]
 *
 * The encrypted file is public, so a weak password can be cracked offline. Passwords under 12
 * characters are refused unless ALLOW_SHORT_PASSWORD=1 is set.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ITERATIONS = 600000;
const MIN_LENGTH = 12;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** index.html with its stylesheet and scripts inlined, so it is one self-contained document. */
function inlineApp() {
  let html = read('index.html');
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${read(href)}\n</style>`);
  // Big libraries (vendor/) go in as plain text and only run when the app asks for them (loadLib in src/sheetui.js), so
  // they cost nothing at start-up. In a plain checkout loadLib fetches the same files by name instead.
  const libs = fs.readdirSync(path.join(ROOT, 'vendor')).filter((f) => f.endsWith('.js')).sort();
  const table = libs.map((f) => `${JSON.stringify('vendor/' + f)}: ${JSON.stringify(read('vendor/' + f)).replace(/<\//g, '<\\/')}`);
  html = html.replace('</body>', () => `<script>window.HW_LIBS = {${table.join(',\n')}};</script>\n</body>`);
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => `<script>\n${read(src).replace(/<\/script/gi, '<\\/script')}\n</script>`);
  if (/<(link|script)[^>]+(href|src)="[^"]+"/.test(html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, ''))) {
    throw new Error('index.html still references an external file after inlining');
  }
  return html;
}

function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // WebCrypto expects ciphertext || tag
  return {
    v: 1,
    id: salt.toString('base64').slice(0, 8), // lets a browser tell "remembered key is for an older password"
    iter: ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: Buffer.concat([ct, tag]).toString('base64'),
  };
}

/** Returns the protected page as a string. Throws on a missing or short password. */
function buildProtected(password, opts) {
  const allowShort = !!(opts && opts.allowShort);
  if (!password) throw new Error('Set SITE_PASSWORD.');
  if (password.length < MIN_LENGTH && !allowShort) {
    throw new Error(`SITE_PASSWORD is under ${MIN_LENGTH} characters. The encrypted file is public, so a short password can be cracked offline. Set ALLOW_SHORT_PASSWORD=1 to use it anyway.`);
  }
  if (password.length < MIN_LENGTH) console.warn(`Warning: password is under ${MIN_LENGTH} characters, so it could be cracked offline.`);
  const payload = encrypt(inlineApp(), password);
  const page = read('scripts/login.template.html').replace('__PAYLOAD__', JSON.stringify(payload));
  if (page.includes(password)) throw new Error('refusing to write a page that contains the password');
  return page;
}

if (require.main === module) {
  try {
    const out = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
    const page = buildProtected(process.env.SITE_PASSWORD, { allowShort: process.env.ALLOW_SHORT_PASSWORD === '1' });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'index.html'), page);
    fs.writeFileSync(path.join(out, '.nojekyll'), '');
    console.log(`Wrote ${path.join(out, 'index.html')} (${(page.length / 1024).toFixed(0)} KB, encrypted)`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { buildProtected, inlineApp, ITERATIONS, MIN_LENGTH };
