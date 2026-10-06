#!/usr/bin/env node
/*
 * Everything in one download: the project files, the MCP server (both builds, ready to run) and the setup guide. The
 * protected site carries this inside its encrypted page, and the Download button in the app turns it into a .zip.
 *
 * The files are the ones git tracks, so the user's samples (my-handwriting*.json), caches, dist/ and node_modules are never in
 * it. Each entry is deflated here, once, so the browser only has to put the pieces together.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { build } = require('./build-mcp');

const ROOT = path.resolve(__dirname, '..');
const TOP = 'handwriting-engine/';
const NEVER = /(^|\/)(node_modules|dist|\.handwriting-cache|\.git)\/|my-handwriting[^/]*\.json$|package-lock\.json$|\.env/;

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 255;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean);
}

/** [{name, size, crc, deflated}] with names under handwriting-engine/. */
function buildPack(extra) {
  const files = tracked()
    .filter((f) => !NEVER.test(f))
    .map((f) => [f, fs.readFileSync(path.join(ROOT, f))]);
  // the servers, built here so a friend can run them straight away (no address baked in: they use their own samples)
  files.push(['handwriting-mcp.js', Buffer.from(build({ pdf: false }))], ['handwriting-mcp-pdf.js', Buffer.from(build({ pdf: true }))]);
  for (const e of extra || []) files.push(e);
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return files.map(([name, data]) => ({ name: TOP + name, size: data.length, crc: crc32(data), deflated: zlib.deflateRawSync(data, { level: 9 }) }));
}

/** The pack as the one line of script the page carries: window.HW_PACK = [[name, size, crc, base64], ...]. */
function packScript(extra) {
  const rows = buildPack(extra).map((e) => `[${JSON.stringify(e.name)},${e.size},${e.crc},${JSON.stringify(e.deflated.toString('base64'))}]`);
  return `window.HW_PACK = [${rows.join(',\n')}];`;
}

module.exports = { buildPack, packScript, crc32, NEVER };
