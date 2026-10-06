'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildProtected, inlineApp } = require('../scripts/build-protected');

const PASSWORD = 'unit-test-password-12345';

function payloadOf(page) {
  const m = page.match(/var P = (\{[^;]*\});/);
  assert.ok(m, 'payload present');
  return JSON.parse(m[1]);
}

/** Decrypt the way the browser does (PBKDF2 -> AES-GCM over ciphertext||tag). */
function decrypt(payload, password) {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const key = crypto.pbkdf2Sync(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, payload.iter, 32, 'sha256');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8');
}

test('the right password decrypts to the complete, self-contained app', () => {
  const page = buildProtected(PASSWORD);
  const html = decrypt(payloadOf(page), PASSWORD);
  assert.ok(html.includes('id="btnNext"') && html.includes('HW_APP') && html.includes('function mulberry32'));
  assert.ok(!/<script src=|<link rel="stylesheet"/.test(html), 'everything is inlined');
  assert.equal(html, inlineApp());
});

test('a wrong password cannot decrypt', () => {
  const page = buildProtected(PASSWORD);
  assert.throws(() => decrypt(payloadOf(page), PASSWORD + 'x'));
});

test('the published page reveals nothing about the app or the password', () => {
  const page = buildProtected(PASSWORD);
  for (const secret of [PASSWORD, 'btnNext', 'HW_APP', 'mulberry32', 'alignWord', 'liquor jugs', 'Pack my box']) {
    assert.ok(!page.includes(secret), 'page leaks: ' + secret);
  }
  assert.match(page, /noindex/);
});

test('every build uses a fresh salt and iv', () => {
  const a = payloadOf(buildProtected(PASSWORD));
  const b = payloadOf(buildProtected(PASSWORD));
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test('short or missing passwords are refused unless explicitly allowed', () => {
  assert.throws(() => buildProtected(''), /Set SITE_PASSWORD/);
  assert.throws(() => buildProtected(undefined), /Set SITE_PASSWORD/);
  assert.throws(() => buildProtected('short'), /under 12/);
  const page = buildProtected('short-pw', { allowShort: true });
  assert.equal(decrypt(payloadOf(page), 'short-pw').includes('HW_APP'), true);
});

test('the pack for the Download button holds the project, the servers and the guide, and never samples or secrets', () => {
  const { buildPack, packScript } = require('../scripts/pack');
  const { readZip } = require('./zip-reader');
  const pack = buildPack();
  const names = pack.map((e) => e.name);
  const top = 'handwriting-engine/';
  for (const need of ['README.md', 'CLAUDE.md', 'package.json', 'index.html', 'src/synth.js', 'mcp/server.js', 'handwriting-mcp.js', 'handwriting-mcp-pdf.js', 'docs/handwriting-engine-guide.pdf', 'scripts/build-mcp.js']) assert.ok(names.includes(top + need), need);
  assert.ok(!names.some((n) => /my-handwriting|node_modules|dist\/|\.handwriting-cache|package-lock|\.git\//.test(n)), 'nothing private or generated');
  // every entry inflates back to what its CRC says, and none of them mention a password this project has used
  const zlib = require('zlib');
  const { crc32 } = require('../scripts/pack');
  for (const e of pack) {
    const data = zlib.inflateRawSync(e.deflated);
    assert.equal(data.length, e.size);
    assert.equal(crc32(data), e.crc, e.name);
    // passwords are never kept in the project, so this reads them from the environment when you want the check run:
    //   HW_SECRETS='one,two' npm test
    for (const secret of (process.env.HW_SECRETS || '').split(',').filter(Boolean)) assert.ok(!data.includes(secret), 'a secret is in ' + e.name);
  }
  const script = packScript();
  assert.ok(script.startsWith('window.HW_PACK = ['));
  assert.ok(!script.includes('</script'), 'safe inside a script tag');
  assert.ok(readZip); // the reader is exercised against the real zip in the browser test
});
