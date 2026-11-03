'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const memorySnapshot = () => {
  try {
    const metrics = app.getAppMetrics() || [];
    let total = 0;
    let renderer = 0;
    for (const metric of metrics) {
      const kb = Number(metric.memory?.workingSetSize) || 0;
      total += kb;
      if (metric.type === 'Tab' || metric.type === 'Renderer') renderer += kb;
    }
    return {
      totalMB: Math.round(total / 1024),
      rendererMB: Math.round(renderer / 1024),
      processes: metrics.length,
    };
  } catch (error) {
    return { error: error.message };
  }
};

const { buildSampleData } = require('./sample-data.js');

async function runImportTest(win, js) {
  const dir = process.env.NEOGRID_IMPORT_DIR || 'D:\\projetos\\BASE-NEOENERGIA PE\\BASE EXPORTADA COMPLETA\\REGIONAL_2_METROPOLITANA_CENTRO';
  const files = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.csv$/i.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  if (!files.length) {
    console.error('[import-test] nenhum CSV em', dir);
    win.destroy();
    process.exit(1);
  }
  console.log('[import-test] dir', dir);
  console.log('[import-test] files', files.map((file) => `${path.basename(file)} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`).join(', '));

  await js(`document.querySelector('#topImport').click()`);
  await wait(700);
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  await dbg.sendCommand('DOM.enable');
  const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
  const node = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#importInput' });
  if (!node?.nodeId) throw new Error('input de importação não encontrado');
  await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
  await js(`document.querySelector('#importInput').dispatchEvent(new Event('change', { bubbles: true }))`);
  await wait(1500);
  const entries = await js(`document.querySelectorAll('#importFiles .import-file').length`);
  console.log('[import-test] entries', entries);
  if (!entries) {
    console.error('[import-test] nenhum arquivo entrou no diálogo');
    win.destroy();
    process.exit(1);
  }

  const started = Date.now();
  await js(`document.querySelector('#importStart').click()`);
  let lastSummary = '';
  let done = false;
  for (let tick = 0; tick < 90; tick++) {
    await wait(2000);
    let memory = null;
    try {
      memory = memorySnapshot();
    } catch {
      memory = null;
    }
    let summary = '';
    let foot = '';
    let dialogOpen = false;
    let confirmOpen = false;
    let confirmText = '';
    try {
      summary = await js(`JSON.stringify(window.__neo.getSummary())`);
      foot = await js(`document.querySelector('#importFootInfo')?.textContent || ''`);
      dialogOpen = await js(`Boolean(document.querySelector('#importDialog')?.open)`);
      confirmOpen = await js(`Boolean(document.querySelector('#confirmDialog')?.open)`);
      if (confirmOpen) confirmText = await js(`document.querySelector('#confirmText')?.textContent || ''`);
    } catch (error) {
      console.error('[import-test] renderer indisponível', error.message);
      break;
    }
    if (confirmOpen) {
      console.log('[import-test] confirm', confirmText);
      try {
        await js(`document.querySelector('#confirmDialog [data-close]')?.click()`);
      } catch {
        /* ignore */
      }
      break;
    }
    if (summary !== lastSummary) {
      console.log('[import-test] summary', summary);
      lastSummary = summary;
    }
    console.log('[import-test]', {
      seconds: Math.round((Date.now() - started) / 1000),
      dialogOpen,
      foot,
      totalMB: memory?.totalMB ?? null,
      rendererMB: memory?.rendererMB ?? null,
    });
    if (!dialogOpen) {
      done = true;
      break;
    }
    if (memory && memory.totalMB > 5200) {
      console.warn('[import-test] limite de memória de teste atingido');
      break;
    }
  }
  console.log('[import-test] finished', { done, seconds: Math.round((Date.now() - started) / 1000) });
  await wait(2500);
  const saveStarted = Date.now();
  try {
    const saveResult = await js(`window.__neo.persistence.saveNow({ silent: false, reason: 'import-test' }).then((result) => JSON.stringify(result))`);
    console.log('[import-test] save', { seconds: Math.round((Date.now() - saveStarted) / 1000), result: saveResult, memory: memorySnapshot() });
  } catch (error) {
    console.error('[import-test] save falhou', error.message);
  }
  await wait(3000);
  try {
    console.log('[import-test] post-import', await js(`JSON.stringify({
      summary: window.__neo.getSummary(),
      labels: document.querySelector('#statusText')?.textContent,
      stats: window.__neo.mapView.renderer.lastStats
    })`));
    const memory = memorySnapshot();
    console.log('[import-test] post-import memory', memory);
  } catch (error) {
    console.error('[import-test] post-import falhou', error.message);
  }
  win.destroy();
  process.exit(0);
}

