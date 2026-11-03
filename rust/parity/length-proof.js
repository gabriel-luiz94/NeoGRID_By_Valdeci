'use strict';
const { DatabaseSync } = require('node:sqlite');
const js = new DatabaseSync(process.argv[2], { readOnly: true });
// Soma dos CODIGOS armazenados (o que o JS somou) vs soma decodificada (o que o Rust somou)
const codes = js.prepare('SELECT "NU_COMPRIMENTO_REAL" FROM "bt"').all().map((r) => r.NU_COMPRIMENTO_REAL);
let sumCodes = 0;
for (const c of codes) sumCodes += Number(c) || 0;
console.log('soma dos valores armazenados (codes):', sumCodes);
const S = JSON.parse(js.prepare("SELECT value FROM meta WHERE key='schema'").get().value);
const dict = S.layers.find((x) => x.type === 'bt').dicts.NU_COMPRIMENTO_REAL;
let sumDec = 0;
for (const c of codes) sumDec += Number(dict[c]) || 0;
console.log('soma decodificada:', sumDec);
console.log('schema js lengthMeters:', S.layers.find((x) => x.type === 'bt').lengthMeters);
js.close();
