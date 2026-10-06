#!/usr/bin/env node
/*
 * The plain files published next to the protected page, so an AI assistant can fetch the MCP server by address instead of
 * the user uploading it each time:
 *
 *   handwriting-mcp.js        the server, one file, no dependencies          (+ .sha256)
 *   handwriting-mcp-pdf.js    the same with inspect_pdf and fill_pdf          (+ .sha256)
 *   mcp.txt                   how to fetch and run it, in plain text
 *
 * These hold the program only. They contain none of the user's handwriting, which stays in their own samples file.
 *
 *   node scripts/build-site-extras.js <outDir> [site address]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { build } = require('./build-mcp');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function instructions(base, hashes) {
  const url = (f) => (base ? base.replace(/\/?$/, '/') + f : f);
  return `Handwriting MCP server
======================

Writes text or math in the owner's own handwriting and returns a PNG. One file of plain Node.js (18 or newer),
no npm packages. It does not contain any handwriting: that is in a separate samples file the owner exports from
the Teach tab of the app (my-handwriting.json), which this server reads from disk and never sends anywhere.

Get it
  curl -fsSLO ${url('handwriting-mcp.js')}
  sha256sum handwriting-mcp.js     # should be ${hashes['handwriting-mcp.js']}

A version that can also read and fill PDFs (2 MB) is ${url('handwriting-mcp-pdf.js')}
  sha256 ${hashes['handwriting-mcp-pdf.js']}

Run it (speaks MCP over stdin/stdout)
  node handwriting-mcp.js --samples /path/to/my-handwriting.json
  (without --samples it looks for my-handwriting.json in the current folder, then next to the file)

As a web address instead
  node handwriting-mcp.js --samples my-handwriting.json --http 8787 --token <a secret of 16+ characters>
  POST http://127.0.0.1:8787/mcp with the header  Authorization: Bearer <token>

Tools
  handwriting_status   is the handwriting loaded, which characters have no sample
  write_text           {text, kind: "text"|"math", width_pt, letter_height_pt, ink, seed, format, include_base64}
                       format "png" (default): a PNG as MCP image content (include_base64 also gives it as text)
                       format "svg": the SVG markup itself as text, transparent, sized in points
                       format "both": both. Start with --format svg to make SVG the default.
  write_batch          {items: [{text, kind, seed, ...}], format, return_images}   many at once, handwriting loaded once
  inspect_pdf, fill_pdf   (PDF version only) find where answers go on a PDF, and write them in

Math input: x^2, \\frac{a}{b}, \\sqrt{x} or sqrt(x), \\sqrt[3]{x} or cubert(x), \\int_0^1, \\sum_{i=1}^{n},
\\text{ words }, and "\\ " for a space that stays (plain spaces are ignored, as in TeX).

The first call after a fresh start builds the handwriting (about 7 seconds) and caches it in a .handwriting-cache
folder next to the samples file, so later starts take under half a second.
`;
}

function buildExtras(outDir, base) {
  fs.mkdirSync(outDir, { recursive: true });
  const hashes = {};
  for (const [name, pdf] of [['handwriting-mcp.js', false], ['handwriting-mcp-pdf.js', true]]) {
    const code = build({ pdf });
    hashes[name] = sha(code);
    fs.writeFileSync(path.join(outDir, name), code);
    fs.writeFileSync(path.join(outDir, name + '.sha256'), `${hashes[name]}  ${name}\n`);
  }
  fs.writeFileSync(path.join(outDir, 'mcp.txt'), instructions(base, hashes));
  return hashes;
}

if (require.main === module) {
  const [, , out, base] = process.argv;
  if (!out) {
    console.error('usage: node scripts/build-site-extras.js <outDir> [site address]');
    process.exit(2);
  }
  const h = buildExtras(path.resolve(out), base);
  console.log('Wrote ' + Object.keys(h).join(', ') + ', mcp.txt');
}

module.exports = { buildExtras };
