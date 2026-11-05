/* Arruamento: OSM -> pista com largura real -> bordas, prévia e ajuste fino (origem: CTWeb). */
const GRP_LARG = {arterial: ['motorway', 'trunk'], principal: ['primary', 'secondary', 'tertiary'], residencial: ['residential', 'unclassified'], calma: ['living_street'], servico: ['service', 'track'], pedestre: ['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor']};
function tabLarg() {
  const t = {}, c = CFG.dxf.ruasLarg;
  for (const [g, hs] of Object.entries(GRP_LARG)) for (const h of hs) t[h] = +c[g] || RUAS.LARG[h];
  t.outros = +c.outros || 6; return t;
}
// ---- ruas do OpenStreetMap guardadas em "ladrilhos" de 0,02° (no banco local; sem o banco, no navegador) ----
const TL = 0.02, OSM2 = new Map();
const tlChave = (ix, iy) => `osm:${ix}:${iy}`;
async function cacheLer(k) {
  // Primeiro o que foi baixado nesta máquina (mais recente); depois o pacote de ruas offline.
  try { return (await window.NG.wsGet('c:' + k)) || (await window.NG.ruasPackTile(k.replace(/^osm:/, ''))); } catch (e) { return null; }
}
async function cacheGravar(k, v) {
  try { await window.NG.wsPut('c:' + k, v); } catch (e) { /* sem cache: segue sem guardar */ }
}
const MANTER = ['highway', 'name', 'width', 'est_width', 'lanes', 'oneway', 'tunnel', 'bridge'];
async function baixarLadrilhos(faltam, cb, signal) {
  // Consultas menores respondem mais rápido e falham menos: até 3 ladrilhos por lote, 2 lotes de cada vez.
  const lotes = []; for (let i = 0; i < faltam.length; i += 3) lotes.push(faltam.slice(i, i + 3));
  let feitos = 0, proximo = 0;
  const umLote = async lote => {
    const bbs = lote.map(([ix, iy]) => [iy * TL, ix * TL, (iy + 1) * TL, (ix + 1) * TL]);
    const q = `[out:json][timeout:50];(${bbs.map(b => `way["highway"](${b.map(x => x.toFixed(6)).join(',')});`).join('')});out tags geom;`;
    const j = await window.NG.overpassCorrida(OVERPASS, q, {signal, aoServidor: h => cb && cb(`${feitos} de ${faltam.length} ladrilhos · consultando ${h}`, feitos / faltam.length)});
    const ways = j.elements.filter(x => x.geometry && x.tags && x.tags.highway).map(x => {
      const t = {}; for (const k of MANTER) if (x.tags[k] != null) t[k] = x.tags[k];
      const pts = x.geometry.filter(g => g).map(g => [Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6]);
      let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of pts) { a = Math.min(a, p[0]); c = Math.max(c, p[0]); b = Math.min(b, p[1]); d = Math.max(d, p[1]); }
      return {i: x.id, p: pts, t, bb: [a, b, c, d]};
    });
    for (const [k, [ix, iy]] of lote.entries()) {
      const bb = bbs[k], mine = ways.filter(w => w.bb[2] >= bb[0] && w.bb[0] <= bb[2] && w.bb[3] >= bb[1] && w.bb[1] <= bb[3]).map(w => ({i: w.i, p: w.p, t: w.t}));
      await cacheGravar(tlChave(ix, iy), {v: 1, ways: mine, data: new Date().toISOString().slice(0, 10)});
    }
    feitos += lote.length;
    cb && cb(`${feitos} de ${faltam.length} ladrilhos baixados`, feitos / faltam.length);
  };
  const trabalhador = async () => { while (proximo < lotes.length) await umLote(lotes[proximo++]); };
  await Promise.all([trabalhador(), trabalhador()]);
}
function tilesDe(b, pad) {
  const w = b.w - pad, e = b.e + pad, s = b.s - pad, n = b.n + pad, t = [];
  for (let ix = Math.floor(w / TL); ix <= Math.floor(e / TL); ix++) for (let iy = Math.floor(s / TL); iy <= Math.floor(n / TL); iy++) t.push([ix, iy]);
  return t;
}
async function ruasOSM2(S, cb, signal) {
  const bb = S.b, caixa = {w: bb.getWest(), e: bb.getEast(), s: bb.getSouth(), n: bb.getNorth()}, tl = tilesDe(caixa, 0.0012);   // ~130 m de folga
  const chaveMem = tl.map(t => t.join(':')).join(',');
  if (OSM2.has(chaveMem)) return OSM2.get(chaveMem);
  const dados = new Map(), faltam = [];
  let n = 0;
  for (const [ix, iy] of tl) {
    cb && cb('Lendo as ruas guardadas...', ++n / tl.length);
    const t = await cacheLer(tlChave(ix, iy)); if (t) dados.set(ix + ':' + iy, t); else faltam.push([ix, iy]);
  }
  if (faltam.length) {
    await baixarLadrilhos(faltam, cb, signal);
    for (const [ix, iy] of faltam) { const t = await cacheLer(tlChave(ix, iy)); if (t) dados.set(ix + ':' + iy, t); }
  }
  const vistos = new Set(), ways = [];
  for (const t of dados.values()) for (const w of t.ways) {
    if (vistos.has(w.i)) continue; vistos.add(w.i);
    ways.push({pts: w.p, tags: w.t, nome: w.t.name || '', hw: w.t.highway});
  }
  const r = {ways, guardados: tl.length - faltam.length, baixados: faltam.length};
  OSM2.set(chaveMem, r); if (OSM2.size > 6) OSM2.delete(OSM2.keys().next().value);
  return r;
}
// baixa e guarda as ruas de uma região (ex.: área visível) para uso rápido e offline
async function guardarRuas(b) {
  const caixa = {w: b.getWest(), e: b.getEast(), s: b.getSouth(), n: b.getNorth()}, tl = tilesDe(caixa, 0.0012);
  const faltam = []; let k = 0;
  await comProg('Verificando ruas já guardadas...', async () => {
    for (const [ix, iy] of tl) { progSet('Verificando ruas já guardadas...', ++k / tl.length); if (!(await cacheLer(tlChave(ix, iy)))) faltam.push([ix, iy]); }
  });
  if (!faltam.length) { $('#st').textContent = `As ruas desta área já estão guardadas (${tl.length} ladrilhos).`; return; }
  if (faltam.length > 200 && !confirm(`Serão baixados ${faltam.length} ladrilhos de ruas do OpenStreetMap (cada um tem ~2 km). Pode demorar. Continuar?`)) return;
  await comProg('Baixando ruas do OpenStreetMap...', async () => {
    try { await baixarLadrilhos(faltam, (m, f) => progSet(m, f)); $('#st').textContent = `Ruas guardadas: ${faltam.length} ladrilhos novos (${tl.length - faltam.length} já existiam).`; }
    catch (e) { alert('Não foi possível baixar tudo: ' + e.message + '\nO que já foi baixado ficou guardado.'); }
  });
  OSM2.clear();
}
async function ruasGuardadas() {
  try { return await window.NG.wsStats('c:osm:'); } catch (e) { return null; }
}
async function apagarRuasGuardadas() {
  if (!confirm('Apagar todas as ruas do OpenStreetMap guardadas? Elas serão baixadas de novo quando precisar.')) return;
  await window.NG.wsDelPrefix('c:osm:'); OSM2.clear();
  $('#st').textContent = 'Ruas guardadas apagadas';
}
// UTM -> lat/lon (Newton sobre a projeção direta)
function utmInv(x, y, Z, sul) {
  let la = (sul ? y - 1e7 : y) / 110950, lo = (Z - 1) * 6 - 180 + 3 + (x - 500000) / (111320 * Math.cos(la * RAD));
  for (let k = 0; k < 6; k++) {
    const [px, py] = utm(la, lo, Z), ey = py - y, ex = px - x; if (Math.hypot(ex, ey) < 0.005) break;
    const [qx, qy] = utm(la + 1e-5, lo, Z), [rx, ry] = utm(la, lo + 1e-5, Z);
    const a = (qx - px) / 1e-5, b = (rx - px) / 1e-5, c = (qy - py) / 1e-5, d = (ry - py) / 1e-5, det = a * d - b * c;
    la -= (d * ex - b * ey) / det; lo -= (-c * ex + a * ey) / det;
  }
  return [la, lo];
}
// ---------------- indicador de processamento ----------------
const PROG = {n: 0};
function progIni(txt) { PROG.n++; const e = $('#prog'); e.hidden = false; progSet(txt, null); }
function progSet(txt, f) {
  const e = $('#prog'); if (e.hidden) e.hidden = false;
  $('#prog-t').textContent = txt + (f != null ? ` · ${Math.round(f * 100)}%` : '');
  const b = $('#prog-b'); b.parentNode.classList.toggle('ind', f == null); b.style.width = f == null ? '' : Math.max(2, Math.min(100, f * 100)) + '%';
}
function progFim() { if (--PROG.n <= 0) { PROG.n = 0; $('#prog').hidden = true; } }
const comProg = async (txt, fn) => { progIni(txt); try { return await fn(); } finally { progFim(); } };

