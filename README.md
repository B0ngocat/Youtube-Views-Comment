# Handwriting Engine

Write a few sentences with an Apple Pencil and the app learns your handwriting. After that you can type any text and it writes it back in your hand.

It runs in the browser. Nothing is uploaded; your samples stay in the browser's local storage.

## Getting started with Claude Code

Unzip the folder, open it in Claude Code, and say: "Read CLAUDE.md and get me set up." `CLAUDE.md` explains how the app works, what you need to write yourself, how to run and publish it, and the mistakes to avoid. You need Node 18 or newer. To use the Pencil, the app has to be open on the iPad (same Wi-Fi with `npm run serve`, or published with a password, see below).

## Using it

1. Open the Teach tab and write each highlighted word on the solid line of the pad, then tap Next. The first round covers every lowercase letter. The later rounds add capitals, numbers and symbols, plus a round of common words so letter pairs look natural.
2. Look at "What it learned". Each letter it cut out of your words has its own colour. If a word looks wrong, tap it and write it again.
3. Switch to the Write tab, type some text and adjust size, slant, spacing, pen and paper. "Write it again" gives a new take. You can save the result as PNG or SVG.

The Single letters round has you write each letter on its own (lowercase twice, capitals once). Those need no cutting, so they are always clean examples, and the app uses them as a reference to catch letters it cut out of your words wrongly: a cut-out letter that looks clearly more like a different letter's reference than its own gets avoided. If that comparison would flag more than one letter in ten, it assumes it can't tell your letters apart and switches itself off.

The Math round has you write each digit and math symbol on its own (digits and operators twice), and Numbers in a row has numbers with decimal points, so the app has clean digits. Tricky letters has words with a, e, o, r and u at the start, middle and end, two of each; those letters are the hardest to cut out of words cleanly, so this gives the app plenty of good examples of them.

Neatness (a slider in the Write tab) sets how much the page leans on your clean single letters instead of letters cut out of your fast writing. At 0% it is the usual mix; higher is easier to read and a little more like print. A short flat run-in stroke on a single letter (the little tail on an "m") is trimmed off, so those letters work anywhere in a word.

**For math and calculus**, four rounds come before Common words: **x and y** (on their own, next to numbers, in short equations), **dy/dx and calculus** (`dy`, `dx`, `dy/dx`, `f(x)`, `dx/dt`…), **More numbers** (whole numbers, decimals, negatives, fractions and equations with numbers) and **x, y and digits again** (single letters and digits, the cleanest examples). A word or number you write in them is written back as you wrote it when you type it, in plain text and in math mode (`dy/dx`, `12`, `2x`), the same way as the common words, and digits cut out of long number words are the weakest part of the app, so extra examples here help more than anywhere else. The app also evens digits out for you: every digit cut out of one of your words is brought to your usual size and onto the baseline (cut-out digits varied by about a sixth in height and wandered up and down by a fifth of a digit, which is what made dense math look wobbly), a decimal point sits on the baseline and keeps a small gap, and in math mode `+`, `-`, `=` and the like sit in the middle of your digits instead of wherever you wrote them on the pad, with a little more room round them. Digits are also spaced the way you space them in your own numbers (they used to be spaced like letters, which is closer, so neighbouring digits touched), and the point keeps the distance you leave round it, up to a limit. A `×` you wrote so small that it looks like a dot (a quarter of your `+`, say) is left out and a clean one is drawn instead; the Teach tab says so under the letter grid, and writing it bigger brings yours back.

Common words has about 90 everyday words. When the text you type contains a word you wrote, the app writes it back from your own strokes instead of building it letter by letter (the "Use my real words" slider sets how willingly, 25% by default; a word used again and again on a page is varied, not pasted). So every common word you write improves every page.

The Full lines round has you write whole sentences on one line. From those the app learns how you really space words and how your baseline, size and slant drift along a line, and uses that when it writes. The words in each line also count as extra samples. At least 3 lines are needed. Word gaps are taken as measured; baseline, size and slant drift are measured less reliably from short lines, so they are kept within ordinary human ranges. The Natural variation slider scales the drift (30% is the default, lower is neater).

