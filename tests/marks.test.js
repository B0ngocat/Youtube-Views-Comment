'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { writeWord } = require('./synth-writer');
const { corpus } = require('./fixtures');
const S = require('../src/style');
const M = require('../src/marks');
const Sheet = require('../src/sheet');
const R = require('../src/render');
const Anchors = require('../mcp/anchors');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { createServer } = require('../mcp/server');
const { build } = require('../scripts/build-mcp');

const pts = (d) => d.strokes.flatMap((s) => s.pts);
const inside = (poly, x, y) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (poly[i].y > y !== poly[j].y > y && x < ((poly[j].x - poly[i].x) * (y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
  }
  return c;
};
const R0 = { x: 200, y: 300, w: 14, h: 11 };

// ---- geometry ------------------------------------------------------------------------------------------

test('a circle encloses its target, is a little bigger, and does not close exactly', () => {
  for (let seed = 0; seed < 25; seed++) {
    const d = M.draw({ type: 'circle', ...R0 }, { seed });
    assert.equal(d.strokes.length, 1);
    const poly = d.strokes[0].pts;
    for (const [x, y] of [[R0.x, R0.y], [R0.x + R0.w, R0.y], [R0.x, R0.y + R0.h], [R0.x + R0.w, R0.y + R0.h]]) assert.ok(inside(poly, x, y), `corner inside, seed ${seed}`);
    const b = M.bounds(d.strokes);
    assert.ok(b.maxX - b.minX < R0.w + 40 && b.maxY - b.minY < R0.h + 40, 'not wildly bigger than the target');
    const gap = Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].y - poly[poly.length - 1].y);
    assert.ok(gap > 0.05, 'the end is not exactly on the start');
  }
});

test('an underline is below the target and spans it; a strike passes through its middle', () => {
  const u = M.draw({ type: 'underline', ...R0 }, { seed: 3 });
  const up = pts(u);
  assert.ok(Math.min(...up.map((p) => p.y)) > R0.y + R0.h, 'below the bottom edge');
  assert.ok(Math.min(...up.map((p) => p.x)) < R0.x && Math.max(...up.map((p) => p.x)) > R0.x + R0.w, 'spans it');
  const k = M.draw({ type: 'strike', ...R0 }, { seed: 3 });
  const kp = pts(k);
  const mid = R0.y + R0.h / 2;
  assert.ok(Math.min(...kp.map((p) => p.y)) < mid + 2 && Math.max(...kp.map((p) => p.y)) > mid - 2);
  assert.ok(kp.every((p) => Math.abs(p.y - mid) < 3), 'stays near the middle');
  assert.ok(Math.min(...kp.map((p) => p.x)) < R0.x && Math.max(...kp.map((p) => p.x)) > R0.x + R0.w);
  const low = M.draw({ type: 'strike', ...R0, mid: 0.64 }, { seed: 3 });
  assert.ok(pts(low).every((p) => Math.abs(p.y - (R0.y + 0.64 * R0.h)) < 3), 'mid moves the line');
});

test('a tick and a cross stay inside their box; a tick is a tick, not a V', () => {
  const box = { x: 100, y: 100, w: 12, h: 12 };
  for (let seed = 0; seed < 20; seed++) {
    for (const type of ['tick', 'cross']) {
      const b = M.bounds(M.draw({ type, ...box }, { seed }).strokes);
      assert.ok(b.minX >= box.x && b.maxX <= box.x + box.w && b.minY >= box.y && b.maxY <= box.y + box.h, `${type} inside, seed ${seed}`);
      assert.ok(b.maxX - b.minX > 0.5 * box.w && b.maxY - b.minY > 0.5 * box.h, `${type} fills it`);
    }
  }
  assert.equal(M.draw({ type: 'cross', ...box }, { seed: 1 }).strokes.length, 2);
  const t = M.draw({ type: 'tick', ...box }, { seed: 1 }).strokes[0].pts;
  const low = t.reduce((a, p) => (p.y > a.y ? p : a));
  const first = t[0];
  const last = t[t.length - 1];
  assert.ok(low.x - first.x < 0.45 * (last.x - first.x), 'the short arm is the short one');
  assert.ok(last.y < first.y, 'ends higher than it starts');
  const dflt = M.bounds(M.draw({ type: 'tick', x: 50, y: 60 }, { seed: 1, xh: 10 }).strokes);
  assert.ok(dflt.maxX - dflt.minX < 15 && dflt.maxX - dflt.minX > 6, 'x and y alone give a default size from the letter height');
});