async function runDbTest(win, js) {
  const dbPath = process.env.NEOGRID_DB || 'C:\\Users\\ORION\\AppData\\Local\\Temp\\neogrid-regional2.sqlite';
  console.log('[db-test] abrindo', dbPath);
  const opened = await js(`window.__neo.openDatabase(${JSON.stringify(dbPath)}).then((ok) => JSON.stringify({ ok }))`);
  console.log('[db-test] opened', opened);
  await wait(1500);
  console.log('[db-test] summary', await js('JSON.stringify(window.__neo.getSummary())'));
  console.log('[db-test] memory', memorySnapshot());

  // Navega até a concentração de dados e força um quadro.
  await js('window.__neo.mapView.fitData({ animate: false })');
  await wait(2500);
  console.log('[db-test] stats', await js('JSON.stringify(window.__neo.mapView.renderer.lastStats)'));
  const capture = async (name) => {
    await wait(400);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', 'screenshots', name), image.toPNG());
    console.log('[db-test]', name);
  };
  await capture('30-db-map.png');

  // Inspetor: primeiro poste da página 0.
  console.log('[db-test] inspector', await js(`(async () => {
    const { dbPage } = await import('/js/data/database-client.js');
    const page = await dbPage({ type: 'poste', offset: 0, limit: 1 });
    const rid = page.rows[0]?.i;
    await window.__neo.mapView.selectFeature('poste', rid);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return JSON.stringify({ rid, title: document.querySelector('#inspectorTitle')?.textContent });
  })()`));
  await capture('31-db-inspector.png');

  // Tabela removida da interface; o teste de banco valida via consultas diretas.
  console.log('[db-test] table', await js(`(async () => {
    const { dbPage } = await import('/js/data/database-client.js');
    const page = await dbPage({ type: 'poste', offset: 0, limit: 5 });
    return JSON.stringify({ total: page.total, rows: page.rows.length });
  })()`));
  await capture('32-db-table.png');

  // Busca por ID.
  console.log('[db-test] search', await js(`(async () => {
    const { default: _lib } = { default: null };
    const { library } = await import('/js/data/library.js');
    const results = await library.searchIdsAsync('10119896', 6);
    return JSON.stringify(results.map((r) => ({ type: r.type, index: r.index, id: r.id })));
  })()`));

  // DXF por área visível.
  console.log('[db-test] dxf', await js(`(async () => {
    const { generateDxf } = await import('/js/modules/dxf/dxf-export.js');
    const { collectForExportAsync } = await import('/js/modules/dxf/dxf-export.js');
    const b = window.__neo.mapView.map.getBounds();
    const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
    const collected = await collectForExportAsync(bounds, window.__neo.mapView.getVisibleLayers(), 50000);
    const result = generateDxf(bounds, 1000, [], window.__neo.mapView.getVisibleLayers(), { collected });
    return JSON.stringify({ counts: result.counts, total: result.total, bytes: result.content.length });
  })()`));

  console.log('[db-test] memory-final', memorySnapshot());
  win.destroy();
  process.exit(0);
}

