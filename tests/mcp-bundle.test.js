'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { build } = require('../scripts/build-mcp');

const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');
const samplesJson = S.toJSON(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));

/** A folder holding only the built file and the samples, as it would be when handed to someone. */
function lonely(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-bundle-'));
  fs.writeFileSync(path.join(dir, 'handwriting-mcp.js'), build(opts));
  fs.writeFileSync(path.join(dir, 'my-handwriting.json'), samplesJson);
  return dir;
}

/** Start the file and return {ask(method, params), close()} over stdio. */
function run(dir, args) {
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), ...(args || [])], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (waiting.has(m.id)) waiting.get(m.id)(m);
    }
  });
  let id = 0;
  return {
    child,
    ask: (method, params) => new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    }),
    close: () => child.kill(),
  };
}

test('the built file has no reference to the rest of the project', () => {
  const code = build({});
  assert.ok(code.length < 400 * 1024, 'small: ' + code.length);
  assert.ok(!/require\(['"]\.{1,2}\//.test(code), 'no relative requires are left');
  assert.ok(!code.includes('pdfjsWorker') && !code.includes('PDFPageLeaf'), 'the PDF libraries are not in the small build');
});

test('alone in a folder with the samples, it answers write_text with a PNG, and base64 on request', async () => {
  const dir = lonely({});
  const s = run(dir);
  try {
    const init = await s.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'handwriting');
    const names = (await s.ask('tools/list')).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['handwriting_status', 'write_batch', 'write_text']);
    const r = await s.ask('tools/call', { name: 'write_text', arguments: { text: 'the quick fox', include_base64: true, width_pt: 300 } });
    const img = r.result.content.find((c) => c.type === 'image');
    assert.equal(Buffer.from(img.data, 'base64').subarray(1, 4).toString(), 'PNG');
    const b64 = r.result.content.map((c) => c.text || '').find((t) => t.startsWith('image/png base64:\n'));
    assert.equal(b64.split('\n')[1], img.data, 'the same picture, as text');
    const st = await s.ask('tools/call', { name: 'handwriting_status', arguments: {} });
    assert.match(st.result.content[0].text, /recorded words/);
    const pdf = await s.ask('tools/call', { name: 'inspect_pdf', arguments: { pdf: 'x.pdf' } });
    assert.ok(pdf.error, 'the PDF tools are not part of this build');
  } finally {
    s.close();
  }
});

test('the --pdf build adds the PDF tools and they work from a single file too', async () => {
  const dir = lonely({ pdf: true });
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  pg.drawText('Question 1', { x: 72, y: 700, size: 14, font });
  pg.drawLine({ start: { x: 72, y: 600 }, end: { x: 540, y: 600 }, thickness: 1 });
  fs.writeFileSync(path.join(dir, 'w.pdf'), await doc.save());
  const s = run(dir, ['--out', path.join(dir, 'results')]);
  try {
    assert.deepEqual((await s.ask('tools/list')).result.tools.map((t) => t.name).sort(), ['fill_pdf', 'handwriting_status', 'inspect_pdf', 'write_batch', 'write_text']);
    const ins = await s.ask('tools/call', { name: 'inspect_pdf', arguments: { pdf: path.join(dir, 'w.pdf') } });
    assert.match(ins.result.content[0].text, /line\s+x=72 y=192 w=468/);
    const fill = await s.ask('tools/call', { name: 'fill_pdf', arguments: { pdf: path.join(dir, 'w.pdf'), answers: [{ page: 1, x: 72, line_y: 192, width: 468, text: 'the quick fox' }] } });
    assert.ok(!fill.result.isError, JSON.stringify(fill.result));
    assert.ok(fs.existsSync(path.join(dir, 'results', 'w-filled.pdf')));
  } finally {
    s.close();
  }
});

test('--http serves the same tools at /mcp, and only with the token', async () => {
  const dir = lonely({});
  const token = 'a-long-enough-secret-123';
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), '--http', '0', '--token', token], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
        const m = err.match(/127\.0\.0\.1:(\d+)\/mcp/);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', () => reject(new Error('exited: ' + err)));
    });
    const post = (body, auth) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth ? { authorization: 'Bearer ' + auth } : {}) }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
      });
      req.end(JSON.stringify(body));
    });
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token-wrong-token')).status, 401);
    const ok = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_text', arguments: { text: 'the fox' } } }, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result.content[0].type, 'image');
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token)).status, 202);
  } finally {
    child.kill();
  }
});

test('--http refuses to start without a real token', async () => {
  const dir = lonely({});
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), '--http', '0', '--token', 'short'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
});
