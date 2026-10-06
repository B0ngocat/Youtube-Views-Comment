#!/usr/bin/env node
/*
 * An MCP server (Model Context Protocol, over stdio) so an AI assistant can write in the user's handwriting and fill
 * worksheets for them. It runs the same engine as the web app, here in Node, from the file the Teach tab's Export button
 * saves. The handwriting file is read from disk and never sent anywhere; only the pictures and text the tools return
 * go back to the assistant.
 *
 *   node mcp/server.js --samples /path/to/my-handwriting.json [--out /folder/for/results]
 *
 * (or HANDWRITING_FILE and HANDWRITING_OUT in the environment). No dependencies: the protocol is a few lines of JSON-RPC.
 */
'use strict';
const { createTools } = require('./tools');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Returns handle(message) -> response object, or null for a notification. */
function createServer(config) {
  const tools = createTools(config);
  return async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined) return null; // notifications (initialized, cancelled) need no answer
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOLS.includes(params && params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'handwriting', version: '1.0.0' },
          instructions: "Writes in the user's own handwriting. Use inspect_pdf to see where things are on a worksheet, write_text to preview an answer, and fill_pdf to put answers on the PDF. Only write what the user asked you to write.",
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.list() });
      case 'tools/call':
        try {
          return reply({ content: await tools.call(params && params.name, params && params.arguments) });
        } catch (e) {
          if (/^Unknown tool/.test(e.message)) return fail(-32602, e.message);
          return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
        }
      default:
        return fail(-32601, 'Method not found: ' + method);
    }
  };
}

function main() {
  // stdout carries the protocol; anything a library prints must go to stderr
  console.log = console.info = console.warn = (...a) => console.error(...a);
  const argv = process.argv.slice(2);
  const handle = createServer({
    samples: argValue(argv, '--samples') || process.env.HANDWRITING_FILE,
    out: argValue(argv, '--out') || process.env.HANDWRITING_OUT,
  });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        continue;
      }
      handle(msg).then(
        (res) => res && process.stdout.write(JSON.stringify(res) + '\n'),
        (e) => msg.id !== undefined && process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }) + '\n')
      );
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();
module.exports = { createServer, PROTOCOLS };