async function runDbBuildTest(win, js) {
  const source = process.env.NEOGRID_BUILD_SOURCE;
  const output = process.env.NEOGRID_BUILD_OUTPUT;
  if (!source || !output) {
    console.error('[db-build-test] defina NEOGRID_BUILD_SOURCE e NEOGRID_BUILD_OUTPUT');
    win.destroy();
    process.exit(1);
  }
  console.log('[db-build-test] origem', source);
  console.log('[db-build-test] destino', output);
  await js(`document.querySelector('#topImport').click()`);
  await wait(600);
  await js(`document.querySelector('#importBuildDb').click()`);
  await wait(600);
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'screenshots', '33-db-build-dialog.png'), shot.toPNG());
  console.log('[db-build-test] 33-db-build-dialog.png');
  await js(`document.querySelector('#dbBuildDialog [data-close]').click()`);
  await js(`document.querySelector('#importCancel').click()`);
  await wait(300);
  const started = Date.now();
  const result = await js(`(async () => {
    const events = [];
    const off = window.desktop.onDbBuildProgress((event) => {
      events.push(event.type === 'log' ? event.message : event.type);
    });
    try {
      const res = await window.desktop.dbBuildStart({ source: ${JSON.stringify(source)}, output: ${JSON.stringify(output)}, rejectLimit: 0.7 });
      return JSON.stringify({ res, tail: events.slice(-8) });
    } finally {
      off();
    }
  })()`);
  console.log('[db-build-test] resultado', result, `em ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('[db-build-test] memory', memorySnapshot());
  win.destroy();
  process.exit(0);
}

async function runFeatureTest(win, js, capture) {
  const sample = buildSampleData();
  await js(`(async () => {
    await window.__neo.importFiles([
      new File([${JSON.stringify(sample.postes)}], 'postes.csv', { type: 'text/csv' }),
      new File([${JSON.stringify(sample.redeBt)}], 'rede_bt.csv', { type: 'text/csv' }),
      new File([${JSON.stringify(sample.redeMt)}], 'rede_mt.csv', { type: 'text/csv' }),
      new File([${JSON.stringify(sample.instalacoes)}], 'instalacoes.csv', { type: 'text/csv' })
    ]);
    return window.__neo.getSummary();
  })()`);
  await wait(1200);
  console.log('[feature-test] summary', await js('JSON.stringify(window.__neo.getSummary())'));

  const kmlText = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Teste NeoGrid</name>
    <Style id="azul"><LineStyle><color>ffff0000</color><width>3</width></LineStyle><PolyStyle><color>4d00ff00</color></PolyStyle><IconStyle><color>ff00ffff</color></IconStyle></Style>
    <Folder><name>Prancha 1</name>
      <Placemark><name>Ponto A</name><styleUrl>#azul</styleUrl><Point><coordinates>-34.9005,-8.0505,0</coordinates></Point></Placemark>
      <Placemark><name>Rua do Meio</name><styleUrl>#azul</styleUrl><LineString><coordinates>-34.9010,-8.0500,0 -34.8990,-8.0510,0 -34.8980,-8.0520,0</coordinates></LineString></Placemark>
      <Placemark><name>Area da SE</name><styleUrl>#azul</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>-34.9020,-8.0500,0 -34.8980,-8.0500,0 -34.8980,-8.0530,0 -34.9020,-8.0530,0 -34.9020,-8.0500,0</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>-34.9010,-8.0510,0 -34.8990,-8.0510,0 -34.8990,-8.0520,0 -34.9010,-8.0520,0 -34.9010,-8.0510,0</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
      <Placemark><name>Multi</name><MultiGeometry><Point><coordinates>-34.9000,-8.0490,0</coordinates></Point><LineString><coordinates>-34.9000,-8.0490,0 -34.8995,-8.0485,0</coordinates></LineString></MultiGeometry></Placemark>
      <Placemark><name>Modelo 3D</name><Model><Link><href>modelo.dae</href></Link></Model></Placemark>
    </Folder>
  </Document>
</kml>`;

  console.log('[feature-test] kml-parse', await js(`(async () => {
    const kml = await import('/js/modules/kml.js');
    const parsed = kml.parseKmlText(${JSON.stringify(kmlText)}, 'teste.kml');
    return JSON.stringify({ counts: parsed.counts, unsupported: parsed.unsupported, bounds: parsed.bounds, firstStyle: parsed.features[0]?.style });
  })()`));

  console.log('[feature-test] kml-import', await js(`(async () => {
    const file = new File([${JSON.stringify(kmlText)}], 'teste.kml', { type: 'application/vnd.google-earth.kml+xml' });
    await window.__neo.kml.importFiles([file]);
    const data = window.__neo.kml.getExportData();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return JSON.stringify({
      hasData: window.__neo.kml.hasData(),
      features: data.features.length,
      kinds: data.features.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc; }, {}),
      pane: Boolean(window.__neo.mapView.map.getPane('kmlPane')),
      paneChildren: window.__neo.mapView.map.getPane('kmlPane')?.children.length || 0,
    });
  })()`));
  await wait(600);
  await js(`window.__neo.setView('map')`);
  await wait(300);
  await capture('40-kml-map.png');
  await js(`document.querySelector('#kmlDialog').showModal()`);
  await wait(400);
  await capture('41-kml-dialog.png');
  await js(`document.querySelector('#kmlDialog').close()`);
  await wait(200);

  console.log('[feature-test] anchor-math', await js(`(async () => {
    const s = await import('/js/modules/dxf/dxf-settings.js');
    const dxf = '0\\nSECTION\\n2\\nBLOCKS\\n0\\nBLOCK\\n8\\n0\\n2\\nPOSTE_TESTE\\n70\\n0\\n10\\n0\\n20\\n0\\n30\\n0\\n0\\nLINE\\n8\\n0\\n62\\n1\\n10\\n-2\\n20\\n-5\\n30\\n0\\n11\\n2\\n21\\n5\\n31\\n0\\n0\\nENDBLK\\n0\\nENDSEC\\n0\\nEOF\\n';
    const parsed = s.parseDxfBlocks(dxf);
    const block = parsed[0];
    return JSON.stringify({
      bounds: block.bounds,
      base: block.base,
      bottom0: s.blockInsertionPoint(block, 'bottom', [100, 200], 0),
      center0: s.blockInsertionPoint(block, 'center', [100, 200], 0),
      bottom90: s.blockInsertionPoint(block, 'bottom', [100, 200], 90),
      blockColor: s.blockColorIndex({ blockColors: { poste: 7 } }, 'poste', 7),
    });
  })()`));

  console.log('[feature-test] dxf-block-style', await js(`(async () => {
    const s = await import('/js/modules/dxf/dxf-settings.js');
    const { generateDxf } = await import('/js/modules/dxf/dxf-export.js');
    const dxf = '0\\nSECTION\\n2\\nBLOCKS\\n0\\nBLOCK\\n8\\n0\\n2\\nPOSTE_TESTE\\n70\\n0\\n10\\n0\\n20\\n0\\n30\\n0\\n0\\nLINE\\n8\\n0\\n62\\n1\\n10\\n-2\\n20\\n-5\\n30\\n0\\n11\\n2\\n21\\n5\\n31\\n0\\n0\\nENDBLK\\n0\\nENDSEC\\n0\\nEOF\\n';
    const settings = s.loadDxfSettings();
    settings.blocks.poste = 'POSTE_TESTE';
    settings.typeBlocks = { poste: {}, inst: {} };
    settings.blockRules = { poste: [], inst: [] };
    settings.uniformBlockColors = true;
    const b = window.__neo.mapView.map.getBounds();
    const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
    const result = generateDxf(bounds, 1000, [], window.__neo.mapView.getVisibleLayers(), { settings, libraryText: dxf });
    const insert = result.content.match(/INSERT[\\s\\S]{0,80}/);
    const blockSection = result.content.split('BLOCKS')[2] || '';
    return JSON.stringify({
      inserts: (result.content.match(/INSERT/g) || []).length,
      insertColor: /INSERT\\n8\\nPOSTES\\n62\\n7/.test(result.content),
      byBlock: /LINE\\n62\\n0/.test(result.content),
      hasOriginalColor: /LINE\\n62\\n1/.test(result.content),
      firstInsert: insert ? insert[0].replace(/\\n/g, '|') : '',
    });
  })()`));

  let streetsResult = { skipped: true };
  if (!process.argv.includes('--no-network')) {
    streetsResult = await js(`(async () => {
      window.__neo.mapView.map.setView([-8.0505, -34.9005], 17, { animate: false });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await window.__neo.streets.startVisible();
      await new Promise((resolve) => setTimeout(resolve, 6500));
      const streets = window.__neo.streets.get();
      return JSON.stringify({ count: streets.length, named: streets.filter((s) => s.nome).length, hasData: window.__neo.streets.hasData() });
    })()`);
  }
  console.log('[feature-test] streets', streetsResult);
  await wait(500);
  await js(`window.__neo.streets.open()`);
  await wait(500);
  await capture('42-streets-dock.png');

  console.log('[feature-test] dxf-with-streets-kml', await js(`(async () => {
    const { generateDxf } = await import('/js/modules/dxf/dxf-export.js');
    const b = window.__neo.mapView.map.getBounds();
    const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
    const streets = window.__neo.streets.getForBounds(bounds);
    const kml = window.__neo.kml.getExportData();
    const result = generateDxf(bounds, 1000, streets, window.__neo.mapView.getVisibleLayers(), { kml });
    return JSON.stringify({ counts: result.counts, bytes: result.content.length, kmlLayers: ['KML_PONTOS','KML_LINHAS','KML_AREAS','TXT_KML'].filter((name) => result.content.includes(name)) });
  })()`));

  await js(`document.querySelector('#dxfSettingsDialog').showModal()`);
  await wait(400);
  await capture('43-dxf-settings-share.png');

  console.log('[feature-test] settings-share', await js(`(async () => {
    const ui = await import('/js/modules/dxf/dxf-settings-ui.js');
    const s = await import('/js/modules/dxf/dxf-settings.js');
    const cfg = s.loadDxfSettings();
    cfg.blocks.poste = 'POSTE_TESTE';
    cfg.blockRules = { poste: [{ id: 'r1', name: 'Regra R', enabled: true, match: 'all', block: 'POSTE_TESTE', conditions: [{ field: 'MATERIAL', operator: 'contains', value: 'CONCRETO' }] }], inst: [] };
    cfg.blockColors = { poste: 7, inst: 0 };
    cfg.blockAnchor = { poste: 'bottom', inst: 'base' };
    cfg.blockSize = 33;
    const payload = ui.buildSettingsPayload(cfg);
    const text = JSON.stringify(payload);
    const file = new File([text], 'neogrid_blocos_teste.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#dxfSettingsImportFile');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const back = s.loadDxfSettings();
    const result = {
      kind: payload.kind,
      version: payload.version,
      bytes: text.length,
      hasLibrary: typeof payload.library?.text === 'string',
      settingsKeys: Object.keys(payload.settings || {}).sort(),
      rulesBack: (back.blockRules?.poste || []).length,
      blockBack: back.blocks?.poste,
      anchorBack: back.blockAnchor?.poste,
      colorBack: back.blockColors?.poste,
      sizeBack: back.blockSize,
      dialogSize: document.querySelector('#dxfBlockSize')?.value,
    };
    document.querySelector('#dxfSettingsDialog').close();
    s.resetDxfSettings();
    return JSON.stringify(result);
  })()`));

  await js(`localStorage.removeItem('neogrid.streets.v1'); localStorage.removeItem('neogrid.kml.v1'); true`);
  win.destroy();
  process.exit(0);
}