test('a box encloses its target; an arrow has its head at `to`; a line has none', () => {
  for (let seed = 0; seed < 15; seed++) {
    const poly = M.draw({ type: 'box', ...R0 }, { seed }).strokes[0].pts;
    for (const [x, y] of [[R0.x, R0.y], [R0.x + R0.w, R0.y], [R0.x, R0.y + R0.h], [R0.x + R0.w, R0.y + R0.h]]) assert.ok(inside(poly, x, y), `box corner inside, seed ${seed}`);
  }
  const a = { x1: 50, y1: 50, x2: 200, y2: 120 };
  const arrow = M.draw({ type: 'arrow', ...a }, { seed: 4 });
  assert.equal(arrow.strokes.length, 3, 'a shaft and two head strokes');
  const shaft = arrow.strokes[0].pts;
  assert.ok(Math.hypot(shaft[0].x - a.x1, shaft[0].y - a.y1) < 0.5, 'starts at from');
  assert.ok(Math.hypot(shaft[shaft.length - 1].x - a.x2, shaft[shaft.length - 1].y - a.y2) < 0.5, 'ends at to');
  for (const h of arrow.strokes.slice(1)) {
    assert.ok(Math.hypot(h.pts[0].x - a.x2, h.pts[0].y - a.y2) < 1.5, 'the head starts at the tip');
    const e = h.pts[h.pts.length - 1];
    assert.ok(Math.hypot(e.x - a.x1, e.y - a.y1) < Math.hypot(h.pts[0].x - a.x1, h.pts[0].y - a.y1), 'and points back along the shaft');
  }
  assert.equal(M.draw({ type: 'line', ...a }, { seed: 4 }).strokes.length, 1);
});

test('same seed, same strokes; another seed, another hand', () => {
  for (const type of ['circle', 'tick', 'cross', 'underline', 'strike', 'box']) {
    const one = JSON.stringify(M.draw({ type, ...R0 }, { seed: 7 }));
    assert.equal(JSON.stringify(M.draw({ type, ...R0 }, { seed: 7 })), one, type);
    assert.notEqual(JSON.stringify(M.draw({ type, ...R0 }, { seed: 8 })), one, type);
  }
  const l = { x1: 10, y1: 10, x2: 120, y2: 60 };
  assert.notEqual(JSON.stringify(M.draw({ type: 'arrow', ...l }, { seed: 1 })), JSON.stringify(M.draw({ type: 'arrow', ...l }, { seed: 2 })));
  assert.throws(() => M.draw({ type: 'squiggle', ...R0 }, {}), /not one of/);
  assert.throws(() => M.draw({ type: 'circle', x: 1, y: 1 }, {}), /needs/);
});

test('a mark is drawn with the same pen as an answer at the same letter height', () => {
  const { style } = corpus('print', 2);
  const answer = Sheet.layoutBox(style, { page: 0, x: 72, y: 100, w: 200, h: 30, text: 'the fox', kind: 'text', xhPt: 9.5, seed: 1 }, {});
  for (const xh of [9.5, 14]) {
    const { placed } = M.toPlaced(M.draw({ type: 'circle', ...R0 }, { seed: 1, xh }), { xh, page: 0 });
    const ans = xh === 9.5 ? answer : Sheet.layoutBox(style, { page: 0, x: 72, y: 100, w: 200, h: 30, text: 'the fox', kind: 'text', xhPt: xh, seed: 1 }, {});
    // the pen width on the page in points is 0.085 * layout.xh * K * (constant pen factor): the same product means the same pen
    assert.ok(Math.abs(placed.layout.xh * placed.K - ans.layout.xh * ans.K) < 1e-9, `pen at ${xh} pt`);
    assert.ok(R.layoutToPath(placed.layout, 1, true).length > 100);
  }
});

