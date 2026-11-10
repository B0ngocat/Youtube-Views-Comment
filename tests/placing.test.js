'use strict';
// Smarter placing: after_text, ruled lines followed by wrapped answers, overlap warnings, inspect_pdf labels. Fake handwriting only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const Sheet = require('../src/sheet');
const { corpus } = require('./fixtures');
const Placing = require('../mcp/placing');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { createServer } = require('../mcp/server');
const { build } = require('../scripts/build-mcp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-placing-'));
const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow hex one'.split(' ');
const samplesJson = S.toJSON(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
const samples = path.join(tmp, 'my-handwriting.json');
fs.writeFileSync(samples, samplesJson);
const server = createServer({ samples, out: path.join(tmp, 'out') });
let nextId = 1;
const call = (name, args) => server({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
const textOf = (res) => res.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const H = 400;

/** A worksheet of 2 pages, 400 x 400 pt. Positions are from the top-left (y down), like the tools. */
async function sheet(dir) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const p1 = doc.addPage([400, H]);
  const p2 = doc.addPage([400, H]);
  const T = (pg, s, x, base) => pg.drawText(s, { x, y: H - base, size: 12, font });
  const L = (pg, x1, x2, y) => pg.drawLine({ start: { x: x1, y: H - y }, end: { x: x2, y: H - y }, thickness: 0.8, color: PDFLib.rgb(0, 0, 0) });
  T(p1, '3. Answer:', 50, 100); // a rule on its row
  L(p1, 130, 380, 102);
  T(p1, 'Name:', 50, 140); // blank space on its row, up to Date:
  T(p1, 'Date:', 300, 140);
  T(p1, 'Explain:', 50, 180); // a rule under it
  L(p1, 50, 380, 205);
  T(p1, 'Show work', 50, 260); // blank space under it, down to Final
  T(p1, 'Final answer', 50, 340);
  T(p1, 'Total:', 330, 300); // too near the right edge for place right, but there is room under it
  T(p2, '7. Answer', 50, 60); // four rules 20 pt apart
  for (const y of [62, 82, 102, 122]) L(p2, 130, 380, y);
  T(p2, '8. Blank lines', 50, 200); // lines the PDF does not draw
  T(p2, '9. Answer too', 50, 300); // a second "Answer"
  const p = path.join(dir || tmp, 'sheet.pdf');
  fs.writeFileSync(p, await doc.save());
  return p;
}

/** The ink of a filled page (what was drawn as filled paths, not the printed rules) as [{x, y}] in points from the top-left. */
async function inkPoints(pdf, pageNo) {
  require('../vendor/pdf.worker.min.js');
  const pdfjs = require('../vendor/pdf.min.js');
  pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), verbosity: 0 }).promise;
  const page = await doc.getPage(pageNo);
  const pageH = page.getViewport({ scale: 1 }).height;
  const { OPS } = pdfjs;
  const ops = await page.getOperatorList();
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const at = (x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: pageH - (m[1] * x + m[3] * y + m[5]) });
  const ink = [];
  let cur = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() || m;
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.constructPath) {
      const [sub, c] = args;
      let k = 0;
      for (const op of sub) {
        if (op === OPS.moveTo || op === OPS.lineTo) {
          cur.push(at(c[k], c[k + 1]));
          k += 2;
        } else if (op === OPS.curveTo) {
          cur.push(at(c[k + 4], c[k + 5]));
          k += 6;
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
          cur.push(at(c[k + 2], c[k + 3]));
          k += 4;
        } else if (op === OPS.rectangle) k += 4;
      }
    } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke) {
      ink.push(...cur);
      cur = [];
    } else if (fn === OPS.stroke || fn === OPS.endPath) cur = [];
  }
  await doc.destroy();
  return ink;
}

/** Splits ink points into lines of writing by gaps in y larger than `gap`: [{top, bottom}]. */
function linesOf(pts, gap) {
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  const out = [{ top: ys[0], bottom: ys[0] }];
  for (const y of ys) {
    const l = out[out.length - 1];
    if (y - l.bottom > gap) out.push({ top: y, bottom: y });
    else l.bottom = y;
  }
  return out;
}

const fill = async (args) => call('fill_pdf', { out: path.join(tmp, 'f' + nextId + '.pdf'), bounce: 0, ...args });
const XH3 = 'oxen sun\noven cure\nmoon sew'; // no tall or deep letters: each line's ink ends on its baseline
const ans = (o) => Object.assign({ page: 1, text: 'the box' }, o);

