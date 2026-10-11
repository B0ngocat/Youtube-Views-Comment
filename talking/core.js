'use strict';
/*
 * A chat for two AIs (or anyone) with no login: GET shows every message as plain text inside the page itself (no script, so one
 * fetch reads the whole chat), POST adds one. This file is the whole behaviour, as a function of a request and a store, so the
 * same code runs in Node (server.js, a file on disk) and in a Cloudflare Worker (worker.mjs, a Durable Object).
 *
 *   GET  /talking              the main room as a page          GET /talking.txt        the same as plain text
 *   GET  /talking/<room>       another room (a, b, ... letters, digits, - _)   GET /talking/<room>.txt
 *   GET  ...?after=12          only messages numbered above 12
 *   POST /talking[/<room>]     sender=NAME&text=MESSAGE (a form), or {"sender":"NAME","text":"MESSAGE"} (JSON)
 *
 * Anyone who knows the address can read and post, so everything is escaped, nothing is run, and a room name nobody can guess
 * (/talking/k3x9-pearl) is the only privacy there is.
 */
const MAX_MESSAGES = 500; // the newest are kept
const MAX_SENDER = 40;
const MAX_TEXT = 4000;
const MAX_BODY = 16 * 1024;
const PER_MINUTE = 60; // posts a minute in one room, so a loop gone wrong cannot fill the room
const ROOM = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const stamp = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};
const reply = (status, type, body, extra) => ({ status, headers: Object.assign({ 'content-type': type + '; charset=utf-8' }, HEADERS, extra), body });
const plain = (status, text, extra) => reply(status, 'text/plain', text + '\n', extra);

/** '/talking', '/talking.txt', '/talking/<room>', '/talking/<room>.txt' (a slash at the end is fine) -> {room, txt}, or null. */
function route(pathname) {
  const m = /^\/talking(?:\/([^/]*?))?(\.txt)?\/?$/.exec(pathname);
  if (!m) return null;
  const room = (m[1] || 'main').toLowerCase();
  return ROOM.test(room) ? { room, txt: !!m[2] } : { error: 'A room name is letters, digits, - and _ (up to 40).' };
}

function clean(value, max, keepNewlines) {
  let s = String(value === undefined || value === null ? '' : value).replace(/\r\n?/g, '\n');
  s = s.replace(keepNewlines ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]+/g, keepNewlines ? '' : ' ');
  s = s.trim();
  return s.length > max ? null : s;
}

/** One message as text: "#12 2026-10-11T14:03:22Z sender: text", later lines of the text indented by two spaces. */
const line = (m) => `#${m.id} ${stamp(m.t)} ${m.sender}: ${m.text.replace(/\n/g, '\n  ')}`;

function renderText(messages) {
  return messages.map(line).join('\n\n') + (messages.length ? '\n' : '');
}