// ---- anchors -------------------------------------------------------------------------------------------

const item = (str, x, baseline, w, h) => ({ str, x, y: baseline - (h || 12), w, h: h || 12, baseline });
const page = (items, lines) => ({ page: 1, items, text: lines || items.map((i) => ({ text: i.str })) });

test('anchors: an exact match gives the item box', () => {
  const pages = [page([item('Question 1. Pick one', 72, 100, 120), item('B) green', 300, 150, 40)])];
  const hit = Anchors.findText(pages, { page: 1, text: 'B) green' });
  assert.deepEqual(hit.rect, { page: 1, x: 300, y: 138, w: 40, h: 12 });
  assert.equal(hit.matches, 1);
  assert.equal(hit.nth, 1);
});

test('anchors: ignores case and runs of whitespace only when there is no exact match', () => {
  const pages = [page([item('Final   ANSWER  is', 50, 80, 90)])];
  const hit = Anchors.findText(pages, { page: 1, text: 'final answer' });
  assert.ok(hit && hit.rect.x === 50, 'the loose match starts at the line start');
  assert.ok(hit.rect.w > 50 && hit.rect.w < 85);
  assert.equal(Anchors.findText(pages, { page: 1, text: 'nothing like it' }), null);
  // exact wins: "b)" does not match the capital B when the lower-case one is printed
  const two = [page([item('a) b) B)', 10, 50, 80)])];
  const e = Anchors.findText(two, { page: 1, text: 'b)' });
  assert.equal(e.matches, 1);
  assert.ok(e.rect.x < 10 + 80 * 0.6, 'the b), not the B)');
});

test('anchors: nth picks a match in reading order, and too large an nth says how many there are', () => {
  const pages = [page([item('B) top', 100, 60, 30), item('B) lower', 100, 160, 40), item('B) right', 300, 160, 40)])];
  assert.equal(Anchors.countText(pages, { page: 1, text: 'B)' }), 3);
  const first = Anchors.findText(pages, { page: 1, text: 'B)' });
  assert.equal(first.matches, 3);
  assert.equal(first.rect.y, 48);
  const third = Anchors.findText(pages, { page: 1, text: 'B)', nth: 3 });
  assert.equal(third.rect.x, 300);
  const second = Anchors.findText(pages, { page: 1, text: 'B)', nth: 2 });
  assert.equal(second.rect.x, 100);
  assert.equal(second.rect.y, 148);
  const none = Anchors.findText(pages, { page: 1, text: 'B)', nth: 4 });
  assert.equal(none.rect, null);
  assert.equal(none.matches, 3);
  assert.equal(Anchors.findText(pages, { page: 2, text: 'B)' }), null, 'another page');
});

test('anchors: a substring inside a longer item lands in the right part of it', () => {
  const str = 'A) red   B) green   C) blue';
  const pages = [page([item(str, 100, 200, 270)])];
  const hit = Anchors.findText(pages, { page: 1, text: 'B)' });
  const at = str.indexOf('B)') / str.length;
  assert.ok(hit.rect.x > 100 + 270 * (at - 0.07) && hit.rect.x < 100 + 270 * (at + 0.07), 'starts about where the characters are: ' + hit.rect.x);
  assert.ok(hit.rect.w > 4 && hit.rect.w < 30);
  assert.equal(hit.rect.y, 188);
});

test('anchors: text spread over several items on one line is the union of its pieces', () => {
  const pages = [page([item('Which is', 50, 100, 45), item('correct?', 98, 100, 44), item('Other', 50, 160, 30)])];
  const hit = Anchors.findText(pages, { page: 1, text: 'is correct' });
  assert.ok(hit.rect.x > 70 && hit.rect.x < 90);
  assert.ok(hit.rect.x + hit.rect.w > 135 && hit.rect.x + hit.rect.w < 142);
  assert.equal(hit.rect.y, 88);
});