// ---- after_text: place -------------------------------------------------------------------------------

test('place line: the rule on the same row to the right of the text', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ after_text: '3.' })] });
  assert.ok(!r.result.isError, textOf(r));
  assert.match(textOf(r), /placed on the printed line after "3\." \(x 130\.0, line_y 102\.0, width 250\.0\)/);
  assert.ok(!/WARNING/.test(textOf(r)), 'an answer on the line next to its label does not warn: ' + textOf(r));
  const ink = await inkPoints(textOf(r).match(/Saved (\S+)/)[1], 1);
  const b = { x0: Math.min(...ink.map((p) => p.x)), y1: Math.max(...ink.map((p) => p.y)) };
  assert.ok(b.x0 >= 128 && b.x0 < 140, 'starts at the rule: ' + b.x0);
  assert.ok(Math.abs(b.y1 - (102 - 0.45 * 9.5)) < 2, 'sits on the rule: ' + b.y1);
});

test('place line: the first rule under the text when there is none on its row, and "line" with none says so', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ after_text: 'Explain:', place: 'line' })] });
  assert.match(textOf(r), /placed on the printed line below "Explain:" \(x 50\.0, line_y 205\.0, width 330\.0\)/);
  const none = await fill({ pdf, answers: [ans({ after_text: 'Name:', place: 'line' })] });
  assert.ok(none.result.isError);
  assert.match(textOf(none), /answer 1: place "line" found no printed ruled line for "Name:" on page 1/);
  assert.match(textOf(none), /What to do: use place "right"/);
  // a rule further down belongs to the text above it: "Show work" has Final answer between it and any rule
  const blocked = await fill({ pdf, answers: [ans({ after_text: 'Final answer', place: 'line' })] });
  assert.ok(blocked.result.isError, 'no rule under it');
});

test('place right: from after the text to the next printed text, on its baseline', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ after_text: 'Name:', place: 'right' })] });
  assert.ok(!r.result.isError, textOf(r));
  const m = textOf(r).match(/placed to the right of "Name:" on its baseline \(x ([\d.]+), line_y ([\d.]+), width ([\d.]+)\)/);
  assert.ok(m, textOf(r));
  const [x, lineY, w] = m.slice(1).map(Number);
  assert.ok(x > 50 + 25 && x < 100, 'after the label: ' + x);
  assert.ok(Math.abs(x + w - (300 - 4)) < 0.6, 'ends just before Date:: ' + (x + w));
  assert.ok(Math.abs(lineY - (140 + 0.45 * 9.5)) < 0.2, 'the writing sits on the label\'s baseline');
  assert.ok(!/WARNING/.test(textOf(r)), textOf(r));
  const ink = await inkPoints(textOf(r).match(/Saved (\S+)/)[1], 1);
  assert.ok(Math.abs(Math.max(...ink.map((p) => p.y)) - 140) < 2, 'the ink rests on the printed baseline');
  const full = await fill({ pdf, answers: [ans({ after_text: 'Total:', place: 'right' })] });
  assert.ok(full.result.isError);
  assert.match(textOf(full), /place "right" has no room: only [\d.]+ pt are free to the right of "Total:"/);
});

test('place below: the blank space under the text, down to the next printed text', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ after_text: 'Show work', place: 'below', text: 'the box\nthe fox\nthe hex' })] });
  assert.ok(!r.result.isError, textOf(r));
  const m = textOf(r).match(/placed below "Show work" \(x ([\d.]+), y ([\d.]+), width ([\d.]+), height ([\d.]+)\)/);
  assert.ok(m, textOf(r));
  assert.equal(Number(m[1]), 50);
  assert.ok(Number(m[2]) > 260 && Number(m[2]) < 270);
  assert.ok(!/WARNING/.test(textOf(r)), textOf(r));
  const ink = await inkPoints(textOf(r).match(/Saved (\S+)/)[1], 1);
  assert.ok(Math.min(...ink.map((p) => p.y)) > 262, 'under the text');
  assert.ok(Math.max(...ink.map((p) => p.y)) < 340 - 12 + 2, 'above the next printed text');
});

