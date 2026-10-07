'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeWord } = require('./synth-writer');
const { readZip } = require('./zip-reader');
const S = require('../src/style');
const Y = require('../src/synth');
const N = require('../src/notability');

const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');
const style = S.buildStyle(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
const hex = (u8) => Buffer.from(u8).toString('hex');

test('property lists round trip: every kind of value, long strings and lists, many objects', () => {
  const src = {
    a: 1, b: 300, c: 70000, d: 5000000000, neg: -2, t: true, f: false, real: new N.Real(1), pi: 3.14159, big: 1e300,
    s: 'plain', u: 'naïve é中', long: 'x'.repeat(40), empty: '', data: Uint8Array.of(1, 2, 3), bigdata: new Uint8Array(100).fill(7),
    list: [1, 'two', [3]], uid: new N.UID(5), nested: { k: { j: [true] } },
    many: Array.from({ length: 300 }, (_, i) => i),
  };
  const back = N.bplistRead(N.bplistWrite(src));
  assert.equal(back.a, 1);
  assert.equal(back.d, 5000000000);
  assert.equal(back.neg, -2);
  assert.equal(back.real, 1);
  assert.ok(Math.abs(back.pi - 3.14159) < 1e-12);
  assert.equal(back.s, 'plain');
  assert.equal(back.u, src.u);
  assert.equal(back.long, src.long);
  assert.deepEqual([...back.data], [1, 2, 3]);
  assert.equal(back.bigdata.length, 100);
  assert.deepEqual(back.list, [1, 'two', [3]]);
  assert.ok(back.uid instanceof N.UID && back.uid.value === 5);
  assert.deepEqual(back.nested, { k: { j: [true] } });
  assert.equal(back.many.length, 300);
  assert.equal(back.many[299], 299);
});

test('Python reads what we write as a property list (an independent reader)', (t) => {
  const py = spawnSync('python3', ['-I', '-c', 'import plistlib,sys,json\nd=plistlib.loads(sys.stdin.buffer.read())\nprint(json.dumps(d, default=lambda o: "UID" if isinstance(o, plistlib.UID) else o.hex() if isinstance(o, bytes) else str(o), sort_keys=True))'], { input: Buffer.from(N.bplistWrite({ n: 7, r: new N.Real(2), s: 'café', d: Uint8Array.of(255, 0), l: [true, 'x'], u: new N.UID(3), big: 123456789012 })) });
  if (py.error || py.status !== 0) return t.skip('python3 is not available');
  const o = JSON.parse(py.stdout.toString());
  assert.deepEqual(o, { n: 7, r: 2, s: 'café', d: 'ff00', l: [true, 'x'], u: 'UID', big: 123456789012 });
});

test('the stroke arrays are byte for byte what svg2notability writes for the same strokes', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'svg2notability-vector.json'), 'utf8'));
  // (the numbers in svg2notability's test are from before it scaled the page to 450 wide, so no scaling here)
  const packed = N.packCurves([{ pts: fx.points, width: fx.width, color: [0x00, 0x6f, 0xff] }]);
  assert.equal(hex(packed.curvespoints), fx.expected.points);
  assert.equal(hex(packed.curvescolors), fx.expected.colors);
  assert.equal(hex(packed.curvesnumpoints), fx.expected.numpoints);
  assert.equal(hex(packed.curveswidth), fx.expected.width);
  assert.equal(hex(packed.curvesfractionalwidths), fx.expected.fractionalwidths);
  assert.equal(packed.numcurves, 1);
  assert.equal(packed.numpoints, 34);
  assert.equal(packed.numfractionalwidths, 12);
});

/** Same shape as the skeleton in tests/data: types and links, not the values. */
function skel(o) {
  if (o instanceof N.UID) return ['uid', o.value];
  if (Array.isArray(o)) return o.map(skel);
  if (o instanceof Uint8Array) return 'data';
  if (typeof o === 'boolean') return 'bool';
  if (typeof o === 'number') return 'num';
  if (typeof o === 'string') return 'str';
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, skel(o[k])]));
}
const loose = (s) => JSON.parse(JSON.stringify(s).replace(/"(int|real)"/g, '"num"'));

