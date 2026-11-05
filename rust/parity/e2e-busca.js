'use strict';
// E2E da barra de pesquisa e dos controles de camadas, no app real, via CDP.
// Altera preferências do perfil: rode só em um perfil de teste.
// Uso: node e2e-busca.js --port 9222 --db base.sqlite --out pasta
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const PORT = Number(args.port || 9222);
const DB = String(args.db || '').replace(/\\/g, '/');
const OUT = path.resolve(args.out || '.');
fs.mkdirSync(OUT, { recursive: true });
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

let falhas = 0;
let total = 0;
function ok(nome, cond, extra = '') {
  total++;
  if (!cond) falhas++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${nome}${extra !== '' ? `  -> ${extra}` : ''}`);
}

const AJUDA = `(() => {
  const neo = window.__neo, campo = document.querySelector('#globalSearch');
  const fetchOrig = window.fetch;
  window.__externos = [];
  window.fetch = function (url, ...resto) {
    const u = String(url?.url || url);
    if (/photon|nominatim/.test(u)) window.__externos.push(u);
    return fetchOrig.call(this, url, ...resto);
  };
  window.__digitar = async (texto) => {
    campo.focus();
    campo.value = texto;
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    await window.__searchTest.pendente();
    await new Promise((r) => setTimeout(r, 30));
    return {
      itens: window.__searchTest.suggestions().map((i) => ({ kind: i.kind, type: i.type, label: i.label, subtitle: i.subtitle, id: i.id, lat: i.lat, lon: i.lon })),
      texto: document.querySelector('#searchResults').innerText,
      aberta: !document.querySelector('#searchResults').hidden,
    };
  };
  window.__enter = async () => {
    campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 900));
    const c = neo.mapView.map.getCenter();
    return { lat: c.lat, lon: c.lng, zoom: neo.mapView.map.getZoom(), marcas: neo.mapView.markerLayer.getLayers().length, campo: campo.value };
  };
  window.__item = (nome) => document.querySelector('#mapLegend [' + nome + ']');
  window.__marcado = (nome) => {
    const i = window.__item(nome);
    return { checked: i.querySelector('input').checked, off: i.classList.contains('is-off') };
  };
  window.__clicar = async (nome) => { window.__item(nome).querySelector('input').click(); await new Promise((r) => setTimeout(r, 500)); };
})()`;

const KML = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>PONTO TESTE</name><Point><coordinates>-34.8925,-8.0615,0</coordinates></Point></Placemark>
<Placemark><name>LINHA TESTE</name><LineString><coordinates>-34.893,-8.062,0 -34.892,-8.061,0</coordinates></LineString></Placemark>
</Document></kml>`;