Math mode (a checkbox under the text box in the Write tab) lays out math in your hand. It reads TeX-style input: `x^2`, `x_1`, `\frac{a}{b}`, `\sqrt{x}`, `\lim_{x \to 0}`, `\int_0^1 x\,dx`, `\sum_{i=1}^{n}`, `\sqrt[3]{x}` (also typed as `sqrt(x)` or `cubert(x)`), `\text{ so }` for plain words in the middle of math, and `->`, `<=`, `>=`, `!=` for the arrows and comparisons. Ordinary spaces are ignored, as in TeX; `\ `, `\,`, `\;` and `\quad` are spaces that stay. Exponents and subscripts are smaller and shifted, fractions are stacked with a bar, and brackets stretch to fit what is inside. Letters and digits come from your samples. For symbols, the Math round in the Teach tab has you write each one on its own (the operators twice); a symbol you haven't written yet is drawn for you with a small wobble, and your own is used as soon as you have written it. Plain paper looks best for math.

Fix mode (a checkbox above the page in the Write tab) is the quickest way to clean up wrong letters. Tick it, then tap any letter on the page that looks wrong. That letter is replaced by another example of the same letter, the example it came from is left out from then on, and every other letter on the page stays exactly as it was. Undo puts it back. It works in ordinary text, not in Math mode. It changes the same "left out" list as the letter check in the Teach tab.

Export (in the Teach tab) saves your samples to a file, and Import loads them on another device.

## Filling in a worksheet

The Sheet tab puts your handwriting on a real worksheet, with nothing to install and nothing sent anywhere.

1. Tap **Open worksheet** and choose the PDF, or a photo or screenshot of it (PNG or JPEG).
2. Tap **Draw answer box** and drag a rectangle where an answer goes. Drag a box to move it, or drag the round handle at its corner to resize it. A box can be on any page; use the arrows to turn pages.
3. With a box selected, type the answer in the panel on the right. It is written in your hand straight away, in the pen and colour set in the Write tab. Choose **Math** to type it as math (`\frac{a}{b}`, `x^2`), and **Another take** if you want that answer written differently.
4. An answer that is too long for its box is written smaller until it fits (unless you untick that), and the panel says so. Letter height sets the size it starts from, in points.
5. **Save PDF** gives back the worksheet with the writing drawn on top as vector ink, so it stays sharp. **Save page as PNG** saves the page you are looking at as a picture.

The boxes and answers are remembered on this device for that file, so you can close the page and open the same file again later. A PDF that is locked with a password has to be unlocked first, and pages that are rotated inside the PDF can be shown but not saved as PDF yet (use the PNG).

The PDF code (`vendor/`, pdf.js and pdf-lib) is only loaded the first time a worksheet is opened.

## Letting an AI assistant use it (MCP)

`mcp/server.js` is an MCP server, so an assistant such as Claude Code or Claude Desktop can write in your hand and fill in worksheets when you ask it to ("fill in the answers on homework.pdf in my handwriting"). It runs the same engine as the web app on your computer, from the file the Export button in the Teach tab saves. It does not open the website, and the handwriting file never leaves your computer: the assistant only gets the pictures and text the tools return.

You need Node 18 or newer and your `my-handwriting.json`.

    # Claude Code
    claude mcp add handwriting -- node /full/path/to/mcp/server.js --samples /full/path/to/my-handwriting.json

For Claude Desktop, add this to its config file (`mcpServers` section) and restart it:

    "handwriting": {
      "command": "node",
      "args": ["/full/path/to/mcp/server.js", "--samples", "/full/path/to/my-handwriting.json", "--out", "/full/path/to/results"]
    }

Building your handwriting takes several seconds, so the first call after a fresh start is slow (about 7 s for a full set of samples). The built result is kept in a `.handwriting-cache` folder next to your samples file (private to you, and git skips it), so every later start takes under half a second, even if your assistant starts the program for each call. `--cache DIR` moves it and `--no-cache` turns it off. A server that stays running (`--http`) keeps it in memory.