// ---------------- postes: posição (nunca alterada), raio do símbolo e regra definida pelo usuário ----------------
function raioSimbolo(est, ke) {
  const bl = est.forma === 'bloco' ? BLOCOS[est.bloco] : null; let rs;
  if (bl) { const sc = est.blocoModo === 'original' ? est.blocoK : (est.tam * MPX) / (bl.max || 1); rs = sc * (bl.max || 1) / 2; }
  else rs = Math.max(est.tam, est.tamh || 0) * MPX / 2;
  return Math.min(8, Math.max(0, rs / ke));
}
function projDXF(S) { const ct = S.b.getCenter(), Z = Math.floor((ct.lng + 180) / 6) + 1; return {Z, cc: utm(ct.lat, ct.lng, Z)}; }
// precisa rodar com os dados da seleção ativos (usarSel)
function postesSel(S, Z) {
  const ke = 1000 / (+CFG.dxf.escala || 1000), out = [];
  for (const t of PTS) {
    const g = S.ids[t]; if (!g?.length || t === 'inst') continue;
    const d = D[t], col = t === 'poste' ? d.id : d.nm, uso = new Map();
    for (const [k, lst] of agrupar(t, g)) {
      const r = raioSimbolo(estEf(t, k), ke);
      for (const i of lst) {
        const [x, y] = utm(d.Y[i], d.X[i], Z);
        let id = col >= 0 ? String(d.rows[i][col] ?? '').trim() : '';
        if (!id) id = `${NOME[t] || t} (${d.Y[i].toFixed(6)}, ${d.X[i].toFixed(6)})`;   // sem nome: identifica pela coordenada
        const n = uso.get(id) || 0; uso.set(id, n + 1); if (n) id += ` #${n + 1}`;     // nomes repetidos (comum no KML) não podem compartilhar a regra
        out.push({x, y, r, t, id, key: t + '|' + id, lat: d.Y[i], lon: d.X[i]});
      }
    }
  }
  return out;
}

