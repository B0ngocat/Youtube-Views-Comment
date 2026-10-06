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
  return files.map(([name, data]) => ({ name: TOP + (name === 'docs/START-HERE.txt' ? 'START-HERE.txt' : name), size: data.length, crc: crc32(data), deflated: zlib.deflateRawSync(data, { level: 9 }) }));
}

/** The pack as a real .zip file (a Buffer), for putting on the site as a plain download. */
function buildZip(extra) {
  const entries = buildPack(extra);
  const d = new Date();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.deflated.length, 18);
    local.writeUInt32LE(e.size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, e.deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(e.crc, 16);
    c.writeUInt32LE(e.deflated.length, 20);
    c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + e.deflated.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** The pack as the one line of script the page carries: window.HW_PACK = [[name, size, crc, base64], ...]. */
function packScript(extra) {
  const rows = buildPack(extra).map((e) => `[${JSON.stringify(e.name)},${e.size},${e.crc},${JSON.stringify(e.deflated.toString('base64'))}]`);
  return `window.HW_PACK = [${rows.join(',\n')}];`;
}

module.exports = { buildPack, buildZip, packScript, crc32, NEVER };