test('place auto: line if there is one, else right if there is room, else below', async () => {
  const pdf = await sheet();
  assert.match(textOf(await fill({ pdf, answers: [ans({ after_text: '3.' })] })), /on the printed line after/);
  assert.match(textOf(await fill({ pdf, answers: [ans({ after_text: 'Name:' })] })), /to the right of "Name:"/);
  assert.match(textOf(await fill({ pdf, answers: [ans({ after_text: 'Total:' })] })), /placed below "Total:"/);
  const bad = await fill({ pdf, answers: [ans({ after_text: 'Name:', place: 'sideways' })] });
  assert.match(textOf(bad), /place "sideways" is not one of auto, line, right, below/);
});

test('explicit width, x and height win over what after_text found, and the report says so', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ after_text: '3.', width: 120, height: 20 })] });
  assert.ok(!r.result.isError, textOf(r));
  assert.match(textOf(r), /\(x 130\.0, line_y 102\.0, width 120\.0\) \[you set width, height, which wins\]/);
  const x = await fill({ pdf, answers: [ans({ after_text: '3.', x: 150, width: 100 })] });
  assert.match(textOf(x), /x 150\.0, line_y 102\.0, width 100\.0/);
  const y = await fill({ pdf, answers: [ans({ after_text: '3.', line_y: 110 })] });
  assert.match(textOf(y), /line_y 110\.0/);
});

test('after_text: several matches (first of N, nth), and a missing text or nth stops before anything is saved', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ after_text: 'Answer', page: 2 })] });
  assert.match(textOf(r), /after "Answer" \(x 130\.0, line_y 62\.0, width 250\.0\) \(first of 2 matches\)/);
  assert.match(textOf(await fill({ pdf, answers: [ans({ after_text: 'Answer', nth: 2, page: 2 })] })), /to the right of "Answer" on its baseline .* \(match 2 of 2\)/);
  const dest = path.join(tmp, 'never.pdf');
  const bad = async (a, re) => {
    const res = await call('fill_pdf', { pdf, out: dest, answers: [a] });
    assert.ok(res.result.isError, JSON.stringify(a));
    assert.match(textOf(res), re);
    assert.ok(!fs.existsSync(dest), 'nothing was saved');
  };
  await bad(ans({ after_text: 'Question 99' }), /answer 1: the text "Question 99" is not printed on page 1\. The closest printed lines on that page are:\n[^]*"3\. Answer:"/);
  await bad(ans({ after_text: 'Answer', nth: 5, page: 2 }), /answer 1: nth is 5 but "Answer" is printed only 2 times on page 2/);
  await bad(ans({ after_text: 'Answer', page: 3 }), /page 3 does not exist/);
  await bad({ page: 1, text: 'x' }, /answer 1: x must be a number/);
});

// ---- ruled lines ---------------------------------------------------------------------------------------

test('a wrapped answer lands on each printed rule: stroke geometry', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ page: 2, after_text: '7.', text: XH3 })] });
  assert.ok(!r.result.isError, textOf(r));
  assert.match(textOf(r), /follows 4 printed lines, 20\.0 pt apart/);
  assert.ok(!/WARNING/.test(textOf(r)), textOf(r));
  const lines = linesOf(await inkPoints(textOf(r).match(/Saved (\S+)/)[1], 2), 4);
  assert.equal(lines.length, 3, JSON.stringify(lines));
  [62, 82, 102].forEach((rule, i) => assert.ok(Math.abs(lines[i].bottom - (rule - 0.45 * 9.5)) < 1.6, `line ${i + 1} rests on rule ${rule}: ink bottom ${lines[i].bottom}`));
});

test('the same by line_y, the box grows only as far as the last rule, and follow_lines: false turns it off', async () => {
  const pdf = await sheet();
  const five = 'oxen\noven\nmoon\nsewn\nnuns';
  const r = await fill({ pdf, answers: [ans({ page: 2, x: 130, line_y: 62, width: 250, text: five })] });
  assert.match(textOf(r), /follows 4 printed lines, 20\.0 pt apart/);
  assert.match(textOf(r), /DOES NOT FIT/, 'a fifth line has no rule');
  const four = await fill({ pdf, answers: [ans({ page: 2, x: 130, line_y: 62, width: 250, text: 'oxen\noven\nmoon\nsewn' })] });
  assert.ok(!/DOES NOT FIT/.test(textOf(four)), textOf(four));
  assert.match(textOf(four), /box GROWN downward from 28 to 88 pt/);
  const off = await fill({ pdf, answers: [ans({ page: 2, x: 130, line_y: 62, width: 250, text: 'oxen\noven\nmoon', follow_lines: false })] });
  assert.ok(!/follows/.test(textOf(off)));
  const lines = linesOf(await inkPoints(textOf(off).match(/Saved (\S+)/)[1], 2), 4);
  assert.ok(Math.abs(lines[2].bottom - lines[1].bottom - 20) > 2, 'without it the lines are the usual distance apart, not the rules\' 20 pt: ' + JSON.stringify(lines));
});