`--out` is where it saves what it makes (default: a `handwriting-out` folder in the directory the server starts in).

Tools:

- `handwriting_status`: is your handwriting loaded, and which characters have no sample yet.
- `write_text`: writes text or TeX-style math and returns it. By default that is a PNG picture. With `format: "svg"` it returns the SVG markup itself as text (transparent, sized in points, ready to save as a `.svg` file), and `"both"` gives both. Both files are saved either way. Start the server with `--format svg` (or `HANDWRITING_FORMAT=svg`) to make SVG the default.
- `write_batch`: the same as `write_text` for a whole list of items in one call, so the handwriting is loaded once. A bad item is reported by number and the rest still come back; `return_images: false` returns just the saved file paths.
- `inspect_pdf`: for each page, the printed text and the ruled lines, with positions in points from the top-left corner. This is how the assistant finds where an answer goes.
- `fill_pdf`: writes answers onto a PDF and saves a new file (the original is never changed). Each answer has a page, an x position, a width, and either a y (top of the box) or the y of the printed line it should sit on. Long answers are written smaller to fit, and the reply says which ones were.
- **Missing characters.** `write_text`, `write_batch` and `fill_pdf` check every character against your handwriting before they draw anything. A character you have never written (a degree sign, a macron, a digit you skipped) is never skipped or guessed: the call stops, and the error lists each missing character with its code (`° (U+00B0)`) and the words it is in (`"30°C"`; for `fill_pdf` also the answer and page, for `write_batch` the item). `write_batch` and `fill_pdf` check every item or answer first, so a bad one stops the whole call with nothing half written. With `on_missing: "fallback"` a clean drawn stand-in is used for symbols and punctuation that have one (`° ¯ ‾ · • ′ ″ ~ ^ _ \ | [ ] { } ( ) < > + - = × ÷ ± . , : ; ! ?` and the upside-down `¿ ¡`) and the reply lists them, because they are not your handwriting. Letters and digits can never be faked, so one missing still stops the call. `handwriting_status` with `check` says which of the missing ones could be drawn. Accents on letters are composed from your own letter and are reported as such (see Spanish).
- **Seeds and re-rolling.** Every call and every answer takes a `seed` (a whole number from 0, default 1; anything else is refused). The same seed is always the same writing, another seed is another take. For digits and symbols another seed picks another of your clean examples (it will never put a digit cut out of a word in front of a clean one of yours), so with two clean examples of a digit there are two looks for it; the more single digits you write (the Teach rounds for digits), the more there are. `fill_pdf` says `(seed N)` in the report when you gave one.
- **Previews (`fill_pdf`).** `preview: "all"` or `"digits"` (only answers that contain a digit) returns a small picture of each answer's ink, cropped, about 3 pixels per point and at most 640 px wide (about 5 to 10 KB each, at most 20 per call), so digits can be checked without rendering whole pages. It shows the writing only, not the page behind it, and does not change the PDF.
- **Fitting an answer to its box (`fill_pdf`).** If an answer does not fit its box at the letter size asked for, it is first wrapped onto more lines inside the box's width; then the box grows downward (up to `max_height`, by default it stops just above the nearest printed text under the box, or at the bottom margin of the page; `grow: false` turns this off); and only then are the letters made smaller, never below `min_size_ratio` (default 0.8) of the size asked for, and only if `shrink_to_fit` is not false. The report says for each answer `fits as it is`, `WRAPPED onto N lines`, `box GROWN downward from A to B pt (it now ends at y = ...)` or `SHRUNK from A to B pt (N% of the size asked for)`, and `DOES NOT FIT` with what is needed if it still does not. Wrapped lines are spaced evenly from the top of the box; they do not follow the printed ruled lines under it.

### One file, and a web address

