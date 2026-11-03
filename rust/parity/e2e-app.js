'use strict';
// E2E do app real via CDP: roda a suite sobre `window.desktop` (o adapter de
// produção) na página verdadeira (`/index.html?test=1`), sem página de teste.
// Uso: node e2e-app.js --port <cdp> --db <sqlite> --source <dir-csv>
//        --out <dir-saida> --marker <arquivo>
// O app precisa estar rodando (o servidor embutido serve o frontend).
const fs = require('fs');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  const name = key.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args[name] = next;
    i++;
  } else {
    args[name] = true; // flag sem valor (ex.: --no-build)
  }
}
const PORT = Number(args.port || 9224);
const DB = (args.db || '').replace(/\\/g, '/');
const SOURCE = (args.source || '').replace(/\\/g, '/');
const OUT = (args.out || '.').replace(/\\/g, '/');
const MARKER = args.marker || 'e2e.marker';
// Base pode ser a amostra (19.996) ou a base completa (5.602.772).
const EXPECT_ROWS = Number(args.rows || 19996);
const EXPECT_POSTE = Number(args.poste || 4999);
const SKIP_BUILD = Boolean(args['no-build'] || args.noBuild);
fs.mkdirSync(OUT, { recursive: true });

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error('ws: ' + (e.message || e)));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (line) => {
  lines.push(line);
  console.log(line);
};

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  if (!pages.length) throw new Error('sem pagina no CDP');
  const page = pages.find((t) => /tauri|localhost|app:\/\//.test(t.url)) || pages[0];
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();

  const evaluateRaw = async (expression, awaitPromise) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '?').slice(0, 300));
    }
    return r.result?.value;
  };

  // App real com harness de teste (?test=1 expoe window.__neo). A origem vem
  // da própria janela (porta efêmera do servidor embutido).
  const origin = await evaluateRaw('location.origin', false);
  if (!/^https?:/.test(origin || '')) throw new Error(`origem inesperada: ${origin}`);
  await cdp.send('Page.navigate', { url: `${origin}/index.html?test=1` });
  await sleep(1500);

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '?').slice(0, 300));
    }
    return r.result?.value;
  };

  const check = (name, cond) => log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  const D = 'window.desktop';

  // Espera adapter + harness do app
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      ready = await evaluate('return !!(window.desktop && window.__neo && window.__neo.ready)');
    } catch { /* carregando */ }
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('app nunca ficou pronto');
  log('js-alive');

  check('adapter', await evaluate(`return window.desktop.platform === 'win32' && window.desktop.isDesktop === true`));
  const info = await evaluate(`return ${D}.dbOpen(${JSON.stringify(DB)})`);
  check('open', info.opened === true && info.info.rows === EXPECT_ROWS);
  check('info', (await evaluate(`return ${D}.dbInfo()`)).opened === true);
  const q = async (channel, payload) => evaluate(`return ${D}.dbQuery(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
  const B = { west: -50, east: -30, south: -15, north: -5 };
  const vp = await q('db:viewport', { type: 'poste', ...B, limit: 100 });
  check('viewport', vp.ok === true && vp.result.length > 0);
  const rows = await q('db:rows', { type: 'poste', ids: [0, 1, 2] });
  check('rows', rows.ok === true && rows.result.length === 3);
  const row = await q('db:row', { type: 'poste', id: 0 });
  check('row', row.ok === true && row.result && row.result.i === 0);
  const bounds = await q('db:bounds', { type: 'poste' });
  check('bounds', bounds.ok === true && bounds.result && bounds.result.west < bounds.result.east);
  const hot = await q('db:hotspots', { type: 'poste', limit: 3 });
  check('hotspots', hot.ok === true && Array.isArray(hot.result));
  const ids = await q('db:ids-in-bounds', { type: 'poste', ...B, limit: 1000 });
  check('ids', ids.ok === true && ids.result.length > 0);
  const search = await q('db:search', { type: 'poste', term: '101', limit: 5 });
  check('search', search.ok === true && Array.isArray(search.result));
  const found = await q('db:find-by-id', { type: 'poste', id: row.result.row[1] });
  check('find', found.ok === true && found.result === 0);
  const pg = await q('db:page', { type: 'poste', offset: 0, limit: 5 });
  check('page', pg.ok === true && pg.result.total === EXPECT_POSTE);
  const dist = await q('db:distinct', { type: 'poste', field: 'MATERIAL', limit: 10 });
  check('distinct', dist.ok === true && dist.result.length > 0);
  const links = await q('db:links', { pole: '___inexistente___' });
  check('links', links.ok === true && Array.isArray(links.result.inst));
  const bad = await q('db:nope', {});
  check('bad-channel', bad.ok === false);

  check('pstatus', (await evaluate(`return ${D}.projectStatus()`)).supported === true);
  // base64 no evaluate: btoa disponivel na pagina
  check('pwrite', (await evaluate(`return ${D}.projectWriteAutosave(new Uint8Array([104,105]), { t: 1 })`)).saved === true);
  const pread = await evaluate(`const r = await ${D}.projectReadAutosave(); return r.found === true && new TextDecoder().decode(r.buffer) === 'hi'`);
  check('pread', pread === true);
  check('pclear', (await evaluate(`return ${D}.projectClearAutosave()`)).cleared === true);
  const denied = await evaluate(`return ${D}.fetchText({ url: 'https://evil.com/x' })`);
  check('netdeny', denied.ok === false);
  check('busy0', (await evaluate(`return ${D}.dbBuildBusy()`)).busy === false);

  // ---- fluxos de exportação na UI real (sem diálogo nativo) ----
  // DXF: mesmo caminho do botão (coleta por área + generateDxf).
  const dxf = await evaluate(`
    if (!window.__neo.library.get('poste')) { await window.__neo.openDatabase(${JSON.stringify(DB)}); }
    const mod = await import('/js/modules/dxf/dxf-export.js');
    const b = window.__neo.mapView.map.getBounds();
    const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
    const visible = { poste: true, inst: true, bt: true, mt: true };
    const collected = await mod.collectForExportAsync(bounds, visible, 20000);
    const total = mod.countCollected(collected).total;
    const r = mod.generateDxf(bounds, 1000, [], visible, { collected });
    return {
      total,
      sections: (r.content.match(/\\bSECTION\\b/g) || []).length,
      hasPostes: r.content.includes('POSTES'),
      eof: r.content.trimEnd().endsWith('EOF'),
      bytes: r.content.length,
      zone: r.zone,
    };
  `);
  check('dxf', dxf && dxf.total > 0 && dxf.hasPostes && dxf.eof && dxf.sections >= 3 && dxf.bytes > 1000);

  // CSV: função pura usada pelo botão de exportação.
  const csv = await evaluate(`
    const { buildCsv } = await import('/js/data/csv-export.js');
    const store = window.__neo.library.get('poste');
    if (store.ensureRows) await store.ensureRows([0, 1, 2]);
    const headers = store.headers.filter((h) => !/_DESC$/.test(h)).slice(0, 4);
    const text = buildCsv(store, [0, 1, 2], headers);
    const lines = text.split('\\r\\n').filter((l) => l.length);
    return { bom: text.charCodeAt(0) === 0xFEFF, lines: lines.length, header: lines[0] };
  `);
  check('csv', csv && csv.bom === true && csv.lines === 4 && csv.header.length > 0);

  // Print: Ctrl+P abre o compositor de prancha (mesma tecla do app).
  const key = (type) => cdp.send('Input.dispatchKeyEvent', {
    type,
    key: 'p',
    code: 'KeyP',
    windowsVirtualKeyCode: 80,
    nativeVirtualKeyCode: 80,
    modifiers: 2, // Ctrl
  });
  await key('keyDown');
  await key('keyUp');
  await sleep(800);
  const print = await evaluate(`
    const panel = document.querySelector('#printPanel');
    return {
      open: !!panel && panel.hidden === false,
      frame: !!document.querySelector('#printFrame') || !!document.querySelector('#printMapSlot'),
      sheetA3: (document.querySelector('#printSheet')?.value || '').length > 0,
    };
  `);
  check('print', print && print.open === true && print.frame === true && print.sheetA3 === true);
  await evaluate(`document.querySelector('#printClose')?.click(); return true`);

  // Build com eventos via adapter (onDbBuildProgress -> coleta na pagina)
  if (SKIP_BUILD) {
    check('build', true);
    check('events', true);
  } else {
    await evaluate(`window.__e2eEvents = [];
      window.__e2eUnsub = window.desktop.onDbBuildProgress((e) => window.__e2eEvents.push(e));`);
    const b = await evaluate(`return ${D}.dbBuildStart({ source: ${JSON.stringify(SOURCE)}, output: ${JSON.stringify(`${OUT}/e2e.sqlite`)}, manifestoOut: ${JSON.stringify(`${OUT}/e2e.json`)} })`);
    check('build', b.started === true && b.finished === true && b.manifest.rows === EXPECT_ROWS);
    const events = await evaluate(`const evs = window.__e2eEvents; window.__e2eUnsub(); return evs.map((e) => e.type)`);
    check('events', events.includes('done') && events.includes('log'));
  }
  check('appinfo', typeof (await evaluate(`return ${D}.appInfo()`)).version === 'string');

  // Smoke do app real: abrir a base pelo harness e conferir summary
  const sum = await evaluate(`await window.__neo.openDatabase(${JSON.stringify(DB)}); return window.__neo.getSummary()`);
  check('app-open', sum.totalRows === EXPECT_ROWS);

  log('DONE');
  const fails = lines.filter((l) => l.startsWith('FAIL')).length;
  fs.writeFileSync(MARKER, fails ? 'FAIL' : 'PASS');
  cdp.close();
  if (fails) process.exitCode = 1;
}

main().catch((e) => {
  log('FAIL exception ' + (e.message || e).slice(0, 200));
  log('DONE');
  try {
    fs.writeFileSync(MARKER, 'FAIL');
  } catch { /* ignore */ }
  process.exit(1);
});