test('a one-line answer on a rule in a run is unchanged: no extra report line', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ page: 2, x: 130, line_y: 62, width: 250 })] });
  assert.ok(!/follows/.test(textOf(r)), textOf(r));
  const lines = linesOf(await inkPoints(textOf(r).match(/Saved (\S+)/)[1], 2), 4);
  assert.ok(Math.abs(lines[0].bottom - (62 - 0.45 * 9.5)) < 1.6);
});

test('line_spacing_pt: lines on paper the PDF does not draw', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ page: 2, x: 50, line_y: 240, width: 300, line_spacing_pt: 25, text: XH3 })] });
  assert.ok(!r.result.isError, textOf(r));
  assert.match(textOf(r), /follows ruled lines 25\.0 pt apart \(line_spacing_pt\)/);
  const lines = linesOf(await inkPoints(textOf(r).match(/Saved (\S+)/)[1], 2), 5);
  assert.equal(lines.length, 3);
  [240, 265, 290].forEach((rule, i) => assert.ok(Math.abs(lines[i].bottom - (rule - 0.45 * 9.5)) < 1.6, `line ${i + 1}: ${lines[i].bottom}`));
  const bad = await fill({ pdf, answers: [ans({ line_y: 100, x: 50, width: 100, line_spacing_pt: 3 })] });
  assert.match(textOf(bad), /line_spacing_pt must be the distance between ruled lines in points, from 10 to 60/);
});

test('letters too tall for the rules are made smaller, within min_size_ratio, and the report says so', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ page: 2, after_text: '7.', letter_height_pt: 11, text: 'the box\nthe fox' })] });
  assert.match(textOf(r), /SHRUNK from 11 to 10\.5 pt \(96% of the size asked for\) because the printed lines are only 20 pt apart/);
  const tight = await fill({ pdf, answers: [ans({ page: 2, after_text: '7.', letter_height_pt: 16, min_size_ratio: 0.95, text: 'the box\nthe fox' })] });
  assert.match(textOf(tight), /taller than lines 20\.0 pt apart allow/);
  const fixed = await fill({ pdf, answers: [ans({ page: 2, after_text: '7.', letter_height_pt: 16, shrink_to_fit: false, text: 'the box' })] });
  assert.ok(!/SHRUNK/.test(textOf(fixed)));
});

test('mixed and math answers follow the rules, and tall math that breaks the spacing is reported, not hidden', async () => {
  const pdf = await sheet();
  const m = await fill({ pdf, on_missing: 'fallback', answers: [ans({ page: 2, after_text: '7.', kind: 'math', text: '\\frac{a}{b}' })] });
  assert.ok(!m.result.isError, textOf(m));
  assert.match(textOf(m), /follows 4 printed lines, 20\.0 pt apart/);
  const ok = await fill({ pdf, on_missing: 'fallback', answers: [ans({ page: 2, after_text: '7.', kind: 'mixed', text: 'oxen $x = a$\noven cure\nmoon sew' })] });
  assert.ok(!ok.result.isError, textOf(ok));
  assert.ok(!/NOT on the ruled lines/.test(textOf(ok)), textOf(ok));
  const lines = linesOf(await inkPoints(textOf(ok).match(/Saved (\S+)/)[1], 2), 4);
  assert.ok(Math.abs(lines[1].bottom - (82 - 0.45 * 9.5)) < 2, 'a mixed answer without tall math is on the second rule: ' + JSON.stringify(lines));
  // tall math no longer drifts: see the tall math tests at the end
});

