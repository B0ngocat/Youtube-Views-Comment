'use strict';
// kind: "mixed" through the tools (write_text, write_batch, fill_pdf) and through the one-file build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { corpus } = require('./fixtures');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { createServer } = require('../mcp/server');
const { build } = require('../scripts/build-mcp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-mixed-'));
const samples = path.join(tmp, 'my-handwriting.json');
fs.writeFileSync(samples, S.toJSON(corpus('print').raws.map((r, i) => writeWord(r.text, { style: 'print', seed: i + 1 }))));
const server = createServer({ samples, out: path.join(tmp, 'out') });
let nextId = 1;
const call = (name, args) => server({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
const textOf = (r) => r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const MIXED = 'the quick fox $\\frac{a}{b}$ and $y = x$ over the lazy dog';

test('write_text kind mixed writes words and math, and kind text still treats $ as a character', async () => {
  const r = await call('write_text', { text: MIXED, kind: 'mixed', format: 'svg', on_missing: 'fallback' });
  assert.ok(!r.result.isError, textOf(r));
  assert.match(textOf(r), /<path/);
  const png = await call('write_text', { text: MIXED, kind: 'mixed', on_missing: 'fallback' });
  assert.match(textOf(png), /Drawn as clean stand-ins.*=/);
  const t = await call('write_text', { text: 'the $quick$ fox', format: 'svg' });
  assert.ok(t.result.isError, 'text mode does not read $ as math: it is a character this writer has no sample of');
  assert.match(textOf(t), /\$ \(U\+0024\) is in "\$quick\$"/);
});

test('mixed: an unclosed $, an unknown command and a missing letter stop the call with the usual messages', async () => {
  const a = await call('write_text', { text: 'the $x fox', kind: 'mixed' });
  assert.ok(a.result.isError);
  assert.match(textOf(a), /Unclosed \$ at character 5/);
  const b = await call('write_text', { text: 'the $x \\foo y$ fox', kind: 'mixed', on_missing: 'fallback' });
  assert.ok(b.result.isError);
  assert.match(textOf(b), /math has TeX commands that are not supported/);
  assert.match(textOf(b), /\\foo in/);
  const c = await call('write_text', { text: 'the qu\u00e6k fox $x$', kind: 'mixed' });
  assert.ok(c.result.isError);
  assert.match(textOf(c), /no sample for some of the characters/);
  assert.match(textOf(c), /"qu\u00e6k"/);
  const d = await call('write_text', { text: 'the fox $x + 5$', kind: 'mixed', on_missing: 'fallback' });
  assert.ok(d.result.isError, 'a digit inside the math cannot be faked');
  assert.match(textOf(d), /5 \(U\+0035\)/);
});

test('write_batch takes mixed items, and reports a broken one by its number', async () => {
  const r = await call('write_batch', { items: [{ text: 'the fox' }, { text: MIXED, kind: 'mixed' }], on_missing: 'fallback', format: 'svg' });
  assert.ok(!r.result.isError, textOf(r));
  const bad = await call('write_batch', { items: [{ text: 'the fox' }, { text: 'a $x \\foo', kind: 'mixed' }] });
  assert.match(textOf(bad), /2\. FAILED: Unclosed/);
});

test('fill_pdf writes a mixed answer, and stops before writing for an unclosed $ or an unknown command', async () => {
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage([612, 792]);
  const pdf = path.join(tmp, 'sheet.pdf');
  fs.writeFileSync(pdf, await doc.save());
  const dest = path.join(tmp, 'filled.pdf');
  const ans = (text) => [{ page: 1, x: 72, y: 100, width: 300, height: 60, text, kind: 'mixed' }];
  const ok = await call('fill_pdf', { pdf, out: dest, answers: ans(MIXED), on_missing: 'fallback' });
  assert.ok(!ok.result.isError, textOf(ok));
  assert.ok(fs.existsSync(dest));
  fs.unlinkSync(dest);
  const open = await call('fill_pdf', { pdf, out: dest, answers: ans('so $x fox') });
  assert.ok(open.result.isError);
  assert.match(textOf(open), /answer 1: Unclosed \$/);
  const unk = await call('fill_pdf', { pdf, out: dest, answers: ans('so $\\foo$ fox') });
  assert.ok(unk.result.isError);
  assert.match(textOf(unk), /answer 1 \(page 1\): \\foo/);
  assert.ok(!fs.existsSync(dest), 'nothing written');
});

test('the one-file build carries mixed: write_text works from a lone file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-mixed-bundle-'));
  fs.writeFileSync(path.join(dir, 'handwriting-mcp.js'), build({}));
  fs.copyFileSync(samples, path.join(dir, 'my-handwriting.json'));
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reply = await new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]));
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_text', arguments: { text: MIXED, kind: 'mixed', format: 'svg', on_missing: 'fallback' } } }) + '\n');
    });
    assert.ok(!reply.result.isError, JSON.stringify(reply).slice(0, 300));
    assert.match(reply.result.content.map((c) => c.text || '').join(''), /<path/);
  } finally {
    child.kill();
  }
});