async function main() {
  let pagina = null;
  for (let i = 0; i < 80 && !pagina; i++) {
    try {
      const alvos = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      pagina = alvos.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1/.test(t.url));
    } catch { /* app subindo */ }
    if (!pagina) await pausa(500);
  }
  if (!pagina) throw new Error('página do app não encontrada');
  const ws = new WebSocket(pagina.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pend = new Map();
  const erros = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') erros.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout: 300000 });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const foto = async (nome) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${nome}.png`), Buffer.from(r.result.data, 'base64'));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  const origem = new URL(pagina.url).origin;
  const abrir = async () => {
    await send('Page.navigate', { url: `${origem}/index.html?test=1` });
    await pausa(800);
    for (let i = 0; i < 80 && !(await js('Boolean(window.__neo && window.__neo.ready)').catch(() => false)); i++) await pausa(500);
    await js(`window.__neo.openDatabase(${JSON.stringify(DB)})`);
    await js('typeof camadaRuasLigada');
    for (let i = 0; i < 60 && (await js(`typeof ngIniciarProjeto === 'function' && typeof ruasMapa === 'object'`).catch(() => false)) !== true; i++) await pausa(250);
    await pausa(1500);
    await js(AJUDA);
  };
  await abrir();
  await js(`document.querySelector('#appShell')?.classList.remove('is-collapsed')`);

  // ---- índice: primeira abertura ----
  const inicio = Date.now();
  const primeira = await js(`window.__digitar('H044357')`);
  console.log(`      primeira busca: ${primeira.texto.replace(/\s+/g, ' ').slice(0, 120)}`);
  const estado0 = await js(`window.__neo.library.searchFields.estado`);
  ok('estado do índice é informado', ['preparando', 'pronto'].includes(estado0), estado0);
  if (estado0 === 'preparando') {
    ok('avisa que a busca está sendo preparada', /Preparando a busca/.test(primeira.texto));
    await foto('busca-preparando');
    const enterCedo = await js(`(async () => { window.__externos.length = 0; const r = await window.__enter(); return { r, externos: window.__externos.length }; })()`);
    ok('Enter durante o preparo não manda o código para fora', enterCedo.externos === 0, JSON.stringify(enterCedo.externos));
  }
  let pronto = null;
  for (let i = 0; i < 600; i++) {
    pronto = await js(`window.__digitar('H044357')`);
    if ((await js(`window.__neo.library.searchFields.estado`)) === 'pronto') break;
    await pausa(1000);
  }
  ok('índice fica pronto', (await js(`window.__neo.library.searchFields.estado`)) === 'pronto', `${Math.round((Date.now() - inicio) / 1000)} s desde a primeira busca`);

  // ---- barramento, placa, instalação ----
  await js('window.__externos.length = 0');
  const t0 = Date.now();
  const barra = await js(`window.__digitar('H044357')`);
  const msBarra = Date.now() - t0;
  ok('barramento exato vem primeiro', barra.itens[0]?.label === 'H044357' && barra.itens[0]?.type === 'poste', JSON.stringify(barra.itens[0]));
  ok('resultado indica o campo e o poste', /^Barramento · Poste 10758734/.test(barra.itens[0]?.subtitle || ''), barra.itens[0]?.subtitle);
  console.log(`      tempo da busca: ${msBarra} ms`);
  const barraMin = await js(`window.__digitar('h0443')`);
  ok('barramento por começo e sem diferenciar maiúsculas', barraMin.itens.filter((i) => i.label.startsWith('H0443')).length >= 2, `${barraMin.itens.length} itens`);
  await foto('busca-barramento');
  const foco = await js(`(async () => {
    await window.__digitar('H044357');
    const r = await window.__enter();
    const s = window.__neo.library.get('poste');
    return { ...r, rid: window.__searchTest.suggestions().length };
  })()`);
  const alvo = await js(`(async () => {
    const r = await window.desktop.dbSql('SELECT "_lat" lat, "_lon" lon FROM poste WHERE "_id" = \\'10758734\\'', 1);
    return r?.result;
  })()`).catch(() => null);
  ok('Enter no barramento leva ao poste', foco.zoom >= 15 && foco.campo === 'H044357', JSON.stringify(foco));
  if (alvo) console.log(`      poste na base: ${JSON.stringify(alvo).slice(0, 160)}`);
  const placa = await js(`window.__digitar('T18120')`);
  ok('placa de instalação', placa.itens.some((i) => i.label === 'T18120' && i.type === 'inst' && /^Placa · Instalação 42666/.test(i.subtitle)), JSON.stringify(placa.itens[0]));
  const inst = await js(`window.__digitar('42666')`);
  ok('número de instalação', inst.itens.some((i) => i.label === '42666' && i.type === 'inst'), JSON.stringify(inst.itens[0]));
  const poste = await js(`window.__digitar('10758734')`);
  ok('número de poste continua funcionando', poste.itens.some((i) => i.label === '10758734' && i.type === 'poste'), JSON.stringify(poste.itens[0]));
  await pausa(500);
  ok('códigos não foram enviados ao serviço de endereços', (await js('window.__externos.length')) === 0, JSON.stringify(await js('window.__externos')));

  // ---- UTM ----
  const utm = await js(`window.__digitar('25M 291443 9108420')`);
  ok('UTM aparece como coordenada', utm.itens[0]?.kind === 'coordinate' && utm.itens[0]?.label === 'UTM 25M 291443 9108420', JSON.stringify(utm.itens[0]));
  await foto('busca-utm');
  const foiUtm = await js(`window.__enter()`);
  ok('Enter no UTM centraliza no ponto', Math.abs(foiUtm.lat - (-8.0615)) < 1e-3 && Math.abs(foiUtm.lon - (-34.8925)) < 1e-3, JSON.stringify(foiUtm));
  ok('UTM deixa a marca no mapa', foiUtm.marcas === 1);
  await js(`window.__neo.mapView.map.setView([-8.3, -35.5], 15, { animate: false })`);
  const invalido = await js(`window.__digitar('25M 5151515 51515151')`);
  ok('UTM fora do intervalo avisa', /fora do intervalo/.test(invalido.texto) && invalido.itens.length === 0, invalido.texto.replace(/\s+/g, ' '));
  await foto('busca-utm-invalido');
  const naoFoi = await js(`window.__enter()`);
  ok('UTM inválido não move o mapa', Math.abs(naoFoi.lat - (-8.3)) < 1e-6 && Math.abs(naoFoi.lon - (-35.5)) < 1e-6, JSON.stringify(naoFoi));
  const invertida = await js(`window.__digitar('-34,8925 -8,0615')`);
  ok('coordenada invertida em Pernambuco é corrigida', Math.abs(invertida.itens[0]?.lat + 8.0615) < 1e-6, JSON.stringify(invertida.itens[0]));
  await pausa(500);
  ok('coordenadas não foram enviadas ao serviço de endereços', (await js('window.__externos.length')) === 0, JSON.stringify(await js('window.__externos')));
  await js(`window.__digitar(''); window.__neo.mapView.clearSearchMarker()`);

  // ---- controles de camadas ----
  await js(`window.__neo.mapView.map.setView([-8.0615, -34.8925], 17, { animate: false })`);
  await pausa(1500);
  const nomes = await js(`[...document.querySelectorAll('#mapLegend label.legend-item')].map((l) => l.innerText.trim())`);
  ok('legenda mostra as camadas e os três controles', ['Postes', 'Rede BT', 'Rede MT', 'Instalações', 'Arruamento', 'KML', 'Rótulos'].every((n) => nomes.includes(n)), nomes.join(', '));
  const caixa = await js(`(() => { const a = document.querySelector('#mapLegend').getBoundingClientRect(), b = document.querySelector('#mapStage').getBoundingClientRect(); return { dentro: a.left >= b.left && a.right <= b.right && a.bottom <= b.bottom, l: a.width, h: a.height }; })()`);
  ok('legenda cabe no mapa', caixa.dentro, JSON.stringify(caixa));
  await foto('camadas-ligadas');

  // Rótulos
  const conta = `(async () => { await window.__neo.mapView.renderer.renderComplete(); return window.__neo.mapView.renderer.lastStats.labels; })()`;
  const comRotulos = await js(conta);
  ok('rótulos aparecem ligados', comRotulos > 0 && (await js(`window.__marcado('data-extra=rotulos')`)).checked, `${comRotulos} rótulos`);
  await js(`window.__clicar('data-extra=rotulos')`);
  const semRotulos = await js(conta);
  ok('desligar Rótulos tira os rótulos', semRotulos === 0, `${semRotulos} rótulos`);
  ok('botões Aa ficam inativos com a chave geral desligada', await js(`[...document.querySelectorAll('#mapLegend [data-rot]')].every((b) => b.disabled)`));
  // Estilos → Camadas é o lugar único das opções de exibição.
  await js(`document.querySelector('#navEstilos').click()`);
  await pausa(600);
  const sp = await js(`({ aba: SP.aba, linhas: document.querySelectorAll('#spc .sp-cam-n').length, geral: document.querySelector('#spc .sec input[type=checkbox]').checked })`);
  ok('Estilos abre em Camadas com as 6 camadas', sp.aba === 'camadas' && sp.linhas === 6, JSON.stringify(sp));
  ok('Estilos → Camadas acompanha a chave geral', sp.geral === false, JSON.stringify(sp));
  await js(`document.querySelector('#spc .sec input[type=checkbox]').click()`);
  await pausa(300);
  ok('ligar em Estilos marca a legenda', (await js(`window.__marcado('data-extra=rotulos')`)).checked === true);
  await foto('estilos-camadas');

  // Rótulos por camada (botão Aa da legenda)
  const comTodos = await js(conta);
  for (const g of ['poste', 'inst', 'bt', 'mt']) await js(`document.querySelector('#mapLegend [data-rot=${g}]').click()`);
  await pausa(400);
  const semRede = await js(conta);
  ok('Aa desliga os rótulos de cada camada', comTodos > 0 && semRede === 0, `${comTodos} -> ${semRede}`);
  ok('Aa fica desmarcado e Estilos acompanha', await js(`document.querySelector('#mapLegend [data-rot=poste]').getAttribute('aria-pressed') === 'false' && CFG.mapa.rot.poste === false`));
  await js(`document.querySelector('#mapLegend [data-rot=poste]').click()`);
  await pausa(400);
  const soPostes = await js(conta);
  ok('ligar só os postes traz só os rótulos dos postes', soPostes > 0 && soPostes < comTodos, `${soPostes} de ${comTodos}`);
  ok('camada continua visível sem rótulo', await js(`window.NG.camadaVisivel('mt') && window.NG.camadaVisivel('bt')`));
  for (const g of ['inst', 'bt', 'mt']) await js(`document.querySelector('#mapLegend [data-rot=${g}]').click()`);
  await pausa(400);
  // A contagem oscila alguns rótulos entre quadros (colisões e limite por quadro): compara com folga de 5%.
  const religados = await js(conta);
  ok('religar devolve todos os rótulos', religados >= comTodos * 0.95, `${religados} de ${comTodos}`);
  // Mostrar/ocultar pela tela de Estilos
  await js(`document.querySelector('#spc [data-sp-mostrar=mt]').click()`);
  await pausa(500);
  ok('Estilos → Camadas oculta a rede MT e a legenda acompanha', await js(`!window.NG.camadaVisivel('mt') && !window.__marcado('data-camada=mt').checked`));
  await js(`document.querySelector('#spc [data-sp-mostrar=mt]').click()`);
  await pausa(500);
  ok('e mostra de novo', await js(`window.NG.camadaVisivel('mt') && window.__marcado('data-camada=mt').checked`));
  await js(`fecharSP()`);

  // Arruamento
  const ruas0 = await js(`({ cfg: CFG.dxf.ruas, ligada: ruasMapa.ligada(), caixa: window.__marcado('data-extra=ruas'), botao: document.querySelector('#mapStreets').classList.contains('is-active'), lay: document.querySelector('#lay-ruas').checked })`);
  ok('Arruamento inicia conforme a configuração', ruas0.cfg === ruas0.ligada && ruas0.caixa.checked === ruas0.cfg && ruas0.botao === ruas0.cfg && ruas0.lay === ruas0.cfg, JSON.stringify(ruas0));
  if (!ruas0.cfg) await js(`window.__clicar('data-extra=ruas')`);
  await js(`window.__neo.mapView.map.fire('moveend'); ruasMapa.pronto()`);
  await pausa(800);
  const ruasL = await js(`({ n: ruasMapa.desenhadas(), cfg: CFG.dxf.ruas })`);
  ok('Arruamento ligado desenha as ruas guardadas', ruasL.n > 0 && ruasL.cfg === true, JSON.stringify(ruasL));
  const nomesRuas = await js(`ruasMapa.nomes()`);
  ok('Arruamento mostra os nomes das ruas', nomesRuas > 0, `${nomesRuas} nomes`);
  await foto('camadas-arruamento');
  await js(`document.querySelector('#mapLegend [data-rot=ruas]').click(); ruasMapa.pronto()`);
  await pausa(600);
  ok('Aa do Arruamento tira os nomes e mantém as ruas', (await js(`ruasMapa.nomes()`)) === 0 && (await js(`ruasMapa.desenhadas()`)) > 0);
  await js(`document.querySelector('#mapLegend [data-rot=ruas]').click(); ruasMapa.pronto()`);
  await pausa(600);
  ok('e devolve os nomes', (await js(`ruasMapa.nomes()`)) > 0);
  await js(`CFG.mapa.ruas.cor = '#00ff00'; ruasMapa.redesenhar(); ruasMapa.pronto()`);
  await pausa(600);
  ok('cor do arruamento vem de Estilos', await js(`ruasMapa.desenhadas() > 0 && (() => { let c = null; window.__neo.mapView.map.eachLayer((l) => { if (l instanceof L.Polyline && l.options.color === '#00ff00') c = true; }); return c; })()`));
  await js(`CFG.mapa.ruas.cor = cfgPadrao().mapa.ruas.cor; ruasMapa.redesenhar()`);
  await js(`window.__clicar('data-extra=ruas')`);
  const ruasD = await js(`({ cfg: CFG.dxf.ruas, ligada: ruasMapa.ligada(), noMapa: ruasMapa.noMapa(), botao: document.querySelector('#mapStreets').classList.contains('is-active'), lay: document.querySelector('#lay-ruas').checked, caixa: window.__marcado('data-extra=ruas') })`);
  ok('desligar Arruamento apaga e tira do DXF', !ruasD.cfg && !ruasD.ligada && !ruasD.noMapa && !ruasD.botao && !ruasD.lay && !ruasD.caixa.checked, JSON.stringify(ruasD));
  await js(`document.querySelector('#mapStreets').click()`);
  await pausa(600);
  const ruasB = await js(`({ cfg: CFG.dxf.ruas, ligada: ruasMapa.ligada(), caixa: window.__marcado('data-extra=ruas'), botao: document.querySelector('#mapStreets').classList.contains('is-active') })`);
  ok('botão da barra e legenda são o mesmo controle', ruasB.cfg && ruasB.ligada && ruasB.caixa.checked && ruasB.botao, JSON.stringify(ruasB));

  // Com o projeto aberto, só o desenho dele aparece sobre o mapa.
  const pausada = await js(`(() => { window.NG.modoProjeto(true); const a = ruasMapa.noMapa(); window.NG.modoProjeto(false); return { a, b: ruasMapa.noMapa() }; })()`);
  ok('ruas guardadas somem no projeto e voltam ao sair', !pausada.a && pausada.b, JSON.stringify(pausada));

  // KML
  const kml0 = await js(`window.__marcado('data-extra=kml')`);
  ok('KML sem arquivo fica desmarcado', !kml0.checked, JSON.stringify(kml0));
  await js(`window.__clicar('data-extra=kml')`);
  const dialogo = await js(`({ aberto: document.querySelector('#kmlDialog').open, caixa: window.__marcado('data-extra=kml') })`);
  ok('KML sem arquivo abre a importação', dialogo.aberto && !dialogo.caixa.checked, JSON.stringify(dialogo));
  await js(`document.querySelector('#kmlDialog').close()`);
  await js(`window.__neo.kml.importFiles([new File([${JSON.stringify(KML)}], 'teste.kml')])`);
  await js(`window.__neo.mapView.map.setView([-8.0615, -34.8925], 17, { animate: false })`);
  await pausa(800);
  // O mapa usa canvas: as formas não viram elementos, então conta o que está no grupo do KML no mapa.
  const kmlPane = `(() => { let n = 0; window.__neo.mapView.map.eachLayer((c) => { if (c.options?.pane === 'kmlPane' && (c instanceof L.Path)) n++; }); return n; })()`;
  const rotKml = `document.querySelectorAll('.kml-label').length`;
  ok('KML importado aparece e marca a caixa', (await js(kmlPane)) > 0 && (await js(`window.__marcado('data-extra=kml')`)).checked, `${await js(kmlPane)} formas`);
  ok('KML traz rótulos', (await js(rotKml)) > 0, `${await js(rotKml)} rótulos`);
  await foto('camadas-kml');
  await js(`window.__clicar('data-extra=rotulos')`);
  ok('Rótulos desligado também vale para o KML', (await js(rotKml)) === 0);
  await js(`window.__clicar('data-extra=rotulos')`);
  await js(`document.querySelector('#mapLegend [data-rot=kml]').click()`);
  await pausa(500);
  ok('Aa do KML tira os nomes e mantém as formas', (await js(rotKml)) === 0 && (await js(kmlPane)) > 0);
  await js(`document.querySelector('#mapLegend [data-rot=kml]').click()`);
  await pausa(500);
  ok('e devolve os nomes do KML', (await js(rotKml)) > 0);
  await js(`window.NG.kmlOpcao('showLines', false)`);
  await pausa(300);
  ok('Estilos → KML sem linhas tira as linhas', (await js(kmlPane)) === 1, `${await js(kmlPane)} formas`);
  await js(`window.NG.kmlOpcao('showLines', true)`);
  ok('KML não é gravado no armazenamento', await js(`!('files' in JSON.parse(localStorage.getItem('neogrid.kml.v1') || '{}'))`));
  await js(`window.__clicar('data-extra=kml')`);
  ok('desligar KML tira do mapa', (await js(kmlPane)) === 0 && !(await js(`window.__marcado('data-extra=kml')`)).checked);
  ok('motor do Projeto acompanha o KML', (await js(`ativo.kmlp === false && ativo.kmll === false && ngCamadaLigada('kml') === false`)));
  await js(`window.__clicar('data-extra=kml')`);
  ok('ligar KML devolve ao mapa', (await js(kmlPane)) > 0 && (await js(`ativo.kmlp === true`)));

  // Camadas da rede continuam funcionando como caixas.
  const mt = await js(`(async () => { const a = window.NG.camadaVisivel('mt'); await window.__clicar('data-camada=mt'); const b = window.NG.camadaVisivel('mt'); const m = window.__marcado('data-camada=mt'); await window.__clicar('data-camada=mt'); return { a, b, m, c: window.NG.camadaVisivel('mt') }; })()`);
  ok('Rede MT liga e desliga pela caixa', mt.a && !mt.b && !mt.m.checked && mt.m.off && mt.c, JSON.stringify(mt));

  // Escolhas continuam depois de reabrir; o KML não (é temporário).
  await js(`window.__clicar('data-extra=ruas')`);
  await js(`window.__clicar('data-extra=rotulos')`);
  await js(`window.ngMapa.definirRotulo('inst', false)`);
  await pausa(1200);   // a configuração do Projeto é gravada 600 ms depois da última mudança
  await abrir();
  for (let i = 0; i < 40 && !(await js(`document.querySelector('#mapLegend [data-extra=kml]') && typeof ativo !== 'undefined'`)); i++) await pausa(250);
  await pausa(1000);
  const depois = await js(`({ ruas: window.__marcado('data-extra=ruas'), kml: window.__marcado('data-extra=kml'), rot: window.__marcado('data-extra=rotulos'), cfg: CFG.dxf.ruas, ligada: ruasMapa.ligada(), kmlArq: window.__neo.kml.hasData(), rotInst: CFG.mapa.rot.inst, aaInst: document.querySelector('#mapLegend [data-rot=inst]').getAttribute('aria-pressed') })`);
  ok('escolhas continuam depois de reabrir', !depois.ruas.checked && !depois.rot.checked && !depois.cfg && !depois.ligada && depois.rotInst === false && depois.aaInst === 'false', JSON.stringify(depois));
  ok('KML não volta ao reabrir', !depois.kmlArq && !depois.kml.checked, JSON.stringify(depois));
  // Devolve o perfil de teste ao estado padrão: os outros E2E contam com o arruamento ligado.
  await js(`window.ngMapa.definirRotulo('inst', true); window.NG.definirRotulosGerais(true); if (!CFG.dxf.ruas) window.__clicar('data-extra=ruas')`);
  await pausa(1200);
  const indiceReaberto = await js(`(async () => { const t = performance.now(); await window.__digitar('H044357'); return { ms: Math.round(performance.now() - t), estado: window.__neo.library.searchFields.estado }; })()`);
  ok('índice é reaproveitado ao reabrir', indiceReaberto.estado === 'pronto', JSON.stringify(indiceReaberto));

  ok('sem erros de script', erros.length === 0, erros.join(' | ').slice(0, 400));
  ws.close();
  console.log(`\n${total - falhas}/${total} verificações passaram`);
  process.exit(falhas ? 1 : 0);
}

main().catch((erro) => { console.error(erro); process.exit(2); });