`npm run build:mcp` folds the server and the whole engine into one file, `dist/handwriting-mcp.js` (about 150 KB), that needs nothing else: no npm packages, no project folder. Copy it anywhere next to your `my-handwriting.json` and run `node handwriting-mcp.js` (it looks for `my-handwriting.json` in the folder it is started in, then next to itself, or use `--samples`). That file has `handwriting_status` and `write_text`. `node scripts/build-mcp.js --pdf --out dist/handwriting-mcp-pdf.js` also adds `inspect_pdf` and `fill_pdf`, and makes the file about 2 MB.

`write_text` returns the picture as an MCP image (a base64 PNG). A client that cannot show images can ask for the base64 as text too with `include_base64: true`.

Deploying the site also publishes the server next to the login page, so an assistant can fetch it instead of you uploading it each time: `https://<you>.github.io/<repo>/handwriting-mcp.js` (and `handwriting-mcp-pdf.js`), each with a `.sha256` file, and `mcp.txt`, a plain-text page of instructions an assistant can read. These files are only the program. Your handwriting is not in them and is not on the site: it stays in your own `my-handwriting.json`, which still has to be given to wherever the server runs.

### Keeping the handwriting locked

`SEAL_PASSWORD='a long password' node scripts/seal-samples.js my-handwriting.json handwriting.enc.json` locks your samples with a password (gzip, then AES-256-GCM with a PBKDF2 key, the same recipe as the protected page) and writes a file that is safe to keep anywhere. Nothing is uploaded. Passwords under 12 characters are refused, because anyone who can download a sealed file can guess at it offline.

The server opens it with `--samples handwriting.enc.json --password ...`, or with `--samples-url <address of the file>`. Prefer `HANDWRITING_PASSWORD` in the environment to `--password`, so the password stays out of process lists. The unlocked samples are only ever held in memory; the speed-up cache described above does hold them unlocked, so keep that folder private.

To use it as a web address instead of a program, add `--http 8787 --token <a secret of 16 or more characters>`. It then answers MCP requests at `http://127.0.0.1:8787/mcp` (POST, header `Authorization: Bearer <token>`). It listens on your computer only. To reach it from another device, put a tunnel or an HTTPS proxy in front of it; the token is the only thing stopping other people from writing in your hand, so keep it private.

The assistant can look at the PDF itself as well as read `inspect_pdf`, which only lists text and lines, not pictures. Check the result before you hand it in. It writes only what it is asked to write, and what you hand in is your call.

## Math: which TeX works

Anything not on this list is **refused, not written out as a word** (the Write tab skips it and warns; the MCP server stops with a short error and suggestions, and `handwriting_status` with `math_help: true` returns this list):

- **Structure:** `x^2` `x_1` `x_i^2`, `\frac{a}{b}` (also `\dfrac`, `\tfrac`), `\sqrt{x}`, `\sqrt[3]{x}`, `sqrt(x)`, `cubert(x)`, `\int` `\sum` `\prod` with `_` and `^`, `\lim_{x \to 0}`, `\left(` `\right)`, `\text{words}` (also `\mathrm`, `\operatorname`), spaces `\,` `\;` `\:` `\quad` `\qquad` `\ `, and a new line or `\\` for a new row.
- **Primes:** `y'`, `f''(x)`, `\prime`: a small mark over the top right of the letter (not your tall apostrophe).
- **Over a letter:** `\bar{x}` (`\overline`), `\vec{v}`, `\hat{n}`, `\dot{x}`, `\ddot{x}`, `\tilde{x}`.
- **Arrows and relations:** `\to \rightarrow \Rightarrow \implies \leftarrow \Leftarrow \leftrightarrow \Leftrightarrow \iff \mapsto \le \ge \ne \approx \equiv \sim \propto \ll \gg \perp \parallel \angle \triangle`.
- **Sets and logic:** `\in \notin \subset \subseteq \cup \cap \emptyset \forall \exists \therefore \because \neg \land \lor`.
- **Operators and dots:** `\pm \mp \times \cdot \div \ast \circ \bullet \ldots \cdots \degree \infty \partial \nabla`.
- **Words:** `\sin \cos \tan \sec \csc \cot \arcsin \arccos \arctan \sinh \cosh \tanh \log \ln \exp \lim \max \min \sup \inf \det \dim \ker \gcd \mod \arg \deg`.
- **Greek:** `\alpha \beta \gamma \delta \epsilon \zeta \eta \theta \kappa \lambda \mu \nu \xi \pi \rho \sigma \tau \upsilon \phi \chi \psi \omega` and the capitals `\Gamma \Delta \Theta \Lambda \Xi \Pi \Sigma \Phi \Psi \Omega`.

