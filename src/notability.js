/*
 * Writing a Notability note (.note) whose handwriting is real pen strokes, so it can be selected, moved and erased in
 * Notability like anything drawn there, instead of being a flat picture on a PDF.
 *
 * How a note is built is not documented by Notability. This follows what jvns/svg2notability worked out (the note is a
 * zip of NSKeyedArchiver property lists, and the strokes are packed into a handful of byte arrays) and what a real note
 * looks like inside. Nothing here has been checked against a current Notability: if a note does not open, or the strokes
 * come out the wrong size or upside down, the numbers to adjust are the options of noteFromLayout.
 *
 * Plain JavaScript with no dependencies, for the page and for Node.
 */
(function (root) {
  'use strict';

  // ---- numbers ---------------------------------------------------------------------------------

  // In Node the pictures can be compressed; in a page they are stored (they are small, and there is no zlib there)
  const zlib = (() => {
    try {
      return typeof require !== 'undefined' ? require('zlib') : null;
    } catch {
      return null;
    }
  })();

  const PAGE_W = 537.5999755859375; // width of a page in Notability's own units on an iPad (pageWidthInDocumentCoordsKey)
  const PAGE_H = 705.6; // the page shape of the thumbnails Notability writes (48 x 63)
  // Found by opening a calibration note on an iPad: strokes are placed with y going DOWN from the top of the page, and x = 0
  // is 12.8 units in from the page's left edge (the page has a 12.8 margin each side), so the drawable width is 512.
  const INNER_W = 512;
  const COCOA_EPOCH = 978307200; // seconds from 1970 to 2001, which is where Apple's dates start

  // ---- binary property lists ---------------------------------------------------------------------

  class UID {
    constructor(value) {
      this.value = value;
    }
  }
  /** A number that must be written as a real (1.0), not an integer (1). */
  class Real {
    constructor(value) {
      this.value = value;
    }
  }

  const be = (n, bytes) => {
    const out = new Uint8Array(bytes);
    let v = BigInt(n);
    for (let i = bytes - 1; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  };
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  function encodeInt(n) {
    if (n < 0) return concat([Uint8Array.of(0x13), be(BigInt.asUintN(64, BigInt(n)), 8)]);
    if (n < 256) return Uint8Array.of(0x10, n);
    if (n < 65536) return concat([Uint8Array.of(0x11), be(n, 2)]);
    if (n < 4294967296) return concat([Uint8Array.of(0x12), be(n, 4)]);
    return concat([Uint8Array.of(0x13), be(n, 8)]);
  }
  /** The marker byte for a type with a length, with the length after it when it does not fit in the low four bits. */
  function marker(type, n) {
    return n < 15 ? Uint8Array.of((type << 4) | n) : concat([Uint8Array.of((type << 4) | 0xf), encodeInt(n)]);
  }

  function bplistWrite(top) {
    const objs = []; // {kind, ...}; index 0 is the top object
    function add(v) {
      const idx = objs.length;
      objs.push(null);
      if (v instanceof UID) objs[idx] = { kind: 'uid', v: v.value };
      else if (v instanceof Real) objs[idx] = { kind: 'real', v: v.value };
      else if (v instanceof Uint8Array) objs[idx] = { kind: 'data', v };
      else if (Array.isArray(v)) {
        const refs = [];
        objs[idx] = { kind: 'array', refs };
        for (const x of v) refs.push(add(x));
      } else if (typeof v === 'string') objs[idx] = { kind: 'str', v };
      else if (typeof v === 'boolean') objs[idx] = { kind: 'bool', v };
      else if (typeof v === 'number') objs[idx] = Number.isInteger(v) ? { kind: 'int', v } : { kind: 'real', v };
      else if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        const krefs = [];
        const vrefs = [];
        objs[idx] = { kind: 'dict', krefs, vrefs };
        for (const k of keys) krefs.push(add(k));
        for (const k of keys) vrefs.push(add(v[k]));
      } else throw new Error('cannot write ' + typeof v + ' into a property list');
      return idx;
    }
    add(top);
    const refSize = objs.length < 256 ? 1 : objs.length < 65536 ? 2 : 4;
    const ref = (i) => be(i, refSize);
    const header = new TextEncoder().encode('bplist00');
    const parts = [header];
    const offsets = [];
    let at = header.length;
    for (const o of objs) {
      offsets.push(at);
      let b;
      if (o.kind === 'bool') b = Uint8Array.of(o.v ? 0x09 : 0x08);
      else if (o.kind === 'int') b = encodeInt(o.v);
      else if (o.kind === 'real') {
        const dv = new DataView(new ArrayBuffer(9));
        dv.setUint8(0, 0x23);
        dv.setFloat64(1, o.v, false);
        b = new Uint8Array(dv.buffer);
      } else if (o.kind === 'data') b = concat([marker(4, o.v.length), o.v]);
      else if (o.kind === 'str') {
        if (/^[\x00-\x7f]*$/.test(o.v)) b = concat([marker(5, o.v.length), new TextEncoder().encode(o.v)]);
        else {
          const u = new Uint8Array(o.v.length * 2);
          for (let i = 0; i < o.v.length; i++) {
            u[2 * i] = o.v.charCodeAt(i) >> 8;
            u[2 * i + 1] = o.v.charCodeAt(i) & 255;
          }
          b = concat([marker(6, o.v.length), u]);
        }
      } else if (o.kind === 'uid') {
        const n = o.v < 256 ? 1 : o.v < 65536 ? 2 : 4;
        b = concat([Uint8Array.of(0x80 | (n - 1)), be(o.v, n)]);
      } else if (o.kind === 'array') b = concat([marker(0xa, o.refs.length), ...o.refs.map(ref)]);
      else b = concat([marker(0xd, o.krefs.length), ...o.krefs.map(ref), ...o.vrefs.map(ref)]);
      parts.push(b);
      at += b.length;
    }
    const offSize = at < 256 ? 1 : at < 65536 ? 2 : at < 4294967296 ? 4 : 8;
    for (const off of offsets) parts.push(be(off, offSize));
    const trailer = new Uint8Array(32);
    trailer[6] = offSize;
    trailer[7] = refSize;
    trailer.set(be(objs.length, 8), 8);
    trailer.set(be(0, 8), 16);
    trailer.set(be(at, 8), 24);
    parts.push(trailer);
    return concat(parts);
  }

  /** Reads a binary property list back (for tests and for looking inside a note). UIDs come back as UID, data as Uint8Array. */
  function bplistRead(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (new TextDecoder().decode(bytes.subarray(0, 8)) !== 'bplist00') throw new Error('not a binary property list');
    const t = bytes.length - 32;
    const offSize = bytes[t + 6];
    const refSize = bytes[t + 7];
    const count = Number(dv.getBigUint64(t + 8));
    const topIdx = Number(dv.getBigUint64(t + 16));
    const tableAt = Number(dv.getBigUint64(t + 24));
    const uint = (at, n) => {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + bytes[at + i];
      return v;
    };
    const offsetOf = (i) => uint(tableAt + i * offSize, offSize);
    function lengthAt(p, low) {
      if (low < 15) return { n: low, next: p + 1 };
      const sizeBytes = 1 << (bytes[p + 1] & 0xf);
      return { n: uint(p + 2, sizeBytes), next: p + 2 + sizeBytes };
    }
    const cache = new Map();
    function read(i) {
      if (cache.has(i)) return cache.get(i);
      const p = offsetOf(i);
      const hi = bytes[p] >> 4;
      const lo = bytes[p] & 0xf;
      let v;
      if (bytes[p] === 0x08) v = false;
      else if (bytes[p] === 0x09) v = true;
      else if (bytes[p] === 0x00) v = null;
      else if (hi === 0x1) v = lo === 3 ? Number(dv.getBigInt64(p + 1)) : uint(p + 1, 1 << lo);
      else if (hi === 0x2) v = lo === 2 ? dv.getFloat32(p + 1) : dv.getFloat64(p + 1);
      else if (hi === 0x3) v = { date: dv.getFloat64(p + 1) };
      else if (hi === 0x4) {
        const { n, next } = lengthAt(p, lo);
        v = bytes.slice(next, next + n);
      } else if (hi === 0x5) {
        const { n, next } = lengthAt(p, lo);
        v = new TextDecoder().decode(bytes.subarray(next, next + n));
      } else if (hi === 0x6) {
        const { n, next } = lengthAt(p, lo);
        v = '';
        for (let k = 0; k < n; k++) v += String.fromCharCode((bytes[next + 2 * k] << 8) | bytes[next + 2 * k + 1]);
      } else if (hi === 0x8) v = new UID(uint(p + 1, lo + 1));
      else if (hi === 0xa) {
        const { n, next } = lengthAt(p, lo);
        v = [];
        for (let k = 0; k < n; k++) v.push(read(uint(next + k * refSize, refSize)));
      } else if (hi === 0xd) {
        const { n, next } = lengthAt(p, lo);
        v = {};
        for (let k = 0; k < n; k++) v[read(uint(next + k * refSize, refSize))] = read(uint(next + (n + k) * refSize, refSize));
      } else throw new Error('unknown property list type 0x' + bytes[p].toString(16));
      cache.set(i, v);
      return v;
    }
    if (count < 1) throw new Error('empty property list');
    return read(topIdx);
  }

  // ---- zip and png ---------------------------------------------------------------------------------

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf, start) {
    let c = start === undefined ? 0xffffffff : start;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return start === undefined ? (c ^ 0xffffffff) >>> 0 : c;
  }

  /** entries: [{name, data}] (a name ending in "/" is a folder). Stored, not compressed: notes are small. */
  function makeZip(entries, when) {
    const d = when || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = e.data || new Uint8Array(0);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true);
      c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(38, e.name.endsWith('/') ? 0x10 : 0, true); // folder flag
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cd = concat(central);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cd.length, true);
    end.setUint32(16, offset, true);
    return concat([...parts, cd, new Uint8Array(end.buffer)]);
  }

  function adler32(buf) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }
  function pngChunk(type, data) {
    const t = new TextEncoder().encode(type);
    const body = concat([t, data]);
    return concat([be(data.length, 4), body, be(crc32(body), 4)]);
  }
  /** An RGB PNG from rgb (width*height*3 bytes). The picture data is stored, not compressed: these are thumbnails. */
  function encodePng(width, height, rgb) {
    const raw = new Uint8Array(height * (1 + width * 3));
    for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
    const ihdr = concat([be(width, 4), be(height, 4), Uint8Array.of(8, 2, 0, 0, 0)]);
    const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    if (zlib) return concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(zlib.deflateSync(raw, { level: 9 }))), pngChunk('IEND', new Uint8Array(0))]);
    const blocks = [Uint8Array.of(0x78, 0x01)];
    for (let at = 0; at < raw.length; at += 65535) {
      const chunk = raw.subarray(at, Math.min(raw.length, at + 65535));
      const last = at + 65535 >= raw.length ? 1 : 0;
      blocks.push(Uint8Array.of(last, chunk.length & 255, chunk.length >> 8, ~chunk.length & 255, (~chunk.length >> 8) & 255), chunk);
    }
    blocks.push(be(adler32(raw), 4));
    return concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', concat(blocks)), pngChunk('IEND', new Uint8Array(0))]);
  }

  /** A small picture of the note for the thumbnails: the strokes as thin lines on white. */
  function thumbnail(curves, width, height) {
    const rgb = new Uint8Array(width * height * 3).fill(255);
    const sx = width / PAGE_W;
    const sy = height / PAGE_H;
    const dot = (x, y, c) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      for (let k = 0; k < 3; k++) rgb[(y * width + x) * 3 + k] = c[k];
    };
    for (const cv of curves) {
      let prev = null;
      for (const [x, y] of cv.pts) {
        const px = Math.round((x + 12.8) * sx);
        const py = Math.round(y * sy); // y goes down in a note, as in a picture
        if (prev) {
          const n = Math.max(Math.abs(px - prev[0]), Math.abs(py - prev[1]), 1);
          for (let k = 0; k <= n; k++) dot(Math.round(prev[0] + ((px - prev[0]) * k) / n), Math.round(prev[1] + ((py - prev[1]) * k) / n), cv.color);
        } else dot(px, py, cv.color);
        prev = [px, py];
      }
    }
    return encodePng(width, height, rgb);
  }

  // ---- the strokes ------------------------------------------------------------------------------------

  const f32 = (values) => {
    const out = new Uint8Array(values.length * 4);
    const dv = new DataView(out.buffer);
    values.forEach((v, i) => dv.setFloat32(i * 4, v, true));
    return out;
  };
  const i32 = (values) => {
    const out = new Uint8Array(values.length * 4);
    const dv = new DataView(out.buffer);
    values.forEach((v, i) => dv.setInt32(i * 4, v, true));
    return out;
  };
  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0x1749b3;
    return [n >> 16, (n >> 8) & 255, n & 255];
  };

  /**
   * A stroke is a chain of cubic Bezier segments: points 0 and 3, 3 and 6, and so on are the ends of a segment and the two points
   * between are its control points, so a stroke has 3k + 1 points. A stroke with any other number of points is not drawn at all
   * (found by opening notes on an iPad), and the width fractions are one per end point (k + 1 of them).
   *
   * This turns the points a stroke passes through into such a chain: a smooth curve through every one of them (a Catmull-Rom
   * spline written as Beziers). Two points give a straight line, and one point, a dot.
   */
  function toChain(anchors) {
    let a = anchors;
    if (a.length === 1) a = [[a[0][0] - 0.01, a[0][1]], [a[0][0] + 0.01, a[0][1]]];
    if (a.length === 2 && a[0][0] === a[1][0] && a[0][1] === a[1][1]) a = [[a[0][0] - 0.01, a[0][1]], [a[0][0] + 0.01, a[0][1]]];
    const m = a.length;
    const at = (i) => {
      if (i < 0) return [2 * a[0][0] - a[1][0], 2 * a[0][1] - a[1][1]]; // past the ends, carry on in the same direction
      if (i >= m) return [2 * a[m - 1][0] - a[m - 2][0], 2 * a[m - 1][1] - a[m - 2][1]];
      return a[i];
    };
    const out = [a[0]];
    for (let i = 0; i < m - 1; i++) {
      const p0 = at(i - 1);
      const p1 = a[i];
      const p2 = a[i + 1];
      const p3 = at(i + 2);
      out.push([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2);
    }
    return out;
  }

  /** Drop points closer than `spacing` to the last one kept (the first and last always stay): a stroke of thousands of points becomes a few hundred. */
  function thin(pts, spacing) {
    if (pts.length < 3 || !(spacing > 0)) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const l = out[out.length - 1];
      if (Math.hypot(pts[i][0] - l[0], pts[i][1] - l[1]) >= spacing) out.push(pts[i]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * The byte arrays a note keeps its strokes in. curves: [{pts: [[x, y], ...] (3k + 1 of them, see toChain), width, color: [r, g, b]}], already in the
   * note's own units. Little-endian, as written on an iPad.
   */
  function packCurves(curves) {
    const counts = curves.map((c) => c.pts.length);
    counts.forEach((n) => {
      if (n % 3 !== 1 || n < 4) throw new Error('A stroke must have 3k + 1 points (see toChain), not ' + n);
    });
    const fracCounts = counts.map((n) => (n - 1) / 3 + 1); // one width fraction (1.0 = the pen's width) for each end point of a segment
    const colors = new Uint8Array(curves.length * 4);
    curves.forEach((c, i) => colors.set([c.color[0], c.color[1], c.color[2], 255], i * 4));
    return {
      curvespoints: f32(curves.flatMap((c) => c.pts.flat())),
      curveswidth: f32(curves.map((c) => c.width)),
      curvesnumpoints: i32(counts),
      curvescolors: colors,
      curvesfractionalwidths: f32(curves.flatMap((c, i) => (c.fractions && c.fractions.length === fracCounts[i] ? c.fractions : new Array(fracCounts[i]).fill(1)))),
      eventTokens: new Uint8Array(curves.length * 4).fill(255),
      numcurves: curves.length,
      numpoints: counts.reduce((a, b) => a + b, 0),
      numfractionalwidths: fracCounts.reduce((a, b) => a + b, 0),
    };
  }

  // ---- the note ---------------------------------------------------------------------------------------------

  const safeName = (s) => String(s || 'Handwriting').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 60) || 'Handwriting';

  // ---- a PDF behind the pages ---------------------------------------------------------------------------------
  //
  // From the notes of people who read Notability files (lh/notability-to-pdf, which checked them against thousands of notes):
  // the PDF sits in the note's PDFs/ folder; Session.plist lists it in `pdfFiles` (objects with pdfFileName, version 2) and has
  // one entry per page in `pageLayoutArray` (which PDF, which page of it). A note is one long canvas PAGE_W wide, y down, and
  // the pages are stacked on it top to bottom, each scaled to the canvas width. Not checked here by opening one in Notability:
  // the class name of the PDF object, and the exact left/top offsets (PDF_X0, PDF_Y0), which the calibration note is for.
  const PDF_X0 = -12.8; // where the PDF's left edge is, in stroke x (a blank page's edge is 12.8 left of x = 0 too)
  const PDF_Y0 = 0; // and its top edge, relative to the top of its page's band
  const PDF_SHIFT_X = -1.5; // points: measured with the colour ladder note on an iPad, pen lines came out 1.5 pt right of the PDF (up and down was exact)

  /**
   * Where each PDF page is on the canvas. pages: [{w, h}] in points. Returns [{top, height, scale, xoff}]: the page's band starts
   * `top` units down the canvas and is `height` units tall, one note unit is `scale` points, and the page starts `xoff` points
   * in from the left. Measured on an iPad with a letter page followed by an A4 one: every page has the same scale (the
   * widest page fills the canvas width) and a narrower page is centred, rather than each being stretched to the width.
   */
  function pdfBands(pages) {
    const widest = Math.max(...pages.map((p) => p.w));
    const scale = widest / PAGE_W;
    let top = 0;
    return pages.map((p) => {
      const band = { top, height: p.h / scale, scale, xoff: (widest - p.w) / 2 };
      top += band.height;
      return band;
    });
  }

  /** A point on page `page` (0-based), in points from the page's top left corner, as a point of the canvas. */
  function pdfPoint(bands, page, x, y) {
    const b = bands[page];
    return [(x + b.xoff + PDF_SHIFT_X) / b.scale + PDF_X0, b.top + PDF_Y0 + y / b.scale];
  }

  /** The objects Session.plist needs to show a PDF, to go after the 45 a blank note has; first is at index `at`. */
  function pdfObjects(pdf, at) {
    const U = (n) => new UID(n);
    const o = [
      { $classname: 'PDFFile', $classes: ['PDFFile', 'NSObject'] }, // at
      pdf.fileName, // at + 1
      { pdfFileName: U(at + 1), highlights: U(3), pageNumbers: U(0), version: 2, type: 0, contentBoxVersion: 1, $class: U(at) }, // at + 2
      { 'NS.object.0': U(at + 2), $class: U(4) }, // at + 3: pdfFiles
      'kPageLayoutPDFFileKey', // at + 4
      'kPageLayoutPDFPageNumberKey', // at + 5
      'kPageLayoutPDFIsOriginalPageKey', // at + 6
      true, // at + 7
    ];
    const entries = [];
    for (let i = 0; i < pdf.pageCount; i++) {
      o.push(i + 1); // the page number, 1-based
      const num = at + o.length - 1;
      o.push({ 'NS.key.0': U(at + 4), 'NS.object.0': U(at + 2), 'NS.key.1': U(at + 5), 'NS.object.1': U(num), 'NS.key.2': U(at + 6), 'NS.object.2': U(at + 7), $class: U(24) });
      entries.push(at + o.length - 1);
    }
    const layout = { $class: U(6) };
    entries.forEach((e, i) => (layout['NS.object.' + i] = U(e)));
    o.push(layout);
    return { objects: o, files: at + 3, layout: at + o.length - 1 };
  }

  /** Session.plist: the same 45 objects, in the same order, as a note written by Notability, with the strokes put in. */
  function sessionPlist(name, packed, when, pdf) {
    const U = (n) => new UID(n);
    const cocoa = (when.getTime() / 1000 - COCOA_EPOCH);
    const extra = pdf ? pdfObjects(pdf, 45) : { objects: [], files: 3, layout: 3 };
    const objects = [
      '$null',
      { subject: U(40), NBNoteTakingSessionBundleVersionNumberKey: U(41), contentPlaybackEventManager: U(42), paperLineStyle: 0, NBNoteTakingSessionMinorVersionNumberKey: 3, packagePath: U(37), tags: U(36), sessionFormatVersion: 4, $class: U(44), paperIndex: 12, richText: U(2), isReadOnly: false, creationDate: U(38), name: U(37) },
      { formatVersion: 4, pageLayoutArray: U(extra.layout), attributedString: U(29), 'Handwriting Overlay': U(7), NBAttributedBackingString: U(17), $class: U(35), reflowState: U(14), didBecomeReflowable: true, pdfFiles: U(extra.files), mediaObjects: U(3), 'Handwriting Objects': U(5), recordingTimestampString: U(32) },
      { $class: U(4) },
      { $classname: 'NSArray', $classes: ['NSArray', 'NSObject'] },
      { $class: U(6) },
      { $classname: 'NSMutableArray', $classes: ['NSMutableArray', 'NSArray', 'NSObject'] },
      { SpatialHash: U(8), $class: U(13) },
      { eventTokens: packed.eventTokens, curvesnumpoints: packed.curvesnumpoints, numfractionalwidths: U(9), curveswidth: packed.curveswidth, curvesfractionalwidths: packed.curvesfractionalwidths, $class: U(12), curvescolors: packed.curvescolors, curvespoints: packed.curvespoints, numpoints: U(11), numcurves: U(10) },
      packed.numfractionalwidths,
      packed.numcurves,
      packed.numpoints,
      { $classname: 'InkedSpatialHash', $classes: ['InkedSpatialHash', 'NSObject'] },
      { $classname: 'HandwritingObject', $classes: ['HandwritingObject', 'NSObject'] },
      { pageWidthInDocumentCoordsKey: new Real(PAGE_W), nativeLayoutDeviceStringKey: U(15), $class: U(16) },
      'iPad',
      { $classname: 'NBReflowStateLocked', $classes: ['NBReflowStateLocked', 'NBReflowState', 'NSObject'] },
      { $class: U(28), NBAttributedBackingStringCodingKey: U(18), NBAttributedLayoutStringCodingKey: U(25) },
      { 'NS.key.1': U(22), 'NS.object.1': U(23), 'NS.key.0': U(19), 'NS.object.0': U(20), $class: U(24) },
      'stringKey',
      { $class: U(21), 'NS.bytes': new Uint8Array(0) },
      { $classname: 'NSMutableString', $classes: ['NSMutableString', 'NSString', 'NSObject'] },
      'subRangesKey',
      { $class: U(6) },
      { $classname: 'NSMutableDictionary', $classes: ['NSMutableDictionary', 'NSDictionary', 'NSObject'] },
      { 'NS.key.1': U(22), 'NS.object.1': U(27), 'NS.key.0': U(19), 'NS.object.0': U(26), $class: U(24) },
      { $class: U(21), 'NS.bytes': new Uint8Array(0) },
      { $class: U(6) },
      { $classname: 'NBAttributedString', $classes: ['NBAttributedString', 'NSObject'] },
      { 'NS.key.1': U(22), 'NS.object.1': U(31), 'NS.key.0': U(19), 'NS.object.0': U(30), $class: U(24) },
      '',
      { $class: U(6) },
      { 'NS.key.1': U(22), 'NS.object.1': U(34), 'NS.key.0': U(19), 'NS.object.0': U(33), $class: U(24) },
      { $class: U(21), 'NS.bytes': new Uint8Array(0) },
      { $class: U(6) },
      { $classname: 'FormattedString', $classes: ['FormattedString', 'NSObject'] },
      '',
      name,
      { 'NS.time': new Real(cocoa), $class: U(39) },
      { $classname: 'NSDate', $classes: ['NSDate', 'NSObject'] },
      'unsortedNotesKey',
      '7.2.5',
      { $class: U(43), NBCPTimeManagerSOATimestampsKey: new Uint8Array(0), NBCPTimeManagerSOANumEventsKey: 0, NBCPTimeManagerSOARecordingIDsKey: new Uint8Array(0), NBCPTimeManagerSOADurationsKey: new Uint8Array(0), NBCPTimeManagerSOAEventIDsKey: new Uint8Array(0) },
      { $classname: 'NBCPEventManager', $classes: ['NBCPEventManager', 'NSObject'] },
      { $classname: 'NoteTakingSession', $classes: ['NoteTakingSession', 'NSObject'] },
    ].concat(extra.objects);
    return bplistWrite({ $version: 100000, $objects: objects, $archiver: 'GLKeyedArchiver', $top: { $0: U(1) } });
  }

  function metadataPlist(name, when) {
    const U = (n) => new UID(n);
    const cocoa = new Real(when.getTime() / 1000 - COCOA_EPOCH);
    return bplistWrite({
      $version: 100000,
      $objects: [
        '$null',
        { notePackagePath: U(6), exportedSinceLastSave: false, documentVersion: 1, noteCreationDateKey: U(2), $class: U(8), noteSubject: U(7), noteHasRecordingKey: false, noteSizeKey: 0, noteName: U(6), noteTags: U(5), noteModifiedDateKey: U(4) },
        { 'NS.time': cocoa, $class: U(3) },
        { $classname: 'NSDate', $classes: ['NSDate', 'NSObject'] },
        { 'NS.time': cocoa, $class: U(3) },
        '',
        name,
        'unsortedNotesKey',
        { $classname: 'SessionInfo', $classes: ['SessionInfo', 'NSObject'] },
      ],
      $archiver: 'NSKeyedArchiver',
      $top: { root: U(1) },
    });
  }

  /** The thumbnail files are a UIImage archived into a property list around a PNG. */
  function imagePlist(png, scale) {
    const U = (n) => new UID(n);
    return bplistWrite({
      $version: 100000,
      $objects: [
        '$null',
        { UIImageIsFlippedInRightToLeft: false, UIRenderingMode: 0, $class: U(5), UIScale: new Real(scale), UIKitDidEncode: true, UIHasPattern: false, UIImageOrientation: 0, UIImageTraitCollection: U(3), UIImageData: U(2) },
        png,
        { 'UITraitCollectionBuiltinTrait-_UITraitNameDisplayScale': new Real(scale), $class: U(4) },
        { $classname: 'UITraitCollection', $classes: ['UITraitCollection', 'NSObject'] },
        { $classname: 'UIImage', $classes: ['UIImage', 'NSObject'] },
      ],
      $archiver: 'NSKeyedArchiver',
      $top: { root: U(1) },
    });
  }

  const LIBRARY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>application version</key>
\t<string>3392</string>
\t<key>library-format-version</key>
\t<string>1.0</string>
\t<key>recordings</key>
\t<dict/>
</dict>
</plist>
`;

  /**
   * A .note file (a Uint8Array) from curves in the note's units (see packCurves).
   * opts: {name, when (a Date), pdf: {bytes (Uint8Array), pages: [{w, h}] in points}}. With a pdf, the note has that PDF's pages as
   * its pages (curves are then in canvas units, see pdfBands) instead of blank paper.
   */
  function buildNote(curves, opts) {
    const o = opts || {};
    const name = safeName(o.name);
    const when = o.when || new Date();
    if (!curves.length) throw new Error('There is nothing to put in the note.');
    const enc = new TextEncoder();
    const dir = name + '/';
    const png = (w, h) => thumbnail(curves, w, h);
    let pdf = null;
    if (o.pdf) {
      if (!o.pdf.pages || !o.pdf.pages.length) throw new Error('The PDF has no pages.');
      pdf = { fileName: pdfFileName(o.pdf.bytes, name), pageCount: o.pdf.pages.length };
    }
    return makeZip(
      [
        { name: dir + 'thumbnail', data: imagePlist(png(48, 63), 1) },
        { name: dir + 'Assets/' },
        { name: dir + 'Session.plist', data: sessionPlist(name, packCurves(curves), when, pdf) },
        ...(pdf ? [{ name: dir + 'PDFs/' }, { name: dir + 'PDFs/' + pdf.fileName, data: o.pdf.bytes }] : []),
        { name: dir + 'thumb3x.png', data: png(144, 189) },
        { name: dir + 'Recordings/library.plist', data: enc.encode(LIBRARY_PLIST) },
        { name: dir + 'Recordings/' },
        { name: dir + 'thumb2x.png', data: png(96, 126) },
        { name: dir + 'thumbnail2x', data: imagePlist(png(96, 126), 2) },
        { name: dir + 'metadata.plist', data: metadataPlist(name, when) },
        { name: dir + 'Images/' },
        { name: dir + 'thumb6x.png', data: png(288, 378) },
        { name: dir + 'thumb.png', data: png(48, 63) },
      ],
      when
    );
  }

  /**
   * The curves of a handwriting layout (synth.layout or math.layout), placed on the page: left and top are the distance from
   * the left of the drawable area and from the top of the page to the text's top left corner.
   * opts: {ink '#rrggbb', xhDoc (height of a lowercase letter in note units, default 8.8, which is 10 pt on a letter page),
   * pen (the line width in note units, default 1.05, a Notability pen at thickness 3), left (20), top (40), spacing (keep a point
   * about this far apart, default 1.2), fractions (a function (pointCount) -> the width fractions, one per end point, default all 1)}
   */
  function curvesFromLayout(layout, opts) {
    const o = opts || {};
    const K = (o.xhDoc || 8.8) / (layout.xh || 34);
    const left = o.left === undefined ? 20 : o.left;
    const top = o.top === undefined ? 40 : o.top;
    const color = hexToRgb(o.ink);
    const curves = [];
    for (const s of layout.strokes) {
      if (!s.pts || !s.pts.length) continue;
      const pts = toChain(thin(s.pts.map((p) => [left + p.x * K, top + p.y * K]), o.spacing === undefined ? 1.2 : o.spacing));
      const curve = { pts, width: o.pen || 1.05, color };
      if (o.fractions) curve.fractions = o.fractions(pts.length);
      curves.push(curve);
    }
    return curves;
  }

  /** A UUID-shaped name for the PDF inside the note, from the PDF's own bytes so the same file always gets the same one. */
  function pdfFileName(bytes) {
    let a = 0x811c9dc5;
    let b = 0x1b873593;
    for (let i = 0; i < bytes.length; i++) {
      a = Math.imul(a ^ bytes[i], 16777619) >>> 0;
      b = Math.imul(b + bytes[i], 2246822519) >>> 0;
    }
    const h = (n) => n.toString(16).toUpperCase().padStart(8, '0');
    const t = h(a) + h(b) + h(Math.imul(a, b) >>> 0) + h((a ^ b) >>> 0);
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-4${t.slice(13, 16)}-A${t.slice(17, 20)}-${t.slice(20, 32)}.pdf`;
  }

  /**
   * Handwriting placed in boxes on the pages of a PDF, as curves in canvas units. items: [{box, placed}] as the Sheet tab and
   * sheet.layoutBox give them (box in points from the page's top left; the layout belongs at box.x - dx * K, box.y - dy * K).
   * pages: [{w, h}] in points. opts: {ink, pen (line width in note units, default 1.05), spacing, fractions}.
   */
  function curvesFromBoxes(items, pages, opts) {
    const o = opts || {};
    const bands = pdfBands(pages);
    const color = hexToRgb(o.ink);
    const curves = [];
    for (const { box, placed } of items) {
      if (!bands[box.page]) continue;
      const ox = box.x - placed.dx * placed.K;
      const oy = box.y - placed.dy * placed.K;
      for (const s of placed.layout.strokes) {
        if (!s.pts || !s.pts.length) continue;
        const raw = s.pts.map((p) => pdfPoint(bands, box.page, ox + p.x * placed.K, oy + p.y * placed.K));
        const pts = toChain(thin(raw, o.spacing === undefined ? 1.2 : o.spacing));
        const curve = { pts, width: o.pen || 1.05, color };
        if (o.fractions) curve.fractions = o.fractions(pts.length);
        curves.push(curve);
      }
    }
    return curves;
  }

  /** A note of a PDF with handwriting on its pages. items as for curvesFromBoxes; opts as there, plus {name, when}. */
  function noteFromBoxes(pdfBytes, pages, items, opts) {
    const o = opts || {};
    return buildNote(curvesFromBoxes(items, pages, o), { name: o.name, when: o.when, pdf: { bytes: pdfBytes, pages } });
  }

  // The calibration note: in each corner of each page, two rows of seven small corner pieces, numbered 1 to 7. The PDF has each
  // piece as a grey L; the pen draws a thin L inside it, moved by (number - 4) steps of PIECE_STEP points: sideways in the
  // first row, up or down in the second. The piece where the pen line sits in the middle of the grey says how far to move the pen.
  const PIECE_STEP = 1.5; // points between two pieces' offsets
  const PIECE_ARM = 20; // length of an arm of the L, points
  const PIECE_PITCH = 34; // points between two pieces along an edge
  const PIECE_INSET = 24; // from the page edge to the first piece's corner
  const PIECE_ROW = 52; // points between the two rows

  /**
   * The pieces, in points from the page's top left: {page, corner ('TL', 'TR', 'BL', 'BR'), row (0 sideways, 1 up and down),
   * n (1 to 7), x, y (where the L's corner is), sx, sy (which way its arms point), dx, dy (how far the pen is moved)}.
   */
  function pdfCalibrationPieces(pages) {
    const out = [];
    pages.forEach((p, page) => {
      for (const corner of ['TL', 'TR', 'BL', 'BR']) {
        const sx = corner[1] === 'L' ? 1 : -1; // the arms point into the page
        const sy = corner[0] === 'T' ? 1 : -1;
        for (let row = 0; row < 2; row++) {
          for (let n = 1; n <= 7; n++) {
            const x = (sx > 0 ? PIECE_INSET : p.w - PIECE_INSET) + sx * (n - 1) * PIECE_PITCH;
            const y = (sy > 0 ? PIECE_INSET : p.h - PIECE_INSET) + sy * row * PIECE_ROW;
            const off = (n - 4) * PIECE_STEP;
            out.push({ page, corner, row, n, x, y, sx, sy, dx: row === 0 ? off : 0, dy: row === 1 ? off : 0 });
          }
        }
      }
    });
    return out;
  }

  // And right on each page corner: a grey L on the PDF, flush with the page edges (CORNER_THICK thick, CORNER_ARM long), with seven
  // pen Ls in different colours over it, each moved a step further down and to the right (the first one up and to the left).
  // The colour that sits in the middle of the grey, exactly on the real corner, is the offset. Black is not moved.
  const CORNER_COLORS = [
    { name: 'purple', rgb: '#7b2cbf' },
    { name: 'blue', rgb: '#1f4fff' },
    { name: 'green', rgb: '#1fa84f' },
    { name: 'black', rgb: '#000000' },
    { name: 'orange', rgb: '#ff7f00' },
    { name: 'red', rgb: '#e00000' },
    { name: 'pink', rgb: '#ff4fa3' },
  ];
  const CORNER_THICK = 6;
  const CORNER_ARM = 40;

  /** Strokes for the corner Ls (see above). */
  function pdfCornerCurves(pages) {
    const bands = pdfBands(pages);
    const curves = [];
    pages.forEach((p, page) => {
      for (const corner of ['TL', 'TR', 'BL', 'BR']) {
        const sx = corner[1] === 'L' ? 1 : -1;
        const sy = corner[0] === 'T' ? 1 : -1;
        const cx = corner[1] === 'L' ? 0 : p.w;
        const cy = corner[0] === 'T' ? 0 : p.h;
        CORNER_COLORS.forEach((c, i) => {
          const d = (i - 3) * PIECE_STEP;
          const x = cx + sx * (CORNER_THICK / 2 + d); // the centre line of the grey, moved
          const y = cy + sy * (CORNER_THICK / 2 + d);
          const color = hexToRgb(c.rgb);
          const line = (a, b) => curves.push({ pts: toChain([pdfPoint(bands, page, a[0], a[1]), pdfPoint(bands, page, b[0], b[1])]), width: 0.8, color });
          line([x, y], [x + sx * (CORNER_ARM - CORNER_THICK), y]);
          line([x, y], [x, y + sy * (CORNER_ARM - CORNER_THICK)]);
        });
      }
    });
    return curves;
  }

  /** Strokes for the calibration note (see above); the grey Ls are drawn on the PDF by scripts/make-calibration-pdf-note.js. */
  function pdfCalibrationCurves(pages, ink) {
    const bands = pdfBands(pages);
    const color = hexToRgb(ink || '#1749b3');
    const curves = [];
    const line = (page, a, b) => curves.push({ pts: toChain([pdfPoint(bands, page, a[0], a[1]), pdfPoint(bands, page, b[0], b[1])]), width: 0.8, color });
    for (const c of pdfCalibrationPieces(pages)) {
      const x = c.x + c.dx;
      const y = c.y + c.dy;
      line(c.page, [x, y], [x + c.sx * PIECE_ARM, y]);
      line(c.page, [x, y], [x, y + c.sy * PIECE_ARM]);
    }
    return curves.concat(pdfCornerCurves(pages));
  }

  /** A note from a handwriting layout; opts as for curvesFromLayout, plus {name, when}. */
  function noteFromLayout(layout, opts) {
    const o = opts || {};
    return buildNote(curvesFromLayout(layout, o), { name: o.name, when: o.when });
  }

  /**
   * Strokes to tell what is wrong if a note does not look right: a frame around the drawable area (512 wide, the page tall), a
   * letter F near the top left (it shows which way is up and which is left) and a ruler 100 units long.
   */
  function calibrationCurves(ink) {
    const color = hexToRgb(ink);
    const line = (a, b) => ({ pts: toChain([a, b]), width: 1.05, color });
    const m = 2;
    const R = INNER_W - m;
    const B = PAGE_H - m;
    return [
      line([m, m], [R, m]),
      line([R, m], [R, B]),
      line([R, B], [m, B]),
      line([m, B], [m, m]),
      line([60, 60], [60, 160]), // the F: its stem, then the top arm and the middle arm
      line([60, 60], [100, 60]),
      line([60, 110], [90, 110]),
      line([60, 200], [160, 200]), // the ruler: 100 units
      line([60, 195], [60, 205]),
      line([160, 195], [160, 205]),
    ];
  }

  const api = { UID, Real, bplistWrite, bplistRead, makeZip, encodePng, crc32, packCurves, toChain, thin, buildNote, curvesFromLayout, noteFromLayout, curvesFromBoxes, noteFromBoxes, pdfCalibrationCurves, pdfCalibrationPieces, pdfCornerCurves, CORNER_COLORS, CORNER_THICK, CORNER_ARM, PDF_SHIFT_X, PIECE_ARM, pdfBands, pdfPoint, calibrationCurves, safeName, PAGE_W, PAGE_H, INNER_W };
  root.HW = root.HW || {};
  root.HW.notability = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
