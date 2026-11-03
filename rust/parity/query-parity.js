'use strict';
// Mesma suite do binario neogrid-query-parity, via electron/database.js.
// Uso: node query-parity.js <banco.sqlite>  (imprime JSON canonico)
const { manager } = require('../../electron/database.js');

async function main() {
  const db = process.argv[2];
  const info = manager.open(db);
  const layers = info.layers.map((l) => ({ type: l.type, count: l.count, headers: l.headers.length }));
  const suite = { layers };

  const poste = info.layers.find((l) => l.type === 'poste');
  const b = poste.bounds || { west: -35.0, east: -34.0, south: -8.5, north: -7.5 };
  const w = (b.west + b.east) / 2 - 0.02;
  const e = (b.west + b.east) / 2 + 0.02;
  const s = (b.south + b.north) / 2 - 0.02;
  const n = (b.south + b.north) / 2 + 0.02;

  suite.viewport_poste = manager.viewport('poste', { west: w, east: e, south: s, north: n, limit: 100 });
  suite.ids_in_bounds = manager.idsInBounds('poste', { west: w, east: e, south: s, north: n, limit: 1000 });
  suite.row0 = manager.row('poste', 0) || null;
  suite.rows_0_49 = manager.rows('poste', Array.from({ length: 50 }, (_, i) => i));
  suite.search_101 = manager.search('poste', '101', 5);
  suite.page_plain = manager.page('poste', { offset: 0, limit: 5 });

  const row0 = suite.row0;
  const poleIdx = poste.indexes.pole;
  const idIdx = poste.indexes.id;
  const pole = poleIdx >= 0 ? (row0.row[poleIdx] || '') : '';
  const theId = idIdx >= 0 ? (row0.row[idIdx] || '') : '';
  const found = manager.findById('poste', theId);
  suite.find_by_id = found == null ? null : found;
  suite.links = manager.linksForPole(pole);
  suite.distinct_material = manager.distinct('poste', 'MATERIAL', 10);
  suite.bounds = manager.indexBounds('poste');
  suite.hotspots = manager.hotspots('poste', 3);
  suite.viewport_bt = manager.viewport('bt', { west: w, east: e, south: s, north: n, limit: 50 });
  suite.viewport_mt = manager.viewport('mt', { west: w, east: e, south: s, north: n, limit: 50 });
  suite.viewport_inst = manager.viewport('inst', { west: w, east: e, south: s, north: n, limit: 50 });
  suite.page_search = manager.page('poste', { offset: 10, limit: 5, search: 'CONCRETO', sort: 'NU_PG_ID', dir: 1 });

  console.log(JSON.stringify(suite));
  manager.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
