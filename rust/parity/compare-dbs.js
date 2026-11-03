'use strict';
// Compara dois bancos (JS vs Rust): schema, linhas decodificadas, rtree, links.
const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib');

const [jsPath, rsPath] = process.argv.slice(2);
if (!jsPath || !rsPath) { console.error('uso: node compare-dbs.js <js.sqlite> <rs.sqlite>'); process.exit(2); }

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (!cond) { fails++; console.log(`FAIL ${msg} ${extra}`); }
  else console.log(`ok   ${msg}`);
};

const js = new DatabaseSync(jsPath, { readOnly: true });
const rs = new DatabaseSync(rsPath, { readOnly: true });

const schemaOf = (db) => JSON.parse(db.prepare("SELECT value FROM meta WHERE key='schema'").get().value);
const S1 = schemaOf(js), S2 = schemaOf(rs);

ok(S1.rows === S2.rows, 'total rows', `${S1.rows} vs ${S2.rows}`);
ok(S1.located === S2.located, 'located', `${S1.located} vs ${S2.located}`);
// totalLength tem o mesmo desvio documentado do lengthMeters (soma de codigos
// no JS quando a coluna e dicionario); validado por camada como ==decoded.
console.log(`info totalLength js=${S1.totalLength} rs=${S2.totalLength} (desvio documentado)`);
ok(S1.links.inst === S2.links.inst && S1.links.nets === S2.links.nets, 'links', JSON.stringify(S1.links) + ' vs ' + JSON.stringify(S2.links));
ok(S1.rejects === S2.rejects, 'rejects', `${S1.rejects} vs ${S2.rejects}`);

for (const l1 of S1.layers) {
  const l2 = S2.layers.find((x) => x.type === l1.type);
  ok(!!l2, `layer ${l1.type} exists`);
  if (!l2) continue;
  ok(JSON.stringify(l1.headers) === JSON.stringify(l2.headers), `${l1.type} headers`);
  for (const k of ['count', 'located', 'missing', 'duplicates', 'idPresent']) {
    ok(l1[k] === l2[k], `${l1.type}.${k}`, `${l1[k]} vs ${l2[k]}`);
  }
  // lengthMeters: desvio conhecido e documentado — o JS soma os CODIGOS do
  // dicionario quando a coluna de comprimento e elegivel (bug latente visivel
  // em bases pequenas); o Rust soma os valores decodificados (correto, e
  // identico ao JS nas bases reais onde a coluna e TEXT). Aqui validamos que
  // o valor Rust == soma decodificada do banco JS.
  const lenIdx = l1.indexes.length;
  if (lenIdx >= 0) {
    const h = l1.headers[lenIdx];
    const dict = l1.dicts[h];
    const colVals = js.prepare(`SELECT ${'"' + h.replace(/"/g, '""') + '"'} FROM "${l1.type}"`).all().map((r) => r[h]);
    let expect = 0;
    for (const v of colVals) {
      const s = typeof v === 'number' && dict ? (dict[v] ?? '') : String(v ?? '');
      const n = Number(String(s).trim().replace(',', '.'));
      if (Number.isFinite(n)) expect += n;
    }
    ok(Math.abs(l2.lengthMeters - expect) < 1e-6, `${l1.type}.lengthMeters==decoded`, `${l2.lengthMeters} vs ${expect}`);
  } else {
    ok(l1.lengthMeters === l2.lengthMeters, `${l1.type}.lengthMeters`, `${l1.lengthMeters} vs ${l2.lengthMeters}`);
  }
  ok(JSON.stringify(l1.dicts) === JSON.stringify(l2.dicts), `${l1.type} dicts`);
  ok(JSON.stringify(l1.bounds) === JSON.stringify(l2.bounds), `${l1.type} bounds`);
  ok(l1.hotspots.length === l2.hotspots.length, `${l1.type} hotspots len`, `${l1.hotspots.length} vs ${l2.hotspots.length}`);
  ok(JSON.stringify(l1.hotspots) === JSON.stringify(l2.hotspots), `${l1.type} hotspots`);
  ok(JSON.stringify(l1.indexes) === JSON.stringify(l2.indexes), `${l1.type} indexes`);
  for (const k of ['material', 'poleType', 'installationType', 'conductor']) {
    ok(JSON.stringify(l1[k]) === JSON.stringify(l2[k]), `${l1.type}.${k}`);
  }
}

