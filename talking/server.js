#!/usr/bin/env node
'use strict';
/*
 * The chat from core.js as a small server with no dependencies, keeping each room in a JSON file. For a machine of yours that
 * the two AIs can reach (put it behind a tunnel or a port forward to make it public):
 *
 *   node talking/server.js [--port 8787] [--host 0.0.0.0] [--dir talking-data]
 *
 *   curl http://localhost:8787/talking.txt                       (read everything)
 *   curl -d sender=A -d text="hello" http://localhost:8787/talking   (write)
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const core = require('./core');

/** Rooms as JSON files in `dir`, writes one at a time per room and through a temporary file so a crash never leaves half a file. */
function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const mem = core.memoryStore();
  const loaded = new Set();
  const chains = new Map();
  const file = (room) => path.join(dir, room + '.json');
  function load(room) {
    if (loaded.has(room)) return;
    loaded.add(room);
    try {
      const list = JSON.parse(fs.readFileSync(file(room), 'utf8'));
      if (Array.isArray(list)) mem.rooms.set(room, list.filter((m) => m && Number.isInteger(m.id) && typeof m.text === 'string'));
    } catch {
      /* a new room */
    }
  }
  return {
    async list(room) {
      load(room);
      return mem.list(room);
    },
    append(room, m) {
      // one at a time: the number is taken and the file written before the next post starts
      const run = (chains.get(room) || Promise.resolve()).then(async () => {
        load(room);
        const msg = await mem.append(room, m);
        const tmp = file(room) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(mem.rooms.get(room)));
        fs.renameSync(tmp, file(room));
        return msg;
      });
      chains.set(room, run.catch(() => {}));
      return run;
    },
  };
}

function createServer(opts) {
  const store = (opts && opts.store) || fileStore((opts && opts.dir) || 'talking-data');
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > core.MAX_BODY) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', async () => {
      try {
        const out = await core.handle(
          {
            method: req.method,
            path: url.pathname,
            query: url.searchParams,
            contentType: req.headers['content-type'],
            body: tooBig ? 'x'.repeat(core.MAX_BODY + 1) : Buffer.concat(chunks).toString('utf8'),
            origin: (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'localhost'),
          },
          store
        );
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      } catch (e) {
        console.error(e);
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Something went wrong.\n');
      }
    });
  });
}

if (require.main === module) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : dflt;
  };
  const port = +arg('port', process.env.PORT || 8787);
  const host = arg('host', '0.0.0.0');
  createServer({ dir: arg('dir', 'talking-data') }).listen(port, host, () => console.log(`talking on http://${host}:${port}/talking`));
}

module.exports = { createServer, fileStore };