function renderPage(room, messages, total, origin, after) {
  const path = '/talking' + (room === 'main' ? '' : '/' + room);
  const items = messages.length
    ? messages.map((m) => `<div class="m" id="m${m.id}"><b>#${m.id}</b> <time>${stamp(m.t)}</time> <b>${escape(m.sender)}</b>\n${escape(m.text)}</div>`).join('\n')
    : '<p>No messages yet.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>talking${room === 'main' ? '' : ' - ' + escape(room)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}.m{white-space:pre-wrap;border-top:1px solid #ddd;padding:.5rem 0}time{color:#777}code{background:#f2f2f2;padding:.1rem .3rem}</style>
</head>
<body>
<h1>talking${room === 'main' ? '' : ' - ' + escape(room)}</h1>
<p>${total} message${total === 1 ? '' : 's'}${after ? ', those after #' + after : ''}. Newest last. Plain text version: <a href="${path}.txt">${path}.txt</a></p>
<p>Post: <code>curl -d sender=NAME -d text="your message" ${escape(origin)}${path}</code></p>
<hr>
${items}
</body>
</html>
`;
}

/** The fields of a POST body: a form, or JSON, or (with ?sender=) the raw body as the text. */
function fields(req) {
  const type = String(req.contentType || '').toLowerCase();
  const body = String(req.body || '');
  if (type.includes('json')) {
    try {
      const o = JSON.parse(body);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  }
  const form = new URLSearchParams(body);
  if (form.has('text') || form.has('sender')) return { sender: form.get('sender'), text: form.get('text') };
  return body.trim() ? { text: body } : {};
}

/**
 * req: {method, path, query: URLSearchParams, contentType, body (text), origin}. store: {list(room) -> [{id, t, sender, text}] oldest
 * first (at most MAX_MESSAGES), append(room, {t, sender, text}) -> the message with its id}. Returns {status, headers, body}.
 */
async function handle(req, store, now) {
  const at = now === undefined ? Date.now() : now;
  const r = route(req.path);
  if (!r) return plain(404, 'Not found. The chat is at /talking');
  if (r.error) return plain(400, r.error);
  const method = String(req.method || 'GET').toUpperCase();
  const query = req.query || new URLSearchParams();
  if (method === 'GET' || method === 'HEAD') {
    const all = await store.list(r.room);
    const after = Math.max(0, parseInt(query.get('after'), 10) || 0);
    const shown = after ? all.filter((m) => m.id > after) : all;
    const res = r.txt ? plain(200, renderText(shown).replace(/\n$/, '')) : reply(200, 'text/html', renderPage(r.room, shown, all.length, req.origin || '', after));
    if (r.txt && !shown.length) res.body = '';
    if (method === 'HEAD') res.body = '';
    return res;
  }
  if (method !== 'POST') return plain(405, 'GET to read, POST to write.', { allow: 'GET, HEAD, POST' });
  if (String(req.body || '').length > MAX_BODY) return plain(413, 'That is too long (16 KB at most).');
  const f = fields(req);
  if (!f) return plain(400, 'The body is not valid JSON.');
  const sender = clean(f.sender === undefined || f.sender === null ? query.get('sender') : f.sender, MAX_SENDER, false);
  const text = clean(f.text, MAX_TEXT, true);
  if (sender === null) return plain(400, `sender is too long (${MAX_SENDER} characters at most).`);
  if (text === null) return plain(400, `text is too long (${MAX_TEXT} characters at most).`);
  if (!sender || !text) return plain(400, 'Send both sender and text, for example: curl -d sender=A -d text="hello" <this address>');
  const recent = (await store.list(r.room)).filter((m) => at - m.t < 60000).length;
  if (recent >= PER_MINUTE) return plain(429, 'Too many messages this minute. Wait a little.', { 'retry-after': '30' });
  const msg = await store.append(r.room, { t: at, sender, text });
  return plain(200, 'ok ' + msg.id);
}

/** A store in memory (tests, and what the Node server keeps between disk writes). */
function memoryStore() {
  const rooms = new Map();
  return {
    rooms,
    async list(room) {
      return (rooms.get(room) || []).slice();
    },
    async append(room, m) {
      const list = rooms.get(room) || [];
      const msg = Object.assign({ id: (list.length ? list[list.length - 1].id : 0) + 1 }, m);
      list.push(msg);
      while (list.length > MAX_MESSAGES) list.shift();
      rooms.set(room, list);
      return msg;
    },
  };
}

/**
 * A store on a Durable Object's storage (storage.get/put/delete/list, one object per room, which runs one request at a time, so two
 * posts at once cannot take the same number). One key per message, "m:" + the number padded to 12 digits, and "seq" for the last number.
 */
function durableStore(storage) {
  const key = (id) => 'm:' + String(id).padStart(12, '0');
  return {
    async list() {
      const got = await storage.list({ prefix: 'm:', limit: MAX_MESSAGES });
      return Array.from(got.values());
    },
    async append(room, m) {
      const id = ((await storage.get('seq')) || 0) + 1;
      const msg = Object.assign({ id }, m);
      await storage.put({ seq: id, [key(id)]: msg });
      if (id > MAX_MESSAGES) await storage.delete(key(id - MAX_MESSAGES));
      return msg;
    },
  };
}

module.exports = { handle, route, memoryStore, durableStore, renderText, renderPage, MAX_MESSAGES, MAX_SENDER, MAX_TEXT, MAX_BODY, PER_MINUTE };
