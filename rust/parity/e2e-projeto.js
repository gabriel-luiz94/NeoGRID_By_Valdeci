'use strict';
// E2E do módulo Projeto e do Pacote no app real, via CDP.
// Uso: node e2e-projeto.js --port 9222 --db base.sqlite --out pasta
//   opcionais: --rows 5602772 --postes 2487524 --lat -8.06 --lon -34.89 --lado 300
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const PORT = Number(args.port || 9222);
const DB = String(args.db || '').replace(/\\/g, '/');
const OUT = path.resolve(args.out || '.');
const ROWS = Number(args.rows || 5602772);
const POSTES = Number(args.postes || 2487524);
let LAT = Number(args.lat || -8.0615);
let LON = Number(args.lon || -34.8925);
const LADO = Number(args.lado || 300);
const CSV = args.csv ? path.resolve(args.csv) : '';   // pasta de CSVs: testa o modo em memória em vez da base SQLite
fs.mkdirSync(OUT, { recursive: true });

let id = 0;
const pendentes = new Map();
const errosConsole = [];
let ws;
function send(method, params = {}) {
  const n = ++id;
  return new Promise((resolve, reject) => {
    pendentes.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}
async function js(expr, timeoutMs = 240000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function foto(nome) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${nome}.png`), Buffer.from(r.data, 'base64'));
}
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function mouse(tipo, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', { type: tipo, x, y, button: 'left', buttons: tipo === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
}
async function arrastar(x0, y0, x1, y1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none' });
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6);
  await mouse('mouseReleased', x1, y1);
}

let falhas = 0;
let total = 0;
function ok(nome, cond, extra = '') {
  total++;
  if (!cond) falhas++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${nome}${extra !== '' ? '  -> ' + extra : ''}`);
}
async function etapa(nome, fn) {
  try { await fn(); } catch (e) { ok(nome, false, e.message.split('\n')[0]); }
}

async function main() {
  let pagina = null;
  for (let i = 0; i < 40 && !pagina; i++) {
    const alvos = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    pagina = alvos.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1/.test(t.url));
    if (!pagina) await pausa(500);
  }
  if (!pagina) throw new Error('página do app não encontrada');
  ws = new WebSocket(pagina.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pendentes.has(m.id)) {
      const { resolve, reject } = pendentes.get(m.id);
      pendentes.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errosConsole.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/tile|ERR_|Failed to load resource/.test(m.params.entry.text)) {
      errosConsole.push(m.params.entry.text);
    }
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  const origem = new URL(pagina.url).origin;
  const cfgOriginal = await js(`window.desktop.wsGet('cfg')`).catch(() => null);
  await send('Page.navigate', { url: `${origem}/index.html?test=1` });
  for (let i = 0; i < 60 && !(await js('Boolean(window.__neo && window.__neo.ready)').catch(() => false)); i++) await pausa(500);
  ok('app pronto em modo de teste', await js('Boolean(window.__neo && window.__neo.ready)'));
  ok('porta fixa do frontend', new URL(pagina.url).port === '48765' || Boolean(process.env.NEOGRID_FRONTEND_PORT), new URL(pagina.url).port);

  if (CSV) await etapa('csv', async () => {
    let total = 0;
    for (const nome of fs.readdirSync(CSV).filter((n) => /\.csv$/i.test(n))) {
      const texto = fs.readFileSync(path.join(CSV, nome), 'utf8');
      await js(`window.__neo.importCsv(${JSON.stringify(nome)}, ${JSON.stringify(texto)})`);
      total += texto.split('\n').length;
    }
    const n = await js('window.__neo.getSummary().totalRows');
    ok('CSV importado em memória', n > 0, n);
    const dlg = await js(`[...document.querySelectorAll('dialog[open]')].map(d => d.id)`);
    if (dlg.length) console.log('      diálogos abertos:', dlg.join(','));
    await js(`document.querySelectorAll('dialog[open]').forEach(d => d.close())`);
    // Centro de uma amostra real dos postes importados.
    const s = await js(`(() => { const st = window.__neo.library.get('poste'), i = Math.floor(st.rows.length / 2); return [st.Y[i], st.X[i]]; })()`);
    [LAT, LON] = s;
    console.log('      centro:', s.join(', '));
    await pausa(5000);   // a importação ainda enquadra o mapa e mostra avisos
  });
  if (!CSV) await etapa('base', async () => {
    const r = await js(`window.__neo.openDatabase(${JSON.stringify(DB)}).then(() => window.__neo.getSummary().totalRows)`);
    ok('abre a base completa', r === ROWS, r);
    const reg = await js(`window.desktop.dbQuery('db:regions', {}).then(r => r.result.all)`);
    ok('base tem regionais', reg.length >= 8, reg.join(' | '));
    const s = await js(`window.desktop.dbSql('select REGIONAL, count(*) as n from v_poste group by REGIONAL order by n desc', 100)`);
    const soma = (s.result?.rows || []).reduce((a, x) => a + x[1], 0);
    ok('SQL decodifica a regional', s.ok && typeof s.result.rows[0][0] === 'string', JSON.stringify(s.result?.rows?.[0]));
    ok('SQL soma todos os postes', soma === POSTES, soma);
    const w = await js(`window.desktop.dbSql('select GEOMETRIA_WKT from v_mt limit 1', 1)`);
    ok('SQL devolve o WKT descompactado', w.ok && /^(MULTI)?LINESTRING/i.test(String(w.result.rows[0][0])), String(w.result?.rows?.[0]?.[0]).slice(0, 40));
    for (const ruim of ['drop table poste', 'select 1; drop table poste', "attach database 'x.db' as y", 'pragma writable_schema=1', 'delete from poste']) {
      const q = await js(`window.desktop.dbSql(${JSON.stringify(ruim)}, 10)`);
      ok(`SQL recusa: ${ruim}`, !q.ok, q.error);
    }
    const lim = await js(`window.desktop.dbSql('with recursive c(x) as (select 1 union all select x+1 from c where x<30000) select x from c', 100)`);
    ok('SQL corta no limite pedido', lim.ok && lim.result.corte === true && lim.result.rows.length === 100);
    // Filtro por regional: a mesma janela do Recife some ao escolher outra regional.
    const dlat = 0.003;
    const janela = `{type:'poste', west:${LON - dlat}, east:${LON + dlat}, south:${LAT - dlat}, north:${LAT + dlat}, limit:500}`;
    const antes = await js(`window.desktop.dbQuery('db:viewport', ${janela}).then(r => r.result.length)`);
    await js(`window.desktop.dbQuery('db:set-regions', {regions:['REGIONAL_9_OESTE']})`);
    const fora = await js(`window.desktop.dbQuery('db:viewport', ${janela}).then(r => r.result.length)`);
    await js(`window.desktop.dbQuery('db:set-regions', {regions:['\\u0000nenhuma']})`);
    const nenhuma = await js(`window.desktop.dbQuery('db:viewport', ${janela}).then(r => r.result.length)`);
    await js(`window.desktop.dbQuery('db:set-regions', {regions:[]})`);
    const depois = await js(`window.desktop.dbQuery('db:viewport', ${janela}).then(r => r.result.length)`);
    ok('filtro por regional restringe o mapa', antes > 0 && fora === 0 && nenhuma === 0 && depois === antes, `${antes}/${fora}/${nenhuma}/${depois}`);
  });

  await etapa('banco de trabalho', async () => {
    await js(`window.desktop.wsPut('teste:a', '{"v":1}')`);
    const v = await js(`window.desktop.wsGet('teste:a')`);
    const st = await js(`window.desktop.wsStats('teste:')`);
    const n = await js(`window.desktop.wsDeletePrefix('teste:')`);
    const vazio = await js(`window.desktop.wsGet('teste:a')`);
    ok('banco de trabalho grava, lê e apaga', v === '{"v":1}' && st.n === 1 && n === 1 && vazio === null);
  });

  await etapa('módulo', async () => {
    await js(`document.querySelector('#navProjeto').click()`);
    for (let i = 0; i < 40 && !(await js(`typeof ngIniciarProjeto === 'function' && !document.querySelector('#prj').hidden`).catch(() => false)); i++) await pausa(250);
    ok('painel do Projeto abre', await js(`!document.querySelector('#prj').hidden`));
    const larguras = await js(`({painel: document.querySelector('#ngPaineis').getBoundingClientRect().width, mapa: document.querySelector('#map').getBoundingClientRect().width, camadas: getComputedStyle(document.querySelector('.map-panel')).display})`);
    ok('painel ao lado do mapa, sem cobri-lo', larguras.painel > 300 && larguras.mapa > 500 && larguras.camadas === 'none', JSON.stringify(larguras));
    await foto('01-painel');
  });

  await etapa('pacote de ruas', async () => {
    const st = await js(`window.desktop.ruasPackStatus()`);
    ok('pacote de ruas instalado', st.instalado, st.instalado ? `${st.info.vias} vias, ${Math.round(st.bytes / 1048576)} MB` : '');
    const t = await js(`window.NG.ruasPackTile(Math.floor(${LON} / 0.02) + ':' + Math.floor(${LAT} / 0.02))`);
    ok('ladrilho do pacote tem coordenadas certas', t && t.ways.length > 0 && Math.abs(t.ways[0].p[0][0] - LAT) < 0.1 && Math.abs(t.ways[0].p[0][1] - LON) < 0.1, t ? `${t.ways.length} vias` : '');
    const fora = await js(`window.NG.ruasPackTile('-2000:-300')`);
    ok('fora de Pernambuco não finge ter dados', fora === null);
  });

  await etapa('configuração no mapa', async () => {
    for (let i = 0; i < 50 && !(await js(`Boolean(window.ngMapa)`)); i++) await pausa(100);
    const r = await js(`(async () => {
      const R = window.__neo.mapView.renderer, st = window.__neo.library.get('poste');
      const caixa = {west: ${LON - 0.002}, east: ${LON + 0.002}, south: ${LAT - 0.002}, north: ${LAT + 0.002}};
      const ids = st.isDatabase ? await window.desktop.dbQuery('db:ids-in-bounds', {type: 'poste', ...caixa, limit: 5}).then(q => q.result) : st.collectInBounds(caixa).slice(0, 5);
      if (st.isDatabase) await st.ensureRows(ids);
      const i = ids[0], antes = R.estiloDe('poste', st, i).cor, copia = JSON.stringify(CFG);
      const texto = JSON.stringify({CFG: {cam: {poste: {base: {cor: '#123456'}, rules: [{nome: 'X', on: true, expr: 'true', est: {cor: '#abcdef'}}], labels: [{nome: 'T', on: true, expr: "'TESTE ' || attribute('NU_PG_ID')", cor: '#fedcba'}]}}}, BLOCOS: {}});
      await new Promise((ok, erro) => { importarCfg({text: async () => texto}); setTimeout(ok, 300); });
      R.syncMapa();
      const depois = R.estiloDe('poste', st, i), rot = R.labelsFor('poste', st, i);
      const res = {antes, cor: depois.cor, rot: [...rot], corRot: rot.cor, id: st.rows[i][st.headers.indexOf('NU_PG_ID')]};
      CFG = JSON.parse(copia); normalizarCfg(); mudou();
      R.syncMapa();
      res.restaurada = R.estiloDe('poste', st, i).cor;
      return res;
    })()`);
    ok('configuração importada vale no mapa', r.cor === '#abcdef' && r.rot[0] === 'TESTE ' + r.id && r.corRot === '#fedcba', JSON.stringify(r));
    ok('volta ao padrão', r.restaurada === r.antes, r.restaurada);
  });

  await etapa('sem arruamento e janela respondendo', async () => {
    const espera = js(`(async () => {
      // Servidores que nunca respondem e nada guardado: o pior caso.
      const g = window.NG, orig = {c: g.overpassCorrida, t: g.ruasPackTile, w: g.wsGet};
      let sinal = null;
      g.overpassCorrida = (u, q, o) => new Promise((_, rej) => { sinal = o.signal; o.signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))); });
      g.ruasPackTile = async () => null;
      g.wsGet = async (k) => (k.startsWith('c:') ? null : orig.w(k));
      OSM2.clear(); RP.R = null;
      map.setView([${LAT}, ${LON}], 17.5, {animate: false});
      const b = map.getBounds().pad(-0.3);
      await selFim(b, null);
      let maior = 0, ant = performance.now();
      const pulso = setInterval(() => { const a = performance.now(); maior = Math.max(maior, a - ant); ant = a; }, 25);
      const abrindo = projAbrir();
      await new Promise(r => { window.__libera = r; });
      const visivel = !document.querySelector('#etapas').hidden, pula = !document.querySelector('#etapas-pula').hidden, linhas = document.querySelector('#etapas-l').innerText;
      document.querySelector('#etapas-pula').click();
      await abrindo;
      clearInterval(pulso);
      const res = {visivel, pula, linhas, on: PJ.on, ruas: PJ.ruasR, maior: Math.round(maior), itens: PJ.items.length};
      projSair();
      // Cancelar: não abre o projeto
      const de = projAbrir();
      await new Promise(r => setTimeout(r, 400));
      document.querySelector('#etapas-cancela').click();
      await de;
      res.cancelou = !PJ.on;
      g.overpassCorrida = orig.c; g.ruasPackTile = orig.t; g.wsGet = orig.w;
      limparPoligono(); OSM2.clear();
      return res;
    })()`);
    await pausa(1800);
    await foto('07-etapas');
    await js('window.__libera()');
    const r = await espera;
    ok('etapas aparecem durante a espera', r.visivel && r.pula && /Ruas do OpenStreetMap/.test(r.linhas), JSON.stringify(r.linhas));
    ok('continuar sem arruamento abre o projeto', r.on && !r.ruas && r.itens > 0, r.itens);
    ok('cancelar não abre o projeto', r.cancelou);
    ok('janela não trava na espera', r.maior < 500, r.maior + ' ms');
  });

  await etapa('estilos único', async () => {
    const r = await js(`(async () => {
      document.querySelector('#navEstilos').click();
      await new Promise(r => setTimeout(r, 300));
      const nav = !document.querySelector('#sp').hidden, abas = [...document.querySelectorAll('#spt button')].map(b => b.textContent);
      fecharSP();
      await new Promise(r => setTimeout(r, 100));
      document.querySelector('[data-estilos-abrir]').click();
      await new Promise(r => setTimeout(r, 300));
      const botao = !document.querySelector('#sp').hidden;
      fecharSP();
      const antigos = ['#dxfDock', '#streetsDock', '#kmlDock', '#mapDxf', '#labelsDialog', '#dxfSettingsDialog', '#sidebarImport', '#printTop', '#kmlPointColor', '#kmlUseKmlColors', '#labelZoom', '#settingsLabels', '[data-dxf-settings-open]', '[data-labels-open]'].filter(q => document.querySelector(q));
      return {nav, botao, abas, antigos, kml: window.ngMapa.kml()};
    })()`);
    ok('Estilos abre pela barra lateral e pelos atalhos', r.nav && r.botao, r.abas.join(', '));
    ok('sem controles duplicados ou mortos', r.antigos.length === 0, r.antigos.join(', '));
    ok('KML segue Estilos', r.kml && r.kml.ponto === '#f472b6' && r.kml.linha === '#38bdf8', JSON.stringify(r.kml));
    const f = await js(`(async () => {
      const R = window.__neo.mapView.renderer;
      map.setView([${LAT}, ${LON}], 18.5, {animate: false});
      await new Promise(r => setTimeout(r, 1500));
      const L0 = CFG.cam.poste.labels[0], o = {t: L0.tam, f: L0.fonte, c: L0.cor, b: L0.bal};
      L0.tam = 18; L0.fonte = 'Georgia'; L0.cor = '#00ff88'; L0.bal = 'ret'; mudou('poste'); R.schedule();
      await new Promise(r => setTimeout(r, 900));
      window.__estiloOrig = o;
      return {labels: R.lastStats && R.lastStats.labels};
    })()`);
    await foto('09-mapa-estilo-alterado');
    await js(`(() => { const L0 = CFG.cam.poste.labels[0], o = window.__estiloOrig; L0.tam = o.t; L0.fonte = o.f; L0.cor = o.c; L0.bal = o.b; mudou('poste'); })()`);
    ok('mapa desenha rótulos com o estilo alterado', f.labels > 0, f.labels);
  });

  await etapa('área', async () => {
    const dLat = LADO / 2 / 111320;
    const dLon = LADO / 2 / (111320 * Math.cos(LAT * Math.PI / 180));
    void dLat; void dLon;
    // Com o mouse, como o usuário: botão Retângulo e arraste de 400 px no mapa.
    const z = Math.log2((400 / LADO) * 40075016.686 * Math.cos(LAT * Math.PI / 180) / 256);
    await js(`map.setView([${LAT}, ${LON}], ${z}, {animate: false}); document.querySelector('#pjret').click()`);
    await pausa(300);
    const c = await js(`(() => { const r = map.getContainer().getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
    const inicio = Date.now();
    await arrastar(c.x - 200, c.y - 200, c.x + 200, c.y + 200);
    for (let i = 0; i < 300 && !(await js('Boolean(SEL && SEL.ids)')); i++) await pausa(200);
    if (!(await js('Boolean(SEL)'))) {
      const d = await js(`({modo, pji: document.querySelector('#pji').textContent, st: document.querySelector('#st').textContent, el: (e => e && (e.id || e.className))(document.elementFromPoint(${c.x}, ${c.y})), c: ${JSON.stringify(c)}, cont: map.getSize(), classes: document.querySelector('.map-layout').className, stage: document.querySelector('#mapStage').className, hidden: document.querySelector('#prj').hidden})`);
      console.log('      diagnóstico:', JSON.stringify(d));
    }
    ok('inspetor não abriu durante a seleção', await js(`!document.querySelector('.map-layout').classList.contains('is-inspector-open')`));
    const r = await js(`({ids: Object.fromEntries(Object.entries(SEL.ids).map(([k, v]) => [k, v.length])), info: document.querySelector('#pji').textContent, rtem: !document.querySelector('#pjcria').hidden})`);
    ok('área lida da base', Object.values(r.ids).reduce((a, b) => a + b, 0) > 0, `${JSON.stringify(r.ids)} em ${Date.now() - inicio} ms`);
    ok('oferece criar o projeto', r.rtem);
    await pausa(1500);
  });

  await etapa('projeto', async () => {
    const inicio = Date.now();
    await js(`document.querySelector('#pjcria').click()`);
    for (let i = 0; i < 240 && !(await js('PJ.on')); i++) await pausa(500);
    const r = await js(`({on: PJ.on, itens: PJ.items.length, ruas: !!PJ.ruasR, aba: PJ.aba, oculto: document.querySelector('#mapStage').classList.contains('is-projeto-ativo'), st: document.querySelector('#st').textContent})`);
    ok('projeto abre', r.on && r.itens > 0, `${r.itens} itens, ruas=${r.ruas}, ${Date.now() - inicio} ms`);
    ok('camadas do mapa recolhidas no projeto', r.oculto);
    await pausa(600);
    await foto('02-projeto-edicao');
    const antes = await js(`PJ.hit.length`);
    const t0 = await js(`(() => { const t = performance.now(); for (let i = 0; i < 20; i++) pjDesenhar(); return (performance.now() - t) / 20; })()`);
    ok('redesenho do projeto', antes > 0 && t0 < 200, `${Math.round(t0)} ms por quadro, ${antes} alvos de clique`);
  });

  await etapa('mouse e teclado', async () => {
    const alvo = await js(`(() => {
      pjDesenhar();
      const r = map.getContainer().getBoundingClientRect(), W = r.width, H = r.height;
      const h = PJ.hit.find(q => q.s.k === 'T' && q.px > 60 && q.py > 60 && q.px < W - 60 && q.py < H - 60);
      return h ? {x: r.left + (h.x0 + h.x1) / 2 * Math.cos(h.a) + h.px, y: r.top + h.py, key: h.s.key} : null;
    })()`);
    ok('há texto clicável na tela', Boolean(alvo));
    const n0 = await js(`Object.keys(PRJ().t).length`);
    await arrastar(alvo.x, alvo.y, alvo.x + 40, alvo.y + 25);
    await pausa(200);
    const n1 = await js(`({n: Object.keys(PRJ().t).length, sel: PJ.sels.length})`);
    ok('arrastar um texto cria a edição', n1.n === n0 + 1, JSON.stringify(n1));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await pausa(150);
    ok('Ctrl+Z desfaz', (await js(`Object.keys(PRJ().t).length`)) === n0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await pausa(100);
    ok('projeto segue aberto após Esc', await js('PJ.on'));
  });

  await etapa('estilos no projeto', async () => {
    const r = await js(`(async () => {
      const it0 = PJ.items.find(i => i.k === 'T' && i.e.fv), L0 = CFG.cam.poste.labels[0], orig = {cor: L0.cor, f: L0.fonte, tam: L0.tam, neg: L0.neg, h: L0.dxfH};
      const antes = {cor: it0 && it0.e.fv.c, h: it0 && it0.e.h};
      L0.cor = '#00ff88'; L0.fonte = 'Georgia'; L0.neg = false; L0.dxfH = 3; mudou('poste');
      await new Promise(r => setTimeout(r, 900));
      const txt = PJ.items.filter(i => i.k === 'T' && i.e.fv && i.e.fv.c === '#00ff88');
      const depois = txt[0] ? {cor: txt[0].e.fv.c, fonte: txt[0].e.fv.f, neg: txt[0].e.fv.n, h: txt[0].e.h} : null;
      Object.assign(L0, {cor: orig.cor, fonte: orig.f, neg: orig.neg, dxfH: orig.h}); mudou('poste');
      await new Promise(r => setTimeout(r, 900));
      return {antes, depois, n: txt.length, voltou: PJ.items.some(i => i.k === 'T' && i.e.fv && i.e.fv.c === orig.cor)};
    })()`);
    ok('mudar o estilo refaz os textos do projeto aberto', r.depois && r.depois.cor === '#00ff88' && r.depois.fonte === 'Georgia' && r.depois.neg === false && r.depois.h === 3 && r.voltou, JSON.stringify(r));
  });

  await etapa('camadas no projeto', async () => {
    const r = await js(`(async () => {
      const contar = () => { const t = usarSel(() => gerarDXF(SEL, PJ.osm, PJ.ruasR)).txt; DXF.ctx = PJ.c; return (t.match(/\\nINSERT/g) || []).length; };
      const vis = () => PJ.hit.length, antes = {hit: vis(), ins: contar(), q: pacoteQuantCsv().texto.includes('Poste;')};
      const caixa = !document.querySelector('#pjCamadas').hidden && document.querySelectorAll('#pjCamadasL input').length;
      await ngLigarCamada('poste', false); pjDesenhar();
      const off = {hit: vis(), ins: contar(), q: pacoteQuantCsv().texto.includes('Poste;'), mapa: window.NG.camadaVisivel('poste')};
      await ngLigarCamada('poste', true); pjDesenhar();
      const on = {hit: vis(), mapa: window.NG.camadaVisivel('poste')};
      return {caixa, antes, off, on};
    })()`);
    ok('camadas à vista no painel', r.caixa === 6, r.caixa);
    ok('desligar tira do desenho, da entrega e do mapa', r.off.hit < r.antes.hit && r.off.ins < r.antes.ins && !r.off.q && r.antes.q && !r.off.mapa, JSON.stringify(r));
    ok('religar devolve tudo', r.on.hit === r.antes.hit && r.on.mapa, JSON.stringify(r.on));
  });

  await etapa('edição', async () => {
    const r = await js(`(() => {
      CFG.dxf.projeto.ex = []; const P = PRJ(), n0 = P.ex.length, ct = SEL.b.getCenter(), {Z} = projDXF(SEL), u = utm(ct.lat, ct.lng, Z);
      pjSnap();
      P.ex.push({id: pjNovoId(), t: 'TEXT', x: u[0], y: u[1], h: 2, s: 'POSTE DT 11/300', rot: 0, lay: '01_INSTALANDO'});
      P.ex.push({id: pjNovoId(), t: 'TEXT', x: u[0], y: u[1] - 6, h: 2, s: 'TRAFO 75 kVA\\nPOSTE DT 11/300', rot: 0, lay: '01_INSTALANDO'});
      P.ex.push({id: pjNovoId(), t: 'TEXT', x: u[0], y: u[1] - 12, h: 2, s: 'CABO 1/0', rot: 0, lay: '01_REMOVER'});
      pjDesenhar();
      const com = P.ex.length;
      pjDesfazer();
      const desfeito = PRJ().ex.length;
      pjRefazer();
      return {n0, com, desfeito, refeito: PRJ().ex.length, an: pacoteAnotacoes()};
    })()`);
    ok('anotar, desfazer e refazer', r.com === r.n0 + 3 && r.desfeito === r.n0 && r.refeito === r.com, JSON.stringify([r.n0, r.com, r.desfeito, r.refeito]));
    const instalar = r.an.find((x) => x[0] === 'Instalar' && x[1] === 'POSTE DT 11/300');
    ok('quantitativo conta os serviços anotados', instalar && instalar[2] === 2 && r.an.some((x) => x[0] === 'Remover' && x[1] === 'CABO 1/0'), JSON.stringify(r.an));
  });

  await etapa('abas', async () => {
    await js(`pjAba('arr')`);
    await pausa(800);
    ok('aba Arruamento', await js(`PJ.aba === 'arr' && !document.querySelector('#arr').hidden`));
    await foto('03-projeto-arruamento');
    await js(`pjAba('pac')`);
    ok('aba Entregar', await js(`PJ.aba === 'pac' && !document.querySelector('#pac').hidden && document.querySelectorAll('#pacc .card').length >= 3 && document.querySelector('#dxo').children.length > 0`));
    await foto('04-projeto-pacote');
  });

  await etapa('pacote', async () => {
    await js(`Object.assign(CFG.pacote, {nome: 'Teste Área Recife', cliente: 'Neoenergia PE', responsavel: 'Eng. Teste', registro: 'CREA 000', observacoes: 'Pacote de teste automatizado.'})`);
    const inicio = Date.now();
    const r = await js(`pacoteGerar().then(async g => {
      const files = g.files.map(a => a.bytes ? {name: a.name, base64: (() => { let b = ''; for (let i = 0; i < a.bytes.length; i += 32768) b += String.fromCharCode.apply(null, a.bytes.subarray(i, i + 32768)); return btoa(b); })()} : {name: a.name, text: a.text});
      const z = await window.desktop.packWrite(${JSON.stringify(path.join(OUT, 'pacote.zip'))}, 'zip', files);
      const p = await window.desktop.packWrite(${JSON.stringify(path.join(OUT, 'pacote-pasta'))}, 'pasta', files);
      const ruim = await window.desktop.packWrite(${JSON.stringify(path.join(OUT, 'pacote-ruim'))}, 'pasta', [{name: '../fora.txt', text: 'x'}]);
      return {nomes: g.files.map(a => a.name), avisos: g.avisos, z, p, ruim, dxf: g.files.find(a => /\\.dxf$/.test(a.name)).text.slice(-40), leia: g.files.find(a => a.name === 'LEIA-ME.txt').text};
    })`);
    ok('pacote gerado', r.z.saved && r.p.saved, `${r.nomes.length} arquivos em ${Date.now() - inicio} ms: ${r.nomes.join(', ')}`);
    ok('caminho inválido é recusado', !r.ruim.saved, r.ruim.error);
    ok('DXF termina em EOF', /EOF\s*$/.test(r.dxf));
    ok('zip criado', fs.existsSync(path.join(OUT, 'pacote.zip')) && fs.statSync(path.join(OUT, 'pacote.zip')).size > 1000);
    ok('sem arquivo fora da pasta', !fs.existsSync(path.join(OUT, 'fora.txt')));
    fs.writeFileSync(path.join(OUT, 'LEIA-ME-gerado.txt'), r.leia);
    if (r.avisos.length) console.log('      avisos:', r.avisos.join(' | '));
  });

  await etapa('salvar e reabrir', async () => {
    const r = await js(`(async () => {
      const arq = pjArquivo(), texto = JSON.stringify(arq), ex0 = PRJ().ex.length;
      projSair();
      const fora = PJ.on;
      const realConfirm = window.confirm; window.confirm = () => true;
      await pjAbrirArquivo({name: 'teste.neogrid-projeto.json', text: async () => texto});
      window.confirm = realConfirm;
      for (let i = 0; i < 400 && !PJ.on; i++) await new Promise(r => setTimeout(r, 100));
      return {fora, on: PJ.on, ex: PRJ().ex.length, ex0, tam: texto.length};
    })()`);
    ok('sair e reabrir do arquivo mantém as anotações', !r.fora && r.on && r.ex === r.ex0, JSON.stringify(r));
  });

  await etapa('consulta', async () => {
    await js(`projSair(); document.querySelector('#prj').hidden = true; document.querySelector('#navConsulta').click()`);
    for (let i = 0; i < 20 && (await js(`document.querySelector('#cons').hidden`)); i++) await pausa(200);
    ok('painel Consultar abre', await js(`!document.querySelector('#cons').hidden && document.querySelector('#cons-c').children.length > 0`));
    await foto('05-consulta');
    const f = await js(`window.NG.lerCamada('poste', map.getBounds(), 2000).then(j => { const d = montarDS('poste', j.h, j.rows, false); return {n: j.n, x: d.X[0], y: d.Y[0], lat: map.getCenter().lat}; })`);
    ok('filtro lê a camada da área', f.n > 0 && Math.abs(f.y - f.lat) < 0.1, JSON.stringify(f));
    await js(`document.querySelector('#cons').hidden = true`);
    ok('coluna volta ao painel de camadas', await js(`!document.querySelector('.map-layout').classList.contains('is-prj')`));
    const leg = await js(`(() => {
      const b = document.querySelector('#mapLegend [data-camada=mt]'), vis = () => window.NG.camadaVisivel('mt');
      const a = vis(); b.querySelector('input').click(); const c = vis(), off = b.classList.contains('is-off'); b.querySelector('input').click();
      return {a, c, off, d: vis(), on: !b.classList.contains('is-off')};
    })()`);
    ok('legenda liga e desliga camadas', leg.a && !leg.c && leg.off && leg.d && leg.on, JSON.stringify(leg));
  });

  await etapa('medir e limites', async () => {
    await js(`document.querySelector('#mapMedir').click()`);
    await pausa(200);
    ok('medição liga', await js(`medir === true`));
    await js(`medirLigar(false); document.querySelector('#lim-mun').click()`);
    await pausa(300);
    ok('limites municipais ligam', await js(`map.hasLayer(LIM.mun)`));
    const m = await js(`limMunicipios('recife')`);
    ok('busca de município', m.length > 0 && /Recife/.test(m[0].t), m[0]?.t);
    await js(`document.querySelector('#lim-mun').click()`);
  });

  // Devolve a configuração do usuário como estava antes do teste.
  await js(`clearTimeout(tsv); ${cfgOriginal == null ? "window.desktop.wsDeletePrefix('cfg')" : `window.desktop.wsPut('cfg', ${JSON.stringify(cfgOriginal)})`}`);
  if (!CSV) await etapa('limpa', async () => {});
  await etapa('abertura', async () => {
    const t0 = Date.now();
    await send('Page.navigate', { url: `${origem}/index.html` });
    let nome = '';
    for (let i = 0; i < 200; i++) {
      await pausa(100);
      nome = await js(`document.querySelector('#sidebarDatasetName')?.textContent || ''`).catch(() => '');
      if (/sqlite/i.test(nome)) break;
    }
    const pronto = Date.now() - t0;
    ok('reabre a última base sozinho', /sqlite/i.test(nome) || Boolean(CSV), `${nome} em ${pronto} ms`);
    const vista = await js(`JSON.parse(localStorage.getItem('neogrid.ultimaVista') || 'null')`);
    ok('lembra a posição do mapa', vista && Math.abs(vista.lat - LAT) < 1, JSON.stringify(vista));
    await js(`new Promise(r => setTimeout(r, 300))`);
    await pausa(2500);
    await foto('06-mapa');
    await js(`document.querySelector('.nav-item[data-view=exports]').click()`);
    await pausa(400);
    await foto('08-exportacoes');
    await js(`document.querySelector('.nav-item[data-view=map]').click()`);
  });

  ok('sem erros no console', errosConsole.length === 0, errosConsole.slice(0, 5).join(' || '));
  console.log(`\n${total - falhas}/${total} PASS`);
  ws.close();
  process.exit(falhas ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