Your own symbol is used when you wrote one (an operator needs two samples). Without one, the symbols above that have a clean drawing (arrows, sets, `\times`, dots, brackets...) are drawn for you and the MCP reply says which. Greek letters have no drawing: you wrote them or they are reported as missing.

## Spanish

Type Spanish as you normally would: `ñ`, `á é í ó ú ü`, the capitals (`Ñ Á É Í Ó Ú`) and `¿ ¡`. It works without teaching anything extra. An accented letter you have not written is drawn as your own plain letter with the accent drawn over it in your style (an acute, a tilde, two dots; an `i` loses its dot to the accent), a capital is your small letter made larger, and `¿` and `¡` are your own `?` and `!` turned upside down. In the Write tab and in the Sheet tab's answer box, **Spanish letters** (a folded section under the text) has buttons for them, and **Capitals** switches the vowels and `ñ` to capitals, because the iPad keyboard hides them behind a long press. Your accents are drawn the same way every time in style, but they are not yet *yours*. To make them yours, do the optional rounds at the end of the Teach tab: **Spanish words** (`mañana`, `está`, `qué`...), **Spanish letters** (each one on its own, with its accent, and `¿` `¡`) and **Spanish lines**. A letter you wrote is used instead of the drawn one, the same as any other letter, and the Coverage grid has a Spanish row where you can check them and tap any that came out wrong. The MCP server writes Spanish the same way (just send the text with its accents).

## Notability notes with editable pen strokes

**Save for Notability** (Write tab) makes a Notability note (`.note`) whose writing is real pen strokes, so it can be selected, moved, resized and erased in Notability like anything you drew there. A PDF can't do that, because the writing in a PDF is part of the page. On an iPad it opens the share sheet, where you pick Notability; elsewhere it downloads `handwriting.note`, which you can open from Files with Share, then Notability. The MCP server does the same with `format: "note"`.

