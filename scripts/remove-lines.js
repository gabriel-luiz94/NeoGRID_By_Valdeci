'use strict';
const fs = require('node:fs');
const [file, from, to] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split('\n');
lines.splice(Number(from) - 1, Number(to) - Number(from) + 1);
fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log('removed lines', from, 'to', to);
