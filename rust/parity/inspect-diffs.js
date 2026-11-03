'use strict';
const { DatabaseSync } = require('node:sqlite');
const [jsPath, rsPath] = process.argv.slice(2);
const js = new DatabaseSync(jsPath, { readOnly: true });
const rs = new DatabaseSync(rsPath, { readOnly: true });
const S1 = JSON.parse(js.prepare("SELECT value FROM meta WHERE key='schema'").get().value);
const S2 = JSON.parse(rs.prepare("SELECT value FROM meta WHERE key='schema'").get().value);
for (const t of ['poste', 'bt', 'mt', 'inst']) {
  const a = S1.layers.find((x) => x.type === t);
  const b = S2.layers.find((x) => x.type === t);
  const ka = Object.keys(a.dicts);
  const kb = Object.keys(b.dicts);
  console.log(t, 'dictcols js=' + ka.length, 'rs=' + kb.length);
  const onlyA = ka.filter((k) => !kb.includes(k));
  const onlyB = kb.filter((k) => !ka.includes(k));
  if (onlyA.length || onlyB.length) console.log('  onlyJS:', onlyA.slice(0, 8), 'onlyRS:', onlyB.slice(0, 8));
  for (const k of ka) {
    if (!b.dicts[k]) continue;
    if (JSON.stringify(a.dicts[k]) !== JSON.stringify(b.dicts[k])) {
      console.log('  col', k, 'jslen=' + a.dicts[k].length, 'rslen=' + b.dicts[k].length);
      const sa = new Set(a.dicts[k]);
      const sb = new Set(b.dicts[k]);
      console.log('   inJSnotRS:', a.dicts[k].filter((v) => !sb.has(v)).slice(0, 5));
      console.log('   inRSnotJS:', b.dicts[k].filter((v) => !sa.has(v)).slice(0, 5));
      console.log('   js[:3]=' + JSON.stringify(a.dicts[k].slice(0, 3)));
      console.log('   rs[:3]=' + JSON.stringify(b.dicts[k].slice(0, 3)));
      break;
    }
  }
}
console.log('js SHP_LENGTH:', JSON.stringify(js.prepare('SELECT "SHP_LENGTH" FROM "bt" LIMIT 5').all()));
console.log('rs SHP_LENGTH:', JSON.stringify(rs.prepare('SELECT "SHP_LENGTH" FROM "bt" LIMIT 5').all()));
console.log('js NU_COMPRIMENTO_REAL:', JSON.stringify(js.prepare('SELECT "NU_COMPRIMENTO_REAL" FROM "bt" LIMIT 5').all()));
console.log('rs NU_COMPRIMENTO_REAL:', JSON.stringify(rs.prepare('SELECT "NU_COMPRIMENTO_REAL" FROM "bt" LIMIT 5').all()));
console.log('bt indexes js:', JSON.stringify(S1.layers.find((x) => x.type === 'bt').indexes));
console.log('bt indexes rs:', JSON.stringify(S2.layers.find((x) => x.type === 'bt').indexes));
js.close(); rs.close();