function sampleNote() {
  const lay = Y.layout(style, 'the quick fox', { xh: 34, width: 700, seed: 3 });
  return { lay, bytes: N.noteFromLayout(lay, { name: 'Test note', ink: '#1749b3', when: new Date(Date.UTC(2026, 9, 7, 12)) }) };
}

test('a note has the same files, and the same property list structure, as one written by Notability', () => {
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'notability-skeleton.json'), 'utf8'));
  const files = readZip(sampleNote().bytes);
  assert.deepEqual([...files.keys()].filter((n) => !n.endsWith('/')).map((n) => n.replace('Test note/', '')).sort(), ['Recordings/library.plist', 'Session.plist', 'metadata.plist', 'thumb.png', 'thumb2x.png', 'thumb3x.png', 'thumb6x.png', 'thumbnail', 'thumbnail2x']);
  const session = N.bplistRead(files.get('Test note/Session.plist'));
  assert.deepEqual(loose(skel(session)), loose(ref.session), 'Session.plist');
  assert.deepEqual(loose(skel(N.bplistRead(files.get('Test note/metadata.plist')))), loose(ref.metadata), 'metadata.plist');
  assert.deepEqual(loose(skel(N.bplistRead(files.get('Test note/thumbnail')))), loose(ref.thumbnail), 'thumbnail');
  assert.equal(session.$archiver, 'GLKeyedArchiver');
});

test('the strokes in the note add up: counts, names and sizes agree', () => {
  const { bytes } = sampleNote();
  const files = readZip(bytes);
  const o = N.bplistRead(files.get('Test note/Session.plist')).$objects;
  const h = o[8];
  const n = o[10];
  assert.ok(n > 5, 'curves: ' + n);
  assert.equal(h.curvesnumpoints.length, 4 * n);
  assert.equal(h.curveswidth.length, 4 * n);
  assert.equal(h.curvescolors.length, 4 * n);
  assert.equal(h.eventTokens.length, 4 * n);
  assert.equal(h.curvespoints.length, 8 * o[11]);
  assert.equal(h.curvesfractionalwidths.length, 4 * o[9]);
  const counts = new Int32Array(h.curvesnumpoints.buffer.slice(h.curvesnumpoints.byteOffset, h.curvesnumpoints.byteOffset + h.curvesnumpoints.length));
  assert.equal(counts.reduce((a, b) => a + b, 0), o[11]);
  assert.ok(counts.every((c) => c >= 4), 'every stroke has at least four points');
  assert.equal(counts.reduce((a, c) => a + Math.max(Math.floor(c / 3) + 1, 2), 0), o[9]);
  assert.deepEqual([...h.curvescolors.subarray(0, 4)], [0x17, 0x49, 0xb3, 255], 'the pen colour');
  assert.equal(o[37], 'Test note', 'the name inside is the name of the folder');
  assert.ok([...files.keys()].every((k) => k.startsWith('Test note/')));
  const meta = N.bplistRead(files.get('Test note/metadata.plist')).$objects;
  assert.equal(meta[6], 'Test note');
});

test('the handwriting lands on the page, at the top left, the right way up and the right size', () => {
  const { lay, bytes } = sampleNote();
  const h = N.bplistRead(readZip(bytes).get('Test note/Session.plist')).$objects[8];
  const f = new Float32Array(h.curvespoints.buffer.slice(h.curvespoints.byteOffset, h.curvespoints.byteOffset + h.curvespoints.length));
  const xs = [];
  const ys = [];
  for (let i = 0; i < f.length; i += 2) {
    xs.push(f[i]);
    ys.push(f[i + 1]);
  }
  // measured on an iPad: y goes DOWN from the top of the page, and x = 0 is the left of a 512 wide drawable area
  assert.ok(Math.min(...xs) >= 19 && Math.max(...xs) <= N.INNER_W, 'inside the drawable width');
  assert.ok(Math.min(...ys) >= 30 && Math.max(...ys) < 120, 'at the top of the page: ' + Math.min(...ys) + '..' + Math.max(...ys));
  // y down means the first line comes before the second one: the layout's y (also down) keeps its order
  const layY = lay.strokes.flatMap((s) => s.pts.map((p) => p.y));
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - ((Math.max(...layY) - Math.min(...layY)) * 8.8) / 34) < 2, 'about the layouts height (thinning shaves the tips), not mirrored');
  const layX = lay.strokes.flatMap((s) => s.pts.map((p) => p.x));
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - ((Math.max(...layX) - Math.min(...layX)) * 8.8) / 34) < 1);
  const w = new Float32Array(h.curveswidth.buffer.slice(h.curveswidth.byteOffset, h.curveswidth.byteOffset + 4))[0];
  assert.ok(Math.abs(w - 1.05) < 1e-6);
});

