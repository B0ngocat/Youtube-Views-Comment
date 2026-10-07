#!/usr/bin/env node
/*
 * Writes a Notability note to open on the iPad when a handwriting note does not look right: a frame the size of a page, a
 * letter F near the top left (it shows which way is up and which is left), and a ruler 100 units long.
 *
 *   node scripts/make-calibration-note.js [Calibration.note]
 */
'use strict';
const fs = require('fs');
const N = require('../src/notability');

const out = process.argv[2] || 'Calibration.note';
fs.writeFileSync(out, N.buildNote(N.calibrationCurves('#1749b3'), { name: 'Calibration' }));
console.log('Wrote ' + out);