test('layoutBox: lineStep puts every baseline on its rule (no tool needed)', () => {
  const { style } = corpus('print', 2);
  const box = { page: 0, x: 10, y: 100, w: 300, h: 28, text: 'the fox\nthe dog\nthe box', kind: 'text', xhPt: 9.5, seed: 3, lineStep: 22, growTo: 28 + 2 * 22 };
  const placed = Sheet.layoutBox(style, box, { bounce: 0 });
  assert.equal(placed.lines, 3);
  placed.layout.baselines.forEach((b, i) => assert.ok(Math.abs(box.y + (b - placed.dy) * placed.K - (100 + 28 + i * 22 - 0.45 * 9.5)) < 0.01, `baseline ${i}`));
  assert.ok(placed.ruled && placed.ruled.off.length === 0);
  const noStep = Sheet.layoutBox(style, { ...box, lineStep: undefined }, { bounce: 0 });
  assert.equal(noStep.ruled, undefined, 'without lineStep nothing changes');
});

// ---- warnings --------------------------------------------------------------------------------------------

test('warnings: the writing over printed text, over another answer, and off the page; quiet otherwise', async () => {
  const pdf = await sheet();
  const quiet = await fill({ pdf, answers: [ans({ after_text: '3.' }), ans({ after_text: 'Name:' }), ans({ x: 130, line_y: 62, width: 250, page: 2 })] });
  assert.ok(!/WARNING/.test(textOf(quiet)), 'normal answers do not warn: ' + textOf(quiet));
  const over = await fill({ pdf, answers: [ans({ x: 48, y: 160, width: 200, height: 28, text: 'the box' })] });
  assert.ok(!over.result.isError);
  assert.match(textOf(over), /WARNING: answer 1 \(page 1\): the writing covers the printed text "Explain:" \(x 50\.0, y [\d.]+\) by [\d.]+ x [\d.]+ pt/);
  assert.ok(fs.existsSync(textOf(over).match(/Saved (\S+)/)[1]), 'a warning is not an error: the file is saved');
  const two = await fill({ pdf, answers: [ans({ x: 130, line_y: 62, width: 200, page: 2 }), ans({ x: 150, line_y: 64, width: 200, page: 2 })] });
  assert.match(textOf(two), /WARNING: answer 1 \(page 2\) and answer 2 \(page 2\) overlap by [\d.]+ x [\d.]+ pt/);
  const apart = await fill({ pdf, answers: [ans({ x: 130, line_y: 62, width: 200, page: 2 }), ans({ x: 130, line_y: 110, width: 200, page: 2 })] });
  assert.ok(!/WARNING/.test(textOf(apart)), textOf(apart));
  const wide = await fill({ pdf, answers: [ans({ x: 330, line_y: 250, width: 60, text: 'ooooooooooooooooooooooooooooooooooo', shrink_to_fit: false })] });
  assert.match(textOf(wide), /WARNING: answer 1 \(page 1\): the writing leaves the page: [\d.]+ pt past the right edge/);
});

test('Placing.warnings ignores a touch under 1.5 pt', () => {
  const printed = [{ text: [{ text: 'Label', x: 50, y: 90, w: 40, h: 12 }] }];
  const touch = [{ label: 'answer 1', page: 0, boxes: [{ x0: 88.2, y0: 90, x1: 140, y1: 102 }] }];
  assert.deepEqual(Placing.warnings(touch, printed, [{ w: 400, h: 400 }]), []);
  const real = [{ label: 'answer 1', page: 0, boxes: [{ x0: 80, y0: 90, x1: 140, y1: 102 }] }];
  assert.equal(Placing.warnings(real, printed, [{ w: 400, h: 400 }]).length, 1);
});

// ---- inspect_pdf ---------------------------------------------------------------------------------------

test('inspect_pdf keeps its lines and appends what a rule follows and its place in a run', async () => {
  const pdf = await sheet();
  const t = textOf(await call('inspect_pdf', { pdf })).split('\n');
  assert.ok(t.includes('Page 1: 400 x 400 pt'));
  assert.ok(t.some((l) => /^  text  x=50 y=\S+ w=\S+ h=\S+  "3\. Answer:"$/.test(l)), 'text lines are unchanged');
  const row = t.find((l) => l.startsWith('  line  x=130 y=102 w=250'));
  assert.equal(row, '  line  x=130 y=102 w=250  after "3. Answer:"');
  const run = t.filter((l) => l.startsWith('  line  x=130') && /line \d of 4/.test(l));
  assert.equal(run.length, 4);
  assert.match(run[0], /^  line  x=130 y=62 w=250  after "7\. Answer", line 1 of 4, 20 pt apart$/);
  assert.match(run[3], /y=122 w=250  line 4 of 4, 20 pt apart$/);
  assert.equal(t.find((l) => l.startsWith('  line  x=50 y=205')), '  line  x=50 y=205 w=330');
});

