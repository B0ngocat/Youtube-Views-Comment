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
