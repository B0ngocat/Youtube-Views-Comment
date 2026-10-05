# Handwriting engine: notes for Claude

A browser app. The user writes samples with an Apple Pencil on an iPad (the Teach tab). After that they type any text, or TeX-style math, and get it back in their own handwriting (the Write tab). Output is vector ink: canvas, SVG, PNG, or placed on a PDF.

Plain JavaScript, no build step, no framework. Node 18+ for the tests and scripts. Everything runs in the browser except `scripts/` and `tools/`.

## What the user needs to do (you cannot do this part)

The handwriting is theirs. Only they can write the samples, and only on a device with a Pencil (or a finger/mouse, which works but looks worse). Walk them through it:

1. Get the app in front of them on the iPad (see "Running it").
2. Teach tab, rounds in this order: **Alphabet, Capitals, Numbers, Symbols, Single letters, Math, Tricky letters, Numbers in a row, Full lines**. Each is one word, letter or sentence at a time on the pad, then Next. Write at normal speed and size, on the solid line. About 25 to 30 minutes in total.
3. In the Write tab, tick **Fix mode** and tap any letter on the page that looks wrong: it is replaced and that example is left out for good (Undo is right there). Or, in the Teach tab, look at "What it learned" and tap any letter in the Coverage grid to see every example the app cut out for it, and tap the ones that do not look like the letter to leave them out. This is the most effective way to improve quality, especially for **a, e, o, r, u** and the digits. The Tricky letters round (those five at the start, middle and end of words) and Numbers in a row exist to give those a good supply of examples.
4. Export (Teach tab) saves `my-handwriting.json`. **That file is their handwriting. Do not commit it, do not paste it anywhere.** `.gitignore` already skips `my-handwriting*.json`.

If a result looks wrong, ask which letters or words give it away, and fix those specifically. Guessing at "make it more natural" does not work; the fixes that mattered were all specific (a letter pool containing mis-cut examples, a symbol scaled wrongly, a single letter carrying a run-in stroke it only has when written alone).

## Running it

    npm run serve          # http://localhost:8080 (npx http-server)
    npm test               # unit tests (node:test), about 30 s
    npm run e2e            # browser tests, needs Playwright: npm install && npx playwright install chromium
    npm run e2e:protected  # tests the password-protected build
    npx eslint src tests scripts tools

The Pencil needs the app on the iPad itself. Two ways:

- **Same Wi-Fi:** `npm run serve`, then open `http://<computer's address>:8080` in Safari on the iPad.
- **Published, password protected:** `SITE_PASSWORD='...' npm run deploy:pages` builds one encrypted page (AES-256-GCM, PBKDF2) and adds a normal commit on a `gh-pages` branch. In the GitHub repo settings, set Pages to deploy from `gh-pages`. The build refuses passwords under 12 characters unless `ALLOW_SHORT_PASSWORD=1`; a short password can be cracked offline because the encrypted file is public, so only set that if the user understands and says so. Never force-push `gh-pages`; the script does not. Never write the password into a file or commit it.

Samples live in the browser's localStorage, per origin. Use Export/Import to move them between devices.

## How it works

Data flow: `capture.js` records strokes -> `align.js` cuts each word into letters along the pen path -> `style.js` builds the per-letter pools and the writer's profile -> `synth.js` picks examples and joins them -> `render.js` draws the ink.

| File | Job |
| --- | --- |
| `src/capture.js` | The pad (Pointer Events, coalesced events, pen vs touch palm rejection, pressure or speed-based width). |
| `src/align.js` | Forced alignment: a DP that cuts a word into letters. Fits a per-word scale and baseline first, because people do not write at the guide's size. Crossing strokes (x, the bar of a t) stay together. |
| `src/style.js` | `buildStyle(rawWords)`: pools of examples per character (`byChar`), the writer's profile, word-gap and drift rhythm from full lines, flags on examples (see below). Cached per raw word (WeakMap), so a rebuild after adding one word is about 50 ms. |
| `src/synth.js` | `layout(style, text, opts)`: beam search over examples with join costs, Hermite bridges between joined letters, nearest-ink spacing for unjoined ones, small deformations. |
| `src/math.js` | `layout(style, tex, opts)`: TeX-style math (`x^2`, `\frac{a}{b}`, `\sqrt{x}`, `\lim_{x \to 0}`, `\int_0^1`, `\sum_{i=1}^{n}`), brackets that stretch. Draws a hand-wobbled stand-in for any symbol the writer has not written, and uses theirs once they have (operators need two samples). |
| `src/render.js` | Strokes to filled outlines (SVG path data) for canvas/SVG/PNG. Constant-width pen by default. |
| `src/lines.js` | Splits a written line into words. |
| `src/prompts.js` | The Teach rounds. |
| `src/app.js`, `index.html`, `styles.css` | The UI. `window.HW_APP` exposes `style`, `words`, `layout` for debugging. |
| `scripts/build-protected.js`, `deploy-pages.sh`, `login.template.html` | The password-protected site. |
| `tools/handwrite-blocks.js`, `tools/place_on_pdf.py` | Write text or math in the user's hand onto a PDF (see below). |