test('the layout is not flipped: the first stroke of a letter that starts at the top stays above where it ends', () => {
  const lay = { xh: 34, strokes: [{ pts: [{ x: 10, y: 5 }, { x: 10, y: 20 }, { x: 10, y: 40 }, { x: 10, y: 60 }] }] };
  const [c] = N.curvesFromLayout(lay, { spacing: 0 });
  assert.ok(c.pts[0][1] < c.pts[3][1], 'a stroke that goes down the layout goes down the note');
});

test('the thumbnails are PNGs of the right sizes with the writing on them', () => {
  const files = readZip(sampleNote().bytes);
  for (const [f, w, hh] of [['thumb.png', 48, 63], ['thumb2x.png', 96, 126], ['thumb3x.png', 144, 189], ['thumb6x.png', 288, 378]]) {
    const png = files.get('Test note/' + f);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), w);
    assert.equal(png.readUInt32BE(20), hh);
    const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 4);
    const raw = zlib.inflateSync(idat);
    assert.equal(raw.length, hh * (1 + w * 3));
    let ink = 0;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (raw[y * (1 + w * 3) + 1 + x * 3 + 2] > raw[y * (1 + w * 3) + 1 + x * 3] + 50) ink++;
    assert.ok(ink > 5, f + ' has ink: ' + ink);
  }
  const wrapped = N.bplistRead(files.get('Test note/thumbnail2x')).$objects;
  assert.equal(wrapped[2].subarray(1, 4).toString(), 'PNG', 'the thumbnail plists carry the PNG');
  assert.equal(wrapped[1].UIScale, 2);
});

test('short strokes are filled out to four points, dense ones thinned, and an empty note is refused', () => {
  assert.equal(N.lengthen([[1, 1]]).length, 4);
  assert.equal(N.lengthen([[0, 0], [3, 3]]).length, 4);
  assert.deepEqual(N.lengthen([[0, 0], [3, 3]])[1], [1, 1]);
  assert.equal(N.lengthen([[0, 0], [1, 1], [2, 2]]).length, 4);
  const line = Array.from({ length: 1000 }, (_, i) => [i * 0.1, 0]);
  const thin = N.thin(line, 0.8);
  assert.ok(thin.length < 140 && thin[0] === line[0] && thin[thin.length - 1] === line[999]);
  assert.throws(() => N.buildNote([], {}), /nothing/);
  assert.equal(N.safeName('a/b:c'), 'a b c');
  assert.equal(N.safeName(''), 'Handwriting');
});

test('the calibration note builds and has a frame the size of the page', () => {
  const curves = N.calibrationCurves('#1749b3');
  const files = readZip(N.buildNote(curves, { name: 'Calibration' }));
  assert.ok(files.has('Calibration/Session.plist'));
  const xs = curves.flatMap((c) => c.pts.map((p) => p[0]));
  const ys = curves.flatMap((c) => c.pts.map((p) => p[1]));
  assert.ok(Math.max(...xs) > N.INNER_W - 5 && Math.min(...xs) < 5, 'the width of the drawable area');
  assert.ok(Math.max(...ys) > N.PAGE_H - 5 && Math.min(...ys) < 5, 'the height of the page');
  const stem = curves[4];
  assert.ok(stem.pts[0][1] < stem.pts[3][1] && curves[5].pts[0][1] === stem.pts[0][1], 'the F hangs from the top: its stem goes down and its first arm is at the top');
});

test('a real note written by Notability (the svg2notability template, if it is around) reads with the same reader', (t) => {
  const tpl = '/home/user/jvns/svg2notability/template.note';
  if (!fs.existsSync(tpl)) return t.skip('the template is not on this machine');
  const files = readZip(fs.readFileSync(tpl));
  const session = N.bplistRead(files.get('reverse/Session.plist'));
  assert.equal(session.$objects[10], 4);
  assert.deepEqual(loose(skel(session)), loose(JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'notability-skeleton.json'), 'utf8')).session));
  
});
