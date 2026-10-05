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

The Full lines round has you write whole sentences on one line. From those the app learns how you really space words and how your baseline, size and slant drift along a line, and uses that when it writes. The words in each line also count as extra samples. At least 3 lines are needed. Word gaps are taken as measured; baseline, size and slant drift are measured less reliably from short lines, so they are kept within ordinary human ranges. The Natural variation slider scales the drift (30% is the default, lower is neater).

Math mode (a checkbox under the text box in the Write tab) lays out math in your hand. It reads TeX-style input: `x^2`, `x_1`, `\frac{a}{b}`, `\sqrt{x}`, `\lim_{x \to 0}`, `\int_0^1 x\,dx`, `\sum_{i=1}^{n}`, and `->`, `<=`, `>=`, `!=` for the arrows and comparisons. Exponents and subscripts are smaller and shifted, fractions are stacked with a bar, and brackets stretch to fit what is inside. Letters and digits come from your samples. For symbols, the Math round in the Teach tab has you write each one on its own (the operators twice); a symbol you haven't written yet is drawn for you with a small wobble, and your own is used as soon as you have written it. Plain paper looks best for math.

Export (in the Teach tab) saves your samples to a file, and Import loads them on another device.

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

`tools/` has a script that writes text or math in your hand onto a PDF (see `CLAUDE.md`).

The code is in `src/`: `align.js` cuts words into letters, `synth.js` chooses and joins them, `math.js` lays out math, `render.js` draws the ink and `capture.js` is the pad.

## Tests

    npm test
    npm run e2e              (needs Playwright)
    npm run e2e:protected

The tests use a fake pen that writes cursive and print with jitter and slant.