Coordinates inside the engine: x right, **y up**, baseline 0, x-height 1, de-slanted. The page conversion to pixels (y down, slant) happens at the end of `layout`. A "unit" is one cut-out letter: `{ch, strokes, marks, entry, exit, box, ...}`.

Flags `style.js` puts on units (all consumed as costs in `synth.chooseUnits`): `iso` (written on its own, so never mis-cut), `odd` and `dev` (unlike the writer's other examples), `hc` (implausible shape/height), `wrong` (looks more like another letter than its own single-letter reference), `far`, `open` (the writer closes this letter, this copy is open), `stray` (carries a scrap of a neighbour), `skipped` (crossed out by the user in the letter check; kept out of `byChar`, listed in `allByChar`).

Raw sample format (the export file): `{version: 1, words: [{text, xh, baseline, strokes: [[[x, y, t, pressure], ...]], iso?, line?, pos?, skip?}]}`. `skip` is `[{i, ch}]`, the letters the user crossed out.

## Things that bit us (do not repeat)

- **Each word draws from its own random streams** (`synthWord` takes one number from the layout's `rng` and builds one stream for choosing letters and one for spacing/wobble). That is what lets Fix mode replace one letter without disturbing the page: `layout` takes `pins` (one unit id or null per letter per word) and a pinned letter uses exactly that example. Keep it that way; sharing one stream across words makes every edit reshuffle everything after it. `layout().words[i]` has `ids`, `choices` and `spans` (x range of each letter on the page) for tracing a tap back to its example.
- A crossed-out example must never come back by any route. The "natural continuation" shortcut in `chooseUnits` used to add the next letter of the same recorded word without checking `skipped`.

- **Never mutate a cached unit.** `align.js`/`style.js` cache per raw word, so a mutation compounds on every rebuild. Make a copy (see `shrinkSingleLetters`).
- Symbol-only words (`(`, `+`, `=`) have no letters to size them by. They take the writer's usual scale from the profile (`profile.s`, `profile.dy`). Fitting each to its own height made every bracket the size of a lowercase letter.
- Single letters (the `iso` round) are written bigger and wider than the same letters inside words and carry a run-in stroke. They are shrunk by the writer's own in-word ratios and only used to start a word.
- The wrong-letter check compares shape only, so it cannot tell `i` from `l` (a stem is a stem at any height). Stems and punctuation are exempt (`NO_SHAPE_CHECK` in `style.js`). A safety valve turns the check off if it would flag more than 10% of letters.
- Shape distance does not separate good from bad `e`s for most people (their real e's range from c-shaped to loops). Use the letter check, not another heuristic.
- Digits cut out of number words are usually poor. The Math round has digits on their own; ask for it before generating anything numeric.
- A stroke's own width `w` comes from capture speed. The constant pen ignores it (and the tapers) on purpose, because the target (a note-taking app's pen) has one width.
- Test helpers: `tests/synth-writer.js` writes fake handwriting (print or cursive, with jitter and slant) so tests need no real data.

## Making it look like a particular app's pen

`render.js` has `CONSTANT_W`: the constant pen is `0.12` x-heights wide at pen thickness 1.00. That number was measured from a Notability export: a vertical line at thickness 3 was 1.2 pt wide, and lowercase letters in the same sample were about 10 pt tall. To match another pen or thickness, ask the user to export a page from their app with a few lines drawn at the thicknesses they use and a word written beside each, then measure line width and x-height from the PDF (PyMuPDF `get_pixmap` at 600 dpi plus a column scan works; the ink colour is the path's fill colour in `page.get_drawings()`). Then set the colour (`#1749b3` here is that app's blue) and `CONSTANT_W = width / xheight / 0.085`.

## Writing answers onto a PDF (homework, forms)

    pip install pymupdf
    node tools/handwrite-blocks.js my-handwriting.json blocks.json out/
    python3 tools/place_on_pdf.py assignment.pdf out/ answered.pdf 110

`tools/example-blocks.json` shows the format: text or math blocks with a top-left position and width in PDF points, plus optional hand-drawn lines/arrows for marking graphs. Render the assignment pages to PNG first (`pymupdf` `get_pixmap(dpi=120)`) and look at them to find the blank space; positions in points are the pixel position times 72/dpi. Check the result by looking at the page images before handing it over. Read any numbers off graphs programmatically if you can (count dots, find tick positions) instead of eyeballing.

Be honest with the user about what the engine cannot do well yet: numbers are only as good as the digit examples, and a result with illegible digits is not finished. Whether it is acceptable to hand in generated handwriting is the user's call and their school's or employer's rules; do not decide that for them, and do not fill in their name or anything else you were not given.

## Conventions

- Match the surrounding code: small functions, comments that explain why, no dependencies in `src/` (it runs from a `<script>` tag and from Node via the same file).
- Every behaviour change gets a test (`tests/*.test.js`); UI behaviour gets a step in `tests/e2e.js`. Run lint, `npm test` and `npm run e2e` before you commit.
- Keep commit messages and the README plain and specific. Follow whatever the user says about authorship and attribution lines.
- Never commit samples, passwords, tokens or exported pages. Do not create a pull request unless asked.