async function run(win, { root }) {
  const outDir = path.join(root, 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const skipNetwork = process.argv.includes('--no-network');
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, ...args) => {
    let level;
    let message;
    let line;
    let source;
    if (args[0] && typeof args[0] === 'object') {
      ({ level, message, lineNumber: line, sourceId: source } = args[0]);
    } else {
      [level, message, line, source] = args;
    }
    const severity = typeof level === 'number' ? level : (level === 'error' ? 3 : level === 'warning' ? 2 : 0);
    if (severity >= 2) {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
      consoleErrors.push(message);
    }
  });
  win.setSize(1600, 1000);

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const capture = async (name) => {
    await wait(500);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), image.toPNG());
    console.log('[screenshot]', name);
  };

  // Wait for the app boot.
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
    console.error('[screenshot] app não inicializou');
    await capture('00-error.png');
    setTimeout(() => win.app?.quit?.(), 500);
    return;
  }

  if (process.argv.includes('--db-test')) {
    await wait(700);
    await runDbTest(win, js);
    return;
  }

  if (process.argv.includes('--feature-test')) {
    await wait(700);
    await runFeatureTest(win, js, capture);
    return;
  }

  if (process.argv.includes('--db-build-test')) {
    await wait(700);
    await runDbBuildTest(win, js);
    return;
  }

  if (process.argv.includes('--import-test')) {
    await wait(700);
    await runImportTest(win, js);
    return;
  }

  await wait(900);
  await capture('01-map-empty.png');

  const sample = buildSampleData();
  try {
    await js(`(async () => {
      await window.__neo.importFiles([
        new File([${JSON.stringify(sample.postes)}], 'postes.csv', { type: 'text/csv' }),
        new File([${JSON.stringify(sample.redeBt)}], 'rede_bt.csv', { type: 'text/csv' }),
        new File([${JSON.stringify(sample.redeMt)}], 'rede_mt.csv', { type: 'text/csv' }),
        new File([${JSON.stringify(sample.instalacoes)}], 'instalacoes.csv', { type: 'text/csv' })
      ]);
      return window.__neo.getSummary();
    })()`);
    await wait(1600);
    const summary = await js('JSON.stringify(window.__neo.getSummary())');
    console.log('[screenshot] summary', summary);
  } catch (error) {
    console.error('[screenshot] import failed', error);
    await capture('00-import-error.png');
  }

  await js(`window.__neo.setView('map')`);
  await wait(900);
  console.log('[screenshot] renderer', await js(`JSON.stringify({ settings: window.__neo.settings, stats: window.__neo.mapView.renderer.lastStats, zoom: window.__neo.mapView.map.getZoom() })`));
  await capture('02-map.png');

  console.log('[screenshot] dxf', await js(`(async () => {
    const { generateDxf } = await import('/js/modules/dxf/dxf-export.js');
    const b = window.__neo.mapView.map.getBounds();
    const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
    const result = generateDxf(bounds, 1000, [], window.__neo.mapView.getVisibleLayers());
    return JSON.stringify({ counts: result.counts, total: result.total, zone: result.zone, bytes: result.content.length, hasLayers: result.content.includes('REDE_BT') && result.content.includes('TXT_POSTES') });
  })()`));

  console.log('[screenshot] dxf-settings', await js(`(async () => {
    localStorage.removeItem('neogrid.dxfSettings.v1');
    const dxf = '0\\nSECTION\\n2\\nBLOCKS\\n0\\nBLOCK\\n8\\n0\\n2\\nPOSTE_TESTE\\n70\\n0\\n10\\n0\\n20\\n0\\n30\\n0\\n0\\nLINE\\n8\\n0\\n10\\n-1\\n20\\n-1\\n30\\n0\\n11\\n1\\n21\\n1\\n31\\n0\\n0\\nENDBLK\\n0\\nENDSEC\\n0\\nEOF\\n';
    const s = await import('/js/modules/dxf/dxf-settings.js');
    s.setDxfLibrary(dxf, 'teste.dxf');
    const settings = s.loadDxfSettings();
    settings.blocks.poste = 'POSTE_TESTE';
    settings.labels.poste = '{NU_PG_ID}';
    settings.colors.poste = 6;
    const { generateDxf } = await import('/js/modules/dxf/dxf-export.js');
    const b = window.__neo.mapView.map.getBounds();
    const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
    const result = generateDxf(bounds, 1000, [], window.__neo.mapView.getVisibleLayers(), { settings, libraryText: dxf });
    s.setDxfLibrary('', '');
    localStorage.removeItem('neogrid.dxfSettings.v1');
    return JSON.stringify({ hasInsert: result.content.includes('INSERT'), hasBlock: result.content.includes('POSTE_TESTE'), warnings: result.warnings });
  })()`));

  console.log('[screenshot] block-rules', await js(`(async () => {
    localStorage.removeItem('neogrid.dxfSettings.v1');
    const dxf = '0\\nSECTION\\n2\\nBLOCKS\\n0\\nBLOCK\\n8\\n0\\n2\\nPOSTE_TESTE\\n70\\n0\\n10\\n0\\n20\\n0\\n30\\n0\\n0\\nLINE\\n8\\n0\\n10\\n-1\\n20\\n-1\\n30\\n0\\n11\\n1\\n21\\n1\\n31\\n0\\n0\\nENDBLK\\n0\\nENDSEC\\n0\\nEOF\\n';
    const s = await import('/js/modules/dxf/dxf-settings.js');
    s.setDxfLibrary(dxf, 'teste.dxf');
    const settings = s.loadDxfSettings();
    settings.blocks = { poste: '', inst: '' };
    settings.typeBlocks = { poste: {}, inst: {} };
    settings.blockRules = {
      poste: [{
        id: 'regra_teste',
        name: 'DT em concreto',
        enabled: true,
        match: 'all',
        block: 'POSTE_TESTE',
        conditions: [
          { field: 'MATERIAL', operator: 'contains', value: 'CONCRETO' },
          { field: 'TIPO_PG', operator: 'equals', value: 'DT' },
        ],
      }],
      inst: [],
    };
    s.saveDxfSettings(settings);
    const { generateDxf } = await import('/js/modules/dxf/dxf-export.js');
    const b = window.__neo.mapView.map.getBounds();
    const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
    const result = generateDxf(bounds, 1000, [], window.__neo.mapView.getVisibleLayers(), { settings, libraryText: dxf });
    const inserted = (result.content.match(/2\\nPOSTE_TESTE/g) || []).length;
    s.setDxfLibrary('', '');
    localStorage.removeItem('neogrid.dxfSettings.v1');
    window.__neo.bus.emit('dxf:settings-changed');
    return JSON.stringify({ inserted, warnings: result.warnings });
  })()`));

  console.log('[screenshot] label-substitution', await js(`(async () => {
    const s = await import('/js/modules/dxf/dxf-settings.js');
    const st = window.__neo.library.get('mt');
    const cfg = s.loadDxfSettings();
    cfg.labels.mt = '{CONDUTORES}';
    cfg.substitutions = { rules: [{
      id: 'sub_teste', enabled: true, scope: 'mt', field: '__label__',
      operator: 'contains', pattern: 'AL', replacement: 'CABO', action: 'text',
    }] };
    const context = s.templateContext(st, st.rows[0], 'mt', cfg);
    const lines = s.renderLabel(cfg.labels.mt, context, { settings: cfg, type: 'mt' });
    return JSON.stringify({ original: s.templateContext(st, st.rows[0], 'mt'), rendered: lines });
  })()`));

  await js(`window.__neo.setView('map')`);
  await wait(500);
  await js(`document.querySelector('#mapLabels').click()`);
  await wait(650);
  await capture('23-labels-dialog.png');
  await js(`document.querySelector('[data-label-tab="mt"]').click()`);
  await wait(350);
  await capture('25-labels-mt.png');
  await js(`document.querySelector('[data-label-tab="rules"]').click()`);
  await js(`document.querySelector('#labelsAddSubstitution').click()`);
  await wait(250);
  await js(`(() => {
    const card = document.querySelector('#substitutionRules [data-subst-id]');
    card.querySelector('[data-subst-scope]').value = 'mt';
    card.querySelector('[data-subst-field]').value = '__label__';
    card.querySelector('[data-subst-operator]').value = 'contains';
    card.querySelector('[data-subst-pattern]').value = 'AL';
    card.querySelector('[data-subst-replacement]').value = 'CABO';
    card.querySelector('[data-subst-action]').value = 'text';
    card.querySelector('[data-subst-name]').value = 'Trocar AL por CABO';
    card.dispatchEvent(new Event('input', { bubbles: true }));
    card.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await wait(350);
  await capture('26-labels-substitutions.png');
  await js(`document.querySelector('#labelsDialog [data-close]').click()`);
  await wait(250);

  console.log('[screenshot] labels-save', await js(`(async () => {
    window.__neo.bus.emit('labels:open');
    await new Promise((resolve) => setTimeout(resolve, 220));
    document.querySelector('[data-label-tab="mt"]').click();
    await new Promise((resolve) => setTimeout(resolve, 90));
    document.querySelector('[data-label-field="NU_TRECHO"]')?.click();
    document.querySelector('#labelsSave').click();
    const cfg = JSON.parse(localStorage.getItem('neogrid.dxfSettings.v1') || '{}');
    const result = { mt: cfg.labels?.mt, rules: cfg.substitutions?.rules?.length || 0 };
    const s = await import('/js/modules/dxf/dxf-settings.js');
    s.resetDxfSettings();
    window.__neo.bus.emit('dxf:settings-changed');
    return JSON.stringify(result);
  })()`));

  await js(`document.querySelector('#dxfSettingsDialog [data-close]')?.click()`);

  console.log('[screenshot] arruamento', await js(`(async () => {
    if (${skipNetwork}) return JSON.stringify({ skipped: true });
    try {
      const { fetchStreets } = await import('/js/modules/dxf/dxf-export.js');
      const b = window.__neo.mapView.map.getBounds();
      const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
      const streets = await fetchStreets(bounds);
      return JSON.stringify({ streets: streets.length, named: streets.filter((s) => s.nome).length });
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  })()`));

  console.log('[screenshot] map-blocks', await js(`(async () => {
    const dxf = '0\\nSECTION\\n2\\nBLOCKS\\n0\\nBLOCK\\n8\\n0\\n2\\nPOSTE_TESTE\\n70\\n0\\n10\\n0\\n20\\n0\\n30\\n0\\n0\\nCIRCLE\\n8\\n0\\n10\\n0\\n20\\n0\\n30\\n0\\n40\\n1.5\\n0\\nLINE\\n8\\n0\\n10\\n-1.5\\n20\\n0\\n30\\n0\\n11\\n1.5\\n21\\n0\\n31\\n0\\n0\\nENDBLK\\n0\\nENDSEC\\n0\\nEOF\\n';
    const s = await import('/js/modules/dxf/dxf-settings.js');
    s.setDxfLibrary(dxf, 'teste.dxf');
    const cfg = s.loadDxfSettings();
    cfg.typeBlocks = {
      poste: { DT: 'POSTE_TESTE', CIR: 'POSTE_TESTE', 'DUPLO T': 'POSTE_TESTE', CIRCULAR: 'POSTE_TESTE' },
      inst: { TRAFO: 'POSTE_TESTE' },
    };
    cfg.blockSize = 24;
    cfg.labels.poste = '{NU_PG_ID}';
    cfg.labels.inst = '{TIPO_INSTA}';
    s.saveDxfSettings(cfg);
    window.__neo.bus.emit('dxf:settings-changed');
    return true;
  })()`));
  await wait(900);
  await js(`window.__neo.setView('map')`);
  await wait(800);
  await capture('22-map-blocks.png');
  await js(`(async () => {
    const s = await import('/js/modules/dxf/dxf-settings.js');
    s.resetDxfSettings();
    window.__neo.bus.emit('dxf:settings-changed');
  })()`);

  console.log('[screenshot] csv', await js(`(async () => {
    const { buildCsv } = await import('/js/data/csv-export.js');
    const store = window.__neo.library.get('poste');
    const columns = store.importantColumns();
    const content = buildCsv(store, [0, 1, 2], columns);
    return JSON.stringify({ columns, bytes: content.length, lines: content.split('\\r\\n').length });
  })()`));

  await js(`window.__neo.mapView.selectFeature('poste', 18)`);
  await wait(700);
  await capture('03-map-inspector.png');
  await js(`document.querySelector('[data-panel-tab="basemap"]').click()`);
  await wait(400);
  await capture('18-basemap-panel.png');
  await js(`document.querySelector('[data-panel-tab="layers"]').click()`);

  await js(`window.__neo.setView('exports')`);
  await wait(700);
  await capture('06-exports.png');

  await js(`window.__neo.setView('settings')`);
  await wait(700);
  await capture('07-settings.png');
  await js(`document.querySelector('#settingsFields').click()`);
  await wait(500);
  await capture('19-fields-dialog.png');
  await js(`document.querySelector('#fieldsDialog').close()`);

  // Tema claro
  await js(`document.querySelector('#themeSegmented [data-theme-value="light"]').click()`);
  await js(`window.__neo.setView('exports')`);
  await wait(800);
  await capture('08-exports-light.png');
  await js(`document.querySelector('#themeSegmented [data-theme-value="dark"]').click()`);

  // Diálogo de importação
  await js(`window.__neo.setView('map')`);
  await wait(400);
  await js(`document.querySelector('#topImport').click()`);
  await wait(500);
  await capture('10-import-dialog.png');
  await js(`document.querySelector('#importCancel').click()`);

  // Busca local
  await js(`(() => { const input = document.querySelector('#globalSearch'); input.focus(); input.value = '2100'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(900);
  await capture('11-search.png');
  await js(`(() => { const input = document.querySelector('#globalSearch'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); })()`);
  await js(`window.__neo.setView('map')`);

  // Painel de impressão
  await js(`document.querySelector('#printTop').click()`);
  await wait(700);
  await capture('12-print-panel.png');
  await js(`document.querySelector('#printClose').click()`);

  // Dock DXF
  await js(`document.querySelector('#exportDxfView').click()`);
  await wait(1100);
  await capture('13-dxf-dock.png');
  await js(`(async () => {
    const dxf = '0\\nSECTION\\n2\\nBLOCKS\\n0\\nBLOCK\\n8\\n0\\n2\\nPOSTE_DT_CONCRETO\\n70\\n0\\n10\\n0\\n20\\n0\\n30\\n0\\n0\\nLINE\\n8\\n0\\n10\\n-1\\n20\\n-1\\n30\\n0\\n11\\n1\\n21\\n1\\n31\\n0\\n0\\nENDBLK\\n0\\nENDSEC\\n0\\nEOF\\n';
    const s = await import('/js/modules/dxf/dxf-settings.js');
    s.setDxfLibrary(dxf, 'biblioteca_teste.dxf');
    const cfg = s.loadDxfSettings();
    cfg.library = { name: 'biblioteca_teste.dxf', text: dxf };
    cfg.blockRules = {
      poste: [{
        id: 'regra_demonstracao',
        name: 'Poste DT de concreto',
        enabled: true,
        match: 'all',
        block: 'POSTE_DT_CONCRETO',
        conditions: [
          { field: 'MATERIAL', operator: 'contains', value: 'CONCRETO' },
          { field: 'TIPO_PG', operator: 'equals', value: 'DT' },
        ],
      }],
      inst: [],
    };
    s.saveDxfSettings(cfg);
    window.__neo.bus.emit('dxf:settings-changed');
    return true;
  })()`);
  await js(`document.querySelector('#dxfSettings').click()`);
  await wait(700);
  await capture('21-dxf-settings.png');
  await js(`document.querySelector('#dxfBlockRules [data-add-rule="poste"]').click()`);
  await wait(400);
  await capture('24-dxf-rule-editor.png');
  await js(`(() => { document.querySelector('#dxfLabelPoste').value = '{NU_PG_ID}'; document.querySelector('#dxfSettingsSave').click(); })()`);
  await wait(350);
  await js(`document.querySelector('#dxfSettings').click()`);
  await wait(350);
  console.log('[screenshot] dxf-settings-saved', await js(`document.querySelector('#dxfLabelPoste').value`));
  await js(`document.querySelector('#dxfSettingsReset').click()`);
  await js(`document.querySelector('#dxfSettingsDialog [data-close]').click()`);
  await js(`document.querySelector('#dxfDockClose').click()`);

  // Ficha completa
  await js(`window.__neo.openRowDialog('poste', 19)`);
  await wait(500);
  await capture('14-row-dialog.png');
  await js(`document.querySelector('#rowDialog').close()`);

  await js(`window.__neo.setView('map')`);
  await wait(500);

  // Teste do layout de impressão: substitui o diálogo nativo por um no-op e gera PDF.
  try {
    const normalPdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(path.join(outDir, 'print-normal-test.pdf'), normalPdf);
    console.log('[screenshot] print-normal-test.pdf', normalPdf.length);
  } catch (error) {
    console.error('[screenshot] normal printToPDF failed', error.message);
  }

  await js(`(() => { window.__printOriginal = window.print; window.print = () => { window.__printInvoked = true; }; document.querySelector('#printTop').click(); })()`);
  await wait(1000);
  await js(`document.querySelector('#printGo').click()`);
  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(100);
    if (await js(`document.body.classList.contains('is-printing')`)) break;
  }
  await wait(900);
  console.log('[screenshot] printing', await js(`JSON.stringify({ printing: document.body.classList.contains('is-printing'), invoked: Boolean(window.__printInvoked) })`));
  await capture('16-print-layout.png');
  try {
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A3',
      margins: { marginType: 'none' },
    });
    fs.writeFileSync(path.join(outDir, 'print-test.pdf'), pdf);
    console.log('[screenshot] print-test.pdf', pdf.length);
  } catch (error) {
    console.error('[screenshot] printToPDF failed', error.message);
  }
  await js(`window.dispatchEvent(new Event('afterprint')); window.print = window.__printOriginal; true`);
  await wait(600);
  await js(`document.querySelector('#printClose')?.click()`);
  await js(`document.querySelector('#sidebarCollapse')?.click()`);
  await wait(500);
  await capture('17-sidebar-collapsed.png');
  await js(`document.querySelector('#sidebarExpand')?.click()`);
  await wait(300);

  try {
    console.log('[screenshot] encoding-test', await js(`(async () => {
      const text = 'NU_PG_ID;GEO_X;GEO_Y;NU_ALTURA;MATERIAL\\r\\n999001;-34.9;-8.05;12;POSTE C\\u00d4NICO';
      const bytes = new Uint8Array([...text].map((char) => char.charCodeAt(0)));
      const file = new File([bytes], 'postes_encoding.csv', { type: 'text/csv' });
      await window.__neo.importFiles([file]);
      const store = window.__neo.library.get('poste');
      const index = store.rows.length - 1;
      return JSON.stringify({ count: store.stats.count, material: store.rows[index][store.colIndex('MATERIAL')] });
    })()`));
  } catch (error) {
    console.error('[screenshot] encoding test failed', error);
  }

  if (consoleErrors.length) {
    console.log('[screenshot] console errors:', consoleErrors.slice(0, 20));
  }

  if (!process.argv.includes('--keep-open')) {
    setTimeout(() => {
      win.destroy();
      process.exit(0);
    }, 300);
  }
}

module.exports = run;