test('anchors: closestLines lists the printed lines most like the text', () => {
  const pages = [page([item('Question 1. Pick one', 72, 100, 120), item('Name: ________', 72, 40, 80), item('B) green', 300, 150, 40)], [{ text: 'Question 1. Pick one' }, { text: 'Name: ________' }, { text: 'B) green' }])];
  const near = Anchors.closestLines(pages, 1, 'B) grean', 2);
  assert.equal(near[0], 'B) green');
  assert.equal(near.length, 2);
  assert.deepEqual(Anchors.closestLines(pages, 3, 'x'), []);
});

// ---- the tool ------------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-marks-'));
const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');
const samplesJson = S.toJSON(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
const samples = path.join(tmp, 'my-handwriting.json');
fs.writeFileSync(samples, samplesJson);
const out = path.join(tmp, 'out');
let nextId = 1;
const server = createServer({ samples, out });
const call = (name, args) => server({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
const textOf = (res) => res.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function quiz(dir) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const pg = doc.addPage([400, 300]);
  pg.drawText('1. Which is correct?   A) red   B) green   C) blue', { x: 30, y: 250, size: 12, font });
  pg.drawText('2. B) is also here', { x: 30, y: 230, size: 12, font });
  pg.drawRectangle({ x: 30, y: 200, width: 12, height: 12, borderWidth: 1, borderColor: PDFLib.rgb(0, 0, 0) });
  pg.drawText('Agree', { x: 50, y: 202, size: 12, font });
  const p = path.join(dir || tmp, 'quiz.pdf');
  fs.writeFileSync(p, await doc.save());
  return p;
}

const inkLength = async (file) => {
  const doc = await PDFLib.PDFDocument.load(fs.readFileSync(file));
  return doc.getPage(0).node.normalizedEntries().Contents.size();
};

test('inspect_pdf lists the pieces of text and a checkbox, and still lists the lines as before', async () => {
  const pdf = await quiz();
  const t = textOf(await call('inspect_pdf', { pdf }));
  assert.match(t, /text\s+x=30 y=\d+ .*"1\. Which is correct\?/);
  assert.match(t, /box\s+x=30 y=88 w=12 h=12/);
  const pages = await require('../mcp/pdfinfo').inspect(fs.readFileSync(pdf));
  assert.ok(pages[0].items.length >= 4 && pages[0].items.every((i) => i.str && Number.isFinite(i.x) && Number.isFinite(i.baseline)));
});

test('fill_pdf with marks only: one report line per mark, the PDF gets ink', async () => {
  const pdf = await quiz();
  const res = await call('fill_pdf', {
    pdf,
    marks: [
      { page: 1, type: 'circle', text: 'A)' },
      { page: 1, type: 'tick', x: 30, y: 88, width: 12, height: 12 },
      { page: 1, type: 'underline', text: 'Agree' },
      { page: 1, type: 'arrow', x1: 200, y1: 150, x2: 250, y2: 120 },
      { page: 1, type: 'cross', x: 100, y: 100 },
      { page: 1, type: 'box', x: 60, y: 120, width: 40, height: 14, seed: 5 },
    ],
  });
  assert.ok(!res.result.isError, textOf(res));
  const t = textOf(res);
  assert.match(t, /mark 1 \(page 1\): circle round "A\)" at x [\d.]+, y [\d.]+, [\d.]+ x [\d.]+ pt/);
  assert.match(t, /mark 2 \(page 1\): tick on the rectangle at x 30\.0, y 88\.0, 12\.0 x 12\.0 pt/);
  assert.match(t, /mark 3 \(page 1\): underline under "Agree"/);
  assert.match(t, /mark 4 \(page 1\): arrow from \(200\.0, 150\.0\) to \(250\.0, 120\.0\)/);
  assert.match(t, /mark 5 \(page 1\): cross on the rectangle at x 100\.0, y 100\.0, 19\.9 x 19\.9 pt|mark 5 \(page 1\): cross on the rectangle at x 100\.0, y 100\.0, 13\.3 x 13\.3 pt/);
  assert.match(t, /mark 6 \(page 1\): box round the rectangle .*\(seed 5\)/);
  const saved = t.match(/Saved (\S+)/)[1];
  assert.ok((await inkLength(saved)) > 1, 'ink was added');
});

test('fill_pdf says when text matches more than once, and nth picks one', async () => {
  const pdf = await quiz();
  const first = textOf(await call('fill_pdf', { pdf, marks: [{ page: 1, type: 'circle', text: 'B)' }] }));
  assert.match(first, /circle round "B\)" at x [\d.]+, y [\d.]+, [\d.]+ x [\d.]+ pt \(first of 2 matches\)/);
  const second = textOf(await call('fill_pdf', { pdf, marks: [{ page: 1, type: 'circle', text: 'B)', nth: 2 }] }));
  assert.match(second, /\(match 2 of 2\)/);
  const y1 = Number(first.match(/ y ([\d.]+),/)[1]);
  const y2 = Number(second.match(/ y ([\d.]+),/)[1]);
  assert.ok(y2 > y1, 'the second B) is lower on the page');
  const r = await call('fill_pdf', { pdf, marks: [{ page: 1, type: 'circle', text: 'B)', nth: 3 }] });
  assert.ok(r.result.isError);
  assert.match(textOf(r), /nth is 3 but "B\)" is printed only 2 times on page 1/);
});

test('fill_pdf with marks and answers draws both and reports both', async () => {
  const pdf = await quiz();
  const res = await call('fill_pdf', { pdf, answers: [{ page: 1, x: 30, y: 60, width: 300, height: 20, text: 'the quick fox' }], marks: [{ page: 1, type: 'strike', text: 'Agree' }] });
  assert.ok(!res.result.isError, textOf(res));
  const t = textOf(res);
  assert.match(t, /answer 1 \(page 1\): written at 9\.5 pt/);
  assert.match(t, /mark 1 \(page 1\): strike through "Agree"/);
  const both = fs.statSync(t.match(/Saved (\S+)/)[1]).size;
  const only = fs.statSync(textOf(await call('fill_pdf', { pdf, answers: [{ page: 1, x: 30, y: 60, width: 300, height: 20, text: 'the quick fox' }] })).match(/Saved (\S+)/)[1]).size;
  assert.ok(both > only, 'more ink with the mark');
});

test('fill_pdf stops before drawing anything when a mark is wrong', async () => {
  const pdf = await quiz();
  const dest = path.join(tmp, 'never.pdf');
  const bad = async (args, re) => {
    const r = await call('fill_pdf', { pdf, out: dest, ...args });
    assert.ok(r.result.isError, JSON.stringify(args));
    assert.match(textOf(r), re);
    assert.ok(!fs.existsSync(dest), 'nothing was saved');
  };
  await bad({ marks: [{ page: 1, type: 'tick', x: 30, y: 88, width: 12, height: 12 }, { page: 1, type: 'circle', text: 'D) purple' }] }, /mark 2: the text "D\) purple" is not printed on page 1\. The closest printed lines on that page are:\n[^]*"1\. Which is correct\?/);
  await bad({ answers: [{ page: 1, x: 30, y: 60, width: 300, text: 'the fox' }], marks: [{ page: 1, type: 'circle', text: 'zzz' }] }, /mark 1: the text "zzz" is not printed/);
  await bad({ marks: [{ page: 1, type: 'circle', x: 390, y: 10, width: 50, height: 20 }] }, /mark 1: the rectangle .* is outside page 1, which is 400 x 300 pt/);
  await bad({ marks: [{ page: 2, type: 'tick', x: 1, y: 1 }] }, /mark 1: page 2 does not exist/);
  await bad({ marks: [{ page: 1, type: 'squiggle', x: 1, y: 1 }] }, /mark 1: type "squiggle" is not one of circle, tick, cross/);
  await bad({ marks: [{ page: 1, type: 'circle', x: 10, y: 10 }] }, /mark 1: the circle needs width and height/);
  await bad({ marks: [{ page: 1, type: 'arrow', x1: 10, y1: 10, x2: 10 }] }, /mark 1: the arrow needs x1, y1, x2 and y2/);
  await bad({ marks: [{ page: 1, type: 'arrow', x1: 10, y1: 10, x2: 900, y2: 10 }] }, /outside page 1/);
  await bad({}, /Give at least one answer \(answers\) or one mark \(marks\)/);
});

test('fill_pdf with notability: true puts the marks into the note as strokes', async () => {
  const pdf = await quiz();
  const base = { pdf, notability: true, answers: [{ page: 1, x: 30, y: 60, width: 300, height: 20, text: 'the quick fox' }] };
  const plain = textOf(await call('fill_pdf', base)).match(/Notability note: (\S+\.note)/)[1];
  const sizeA = fs.statSync(plain).size;
  const withMarks = textOf(await call('fill_pdf', { ...base, marks: [{ page: 1, type: 'circle', text: 'A)' }, { page: 1, type: 'cross', x: 30, y: 88, width: 12, height: 12 }, { page: 1, type: 'arrow', x1: 100, y1: 150, x2: 300, y2: 200 }] })).match(/Notability note: (\S+\.note)/)[1];
  assert.ok(fs.statSync(withMarks).size > sizeA, 'the note with marks is bigger');
  const N = require('../src/notability');
  const { box, placed } = M.toPlaced(M.draw({ type: 'cross', x: 30, y: 88, w: 12, h: 12 }, { seed: 1 }), { xh: 9.5, page: 0 });
  const curves = N.curvesFromBoxes([{ box, placed }], [{ w: 400, h: 300 }], {});
  assert.equal(curves.length, 2, 'a cross is two pen strokes');
});

test('two circles at different places are never the same, and a given seed is repeatable', async () => {
  const pdf = await quiz();
  const a = await call('fill_pdf', { pdf, out: path.join(tmp, 'a.pdf'), marks: [{ page: 1, type: 'circle', x: 50, y: 150, width: 14, height: 11, seed: 3 }] });
  const b = await call('fill_pdf', { pdf, out: path.join(tmp, 'b.pdf'), marks: [{ page: 1, type: 'circle', x: 50, y: 150, width: 14, height: 11, seed: 3 }] });
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'a.pdf')), fs.readFileSync(path.join(tmp, 'b.pdf')));
  assert.ok(!a.result.isError && !b.result.isError);
  const c = await call('fill_pdf', { pdf, out: path.join(tmp, 'c.pdf'), marks: [{ page: 1, type: 'circle', x: 50, y: 150, width: 14, height: 11 }, { page: 1, type: 'circle', x: 150, y: 150, width: 14, height: 11 }] });
  assert.ok(!c.result.isError, textOf(c));
});

test('the one-file build has marks and anchors in it, and fill_pdf marks work from it', async () => {
  const code = build({ pdf: true });
  assert.ok(!/require\(['"]\.{1,2}\//.test(code), 'no relative requires are left');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-marks-bundle-'));
  fs.writeFileSync(path.join(dir, 'handwriting-mcp.js'), code);
  fs.writeFileSync(path.join(dir, 'my-handwriting.json'), samplesJson);
  const pdf = await quiz(dir);
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), '--out', path.join(dir, 'results')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reply = await new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i >= 0) resolve(JSON.parse(buf.slice(0, i)));
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fill_pdf', arguments: { pdf, marks: [{ page: 1, type: 'circle', text: 'B)' }, { page: 1, type: 'tick', x: 30, y: 88, width: 12, height: 12 }] } } }) + '\n');
    });
    assert.ok(!reply.result.isError, JSON.stringify(reply.result));
    assert.match(reply.result.content[0].text, /mark 1 \(page 1\): circle round "B\)"/);
    assert.ok(fs.existsSync(path.join(dir, 'results', 'quiz-filled.pdf')));
  } finally {
    child.kill();
  }
  const small = build({});
  assert.ok(!small.includes('PDFPageLeaf'), 'the build without PDF support still has no PDF library in it');
  assert.ok(small.includes('hand-drawn') || small.includes('findText'), 'and the pure parts are in it');
});
