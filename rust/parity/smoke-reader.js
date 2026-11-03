'use strict';
// Smoke test: abre o banco gerado pelo Rust com o mesmo codigo de leitura
// do app (electron/database.js) e roda viewport + links + page.
const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib');
const { manager } = require('../../electron/database.js');

const dbPath = process.argv[2];
const info = manager.open(dbPath);
console.log('open ok:', info.rows, 'registros,', info.layers.length, 'camadas');
// viewport no centro do Recife
const vp = manager.viewport('poste', { west: -35.0, east: -34.8, south: -8.2, north: -8.0, limit: 5000 });
console.log('viewport poste recife:', vp.length, 'packets');
const s = manager.search('poste', '10119', 5);
console.log('search sample:', JSON.stringify(s.slice(0, 3)));
const page = manager.page('poste', { offset: 0, limit: 5 });
console.log('page total:', page.total, 'rows:', page.rows.length);
const r = manager.row('poste', 0);
console.log('row0 id:', r ? JSON.stringify(r.row.slice(0, 3)) : null, 'geom[:40]=', r ? r.geom.slice(0, 40) : null);
const links = manager.linksForPole(r ? manager.layer('poste').headers.map((h, i) => r.row[i])[manager.layer('poste').headers.indexOf('NU_PG_ID')] : '');
console.log('links:', JSON.stringify({ inst: links.inst.length, nets: links.nets.length }));
// compara contagem rtree vs count
for (const t of ['poste', 'bt', 'mt', 'inst']) {
  const c = manager.layer(t).count;
  console.log(t, 'count=' + c);
}
manager.close();
console.log('SMOKE OK');