// calcula as bordas do pavimento ajustadas aos postes. Entradas em UTM absoluto (m); saída em UTM absoluto.
async function calcularRuas(S, osm, postes, Z, cc, cb, signal) {
  cb = cb || (() => {});
  const cf = CFG.dxf, sul = S.b.getCenter().lat < 0, reg = cf.regrasPoste || {};
  RUAS.init(ClipperLib);
  for (const p of postes) {
    const r = reg[p.key]; p.regra = r ? {...r} : null;
    if (r && r.alvo) { const [ax, ay] = utm(r.alvo[0], r.alvo[1], Z); p.regra.ax = ax; p.regra.ay = ay; }
  }
  const tab = tabLarg(), area = S.poly ? S.poly.map(p => utm(p[0], p[1], Z)) : [[S.b.getSouth(), S.b.getWest()], [S.b.getSouth(), S.b.getEast()], [S.b.getNorth(), S.b.getEast()], [S.b.getNorth(), S.b.getWest()]].map(p => utm(p[0], p[1], Z));
  const xs = area.map(p => p[0]), ys = area.map(p => p[1]), pad = 60 + (+cf.ruasMaxDesl || 4);
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  const vias = [];
  cb('Preparando as ruas...', 0.05);
  for (const w of osm.ways) {
    if (w.pts.length < 2 || !cf.ruasTipos[grupoVia(w.hw)]) continue;
    const hw = RUAS.largura(w.tags, {larguras: tab, faixa: +cf.ruasFaixa || 3.2}) / 2;
    const pts = w.pts.map(p => utm(p[0], p[1], Z));
    for (const pc of RUAS.recortarRet(pts, x0, y0, x1, y1)) if (pc.length >= 2) vias.push({pts: pc, hw, nome: w.nome, hwTipo: w.hw});
  }
  const ops = (cf.ruasEdit || []).map(o => { const [x, y] = utm(o.lat, o.lon, Z), q = {...o, x, y}; if (o.lat1 != null) { const [x1, y1] = utm(o.lat1, o.lon1, Z); q.x1 = x1; q.y1 = y1; } return q; });
  const params = {vias, postes, area, org: [cc[0], cc[1]], ops, o: {
    encadear: cf.ruasEncadear !== false, ajustar: cf.ruasAjustar !== false, margem: +cf.ruasMargem || 0, maxDesl: +cf.ruasMaxDesl || 4,
    larguraMin: (+cf.ruasLargMin || 65) / 100, raio: cf.ruasRaio ?? 3, original: !!cf.ruasOriginal}};
  const r = await calcRuasFora(params, cb, signal);
  return {vias: r.vias, rel: r.rel, bordas: r.bordas, orig: r.orig, area, Z, sul, postes};
}
// Calcula em um Web Worker: mesmo em áreas grandes a janela continua respondendo.
function calcRuasFora(params, cb, signal) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker('js/projeto/ruas-worker.js'); } catch (e) { calcRuasCore(params, cb).then(resolve, reject); return; }
    const fim = () => { w.terminate(); signal?.removeEventListener('abort', cancelar); };
    const cancelar = () => { fim(); reject(new DOMException('cancelado', 'AbortError')); };
    if (signal?.aborted) { cancelar(); return; }
    signal?.addEventListener('abort', cancelar);
    w.onmessage = e => {
      const m = e.data;
      if (m.prog) cb(m.prog[0], m.prog[1]);
      else if (m.fim) { fim(); resolve(m.fim); }
      else if (m.erro) { fim(); reject(new Error(m.erro)); }
    };
    w.onerror = e => { fim(); reject(new Error(e.message || 'Falha no cálculo das pistas.')); };
    w.postMessage(params);
  });
}

