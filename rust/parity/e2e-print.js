'use strict';
// E2E da impressão pelo botão do mapa, no app real, via CDP. Não abre a janela de impressão:
// troca window.print por uma captura do que está na folha naquele instante.
// Uso: node e2e-print.js --port 9222 --db base.sqlite --out pasta
//   opcionais: --lat -8.0615 --lon -34.8925
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const PORT = Number(args.port || 9222);
const DB = String(args.db || '').replace(/\\/g, '/');
const OUT = path.resolve(args.out || '.');
const LAT = Number(args.lat || -8.0615);
const LON = Number(args.lon || -34.8925);
fs.mkdirSync(OUT, { recursive: true });
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

let falhas = 0;
let total = 0;
function ok(nome, cond, extra = '') {
  total++;
  if (!cond) falhas++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${nome}${extra !== '' ? '  -> ' + extra : ''}`);
}

// Instrumentação: conta os rótulos desenhados e captura a folha no instante da impressão.
const INSTR = `(() => {
  const R = window.__neo.mapView.renderer, map = window.__neo.mapView.map;
  const labelOrig = R.label.bind(R);
  let c = null;
  R.label = function (lines, x, y, color, mode = 'right', angle = 0, maxLabels = Infinity) {
    const antes = R.labelCount;
    labelOrig(lines, x, y, color, mode, angle, maxLabels);
    if (c && R.labelCount !== antes) c[mode === 'center' ? 'redes' : 'pontos']++;
  };
  const dv = R.drawVisible.bind(R);
  R.drawVisible = function (v, f) {
    c = { pontos: 0, redes: 0 };
    dv(v, f);
    window.__quadro = { ...c, zoom: f.zoom, padX: R.padX, canvasW: R.canvas.width, visiveis: { poste: v.poste.length, bt: v.bt.length, mt: v.mt.length, inst: v.inst.length } };
    c = null;
  };
  const tinta = () => {
    const o = R.canvas, k = Math.min(1, 1600 / o.width), t = document.createElement('canvas');
    t.width = Math.round(o.width * k); t.height = Math.round(o.height * k);
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(o, 0, 0, t.width, t.height);
    const d = g.getImageData(0, 0, t.width, t.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return { n, png: t.toDataURL('image/png') };
  };
  const imgs = () => [...document.querySelectorAll('#printMapSlot img.leaflet-tile')];
  window.__medir = (folha, escala, todos) => new Promise((resolve) => {
    document.querySelector('#printSheet').value = folha;
    document.querySelector('#printOrientation').value = 'l';
    document.querySelector('#printScale').value = String(escala);
    document.querySelector('#printAllLabels').checked = todos;
    const t0 = performance.now();
    window.__espera = setInterval(() => {
      const s = document.querySelector('#printStatus');
      if (!s.hidden && !document.querySelector('#printStatusGo').hidden) {
        clearInterval(window.__espera);
        resolve({ bloqueou: true, texto: document.querySelector('#printStatusText').textContent, titulo: document.querySelector('#printStatusTitle').textContent });
      }
    }, 100);
    window.print = () => {
      clearInterval(window.__espera);
      const t = tinta();
      window.__png = t.png;
      resolve({
        bloqueou: false,
        ms: Math.round(performance.now() - t0),
        dbBusy: R.dbBusy,
        statusVisivel: !document.querySelector('#printStatus').hidden,
        tinta: t.n,
        imgs: imgs().length,
        imgsPendentes: imgs().filter((i) => !i.complete).length,
        modo: R.printMode,
        quadro: window.__quadro,
        stats: { ...R.lastStats },
        tamanho: map.getSize(),
        zoomMapa: map.getZoom(),
      });
    };
    document.querySelector('#printGo').click();
  });
  window.__fim = () => { window.dispatchEvent(new Event('afterprint')); };
  return true;
})()`;

async function main() {
  let pagina = null;
  for (let i = 0; i < 60 && !pagina; i++) {
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
  await send('Runtime.enable');
  await send('Page.enable');
  const origem = new URL(pagina.url).origin;
  for (let i = 0; i < 20 && (await js('document.readyState').catch(() => '')) !== 'complete'; i++) await pausa(250);
  const prefs = await js(`Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('neogrid.')).map((k) => [k, localStorage.getItem(k)]))`);
  await send('Page.navigate', { url: `${origem}/index.html?test=1` });
  for (let i = 0; i < 60 && !(await js('Boolean(window.__neo && window.__neo.ready)').catch(() => false)); i++) await pausa(500);
  await js(`window.__neo.openDatabase(${JSON.stringify(DB)})`);
  await pausa(1500);
  await js(INSTR);

  const abrir = async () => {
    await js(`window.__neo.mapView.map.setView([${LAT}, ${LON}], 17, {animate:false}); document.querySelector('#mapPrint').click();`);
    await pausa(900);
  };
  const salvarPng = async (nome) => {
    const b64 = await js('window.__png');
    fs.writeFileSync(path.join(OUT, `${nome}.png`), Buffer.from(b64.split(',')[1], 'base64'));
  };
  const resultados = {};

  for (const [escala, todos] of [[1000, false], [1000, true], [2000, false], [2000, true], [5000, false], [5000, true]]) {
    const rot = `A1_${escala}_${todos ? 'todos' : 'padrao'}`;
    await abrir();
    const r = await js(`window.__medir('A1', ${escala}, ${todos})`);
    if (r.bloqueou) {
      ok(`${rot}: imprime sem bloqueio`, false, r.texto);
      await js(`document.querySelector('#printStatusCancel').click()`);
      await pausa(800);
      continue;
    }
    await salvarPng(rot);
    resultados[rot] = r;
    console.log(`      ${rot}: ${r.ms} ms, ${r.quadro.pontos} rótulos de pontos, ${r.quadro.redes} de redes, ${r.stats.rotulosOmitidos} omitidos, ${r.stats.rotulosZoom} pelo zoom, elementos ${JSON.stringify(r.quadro.visiveis)}`);
    ok(`${rot}: consulta terminou antes de imprimir`, r.dbBusy === false);
    ok(`${rot}: folha não está em branco`, r.tinta > 1000, r.tinta);
    ok(`${rot}: imagens de fundo prontas`, r.imgsPendentes === 0, `${r.imgs} imagens`);
    ok(`${rot}: quadro é do zoom da impressão`, Math.abs(r.quadro.zoom - r.zoomMapa) < 1e-6, r.quadro.zoom.toFixed(2));
    ok(`${rot}: aviso de progresso fora da folha`, r.statusVisivel === false);
    ok(`${rot}: canvas sem margem desperdiçada`, r.quadro.padX === 0);
    ok(`${rot}: sem corte`, !r.stats.truncated && !(r.stats.cortadas || []).length, JSON.stringify(r.stats.cortadas));
    if (escala === 1000 && !todos) {
      const pdf = await send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
      const bytes = Buffer.from(pdf.result?.data || '', 'base64');
      if (bytes.length) fs.writeFileSync(path.join(OUT, `${rot}.pdf`), bytes);
      const caixa = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(bytes.toString('latin1'));
      const [w, h] = caixa ? [Number(caixa[1]) * 25.4 / 72, Number(caixa[2]) * 25.4 / 72] : [0, 0];
      ok('PDF em tamanho A1', Math.abs(w - 841) < 2 && Math.abs(h - 594) < 2, `${Math.round(w)} x ${Math.round(h)} mm`);
    }
    await js('window.__fim()');
    await pausa(1500);
    const volta = await js(`({ impr: document.body.classList.contains('is-printing'), modo: window.__neo.mapView.renderer.printMode, noLugar: !document.querySelector('#printMapSlot .leaflet-container') })`);
    ok(`${rot}: mapa volta ao normal`, !volta.impr && !volta.modo && volta.noLugar, JSON.stringify(volta));
  }

  const p1 = resultados.A1_1000_padrao;
  const t1 = resultados.A1_1000_todos;
  if (p1) ok('A1 1:1000: redes ganham rótulos', p1.quadro.redes > 0, p1.quadro.redes);
  if (p1 && t1) ok('todos os rótulos desenha mais e sem omitir', t1.quadro.pontos + t1.quadro.redes > p1.quadro.pontos + p1.quadro.redes && !t1.stats.rotulosOmitidos, `${p1.quadro.pontos + p1.quadro.redes} -> ${t1.quadro.pontos + t1.quadro.redes}`);
  const p5 = resultados.A1_5000_padrao;
  const t5 = resultados.A1_5000_todos;
  if (p5) ok('zoom mínimo do estilo é respeitado por padrão', p5.quadro.pontos + p5.quadro.redes === 0 ? p5.stats.rotulosZoom > 0 : true, `${p5.stats.rotulosZoom} ocultos`);
  if (t5) ok('todos os rótulos ignora o zoom mínimo', t5.quadro.pontos + t5.quadro.redes > 0 && !t5.stats.rotulosZoom, t5.quadro.pontos + t5.quadro.redes);

  // Escala em que a rede não é desenhada: precisa parar e explicar antes de gastar papel.
  await abrir();
  const longe = await js(`window.__medir('A1', 50000, false)`);
  ok('escala sem rede avisa antes de imprimir', longe.bloqueou && /não é desenhada/.test(longe.texto), longe.texto);
  await js(`document.querySelector('#printStatusCancel').click()`);
  await pausa(1000);
  const cancelado = await js(`({ impr: document.body.classList.contains('is-printing'), modo: window.__neo.mapView.renderer.printMode })`);
  ok('cancelar devolve o mapa', !cancelado.impr && !cancelado.modo, JSON.stringify(cancelado));

  // Cancelar logo no início não pode deixar nada para trás nem imprimir depois.
  await abrir();
  await js(`window.__imprimiu = false; window.print = () => { window.__imprimiu = true; }; document.querySelector('#printAllLabels').checked = false; document.querySelector('#printScale').value = '1000'; document.querySelector('#printGo').click();`);
  await pausa(150);
  await js(`document.querySelector('#printStatusCancel').click()`);
  await pausa(4000);
  const cedo = await js(`({ impr: document.body.classList.contains('is-printing'), imprimiu: window.__imprimiu })`);
  ok('cancelar no início não imprime', !cedo.impr && !cedo.imprimiu, JSON.stringify(cedo));

  // O mapa na tela continua desenhando depois de tudo isso.
  await js(`document.querySelector('#printClose').click(); window.__neo.mapView.map.setView([${LAT}, ${LON}], 18, {animate:false});`);
  await js(`window.__neo.mapView.renderer.renderComplete()`);
  const tela = await js(`({ q: window.__quadro, adapt: window.__neo.mapView.renderer.printMode, st: window.__neo.mapView.renderer.lastStats.visible })`);
  ok('mapa na tela volta a desenhar', tela.st > 0 && tela.q.padX > 0 && !tela.adapt, `${tela.st} elementos`);

  await js(`(() => { const p = ${JSON.stringify(prefs)}; for (const k of Object.keys(localStorage)) if (k.startsWith('neogrid.') && !(k in p)) localStorage.removeItem(k); for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v); })()`);
  ok('sem erros no console', erros.length === 0, erros.slice(0, 3).join(' || '));
  console.log(`\n${total - falhas}/${total} PASS`);
  ws.close();
  process.exit(falhas ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