test('ruleRuns: same x, similar width, even spacing of 10 to 60 pt', () => {
  const rules = [{ x: 50, y: 100, w: 300 }, { x: 50.5, y: 118, w: 300 }, { x: 50, y: 136.4, w: 299 }, { x: 50, y: 154, w: 300 }, { x: 50, y: 200, w: 300 }, { x: 90, y: 118, w: 100 }];
  const runs = Placing.ruleRuns(rules);
  assert.equal(runs[0].rules.length, 4);
  assert.ok(Math.abs(runs[0].pitch - 18) < 0.01);
  assert.ok(runs.some((r) => r.rules.length === 1 && r.rules[0].y === 200), 'a rule that breaks the spacing is on its own');
  assert.equal(Placing.ruleRuns([{ x: 50, y: 100, w: 300 }, { x: 50, y: 105, w: 300 }]).every((r) => r.rules.length === 1), true, 'under 10 pt apart is not a run');
  assert.equal(Placing.ruleRuns([{ x: 50, y: 100, w: 300 }, { x: 50, y: 190, w: 300 }]).every((r) => r.rules.length === 1), true, 'over 60 pt apart is not a run');
});

// ---- the one-file build --------------------------------------------------------------------------------

test('the one-file build places by after_text and follows ruled lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-placing-bundle-'));
  fs.writeFileSync(path.join(dir, 'handwriting-mcp.js'), build({ pdf: true }));
  fs.writeFileSync(path.join(dir, 'my-handwriting.json'), samplesJson);
  const pdf = await sheet(dir);
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), '--out', path.join(dir, 'results')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = (id, name, args) =>
    new Promise((resolve) => {
      let buf = '';
      const on = (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i >= 0) {
          child.stdout.off('data', on);
          resolve(JSON.parse(buf.slice(0, i)));
        }
      };
      child.stdout.on('data', on);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
  try {
    const insp = await rpc(1, 'inspect_pdf', { pdf });
    assert.match(insp.result.content[0].text, /y=102 w=250  after "3\. Answer:"/);
    const reply = await rpc(2, 'fill_pdf', { pdf, answers: [ans({ page: 2, after_text: '7.', text: 'the box\nthe fox' })] });
    assert.ok(!reply.result.isError, JSON.stringify(reply.result));
    assert.match(reply.result.content[0].text, /placed on the printed line after "7\."/);
    assert.match(reply.result.content[0].text, /follows 4 printed lines, 20\.0 pt apart/);
    const miss = await rpc(3, 'fill_pdf', { pdf, answers: [ans({ after_text: 'nothing here' })] });
    assert.ok(miss.result.isError);
    assert.match(miss.result.content[0].text, /is not printed on page 1/);
  } finally {
    child.kill();
  }
});

test('a wrapped answer on a lone rule found by after_text starts on it and goes on below, without covering its label', async () => {
  const pdf = await sheet();
  const r = await fill({ pdf, answers: [ans({ after_text: 'Explain:', place: 'line', text: 'oxen sun\noven cure' })] });
  assert.ok(!r.result.isError, textOf(r));
  assert.ok(!/WARNING|follows/.test(textOf(r)), textOf(r));
  const lines = linesOf(await inkPoints(textOf(r).match(/Saved (\S+)/)[1], 1), 4);
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.ok(Math.abs(lines[0].bottom - (205 - 0.45 * 9.5)) < 1.6, 'the first line rests on the rule: ' + lines[0].bottom);
  assert.ok(lines[1].top > 205 - 2, 'the second line is under the rule');
});

// ---- tall math on ruled lines: every line stays on a rule ------------------------------------------------