// ---------------- prévia na tela, com regras por poste ----------------
const RP = {S: null, osm2: null, Z: 0, cc: null, R: null};
const COR_ST = {ok: '#3ddc84', centro: '#ffd400', impossivel: '#ff3b30', ign: '#8a94a6', alvo: '#3aa0ff'};
function desenharRuas() {
  const R = RP.R; if (!R) return;
  osmGrp.clearLayers();
  const ll = pts => pts.map(p => utmInv(p[0], p[1], R.Z, R.sul));
  for (const b of R.bordas) { const l = ll(b.pts); if (b.fechado) l.push(l[0]); L.polyline(l, {color: '#ff9f1c', weight: 2, interactive: false}).addTo(osmGrp); }
  if (R.orig) for (const b of R.orig) { const l = ll(b.pts); if (b.fechado) l.push(l[0]); L.polyline(l, {color: '#7a869a', weight: 1, dashArray: '4 4', interactive: false}).addTo(osmGrp); }
  const por = new Map(R.postes.map(p => [p.key, p]));
  for (const o of (CFG.dxf.ruasEdit || []).filter(q => isFinite(q.R) && q.R > 0 && q.R < 1e6)) L.circle([o.lat, o.lon], {radius: o.R, color: '#a78bfa', weight: 1, dashArray: '2 5', fill: false, interactive: false}).addTo(osmGrp);   // áreas dos ajustes finos
  for (const it of R.rel.todos) {
    const p = por.get(it.key), pos = p ? [p.lat, p.lon] : utmInv(it.x, it.y, R.Z, R.sul);   // posição original do poste, sem alteração
    const tr = it.regra && it.regra.lado;
    const m = L.circleMarker(pos, {radius: 7, color: tr ? '#ffffff' : COR_ST[it.st], weight: tr ? 3 : 2, fillColor: COR_ST[it.st], fillOpacity: .55}).addTo(osmGrp);
    m.bindPopup(() => popupPoste(it), {minWidth: 220});
    if (it.regra && it.regra.alvo) { L.polyline([pos, it.regra.alvo], {color: COR_ST.alvo, weight: 1.5, dashArray: '3 3', interactive: false}).addTo(osmGrp); L.circleMarker(it.regra.alvo, {radius: 3, color: COR_ST.alvo, weight: 2, fillOpacity: 0, interactive: false}).addTo(osmGrp); }
  }
}
function popupPoste(it) {
  const reg = CFG.dxf.regrasPoste, atual = reg[it.key], div = mk('div');
  const sit = {ok: 'símbolo fora da pista', centro: 'só o centro fora da pista', impossivel: it.ladoErrado ? 'não foi possível respeitar o lado' : 'dentro da pista (sem solução)', ign: 'ignorado no ajuste', alvo: 'posição definida por você'}[it.st];
  div.append(mk('b', null, (NOME[it.t] || it.t) + ' ' + it.id), mk('div', {style: 'margin:4px 0;font-size:12px'}, sit + (it.dist != null ? ` · ${it.dist.toFixed(2).replace('.', ',')} m da borda` : '') + (atual ? ' · regra: ' + (atual.ign ? 'ignorar' : atual.alvo ? 'posição escolhida' : 'lado fixo') : '')));
  const aplica = async nova => { if (nova) reg[it.key] = nova; else delete reg[it.key]; salvar(); map.closePopup(); await comProg('Recalculando o arruamento...', recalcularRuas); };
  const bt = (t, f, cls) => mk('button', {style: 'display:block;width:100%;margin:3px 0', class: cls || '', onclick: f}, t);
  if (it.st !== 'ign') { bt && div.append(bt('Manter a rua deste lado', () => aplica({lado: it.lado})), bt('Passar a rua para o outro lado', () => aplica({lado: -it.lado})), bt('Ignorar este poste (pode ficar na pista)', () => aplica({ign: true}))); }
  if (it.st !== 'ign') div.append(bt('Definir onde ele deve aparecer…', () => escolherAlvo(it, aplica), 'p'));
  if (atual) div.append(bt('Voltar ao automático', () => aplica(null)));
  return div;
}
// o usuário clica no poste e depois no mapa, no ponto onde quer vê-lo em relação à rua; o poste não sai da coordenada, a rua se ajusta
function escolherAlvo(it, aplica) {
  map.closePopup();
  const st = $('#st'), antes = st.textContent, cont = map.getContainer(), cur = cont.style.cursor;
  st.textContent = `Clique no mapa no ponto onde o poste ${it.id} deve aparecer em relação à rua (Esc cancela)`;
  modoSet(`Posição do poste ${it.id}: clique no mapa onde ele deve aparecer em relação à rua`);
  cont.style.cursor = 'crosshair';
  const fim = () => { map.off('click', ao); document.removeEventListener('keydown', esc, true); cont.style.cursor = cur; };
  const ao = e => { fim(); st.textContent = antes; modoFim(); aplica({alvo: [e.latlng.lat, e.latlng.lng]}); };
  const esc = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); fim(); st.textContent = antes; modoFim(); } };
  map.on('click', ao); document.addEventListener('keydown', esc, true);
}
// assinatura de tudo o que influencia o arruamento calculado: o DXF reaproveita exatamente o resultado da prévia quando ela ainda vale
function sigRuas() {
  const cf = CFG.dxf, k = ['ruas', 'ruasModo', 'ruasAjustar', 'ruasMargem', 'ruasMaxDesl', 'ruasLargMin', 'ruasFaixa', 'ruasOriginal', 'ruasRaio', 'ruasEncadear', 'ruasLarg', 'ruasTipos', 'regrasPoste', 'ruasEdit', 'escala'];
  const ids = SEL ? Object.entries(SEL.ids || {}).map(([t, v]) => t + ':' + v.length) : [];
  return JSON.stringify([k.map(x => cf[x]), SEL && SEL.b.toBBoxString(), SEL && SEL.poly, ids, [...Object.keys(CFG.cam)].map(t => JSON.stringify(CFG.cam[t].base) + JSON.stringify(CFG.cam[t].rules))]);
}
async function recalcularRuas() {
  const sg = sigRuas(); PREV.calc = 'calculando'; PREV.etapa = 'Calculando o arruamento...'; arrStatus();
  const R = await calcularRuas(RP.S, RP.osm2, RP.postes, RP.Z, RP.cc, (m, f) => { PREV.etapa = m; arrStatus(); progSet(m, f); });
  RP.R = R; RP.sig = sg; PREV.calc = 'ok'; SEL.ruasR = R; desenharRuas(); relatorioRuas(R); arrStatus();
  $('#st').textContent = `Arruamento: ${nBR(R.rel.ok)} postes com o símbolo fora da pista, ${nBR(R.rel.centro)} só com o centro, ${nBR(R.rel.impossivel)} sem solução, ${nBR(R.rel.ignorados || 0)} ignorados. Clique num poste para definir a regra.`;
}
// prévia automática: recalcula o arruamento na tela pouco depois de qualquer mudança nas opções (ou ao selecionar a área)
let tPrev = 0, prevOcupada = false, prevSel = null;
function limparPrevia() { clearTimeout(tPrev); osmGrp.clearLayers(); EDT.fant.clearLayers(); EDT.vtx.clearLayers(); arrStatus(); }
// ---- camada "Arruamento": liga/desliga a prévia no mapa e a inclusão no DXF ----
const camadaRuasLigada = () => !!CFG.dxf.ruas;
function syncCamadaRuas(comAviso) {
  const c = $('#lay-ruas'); if (c) c.checked = camadaRuasLigada();
  window.ngRuasMapa?.definir(camadaRuasLigada(), comAviso);
  window.NG?.camadasPintar?.();
}
function camadaRuas(on, comAviso) {
  CFG.dxf.ruas = on; salvar(); syncCamadaRuas(comAviso); renderOpcoesRuas(); if (!$('#dxp').hidden) abrirDxp();
  if (on) { if (SEL) previaAuto(true); } else { if (EDT.tool) edtFerramenta(EDT.tool); limparPrevia(); }
  arrStatus();
}
function limparPoligono() {
  sairModos(); clearTimeout(tPrev); selGrp.clearLayers(); osmGrp.clearLayers(); EDT.fant.clearLayers(); EDT.vtx.clearLayers();
  SEL = null; if (typeof PJ !== 'undefined' && PJ.on) projSair(); RP.R = null; RP.S = null; PREV.calc = null; PREV.osm = null; $('#arrq').replaceChildren(); $('#dxq')?.replaceChildren();
  if (typeof prjUI === 'function') prjUI(); selInfo('Área removida. Escolha como selecionar uma nova área.'); $('#st').textContent = 'Área e prévia removidas'; arrStatus();
}
async function reiniciarArruamento() {
  if (!confirm('Reiniciar o arruamento do zero? Isso apaga todos os ajustes finos e as regras de postes desta área e recalcula.')) return;
  sairModos(); CFG.dxf.ruasEdit = []; CFG.dxf.regrasPoste = {}; salvar(); EDT.fant.clearLayers(); EDT.vtx.clearLayers();
  if (SEL && camadaRuasLigada()) await mostrarArruamento(); else { limparPrevia(); $('#arrq').replaceChildren(); }
  $('#st').textContent = 'Arruamento reiniciado: ajustes e regras apagados'; arrStatus();
}
// ---- barra de situação do arruamento ----
const PREV = {calc: null, etapa: '', osm: null, erro: ''};
function arrStatus() {
  const box = $('#arrs'); if (!box) return;
  const ops = (CFG.dxf.ruasEdit || []).length, nreg = Object.keys(CFG.dxf.regrasPoste || {}).length, on = camadaRuasLigada();
  let area = ['', 'Nenhuma área selecionada: use Retângulo ou Polígono'];
  if (modo) area = ['run', 'Desenhando a área no mapa...'];
  else if (SEL) { const b = SEL.b, c = b.getCenter(); area = ['ok', `Selecionada (${Math.round((b.getEast() - b.getWest()) * 111320 * Math.cos(c.lat * RAD))} × ${Math.round((b.getNorth() - b.getSouth()) * 111320)} m)`]; }
  const osm = PREV.calc === 'baixando' ? ['run', PREV.etapa || 'Obtendo as ruas do OpenStreetMap...'] : PREV.osm ? ['ok', `${nBR(PREV.osm)} vias carregadas`] : PREV.calc === 'erro' ? ['er', PREV.erro] : ['', SEL ? 'Ainda não carregadas' : '—'];
  let prev = ['', '—'];
  if (!on) prev = ['', 'Camada Arruamento desligada (não aparece nem entra no DXF)'];
  else if (!SEL) prev = ['', 'Aguardando a seleção da área'];
  else if (PREV.calc === 'calculando') prev = ['run', PREV.etapa || 'Calculando o arruamento...'];
  else if (PREV.calc === 'pendente') prev = ['av', 'Atualizando em instantes (opções mudaram)'];
  else if (PREV.calc === 'erro') prev = ['er', 'Falha: ' + PREV.erro];
  else if (RP.R && RP.S === SEL) { const r = RP.R.rel; prev = ['ok', `Atualizada · ${nBR(r.ok)} postes livres, ${nBR(r.centro + r.impossivel)} a conferir`]; }
  else prev = ['av', 'Ainda não calculada: clique em "Atualizar prévia"'];
  const modoT = EDT.tool ? DICA[EDT.tool] : 'Navegação normal (arrastar o mapa)';
  const lin = (cor, t, v) => [mk('i', {class: cor}), mk('span', null, mk('b', null, t + ': '), v)];
  box.replaceChildren(mk('div', {class: 'st-l'}, ...lin(area[0], 'Área', area[1]), ...lin(osm[0], 'Ruas do OSM', osm[1]), ...lin(prev[0], 'Prévia', prev[1]),
    ...lin(ops || nreg ? 'ok' : '', 'Ajustes', `${ops} ajuste(s) fino(s) · ${nreg} regra(s) de poste`), ...lin(EDT.tool ? 'run' : '', 'Modo', modoT + (EDT.tool ? ' — Esc ou "Sair" volta ao mapa' : ''))));
}

