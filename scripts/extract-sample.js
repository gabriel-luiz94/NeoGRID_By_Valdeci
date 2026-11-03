'use strict';
const fs = require('node:fs');
const src = fs.readFileSync('electron/screenshot-mode.js', 'utf8');
const start = src.indexOf('function buildSampleData()');
const end = src.indexOf('async function run(');
const fn = src.slice(start, end).trimEnd();
fs.writeFileSync(
  'electron/sample-data.js',
  `'use strict';\n\n${fn}\n\nmodule.exports = { buildSampleData };\n`,
  'utf8',
);
console.log('extracted', fn.length);