// Decodifica uma linha como o reader faz.
function decodeRow(db, layer, values) {
  const dicts = {};
  for (const [h, list] of Object.entries(layer.dicts || {})) {
    dicts[layer.headers.indexOf(h)] = list;
  }
  const [rid, geom, minLon, maxLon, minLat, maxLat, ...row] = values;
  for (const [idx, list] of Object.entries(dicts)) {
    const code = row[idx];
    if (typeof code === 'number') row[idx] = list[code] ?? '';
    else if (code == null) row[idx] = '';
  }
  let g = '';
  if (geom != null) {
    g = typeof geom === 'string' ? geom : zlib.inflateSync(Buffer.from(geom)).toString('utf8');
  }
  return { rid, row, geom: g, bbox: [minLon, maxLon, minLat, maxLat] };
}

for (const l1 of S1.layers) {
  const l2 = S2.layers.find((x) => x.type === l1.type);
  const cols = (l) => l.headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(', ');
  const q1 = js.prepare(`SELECT "_rid","_geom","_min_lon","_max_lon","_min_lat","_max_lat",${cols(l1)} FROM "${l1.type}" ORDER BY "_rid"`);
  const q2 = rs.prepare(`SELECT "_rid","_geom","_min_lon","_max_lon","_min_lat","_max_lat",${cols(l2)} FROM "${l2.type}" WHERE "_rid" = ?`);
  q1.setReturnArrays(true); q2.setReturnArrays(true);
  let n = 0, diff = 0;
  for (const a of q1.iterate()) {
    const b = q2.get(a[0]);
    n++;
    if (!b) { diff++; continue; }
    const da = decodeRow(js, l1, a), dbb = decodeRow(rs, l2, b);
    if (JSON.stringify(da) !== JSON.stringify(dbb)) {
      if (diff < 3) console.log(`  diff ${l1.type} rid=${a[0]}:\n   js=${JSON.stringify(da).slice(0, 300)}\n   rs=${JSON.stringify(dbb).slice(0, 300)}`);
      diff++;
    }
  }
  ok(diff === 0, `${l1.type} rows identical`, `${n} rows, ${diff} diffs`);
  // rtree
  const c1 = js.prepare(`SELECT count(*) FROM "rtree_${l1.type}"`).get()[0];
  const c2 = rs.prepare(`SELECT count(*) FROM "rtree_${l2.type}"`).get()[0];
  ok(c1 === c2, `${l1.type} rtree count`, `${c1} vs ${c2}`);
  const r1 = js.prepare(`SELECT * FROM "rtree_${l1.type}" ORDER BY id LIMIT 1000`).all();
  const r2 = rs.prepare(`SELECT * FROM "rtree_${l2.type}" ORDER BY id LIMIT 1000`).all();
  ok(JSON.stringify(r1) === JSON.stringify(r2), `${l1.type} rtree sample`);
}

// links
{
  const a = js.prepare('SELECT * FROM "_link_pole_inst" ORDER BY 1,2').all();
  const b = rs.prepare('SELECT * FROM "_link_pole_inst" ORDER BY 1,2').all();
  ok(a.length === b.length, '_link_pole_inst count', `${a.length} vs ${b.length}`);
  ok(JSON.stringify(a) === JSON.stringify(b), '_link_pole_inst content');
  const c = js.prepare('SELECT * FROM "_link_pole_net" ORDER BY 1,2,3').all();
  const d = rs.prepare('SELECT * FROM "_link_pole_net" ORDER BY 1,2,3').all();
  ok(c.length === d.length, '_link_pole_net count', `${c.length} vs ${d.length}`);
  ok(JSON.stringify(c) === JSON.stringify(d), '_link_pole_net content');
}
// rejects
const ra = js.prepare('SELECT * FROM "_rejects"').all();
const rb = rs.prepare('SELECT * FROM "_rejects"').all();
ok(ra.length === rb.length, '_rejects count');

js.close(); rs.close();
console.log(fails ? `\n${fails} FALHAS` : '\nTUDO IGUAL');
process.exit(fails ? 1 : 0);