function previaAuto(ja) {
  clearTimeout(tPrev);
  if (!SEL || CFG.dxf.ruasPrevia === false || !camadaRuasLigada()) { arrStatus(); return; }
  PREV.calc = 'pendente'; arrStatus();
  tPrev = setTimeout(async () => {
    if (prevOcupada) { previaAuto(); return; }
    prevOcupada = true;
    try { await mostrarArruamento(true); } finally { prevOcupada = false; }
  }, ja ? 60 : 650);
}
async function mostrarArruamento(auto) {
  if (!SEL) { alert('Selecione uma área primeiro.'); return; }
  const cf = CFG.dxf, primeira = prevSel !== SEL; prevSel = SEL;
  if (cf.ruasModo === 'eixo') return previaOSM();
  await comProg('Baixando as ruas do OpenStreetMap...', async () => {
    try {
      const {Z, cc} = projDXF(SEL);
      PREV.calc = 'baixando'; PREV.etapa = 'Obtendo as ruas do OpenStreetMap...'; arrStatus();
      RP.S = SEL; RP.Z = Z; RP.cc = cc; RP.osm2 = await ruasOSM2(SEL, (m, f) => { PREV.etapa = m; arrStatus(); progSet(m, f); });
      PREV.osm = RP.osm2.ways.length;
      progSet('Lendo os postes da área...', null); await new Promise(r => setTimeout(r, 20));
      RP.postes = usarSel(() => postesSel(SEL, Z));
      await recalcularRuas();
      const b = L.latLngBounds(RP.postes.map(p => [p.lat, p.lon])); if ((primeira || auto !== true) && RP.postes.length && !map.getBounds().contains(b)) map.fitBounds(SEL.b.pad(.05));
    } catch (e) { PREV.calc = 'erro'; PREV.erro = e.message; arrStatus(); if (auto === true) $('#st').textContent = 'Prévia do arruamento indisponível: ' + e.message; else alert('Falha ao montar o arruamento: ' + e.message); console.error(e); }
  });
}
function relatorioRuas(R) {
  const box = $('#arrq'), r = R.rel, reg = CFG.dxf.regrasPoste, nreg = Object.keys(reg).length;
  const csv = () => baixar('ruas_postes_fora_do_ideal.csv', csvTexto(['Camada', 'Elemento', 'Situação', 'Distância do centro à borda do pavimento (m)', 'UTM X', 'UTM Y'],
    r.lista.map(q => [NOME[q.t] || q.t, q.id, q.st === 'centro' ? 'só o centro fora da pista' : 'dentro da pista', q.dist.toFixed(2).replace('.', ','), q.x.toFixed(2).replace('.', ','), q.y.toFixed(2).replace('.', ',')])), 'text/csv;charset=utf-8');
  const dot = c => mk('span', {style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:6px`});
  box.replaceChildren(mk('div', {class: 'qs', style: 'padding:6px;line-height:1.6'},
    mk('b', null, 'Ajuste do arruamento aos postes'), mk('br'),
    dot(COR_ST.ok), `${nBR(r.ok)} com o símbolo inteiro fora da pista`, mk('br'),
    dot(COR_ST.centro), `${nBR(r.centro)} só com o centro fora (símbolo toca a borda)`, mk('br'),
    dot(COR_ST.impossivel), `${nBR(r.impossivel)} sem solução (dentro da pista)`, mk('br'),
    dot(COR_ST.ign), `${nBR(r.ignorados || 0)} ignorados de propósito`, mk('br'),
    ...(r.alvo ? [dot(COR_ST.alvo), `${nBR(r.alvo)} com a posição definida por você`, mk('br')] : []),
    mk('small', null, 'As coordenadas dos postes nunca são alteradas: só a rua se ajusta. Clique num poste no mapa para fixar o lado da rua ou ignorá-lo. Contorno branco = lado fixado.')),
  mk('div', {style: 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap'}, mk('button', {onclick: mostrarArruamento}, 'Atualizar na tela'),
    r.lista.length ? mk('button', {onclick: csv}, 'Lista dos postes fora do ideal (CSV)') : '',
    nreg ? mk('button', {onclick: async () => { if (confirm(`Apagar as ${nreg} regras de postes?`)) { CFG.dxf.regrasPoste = {}; salvar(); await comProg('Recalculando o arruamento...', recalcularRuas); } }}, `Limpar regras (${nreg})`) : ''),
  cartaoEdicao());
}

// ---------------- painel Arruamento ----------------
function abrirArr() {
  renderOpcoesRuas(); syncCamadaRuas(); arrStatus();
  if (RP.R && RP.S === SEL) relatorioRuas(RP.R);
  else $('#arrq').replaceChildren();
}

// ---------------- ajuste fino: eixo, bordas e vértices (polilinhas) ----------------
// modo "eixo": mover/girar/suavizar a rua inteira no trecho, alargar/estreitar (as duas bordas ou só a do lado clicado)
// modo "borda": mexer só numa borda (e no lado clicado): mover, alargar/estreitar, suavizar
// modo "vértices": tratar a borda como polilinha: arrastar, apagar (duplo clique) ou inserir (clique na linha) vértices
const EDT = {modo: 'eixo', tool: null, R: 40, f: 50, d: 1, lado: 'um', pivo: null, arr: null, sel: null, fant: L.layerGroup().addTo(map), vtx: L.layerGroup().addTo(map)};
const FERR = {
  eixo: [['mv', 'Mover', 'Arraste a rua'], ['rot', 'Girar', 'Escolha o centro e arraste ao redor'], ['sua', 'Suavizar', 'Clique no trecho com curvas indesejadas'], ['la', 'Alargar', 'Clique na pista'], ['le', 'Estreitar', 'Clique na pista'], ['all', 'Mover tudo', 'Arraste para deslocar todo o arruamento']],
  borda: [['bmv', 'Mover borda', 'Arraste uma borda'], ['bla', 'Alargar', 'Afasta a borda clicada do eixo'], ['ble', 'Estreitar', 'Aproxima a borda clicada do eixo'], ['bsua', 'Suavizar', 'Clique no trecho da borda']],
  vtx: [['vtx', 'Editar vértices', 'Clique numa borda para ver os vértices']],
};
const DICA = {all: 'Mover tudo: arraste em qualquer ponto do mapa para deslocar todo o arruamento', mv: 'Mover: arraste a partir de um ponto da rua', rot: 'Girar: clique na rua para escolher o centro; depois arraste ao redor dele', sua: 'Suavizar: clique no trecho da rua', la: 'Alargar: clique na pista (do lado que quer alargar)', le: 'Estreitar: clique na pista (do lado que quer estreitar)',
  bmv: 'Mover borda: arraste a partir de um ponto da borda', bla: 'Alargar: clique na borda que deve se afastar do eixo', ble: 'Estreitar: clique na borda que deve se aproximar do eixo', bsua: 'Suavizar: clique no trecho da borda',
  vtx: 'Vértices: clique numa borda; arraste os quadrados; duplo clique apaga; clique na linha insere'};
const mPorPx = () => 156543.03 * Math.cos(map.getCenter().lat * RAD) / Math.pow(2, map.getZoom());
function edtRuaEm(ll) {   // a via ajustada mais próxima do ponto, se o clique caiu em cima da pista
  const R = RP.R; if (!R) return null;
  const [x, y] = utm(ll.lat, ll.lng, R.Z); let best = null;
  for (const v of R.vias) for (let i = 0; i + 1 < v.pts.length; i++) {
    const a = v.pts[i], b = v.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
    if (d <= v.hw + 3 && (!best || d < best.d)) best = {d, v, x, y};
  }
  return best;
}
function edtBordaEm(ll, tolPx = 10) {   // a borda (polilinha) mais próxima do ponto
  const R = RP.R; if (!R) return null;
  const [x, y] = utm(ll.lat, ll.lng, R.Z), tol = Math.max(1.5, tolPx * mPorPx()); let best = null;
  R.bordas.forEach((b, bi) => {
    const P = b.pts, n = P.length, m = b.fechado ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = P[i], c = P[(i + 1) % n], dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
      if (d < tol && (!best || d < best.d)) best = {d, bi, i, x: a[0] + t * dx, y: a[1] + t * dy};
    }
  });
  return best;
}
const ptsLL = (pts, fechado) => { const R = RP.R, l = pts.map(p => utmInv(p[0], p[1], R.Z, R.sul)); if (fechado) l.push(l[0]); return l; };
function edtFantasma(op) {   // durante o arraste: mostra como vai ficar
  EDT.fant.clearLayers(); const R = RP.R;
  const lin = (pts, fech) => L.polyline(ptsLL(pts, fech), {color: '#a78bfa', weight: 3, dashArray: '6 4', interactive: false}).addTo(EDT.fant);
  if (op.t === 'bmv') {
    const b = edtBordaEm(utmInv(op.x, op.y, R.Z, R.sul) && {lat: utmInv(op.x, op.y, R.Z, R.sul)[0], lng: utmInv(op.x, op.y, R.Z, R.sul)[1]}, 6); if (!b) return;
    const cp = [{pts: R.bordas[b.bi].pts.map(p => p.slice()), fechado: R.bordas[b.bi].fechado}]; RUAS.editarBordas(cp, [op], R.vias.map(v => v.pts)); lin(cp[0].pts, cp[0].fechado); return;
  }
  const f = RUAS.campoOp(op);
  for (const v of R.vias) {
    if (!v.pts.some(p => Math.hypot(p[0] - op.x, p[1] - op.y) < op.R)) continue;
    const pts = []; for (let i = 0; i + 1 < v.pts.length; i++) { const a = v.pts[i], b = v.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3)); for (let q = 0; q < n; q++) pts.push([a[0] + (b[0] - a[0]) * q / n, a[1] + (b[1] - a[1]) * q / n]); }
    pts.push(v.pts[v.pts.length - 1]); lin(pts.map(p => f(p[0], p[1])), false);
  }
}
async function edtAplicar(op) {
  const R = RP.R, ll = utmInv(op.x, op.y, R.Z, R.sul), rec = {t: op.t, lat: ll[0], lon: ll[1], R: op.R};
  for (const k of ['vx', 'vy', 'ang', 'f', 'd', 'lado']) if (op[k] != null) rec[k] = op[k];
  if (op.x1 != null) { const l1 = utmInv(op.x1, op.y1, R.Z, R.sul); rec.lat1 = l1[0]; rec.lon1 = l1[1]; }
  (CFG.dxf.ruasEdit ||= []).push(rec);
  salvar(); EDT.fant.clearLayers(); EDT.pivo = null;
  await comProg('Aplicando o ajuste fino...', recalcularRuas);
}
function edtDesligar() { if (EDT.tool) edtFerramenta(EDT.tool); }
function edtFerramenta(t) {
  EDT.tool = EDT.tool === t ? null : t; EDT.pivo = null; EDT.arr = null; EDT.sel = null; EDT.fant.clearLayers(); EDT.vtx.clearLayers();
  EDT.tool ? map.dragging.disable() : map.dragging.enable();
  map.getContainer().style.cursor = EDT.tool ? 'crosshair' : '';
  $('#st').textContent = EDT.tool ? DICA[EDT.tool] + ' (Esc sai)' : 'Ajuste fino desligado';
  EDT.tool ? modoSet(DICA[EDT.tool]) : modoFim(); arrStatus();
  if (RP.R) relatorioRuas(RP.R);
}
function edtVertices(bi) {   // quadrados arrastáveis nos vértices da borda escolhida
  EDT.vtx.clearLayers(); const R = RP.R, b = R.bordas[bi]; if (!b) return; EDT.sel = bi;
  const vb = map.getBounds().pad(0.1); let n = 0;
  L.polyline(ptsLL(b.pts, b.fechado), {color: '#a78bfa', weight: 2, interactive: false}).addTo(EDT.vtx);
  b.pts.forEach(p => {
    const ll = utmInv(p[0], p[1], R.Z, R.sul); if (!vb.contains(ll) || ++n > 500) return;
    const m = L.marker(ll, {draggable: true, icon: L.divIcon({className: 'edt-vtx', iconSize: [11, 11]}), zIndexOffset: 1000}).addTo(EDT.vtx);
    m.on('dragend', () => { const q = m.getLatLng(), [x1, y1] = utm(q.lat, q.lng, R.Z); edtAplicar({t: 'vtx', x: p[0], y: p[1], x1, y1}); });
    m.on('dblclick', ev => { L.DomEvent.stop(ev); edtAplicar({t: 'vdel', x: p[0], y: p[1]}); });
  });
  $('#st').textContent = `Borda com ${b.pts.length} vértices${n > 500 ? ' (mostrando 500)' : ''}: arraste um quadrado; duplo clique apaga; clique na linha insere um vértice`;
}
function cartaoEdicao() {
  const ops = CFG.dxf.ruasEdit || [], ferr = FERR[EDT.modo];
  const modos = mk('div', {style: 'display:flex;gap:4px;margin:6px 0'}, ...[['eixo', 'Eixo'], ['borda', 'Bordas'], ['vtx', 'Polilinhas']].map(([m, l]) => mk('button', {class: EDT.modo === m ? 'p' : '', style: 'flex:1', onclick: () => { if (EDT.tool) edtFerramenta(EDT.tool); EDT.modo = m; relatorioRuas(RP.R); }}, l)));
  const rg = (l, k, mn, mx, un, st = 1) => { const i = mk('input', {type: 'range', min: mn, max: mx, step: st, value: EDT[k], style: 'flex:1'}), v = mk('span', {style: 'min-width:5ch;text-align:right'}, EDT[k] + un); i.oninput = () => { EDT[k] = +i.value; v.textContent = i.value + un; }; return mk('label', {class: 'c', style: 'display:flex;gap:8px;width:100%'}, l, i, v); };
  const lado = mk('select', {onchange: e => { EDT.lado = e.target.value; }}, mk('option', {value: 'um'}, 'Só a borda do lado clicado'), mk('option', {value: 'ambos'}, 'As duas bordas')); lado.value = EDT.lado;
  const hint = {eixo: 'Mexe na rua (eixo) no trecho clicado: os cruzamentos continuam ligados. Alargar/estreitar vale para a rua inteira.', borda: 'Mexe só na borda clicada (e no lado dela), sem afetar a outra borda nem o eixo.', vtx: 'Trata o contorno como polilinhas: cada vértice pode ser arrastado, apagado ou inserido.'}[EDT.modo];
  return mk('div', {class: 'card', style: 'margin-top:8px'},
    mk('b', null, 'Ajuste fino'), modos, mk('div', {class: 'hint'}, hint + ' As coordenadas dos postes não mudam.'),
    mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0'}, ferr.map(([t, l, tip]) => mk('button', {class: EDT.tool === t ? 'on' : '', title: tip, onclick: () => edtFerramenta(t)}, l))),
    EDT.modo !== 'vtx' ? rg('Alcance', 'R', 10, 200, ' m') : '', EDT.modo !== 'vtx' ? rg('Suavização', 'f', 0, 100, '%') : '', EDT.modo !== 'vtx' ? rg('Alargar/estreitar', 'd', 0.1, 10, ' m', 0.1) : '',
    EDT.modo === 'eixo' ? mk('label', {class: 'c', style: 'display:flex;gap:8px;width:100%;margin-top:4px'}, 'Largura', lado) : '',
    mk('div', {style: 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap'},
      mk('button', {disabled: !ops.length, onclick: async () => { CFG.dxf.ruasEdit.pop(); salvar(); await comProg('Desfazendo...', recalcularRuas); }}, `Desfazer (${ops.length})`),
      mk('button', {disabled: !ops.length, onclick: async () => { CFG.dxf.ruasEdit = []; salvar(); await comProg('Removendo ajustes...', recalcularRuas); }}, 'Limpar ajustes')));
}
function edtLigar() {
  const pt = ev => { const R = RP.R; return utm(ev.latlng.lat, ev.latlng.lng, R.Z); };
  const ehMarcador = ev => ev.originalEvent && ev.originalEvent.target && ev.originalEvent.target.closest && ev.originalEvent.target.closest('.leaflet-interactive,.leaflet-marker-icon');
  map.on('mousedown', e => {
    const T = EDT.tool; if (!T || !RP.R || ehMarcador(e)) return;
    const [x, y] = pt(e);
    if (T === 'vtx') {
      const b = edtBordaEm(e.latlng, 10); if (!b) { EDT.vtx.clearLayers(); EDT.sel = null; $('#st').textContent = 'Clique em cima de uma borda (linha laranja).'; return; }
      if (EDT.sel === b.bi) { const R = RP.R, P = R.bordas[b.bi].pts, perto = P.some(p => Math.hypot(p[0] - b.x, p[1] - b.y) < 12 * mPorPx()); if (!perto) edtAplicar({t: 'vins', x: b.x, y: b.y}); }
      else edtVertices(b.bi);
      return;
    }
    if (T === 'rot' && EDT.pivo) { EDT.arr = {a0: Math.atan2(y - EDT.pivo.y, x - EDT.pivo.x)}; return; }
    if (T[0] === 'b') {   // ferramentas de borda
      const b = edtBordaEm(e.latlng, 10); if (!b) { $('#st').textContent = 'Clique em cima de uma borda (linha laranja).'; return; }
      if (T === 'bmv') EDT.arr = {x: b.x, y: b.y};
      else edtAplicar({t: T === 'bsua' ? 'bsua' : 'blarg', x: b.x, y: b.y, R: EDT.R, f: EDT.f / 100, d: (T === 'ble' ? -1 : 1) * EDT.d});
      return;
    }
    if (T === 'all') { EDT.arr = {x, y}; return; }
    const rua = edtRuaEm(e.latlng); if (!rua) { $('#st').textContent = 'Clique em cima de uma rua (a faixa do pavimento).'; return; }
    if (T === 'sua') { edtAplicar({t: 'sua', x, y, R: EDT.R, f: EDT.f / 100}); return; }
    if (T === 'la' || T === 'le') { const d = (T === 'le' ? -1 : 1) * EDT.d; edtAplicar({t: 'larg', x, y, R: EDT.R, d, lado: EDT.lado === 'ambos' ? 0 : RUAS.ladoCanon(rua.v, x, y)}); return; }
    if (T === 'mv') EDT.arr = {x, y};
    if (T === 'rot') { EDT.pivo = {x, y}; L.circle(e.latlng, {radius: EDT.R, color: '#a78bfa', weight: 1, fill: false, interactive: false}).addTo(EDT.fant); L.circleMarker(e.latlng, {radius: 4, color: '#a78bfa', fillOpacity: 1, interactive: false}).addTo(EDT.fant); $('#st').textContent = 'Agora arraste ao redor do ponto roxo para girar'; modoSet('Girar: arraste ao redor do ponto roxo (solte para aplicar)'); }
  });
  map.on('mousemove', e => {
    if (!EDT.arr || !RP.R) return; const [x, y] = pt(e);
    if (EDT.tool === 'mv') { EDT.arr.op = {t: 'mv', x: EDT.arr.x, y: EDT.arr.y, vx: x - EDT.arr.x, vy: y - EDT.arr.y, R: EDT.R}; edtFantasma(EDT.arr.op); }
    if (EDT.tool === 'all') { EDT.arr.op = {t: 'mv', x: EDT.arr.x, y: EDT.arr.y, vx: x - EDT.arr.x, vy: y - EDT.arr.y, R: 1e9}; edtFantasma(EDT.arr.op); modoSet(`Movendo todo o arruamento: ${Math.hypot(EDT.arr.op.vx, EDT.arr.op.vy).toFixed(1)} m — solte para aplicar`); }
    if (EDT.tool === 'bmv') { EDT.arr.op = {t: 'bmv', x: EDT.arr.x, y: EDT.arr.y, vx: x - EDT.arr.x, vy: y - EDT.arr.y, R: EDT.R}; edtFantasma(EDT.arr.op); }
    if (EDT.tool === 'rot') { const ang = Math.atan2(y - EDT.pivo.y, x - EDT.pivo.x) - EDT.arr.a0; EDT.arr.op = {t: 'rot', x: EDT.pivo.x, y: EDT.pivo.y, ang, R: EDT.R}; edtFantasma(EDT.arr.op); $('#st').textContent = `Girando ${(ang * 180 / Math.PI).toFixed(1)}°`; }
  });
  map.on('mouseup', () => {
    const a = EDT.arr; EDT.arr = null; if (!a || !a.op) return;
    if ((a.op.t === 'mv' || a.op.t === 'bmv') && Math.hypot(a.op.vx, a.op.vy) < 0.05) { EDT.fant.clearLayers(); return; }
    if (a.op.t === 'rot' && Math.abs(a.op.ang) < 0.002) return;
    edtAplicar(a.op);
  });
}
