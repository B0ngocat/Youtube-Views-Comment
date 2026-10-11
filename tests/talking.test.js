'use strict';
// The chat for two AIs: readable with one plain fetch, writable with one curl, no login, nothing run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../talking/core');
const { createServer } = require('../talking/server');

const req = (method, p, body, type) => {
  const u = new URL(p, 'http://x');
  return { method, path: u.pathname, query: u.searchParams, contentType: type, body: body || '', origin: 'https://chat.example' };
};
const post = (store, p, form, now) => core.handle(req('POST', p, new URLSearchParams(form).toString(), 'application/x-www-form-urlencoded'), store, now);

test('an empty room is a page that says so, with no script', async () => {
  const r = await core.handle(req('GET', '/talking'), core.memoryStore());
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/html/);
  assert.ok(r.body.includes('No messages yet.') && !/<script/i.test(r.body), 'nothing to run');
  assert.ok(r.body.includes('curl -d sender=NAME -d text="your message" https://chat.example/talking'), 'says how to post, with its own address');
});

test('a posted message is in the page itself as text, newest last, and in the plain text version', async () => {
  const store = core.memoryStore();
  assert.equal((await post(store, '/talking', { sender: 'Ana', text: 'first' }, 1e12)).body, 'ok 1\n');
  assert.equal((await post(store, '/talking', { sender: 'Ben', text: 'second\nline two' }, 1e12 + 5000)).body, 'ok 2\n');
  const page = (await core.handle(req('GET', '/talking'), store)).body;
  assert.ok(page.indexOf('first') < page.indexOf('second'), 'in order');
  assert.ok(page.includes('<b>Ana</b>') && page.includes('second\nline two') && page.includes('2 messages'));
  const txt = await core.handle(req('GET', '/talking.txt'), store);
  assert.match(txt.headers['content-type'], /^text\/plain/);
  assert.equal(txt.body, '#1 2001-09-09T01:46:40Z Ana: first\n\n#2 2001-09-09T01:46:45Z Ben: second\n  line two\n');
});

test('?after=N gives only what is new', async () => {
  const store = core.memoryStore();
  for (const t of ['a', 'b', 'c']) await post(store, '/talking', { sender: 'x', text: t });
  const r = await core.handle(req('GET', '/talking.txt?after=2'), store);
  assert.ok(r.body.includes('#3') && !r.body.includes('#2') && !r.body.includes('#1'));
  assert.equal((await core.handle(req('GET', '/talking.txt?after=3'), store)).body, '');
  assert.ok((await core.handle(req('GET', '/talking?after=1'), store)).body.includes('those after #1'));
});

test('JSON, a form, and a raw body with ?sender= all post', async () => {
  const store = core.memoryStore();
  assert.equal((await core.handle(req('POST', '/talking', JSON.stringify({ sender: 'J', text: 'json' }), 'application/json'), store)).status, 200);
  assert.equal((await post(store, '/talking', { sender: 'F', text: 'form' })).status, 200);
  assert.equal((await core.handle(req('POST', '/talking?sender=R', 'raw body text', 'text/plain'), store)).status, 200);
  assert.equal((await core.handle(req('POST', '/talking', '{not json', 'application/json'), store)).status, 400);
  const list = await store.list('main');
  assert.deepEqual(list.map((m) => [m.sender, m.text]), [['J', 'json'], ['F', 'form'], ['R', 'raw body text']]);
});

test('bad posts are refused with a plain reason: nothing missing, nothing too long, nothing with other methods', async () => {
  const store = core.memoryStore();
  assert.equal((await post(store, '/talking', { sender: 'A' })).status, 400);
  assert.equal((await post(store, '/talking', { text: 'no sender' })).status, 400);
  assert.equal((await post(store, '/talking', { sender: 'x'.repeat(41), text: 'hi' })).status, 400);
  assert.equal((await post(store, '/talking', { sender: 'A', text: 'x'.repeat(4001) })).status, 400);
  assert.equal((await core.handle(req('POST', '/talking', 'x'.repeat(core.MAX_BODY + 1), 'text/plain'), store)).status, 413);
  for (const m of ['PUT', 'DELETE', 'PATCH']) assert.equal((await core.handle(req(m, '/talking'), store)).status, 405, m);
  assert.equal((await core.handle(req('GET', '/other'), store)).status, 404);
  assert.equal((await core.handle(req('GET', '/talking/BAD ROOM!'), store)).status, 400);
  assert.equal((await store.list('main')).length, 0, 'nothing was stored');
});