How it works: a note is a zip of Apple property lists, and the strokes are packed into a few arrays of numbers. This follows [jvns/svg2notability](https://github.com/jvns/svg2notability), which worked that out in 2018, and the files are checked against a note that Notability itself wrote (same files, same structure, and the stroke arrays match byte for byte for the same strokes). The code is in `src/notability.js` and has no dependencies, so it runs in the page and in Node.

**What was found by opening notes on an iPad.** They open and the strokes are editable. In a note, y goes down from the top of the page and x = 0 is 12.8 units in from the left edge (the page has a margin on each side, so the drawable width is 512 of the 537.6). A stroke is a chain of cubic Bézier segments, so it must have 3k + 1 points: strokes with any other number of points are not drawn at all (circles of 25 and 241 points showed, ones of 9 and 81 did not). `src/notability.js` turns the stroke points into such a chain, so the curve goes through every point. The reference note is from Notability 7.2.5 (2018) and the app has moved on, so if something else looks off, make a test note with `node scripts/make-calibration-note.js` (a frame, an F near the top left and a ruler) or `node scripts/make-notability-sample.js my-handwriting.json Sample.note` (the same words at five sizes and pen widths) and look at what comes out. The numbers to change are `xhDoc` (letter height), `pen` (line width), `left` and `top` in `curvesFromLayout`.

**A worksheet in Notability.** In the Sheet tab, **Save for Notability** (next to Save PDF) makes a note whose pages are the worksheet's own pages, with the answers on top as pen strokes in the boxes you drew. Through the MCP server, `fill_pdf` with `"notability": true` saves the same note next to the filled PDF (`<name>-filled.note`; `pen_width` sets the line width). Pages of different sizes work (letter then A4 was checked), pages are placed as Notability places them (measured on an iPad, to about 1 pt), and rotated pages are not supported. Open it from Files with Share, then Notability. A note made from the Write tab is one page of text with no PDF behind it.

## Downloading everything

On the published (password-protected) site there is a **Download everything** button at the bottom left. It gives one `handwriting-engine.zip` with the app's code, the MCP server (`handwriting-mcp.js`, and the PDF version), and the setup guide as a PDF. Tick the box in its panel to add your own `my-handwriting.json` as well; it is off by default so a zip you send to someone does not carry your handwriting. The package is built into the encrypted page by `scripts/pack.js` and put together as a zip in the browser (`src/download.js`), so it works offline once the page has loaded. It is not there when you run the app locally with `npm run serve`.

### More passwords, each with its own part of the site

`SITE_PASSWORD='...' NIKO_PASSWORD='...' SEBA_PASSWORD='...' npm run deploy:pages` puts more parts behind the same login page, one per password (the names are in `PROFILES` in `scripts/pack.js`). Each person gets the same app with their own saved data (it never mixes with anyone else's, even in one browser). **Niko's** part has the full **Download everything** button. **Seba's** is for someone whose AI cannot host a site: it has a front page with three steps and a button, **Download for my AI**, that saves a small zip: their handwriting, the two MCP servers, the guide and `FOR-THE-AI.txt`, plain instructions for an assistant that can run a program but cannot host a website or use GitHub. Nothing of the main part is in it. The two passwords must differ, and neither opens the other's part.

## Looking like a note-taking app

The default pen is a constant-width pen with round ends, like a ballpoint in a note-taking app, in Notability's blue (`#1749b3`) on white paper. Its width, at the default 1.00, matches Notability's thickness 3 for handwriting of about 10 pt x-height on a letter page (measured from an exported sample page; 0.4 is thickness 1). Under Look, "Pen thickness" sets the width and "Pen" switches to the older speed-based line. Under Paper & ink, "Exact ink colour" takes any colour, so you can match your own pen.

## Apple Pencil

Once the Pencil has been used on the pad, finger and palm touches are ignored (there is a checkbox to turn that off). If the Pencil reports pressure, it sets the line weight. If it doesn't (the USB-C Pencil has no pressure sensor), line weight follows pen speed instead.

## Running and publishing

There is no build step for the app itself. `npm run serve` serves it on localhost:8080.

The published site is password protected. GitHub Pages can't check a password on a server, so the build script encrypts the whole app with the password (AES-256-GCM, key from PBKDF2) and the login page decrypts it in the browser:

    SITE_PASSWORD='...' npm run deploy:pages

That pushes a `gh-pages` branch containing only the login page and the encrypted app. In the repository settings, set Pages to deploy from that branch. Run the command again to update the site or change the password.

The encrypted file is public, so a short or guessable password can be cracked offline. The build refuses passwords under 12 characters unless `ALLOW_SHORT_PASSWORD=1` is set.

## How it works

Each captured word is cut into letters along the pen path, so joins and loops stay attached to the right letter. To write new text it picks from your recorded letters (reusing real letter pairs when it has them), joins them with smooth curves and adds a little drift so the result doesn't look copy-pasted.

The Sheet tab does the same job as the script in `tools/` (writing text or math in your hand onto a PDF, see `CLAUDE.md`), but from the browser, by dragging boxes onto the page.

The code is in `src/`: `align.js` cuts words into letters, `synth.js` chooses and joins them, `math.js` lays out math, `render.js` draws the ink, `capture.js` is the pad, and `sheet.js` and `sheetui.js` are the Sheet tab.

## Tests

    npm test
    npm run e2e              (needs Playwright)
    npm run e2e:protected

The tests use a fake pen that writes cursive and print with jitter and slant.
