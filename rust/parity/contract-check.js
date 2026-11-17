'use strict';
// Audita o contrato adapter (desktop-tauri.js) x backend (commands.rs).
// Tabela explicita: command -> args esperados (camelCase, via rename_all).
const fs = require('fs');
const path = require('path');

// Raiz do repositório (este script vive em rust/parity).
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const adapter = read('src/js/core/desktop-tauri.js');
const backend = read('rust/neogrid-app/src/commands.rs');

const EXPECTED = {
  file_save: ['title', 'defaultName', 'filters', 'content'],
  net_fetch_text: ['url', 'headers', 'body', 'timeoutMs'],
  file_reveal: ['path'],
  app_info: [],
  auth_request: ['method', 'url', 'path', 'body', 'apikey', 'token'],
  update_check: [],
  update_install: [],
  window_overlay_theme: ['theme'],
  app_open_external: ['url'],
  project_status: [],
  project_write_autosave: ['bufferB64', 'meta'],
  project_read_autosave: [],
  project_clear_autosave: [],
  project_save_as: ['bufferB64', 'suggestedName'],
  project_open_file: [],
  db_open_dialog: [],
  db_open: ['path'],
  db_info: [],
  db_close: [],
  db_query: ['channel', 'payload'],
  db_pick_folder: [],
  db_pick_output: ['suggestedName'],
  db_build_start: ['payload'],
  db_build_cancel: [],
  db_build_busy: [],
  db_pick_zip: [],
  db_area: ['payload'],
  db_sql: ['query', 'max'],
  ws_get: ['key'],
  ws_put: ['key', 'value'],
  ws_delete_prefix: ['prefix'],
  ws_stats: ['prefix'],
  pack_pick: ['mode', 'suggestedName'],
  pack_write: ['path', 'mode', 'files'],
  ruas_pack_status: [],
  ruas_pack_tile: ['key'],
  ruas_pack_import: [],
  ruas_pack_export: [],
  ruas_pack_download: [],
  ruas_pack_cancel: [],
};

let fails = 0;
// comandos registrados no generate_handler!
const registered = [...backend.matchAll(/commands::(\w+)/g)].map((m) => m[1]);
const inMain = read('rust/neogrid-app/src/main.rs');
function sentArgs(cmd) {
  const tag = `invoke('${cmd}'`;
  const at = adapter.indexOf(tag);
  if (at < 0) return null;
  let i = at + tag.length;
  while (i < adapter.length && /[\s,)]/.test(adapter[i]) && adapter[i] !== '{') {
    if (adapter[i] === ')') return []; // sem args
    i++;
  }
  if (adapter[i] !== '{') return [];
  let depth = 0;
  let j = i;
  for (; j < adapter.length; j++) {
    if (adapter[j] === '{') depth++;
    else if (adapter[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = adapter.slice(i, j + 1);
  // chaves de primeiro nivel: remove blocos aninhados
  let flat = '';
  let d = 0;
  for (const ch of body) {
    if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') d--;
    else if (d === 1) flat += ch;
  }
  const keys = new Set();
  for (const m of flat.matchAll(/(?:^|[{,])\s*(\w+)\s*:/g)) keys.add(m[1]);
  for (const m of flat.matchAll(/(?:^|[{,])\s*(\w+)\s*(?=[,}])/g)) {
    if (!['null', 'true', 'false'].includes(m[1])) keys.add(m[1]);
  }
  return [...keys];
}

for (const [cmd, args] of Object.entries(EXPECTED)) {
  if (!new RegExp(`pub (?:async )?fn ${cmd}\\b`).test(backend)) {
    console.log(`FAIL fn ausente: ${cmd}`);
    fails++;
    continue;
  }
  if (!inMain.includes(`commands::${cmd}`)) {
    console.log(`FAIL nao registrado no handler: ${cmd}`);
    fails++;
    continue;
  }
  const sent = sentArgs(cmd);
  if (sent === null) {
    console.log(`FAIL adapter nao invoca: ${cmd}`);
    fails++;
    continue;
  }
  const missing = args.filter((a) => !sent.includes(a));
  const extra = sent.filter((s) => !args.includes(s) && s !== '__proto__');
  if (missing.length || extra.length) {
    console.log(`FAIL ${cmd}: faltando [${missing}] sobrando [${extra}]`);
    fails++;
  } else {
    console.log(`ok   ${cmd}(${args.join(', ')})`);
  }
}
// todos os invokes do adapter sao conhecidos?
for (const m of adapter.matchAll(/invoke\('([^']+)'/g)) {
  if (!EXPECTED[m[1]]) {
    console.log(`FAIL invoke desconhecido no adapter: ${m[1]}`);
    fails++;
  }
}
console.log(fails ? `\n${fails} FALHAS` : '\nCONTRATO OK');

// Auditoria tripla do ACL: handler == AppManifest == capability allows.
const mainRs = read('rust/neogrid-app/src/main.rs');
const buildRs = read('rust/neogrid-app/build.rs');
const cap = JSON.parse(read('rust/neogrid-app/capabilities/default.json'));
// Só o bloco do `generate_handler![]` conta como command registrado
// (o `main.rs` também chama funções internas como `commands::migrate_*`).
const handlerBlocks = [...mainRs.matchAll(/generate_handler!\[([\s\S]*?)\]/g)].map((m) => m[1]);
const handlerCmds = [
  ...new Set(handlerBlocks.flatMap((b) => [...b.matchAll(/commands::(\w+)/g)].map((m) => m[1]))),
];
const manifestBlock = buildRs.slice(buildRs.indexOf('.commands(&['));
const manifestCmds = [...manifestBlock.slice(0, manifestBlock.indexOf('])')).matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
const allowCmds = (cap.permissions || [])
  .filter((p) => p.startsWith('allow-') && !p.includes(':'))
  .map((p) => p.slice('allow-'.length).replace(/-/g, '_'));
const onlyHandler = handlerCmds.filter((c) => !manifestCmds.includes(c));
const onlyManifest = manifestCmds.filter((c) => !handlerCmds.includes(c));
const onlyAllow = allowCmds.filter((c) => !handlerCmds.includes(c));
const missingAllow = handlerCmds.filter((c) => !allowCmds.includes(c));
for (const c of onlyHandler) {
  console.log(`FAIL no AppManifest: ${c}`);
  fails++;
}
for (const c of onlyManifest) {
  console.log(`FAIL no handler: ${c}`);
  fails++;
}
for (const c of onlyAllow) {
  console.log(`FAIL allow sobrando: ${c}`);
  fails++;
}
for (const c of missingAllow) {
  console.log(`FAIL sem allow: ${c}`);
  fails++;
}
if (!onlyHandler.length && !onlyManifest.length && !onlyAllow.length && !missingAllow.length) {
  console.log(`ACL OK (${handlerCmds.length} commands nas 3 listas)`);
}
if (!cap.remote?.urls?.some((u) => u.includes('localhost'))) {
  console.log('FAIL capability sem remote.urls para localhost');
  fails++;
} else {
  console.log('ok   remote.urls localhost (porta efêmera)');
}
console.log(fails ? `\n${fails} FALHAS TOTAIS` : '\nTUDO OK (contrato + ACL)');
process.exit(fails ? 1 : 0);