test('what people send is text and never markup: escaped in the page, and the page cannot run anything', async () => {
  const store = core.memoryStore();
  await post(store, '/talking', { sender: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script> & "quotes" \'single\'' });
  const r = await core.handle(req('GET', '/talking'), store);
  assert.ok(!/<script/i.test(r.body) && !r.body.includes('<img'), 'escaped');
  assert.ok(r.body.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &#39;single&#39;'));
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  const t = await core.handle(req('GET', '/talking.txt'), store);
  assert.match(t.headers['content-type'], /^text\/plain/, 'the text version is never taken for a page');
});

test('control characters are dropped, a sender is one line, and rooms are separate', async () => {
  const store = core.memoryStore();
  await post(store, '/talking/Pearl-9', { sender: 'A\nB\u0007', text: 'x\u0000y\r\nz' });
  const [m] = await store.list('pearl-9');
  assert.deepEqual([m.sender, m.text], ['A B', 'xy\nz']);
  assert.equal((await store.list('main')).length, 0);
  assert.ok((await core.handle(req('GET', '/talking/pearl-9/'), store)).body.includes('<b>A B</b>'));
  assert.ok((await core.handle(req('GET', '/talking/pearl-9.txt'), store)).body.includes('A B: xy'));
});

test('the newest 500 are kept, and a flood in one minute is stopped', async () => {
  const store = core.memoryStore();
  for (let i = 0; i < core.MAX_MESSAGES + 5; i++) await store.append('main', { t: i * 1000, sender: 's', text: 'm' + i });
  const list = await store.list('main');
  assert.equal(list.length, core.MAX_MESSAGES);
  assert.equal(list[0].id, 6, 'the oldest went');
  const quick = core.memoryStore();
  const now = 5e12;
  let last = 0;
  for (let i = 0; i < core.PER_MINUTE + 3; i++) last = (await post(quick, '/talking', { sender: 'a', text: 'spam' }, now + i)).status;
  assert.equal(last, 429);
  assert.equal((await post(quick, '/talking', { sender: 'a', text: 'later' }, now + 61000)).status, 200, 'and fine a minute later');
});

test('the Durable Object store numbers messages in order, keeps 500, and lists them oldest first', async () => {
  const data = new Map();
  const storage = {
    async get(k) {
      return data.get(k);
    },
    async put(o) {
      for (const [k, v] of Object.entries(o)) data.set(k, v);
    },
    async delete(k) {
      data.delete(k);
    },
    async list({ prefix, limit }) {
      return new Map(Array.from(data.entries()).filter(([k]) => k.startsWith(prefix)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, limit));
    },
  };
  const store = core.durableStore(storage);
  for (let i = 1; i <= core.MAX_MESSAGES + 3; i++) assert.equal((await store.append('r', { t: i, sender: 's', text: 't' })).id, i);
  const list = await store.list('r');
  assert.equal(list.length, core.MAX_MESSAGES);
  assert.deepEqual([list[0].id, list[list.length - 1].id], [4, core.MAX_MESSAGES + 3]);
});

test('the server: curl-style post and read over HTTP, kept in a file across a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talking-'));
  const run = async (fn) => {
    const server = createServer({ dir });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  };
  await run(async (base) => {
    const a = await fetch(base + '/talking', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'sender=A&text=hello+there' });
    assert.equal(await a.text(), 'ok 1\n');
    const both = await Promise.all([1, 2, 3, 4, 5].map((i) => fetch(base + '/talking', { method: 'POST', body: JSON.stringify({ sender: 'B', text: 'n' + i }), headers: { 'content-type': 'application/json' } }).then((r) => r.text())));
    assert.deepEqual(both.map((x) => x.trim()).sort(), ['ok 2', 'ok 3', 'ok 4', 'ok 5', 'ok 6'], 'posts at the same moment get their own numbers');
    const page = await (await fetch(base + '/talking')).text();
    assert.ok(page.includes('hello there') && !/<script/i.test(page));
  });
  await run(async (base) => {
    const txt = await (await fetch(base + '/talking.txt')).text();
    assert.ok(txt.startsWith('#1 ') && txt.includes('A: hello there') && txt.includes('#6 '), 'still there after a restart');
    const big = await fetch(base + '/talking', { method: 'POST', body: 'x'.repeat(40000) });
    assert.equal(big.status, 413);
  });
});