/** A page with `n` rules `pitch` apart under "7. Answer", and the mixed answer filled on it; returns the report and the lines of ink. */
async function tallCase(pitch, text, n) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const pg = doc.addPage([400, H]);
  pg.drawText('7. Answer', { x: 50, y: H - 60, size: 12, font });
  for (let k = 0; k < n; k++) pg.drawLine({ start: { x: 130, y: H - (62 + k * pitch) }, end: { x: 380, y: H - (62 + k * pitch) }, thickness: 0.8, color: PDFLib.rgb(0, 0, 0) });
  const pdf = path.join(tmp, 'tall-' + pitch + '-' + n + '.pdf');
  fs.writeFileSync(pdf, await doc.save());
  const r = await fill({ pdf, on_missing: 'fallback', answers: [ans({ after_text: '7.', kind: 'mixed', text })] });
  assert.ok(!r.result.isError, textOf(r));
  // only the first word of each line (left of the fraction), so the fraction's hanging denominator does not blur line 1
  const lines = linesOf((await inkPoints(textOf(r).match(/Saved (\S+)/)[1], 1)).filter((p) => p.x < 150), 2.5);
  return { t: textOf(r), lines };
}
const onRule = (line, ruleY) => Math.abs(line.bottom - (ruleY - 0.45 * 9.5)) < 1.6;
const FRAC = 'oxen $\\frac{a}{b}$ sun\noven cure\nmoon sew';

test('a fraction on line 1 of a mixed answer: every line ends on a rule, in order', async () => {
  const { t, lines } = await tallCase(24, FRAC, 8);
  assert.ok(!/NOT on the ruled lines/.test(t), t);
  assert.equal(lines.length, 3, JSON.stringify(lines));
  const rules = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => 62 + 24 * k);
  let from = 0;
  for (const l of lines) {
    const k = rules.findIndex((y, i) => i >= from && onRule(l, y));
    assert.ok(k >= from, `a line ends on a rule: ${JSON.stringify(l)} in ${t}`);
    from = k + 1;
  }
});

test('a tighter pitch skips a rule for the fraction, and the report says so; a roomy one skips none', async () => {
  const tight = await tallCase(18, FRAC, 8);
  assert.match(tight.t, /line 2 skips a ruled line: the tall math/);
  assert.ok(!/NOT on the ruled lines/.test(tight.t), tight.t);
  assert.equal(tight.lines.length, 3);
  const rules = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => 62 + 18 * k);
  assert.ok(onRule(tight.lines[0], 62));
  const k2 = rules.findIndex((y) => onRule(tight.lines[1], y));
  const k3 = rules.findIndex((y) => onRule(tight.lines[2], y));
  assert.ok(k2 >= 2, 'line 2 is at least one rule further down: rule ' + k2);
  assert.equal(k3, k2 + 1, 'and line 3 is on the next rule');
  const roomy = await tallCase(40, FRAC, 4);
  assert.ok(!/skips|NOT on/.test(roomy.t), roomy.t);
  assert.ok(onRule(roomy.lines[1], 102) && onRule(roomy.lines[2], 142), JSON.stringify(roomy.lines));
});

test('a rule skipped for tall math counts as a rule: it does not fit when the rules run out', async () => {
  const { t } = await tallCase(18, FRAC, 3);
  assert.match(t, /DOES NOT FIT/);
});

test('layoutBox lineStep and synth snapLines: whole steps for tall math; without the option nothing changes', () => {
  const { style } = corpus('print', 2);
  const X = require('../src/mixed');
  const box = { page: 0, x: 10, y: 100, w: 300, h: 28, text: FRAC, kind: 'mixed', xhPt: 9.5, seed: 3, lineStep: 18, growTo: 28 + 7 * 18 };
  const placed = Sheet.layoutBox(style, box, { bounce: 0, fallbackGlyphs: true });
  assert.deepEqual(placed.ruled.off, []);
  assert.ok(placed.ruled.skips.length >= 1 && placed.ruled.rules > placed.lines);
  const o = { xh: 34, width: 600, seed: 3, fallbackGlyphs: true };
  const a = JSON.stringify(X.layout(style, FRAC, o).baselines);
  assert.equal(JSON.stringify(X.layout(style, FRAC, { ...o, snapLines: false }).baselines), a, 'no option, no change');
  const lh = 2.5 * 34;
  const snapped = X.layout(style, FRAC, { ...o, lineHeight: 2.5, snapLines: true }).baselines;
  snapped.slice(1).forEach((v, i) => assert.ok(Math.abs((v - snapped[i]) / lh - Math.round((v - snapped[i]) / lh)) < 1e-6, 'whole line heights'));
});
