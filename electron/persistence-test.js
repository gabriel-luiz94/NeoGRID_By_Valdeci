'use strict';

/* Teste de round-trip da persistência:
   importar CSVs → salvar snapshot → limpar memória → restaurar do disco →
   comparar contagens e amostragem de células. Também exercita a abertura
   de um buffer .neogrid via openFileObject (caminho do arrastar-e-soltar). */

const { buildSampleData } = require('./sample-data.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`[persist-test] PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`[persist-test] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  win.webContents.on('console-message', (_event, ...args) => {
    let level;
    let message;
    if (args[0] && typeof args[0] === 'object') {
      ({ level, message } = args[0]);
    } else {
      [level, message] = args;
    }
    if (typeof level === 'number' ? level >= 1 : true) console.log(`[renderer] ${message}`);
  });
  console.log('[persist-test] aguardando boot do app…');

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await wait(250);
    try {
      ready = await js('window.__neo && window.__neo.ready === true');
    } catch {
      ready = false;
    }
    if (ready) break;
  }
  if (!ready) {
    console.error('[persist-test] app não inicializou');
    process.exitCode = 1;
    win.destroy();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  try {
    // Desliga o autosave para o teste ser determinístico.
    await js('window.__neo.settings.autosave = false');

    const sample = buildSampleData();
    await js(`(async () => {
      await window.__neo.importFiles([
        new File([${JSON.stringify(sample.postes)}], 'postes.csv', { type: 'text/csv' }),
        new File([${JSON.stringify(sample.redeBt)}], 'rede_bt.csv', { type: 'text/csv' }),
        new File([${JSON.stringify(sample.redeMt)}], 'rede_mt.csv', { type: 'text/csv' }),
        new File([${JSON.stringify(sample.instalacoes)}], 'instalacoes.csv', { type: 'text/csv' })
      ]);
      return true;
    })()`);

    const fingerprint = await js(`(() => {
      const out = {};
      for (const type of ['poste', 'bt', 'mt', 'inst']) {
        const store = window.__neo.library.get(type);
        if (!store) { out[type] = null; continue; }
        const n = store.stats.count;
        const pick = (i) => (i >= 0 && i < n ? store.rows[i].join('|') : null);
        out[type] = { n, first: pick(0), mid: pick(n >> 1), last: pick(n - 1), headers: store.headers.join(',') };
      }
      out.imports = window.__neo.library.importHistory.length;
      return JSON.stringify(out);
    })()`);
    const before = JSON.parse(fingerprint);
    console.log('[persist-test] fingerprint antes:', fingerprint);
    check('importação tem 4 camadas com linhas', ['poste', 'bt', 'mt', 'inst'].every((t) => before[t] && before[t].n > 0));

    // 1) Salvar snapshot.
    const saved = await js(`window.__neo.persistence.saveNow({ silent: true })`);
    check('saveNow salvou', saved?.saved === true, JSON.stringify(saved));

    const status = await js(`window.desktop.projectStatus()`);
    check('status mostra arquivo em disco', status?.file?.exists === true, `${status?.file?.size} bytes`);
    const meta = status?.meta || {};
    console.log('[persist-test] meta:', JSON.stringify(meta));
    check('meta tem rawBytes e compressedBytes', meta.rawBytes > 0 && meta.compressedBytes > 0);
    const ratio = 1 - meta.compressedBytes / meta.rawBytes;
    console.log(`[persist-test] taxa de compressão: ${(ratio * 100).toFixed(1)}% (${meta.rawBytes} → ${meta.compressedBytes} bytes)`);
    check('snapshot comprimido é menor que o JSON', meta.compressedBytes < meta.rawBytes);

    // 2) Limpar memória e restaurar do disco (autoload).
    await js(`window.__neo.library.clear()`);
    const empty = await js(`JSON.stringify(window.__neo.getSummary())`);
    check('memória limpa', JSON.parse(empty).totalRows === 0);

    const loaded = await js(`window.__neo.persistence.autoload()`);
    check('autoload restaurou', loaded?.loaded === true, JSON.stringify(loaded));

    const after = JSON.parse(await js(`(() => {
      const out = {};
      for (const type of ['poste', 'bt', 'mt', 'inst']) {
        const store = window.__neo.library.get(type);
        if (!store) { out[type] = null; continue; }
        const n = store.stats.count;
        const pick = (i) => (i >= 0 && i < n ? store.rows[i].join('|') : null);
        out[type] = { n, first: pick(0), mid: pick(n >> 1), last: pick(n - 1), headers: store.headers.join(',') };
      }
      out.imports = window.__neo.library.importHistory.length;
      return JSON.stringify(out);
    })()`));
    check('round-trip preserva contagens e células', JSON.stringify(after) === JSON.stringify(before));

    // 3) Caminho do arquivo .neogrid (openFileObject, como no drag-and-drop).
    const disk = await js(`window.desktop.projectReadAutosave()`);
    check('leitura do snapshot do disco', disk?.found === true);
    console.log('[persist-test] renderer disk bytes:', await js(`(async () => { const r = await window.desktop.projectReadAutosave(); return JSON.stringify({ found: r.found, length: r.buffer?.byteLength, first: r.buffer ? Array.from(new Uint8Array(r.buffer.slice(0, 4))) : null }); })()`));
    console.log('[persist-test] disk buffer shape:', JSON.stringify({
      constructor: disk?.buffer?.constructor?.name,
      isUint8: disk?.buffer instanceof Uint8Array,
      isArray: Array.isArray(disk?.buffer),
      keys: disk?.buffer && typeof disk.buffer === 'object' ? Object.keys(disk.buffer).slice(0, 5) : [],
      first: disk?.buffer instanceof Uint8Array ? Array.from(disk.buffer.slice(0, 4)) : disk?.buffer?.data?.slice?.(0, 4),
    }));
    await js(`window.__neo.library.clear()`);
    const opened = await js(`(async () => {
      const bytes = new Uint8Array(${JSON.stringify(Array.from(new Uint8Array(0)))});
      void bytes;
      const { buffer } = await window.desktop.projectReadAutosave();
      const file = new File([buffer], 'backup.neogrid', { type: 'application/octet-stream' });
      return window.__neo.persistence.openFileObject(file);
    })()`);
    check('openFileObject (.neogrid) restaurou', opened?.opened === true, JSON.stringify({ rows: opened?.rows }));
    const final = JSON.parse(await js(`JSON.stringify(window.__neo.getSummary())`));
    check('contagem final igual à original', final.totalRows === JSON.parse(fingerprint).poste.n + JSON.parse(fingerprint).bt.n + JSON.parse(fingerprint).mt.n + JSON.parse(fingerprint).inst.n, `${final.totalRows} registros`);

    // 4) Busca e geometria continuam funcionais após restore.
    const probe = await js(`(() => {
      const store = window.__neo.library.get('poste');
      const idIdx = store.colIndex('NU_PG_ID');
      const found = window.__neo.library.findById(store.rows[0][idIdx]);
      const geom = store.getGeometry(0);
      return JSON.stringify({ found: !!found, geomLen: geom.length });
    })()`);
    check('índices e geometria funcionais após restore', JSON.parse(probe).found === true);
  } catch (error) {
    failures += 1;
    console.error('[persist-test] erro inesperado:', error);
  }

  console.log(failures ? `[persist-test] FALHOU (${failures})` : '[persist-test] TODOS OS TESTES PASSARAM');
  win.destroy();
  setTimeout(() => process.exit(failures ? 1 : 0), 400);
}

module.exports = run;
