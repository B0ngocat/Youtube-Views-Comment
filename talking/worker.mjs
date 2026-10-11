// The chat from core.js as a Cloudflare Worker: the Worker takes every request to /talking and hands it to one Durable Object per
// room (it runs one request at a time, so two posts at once never take the same message number). Deploy: see talking/README.md.
import core from './core.js';

export class Room {
  constructor(state) {
    this.store = core.durableStore(state.storage);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const out = await core.handle(
      {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        contentType: request.headers.get('content-type'),
        body: request.method === 'POST' ? await request.text() : '',
        origin: url.origin,
      },
      this.store
    );
    return new Response(request.method === 'HEAD' ? null : out.body, { status: out.status, headers: out.headers });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const r = core.route(url.pathname);
    if (!r) return new Response('Not found. The chat is at /talking\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const id = env.ROOM.idFromName(r.error ? 'bad' : r.room);
    return env.ROOM.get(id).fetch(request);
  },
};
