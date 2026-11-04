/* Medição, seleção de área e DXF (origem: CTWeb). */
let medir = false, medPts = [], medL = L.layerGroup().addTo(map), medLinha = null;
function medirAtualiza() {
  medL.clearLayers();
  if (!medPts.length) return;
  medLinha = L.polyline(medPts, {color: COR_DESTAQUE(), weight: 3, interactive: false}).addTo(medL);
  let tot = 0; for (let k = 1; k < medPts.length; k++) tot += hav(medPts[k - 1].lat, medPts[k - 1].lng, medPts[k].lat, medPts[k].lng);
  medPts.forEach(p => L.circleMarker(p, {radius: 3, color: COR_DESTAQUE(), fillOpacity: 1, interactive: false}).addTo(medL));
  const txt = tot >= 1000 ? (tot / 1000).toFixed(3).replace('.', ',') + ' km' : tot.toFixed(1).replace('.', ',') + ' m';
  L.marker(medPts[medPts.length - 1], {interactive: false, icon: L.divIcon({className: 'ic', html: `<div class="medtip">${txt}</div>`, iconSize: [0, 0]})}).addTo(medL);
  $('#st').textContent = 'Medição: ' + txt + ' (clique para continuar, duplo clique ou Esc para encerrar)';
}
function medirLigar(on) {
  medir = on; $('#mapMedir')?.classList.toggle('is-active', on); on ? modoSet('Medição: clique no mapa para marcar pontos; duplo clique encerra') : modoFim();
  if (on) { selCancelar(); map.doubleClickZoom.disable(); map.getContainer().style.cursor = 'crosshair'; medPts = []; medirAtualiza(); $('#st').textContent = 'Medição: clique no mapa para marcar pontos'; }
  else { map.doubleClickZoom.enable(); map.getContainer().style.cursor = ''; medL.clearLayers(); medPts = []; }
}

let modo = null, SEL = null, selForma = null, polyPts = [], polyL = null, dxA = null, semClique = 0;
const selGrp = L.layerGroup().addTo(map), osmGrp = L.layerGroup().addTo(map);
function emPoli(lat, lng, poly) {
  let dentro = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
function linhaEmPoli(d, i, poly) {
  for (const ring of geo(d, i)) for (let k = 0; k < ring.length; k++) {
    if (emPoli(ring[k][0], ring[k][1], poly)) return true;
    if (k && emPoli((ring[k][0] + ring[k - 1][0]) / 2, (ring[k][1] + ring[k - 1][1]) / 2, poly)) return true;
  }
  return false;
}
function selIds(S) {
  const b = S.b, w0 = b.getWest(), e0 = b.getEast(), s0 = b.getSouth(), n0 = b.getNorth(), out = {};
  for (const t of Object.keys(D)) {
    if (!ativo[t]) continue;
    const d = D[t], lin = LINHA(t), v = out[t] = [], seen = new Set(), ocul = KML(t) && d.gr >= 0 && Object.keys(CFG.kml.ocultos).length ? CFG.kml.ocultos : null;
    for (let cx = Math.floor(w0 * 100) - 1; cx <= Math.floor(e0 * 100) + 1; cx++) for (let cy = Math.floor(s0 * 100) - 1; cy <= Math.floor(n0 * 100) + 1; cy++) {
      for (const i of d.grid.get(cx + ',' + cy) || []) {
        if (seen.has(i)) continue; seen.add(i);
        if (ocul && ocul[d.rows[i][d.gr]]) continue;
        if (!lin) { const x = d.X[i], y = d.Y[i]; if (x >= w0 && x <= e0 && y >= s0 && y <= n0 && (!S.poly || emPoli(y, x, S.poly))) v.push(i); continue; }
        if (!(d.x1[i] >= w0 && d.x0[i] <= e0 && d.y1[i] >= s0 && d.y0[i] <= n0)) continue;
        if (S.poly && !linhaEmPoli(d, i, S.poly)) continue;
        v.push(i);
      }
    }
  }
  return out;
}
function selCancelar(limpar = true) {
  modoFim();
  modo = null; dxA = null; polyPts = []; polyL?.remove(); polyL = null;
  map.dragging.enable(); if (!medir) { map.doubleClickZoom.enable(); map.getContainer().style.cursor = ''; }
  if (limpar) { selGrp.clearLayers(); osmGrp.clearLayers(); SEL = null; if (typeof PJ !== 'undefined' && PJ.on) projSair(); if (typeof prjUI === 'function') prjUI(); }
}
// faixa de modo (no topo do mapa): diz o que o mouse está fazendo e tem o botão para sair e voltar a arrastar o mapa
const modoSet = t => { const e = $('#modo'); if (e) { $('#modo-t').textContent = t; e.hidden = false; } if (typeof arrStatus === 'function') arrStatus(); };
const modoFim = () => { const e = $('#modo'); if (e) e.hidden = true; if (typeof arrStatus === 'function') arrStatus(); };
function sairModos() {   // Esc ou botão "Sair": cancela medição, desenho de área e ferramentas de edição; devolve true se havia algo ativo
  let saiu = false;
  if (medir) { medirLigar(false); saiu = true; }
  if (modo) { selCancelar(false); selInfo('Desenho da área cancelado.'); saiu = true; }
  if (typeof EDT !== 'undefined' && EDT.tool) { edtFerramenta(EDT.tool); saiu = true; }
  if (typeof projSairFerr === 'function' && projSairFerr()) saiu = true;
  if (saiu) { modoFim(); $('#st').textContent = 'Modo de edição encerrado: o mapa volta a ser arrastado normalmente.'; if (typeof arrStatus === 'function') arrStatus(); }
  return saiu;
}
let origemSel = 'dxp';   // painel que pediu a seleção de área (exportar ou arruamento)
const selInfo = t => { for (const id of ['#pji']) { const e = $(id); if (e) e.textContent = t; } if (typeof arrStatus === 'function') arrStatus(); };
const abrirOrigem = () => { if (typeof prjUI === 'function') prjUI(); };
function selIniciar(m, origem = 'dxp') {
  if (!window.NG.hasData()) { alert('Abra uma base ou importe os CSVs primeiro.'); return; }
  if (medir) medirLigar(false);
  if (typeof EDT !== 'undefined' && EDT.tool) edtFerramenta(EDT.tool);
  origemSel = origem; selCancelar(); modo = m; abrirOrigem();
  modoSet(m === 'ret' ? 'Desenhando a área: arraste no mapa para criar o retângulo' : 'Desenhando o polígono: clique para marcar os vértices; duplo clique conclui');
  map.getContainer().style.cursor = 'crosshair';
  if (m === 'ret') map.dragging.disable(); else map.doubleClickZoom.disable();
  $('#st').textContent = m === 'ret' ? 'Seleção: arraste no mapa para desenhar o retângulo' : 'Seleção: clique para marcar os vértices; duplo clique conclui (Esc cancela)';
}
async function selFim(b, poly) {
  selCancelar(false); selGrp.clearLayers(); osmGrp.clearLayers();
  SEL = {b, poly};
  selForma = poly ? L.polygon(poly, {color: COR_DESTAQUE(), weight: 2, fillOpacity: .08, interactive: false}) : L.rectangle(b, {color: COR_DESTAQUE(), weight: 2, fillOpacity: .08, interactive: false});
  selForma.addTo(selGrp); semClique = Date.now() + 300;
  selInfo('Lendo a área...'); abrirOrigem(); progIni('Lendo a área...');
  try { SEL.dados = await window.NG.lerArea(b, m => { selInfo(m); progSet(m, null); }); progFim(); }
  catch (e) { progFim(); selInfo(e.message === 'cancelado' ? 'Seleção cancelada' : 'Falha ao ler a área: ' + e.message); SEL = null; selGrp.clearLayers(); return; }
  SEL.ids = usarSel(() => selIds(SEL));
  const c = b.getCenter(), wm = (b.getEast() - b.getWest()) * 111320 * Math.cos(c.lat * RAD), hm = (b.getNorth() - b.getSouth()) * 111320;
  const cont = Object.entries(SEL.ids).filter(([, v]) => v.length).map(([k, v]) => NOME[k] + ' ' + v.length).join(' | ') || 'nenhum elemento';
  selInfo(`Área ${Math.round(wm)} × ${Math.round(hm)} m — ${cont}`);
  $('#dxq').replaceChildren(); abrirOrigem();
}

const san = s => String(s || '0').toUpperCase().replace(/[^A-Z0-9_$-]/g, '_');
const GRPV = {principais: /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/, residenciais: /^(residential|unclassified|living_street)$/, servico: /^(service|track)$/, pedestre: /^(footway|path|steps|pedestrian|cycleway|bridleway|corridor)$/};
const grupoVia = h => { for (const [k, re] of Object.entries(GRPV)) if (re.test(h)) return k; return 'outros'; };
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const OSMC = new Map();
async function ruasOSM(S, edif, signal) {
  const b = S.b, bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(x => x.toFixed(6)).join(',');
  const c0 = OSMC.get(bb); if (c0 && (c0.edif || !edif)) return c0;
  const q = `[out:json][timeout:50];(way["highway"](${bb});${edif ? `way["building"](${bb});` : ''});out tags geom(${bb});`;
  const j = await window.NG.overpassCorrida(OVERPASS, q, {signal, aoServidor: h => { $('#st').textContent = 'Baixando dados do OpenStreetMap... (' + h + ')'; }});
  const c = {edif: !!edif, ways: j.elements.filter(x => x.geometry).map(x => ({pts: x.geometry.filter(g => g).map(g => [g.lat, g.lon]), nome: x.tags?.name || '', hw: x.tags?.highway || '', bld: !!x.tags?.building}))};
  OSMC.set(bb, c); return c;
}
function filtrarOSM(S, osm) {
  const cf = CFG.dxf, ruas = [], edif = [];
  for (const w of osm.ways) {
    if (w.pts.length < 2) continue;
    if (S.poly && !w.pts.some(p => emPoli(p[0], p[1], S.poly))) continue;
    if (w.hw) { if (cf.ruas && cf.ruasModo === 'eixo' && cf.ruasTipos[grupoVia(w.hw)]) ruas.push(w); }
    else if (w.bld && cf.edif) edif.push(w);
  }
  return {ruas, edif};
}
async function previaOSM() {
  if (!SEL) return;
  const cf = CFG.dxf;
  try {
    if (cf.ruas && cf.ruasModo !== 'eixo' && !cf.edif) { $('#st').textContent = 'Pré-visualização do arruamento: use "Gerar DXF" e depois "Ver arruamento na tela".'; return; }
    const o = filtrarOSM(SEL, await ruasOSM(SEL, cf.edif));
    osmGrp.clearLayers();
    o.ruas.forEach(w => L.polyline(w.pts, {color: '#ff9f1c', weight: 2, interactive: false}).addTo(osmGrp));
    o.edif.forEach(w => L.polygon(w.pts, {color: '#9aa5ad', weight: 1, fillOpacity: .2, interactive: false}).addTo(osmGrp));
    $('#st').textContent = `OpenStreetMap: ${o.ruas.length} vias, ${o.edif.length} edificações`;
  } catch (e) { $('#st').textContent = 'Falha ao baixar o OpenStreetMap: ' + e.message; }
}

// ---- construção do balão em coordenadas locais (y para baixo) ----
function balaoVerts(lay, L_, U) {
  const {x, y, w, h} = lay, K = 0.41421356;
  const r = L_.bal === 'arred' || L_.bal === 'balao' ? Math.min(6 * U, h / 2) : 0, tp = L_.bal === 'balao' ? calcTip(lay, r, U) : null;
  const x2 = x + w, y2 = y + h, V = [], A = (px, py, b = 0) => V.push([px, py, b]);
  const corner = (ax, ay, bx, by, cx, cy) => { if (r) { A(ax, ay, K); A(bx, by); } else A(cx, cy); };
  A(x + r, y);
  if (tp && tp.side === 't') { A(tp.a, y); A(tp.x, tp.y); A(tp.b, y); }
  corner(x2 - r, y, x2, y + r, x2, y);
  if (tp && tp.side === 'r') { A(x2, tp.a); A(tp.x, tp.y); A(x2, tp.b); }
  corner(x2, y2 - r, x2 - r, y2, x2, y2);
  if (tp && tp.side === 'b') { A(tp.b, y2); A(tp.x, tp.y); A(tp.a, y2); }
  corner(x + r, y2, x, y2 - r, x, y2);
  if (tp && tp.side === 'l') { A(x, tp.b); A(tp.x, tp.y); A(x, tp.a); }
  if (r) { A(x, y + r, K); /* arco até (x+r,y), que é o vértice inicial */ } else { /* fecha no primeiro vértice */ }
  return V;
}
// ================= DXF: geração =================
const parseAtrib = txt => String(txt || '').split('\n').map(s => s.trim()).filter(Boolean).map(s => {
  const q = s.indexOf('=');
  return q > 0 ? {tag: s.slice(0, q).trim(), expr: s.slice(q + 1).trim()} : {tag: s, expr: ''};
});

// amostra um contorno com bulges e o triangula (orelhas) para preencher o fundo do balão com SOLID
function triangulaBalao(V) {
  const P = [];
  for (let k = 0; k < V.length; k++) {
    const a = V[k], b = V[(k + 1) % V.length]; P.push([a[0], a[1]]);
    if (a[2]) {
      const th = 4 * Math.atan(a[2]), dx = b[0] - a[0], dy = b[1] - a[1], c = Math.hypot(dx, dy), r = c / (2 * Math.sin(th / 2)), sg = Math.sign(th);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, h = Math.sqrt(Math.max(0, r * r - c * c / 4)) * (Math.abs(th) > Math.PI ? -1 : 1) * sg;
      const cx = mx - dy / c * h, cy = my + dx / c * h, a0 = Math.atan2(a[1] - cy, a[0] - cx), n = Math.max(2, Math.ceil(Math.abs(th) / (Math.PI / 12)));
      for (let q = 1; q < n; q++) { const an = a0 + th * q / n; P.push([cx + Math.abs(r) * Math.cos(an), cy + Math.abs(r) * Math.sin(an)]); }
    }
  }
  const area = P.reduce((s, p, k) => { const q = P[(k + 1) % P.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  const idx = P.map((_, k) => k); if (area < 0) idx.reverse();
  const tri = [], cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const dentro = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let cortou = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length], a = P[i0], b = P[i1], c = P[i2];
      if (cross(a, b, c) <= 1e-9) continue;
      if (idx.some(j => j !== i0 && j !== i1 && j !== i2 && dentro(P[j], a, b, c))) continue;
      tri.push([a, b, c]); idx.splice(k, 1); cortou = true; break;
    }
    if (!cortou) break;
  }
  if (idx.length === 3) tri.push(idx.map(j => P[j]));
  return tri;
}

function dxfRotulos(t, ids, P, body, lay) {
  const d = D[t], ln = LINHA(t);
  CFG.cam[t].labels.forEach((L_, li) => {
    if (!L_.on || !L_.expr) return;
    const layer = lay(L_.camada || ('TXT_' + t.toUpperCase()), L_.cor), H = L_.dxfH || 1.5, lh = H * 1.25, cw = H * .6 * (L_.dxfW || 1);
    for (const i of ids) {
      const inf = rotInfo(t, li, i); if (!inf) continue;
      let an, ang = 0;
      if (ln) {
        const ring = geo(d, i)[0]; if (!ring || ring.length < 2) continue;
        const xs = [], ys = []; let tot = 0;
        ring.forEach((q, k) => { const p = P(q[0], q[1]); xs.push(p[0]); ys.push(-p[1]); if (k) tot += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]); });
        if (tot < 1e-6) continue;
        an = pontoAoLongo(xs, ys, tot, FR[L_.ancora] ?? .5); if (!an) continue;
        ang = legivel(an.ang);
      } else { const p = P(d.Y[i], d.X[i]); an = {x: p[0], y: -p[1]}; }
      const lw = Math.max(...inf.lines.map(s => s.length)) * cw;
      const rotH = ln && L_.modo === 'alinhado' ? 0 : rotPonto(L_, inf, t, i, ang);
      const ly = layoutRot(L_, inf.lines.length, lw, lh, MPX, ln ? 'ln' : 'pt', ang, rotH);
      const c = Math.cos(ly.rot), s = Math.sin(ly.rot);
      const W = (lx, lyy) => [an.x + lx * c - lyy * s, -(an.y + lx * s + lyy * c)];
      if (L_.bal !== 'nenhum') {
        const gkB = {t, li, i, k: -1, x: an.x, y: -an.y};   // peças do balão acompanham o rótulo no módulo Projeto
        const V = balaoVerts(ly, L_, MPX).map(v => { const w = W(v[0], v[1]); return [w[0], w[1], v[2]]; });
        if (L_.balOp > .05 && L_.bal !== 'linha') for (const tr of triangulaBalao(V)) DXF.wEnt(body, {t: 'SOLID', pts: tr.map(q => [q[0], q[1]]), gk: gkB}, layer, DXF.aci(L_.balFill));
        if (L_.balBW > 0 || L_.bal === 'linha') DXF.wEnt(body, {t: 'PLINE', pts: V, closed: true, gk: gkB}, layer, DXF.aci(L_.balBorda));
        if (L_.bal === 'linha') {
          const px = Math.max(ly.x, Math.min(0, ly.x + ly.w)), py = Math.max(ly.y, Math.min(0, ly.y + ly.h));
          if (Math.hypot(px, py) > 2 * MPX) DXF.wEnt(body, {t: 'LINE', a: W(px, py), b: W(0, 0), gk: {...gkB, leader: true}}, layer, DXF.aci(L_.balBorda));
        }
      }
      const hj = L_.alinh === 'dir' ? 2 : L_.alinh === 'cen' ? 1 : 0;
      const lx = L_.alinh === 'dir' ? ly.x + ly.w - ly.pad : L_.alinh === 'cen' ? ly.x + ly.w / 2 : ly.x + ly.pad;
      inf.lines.forEach((txt, k) => {
        DXF.wEnt(body, {t: 'TEXT', p: W(lx, ly.y + ly.pad + (k + .5) * lh), h: H, s: txt, rot: -ly.rot / RAD, hj, vj: 2, w: L_.dxfW, fv: {f: L_.fonte, n: L_.neg, i: L_.ital, c: inf.cor || L_.cor, h: L_.halo, hc: L_.haloCor, hw: L_.haloW}, gk: {t, li, i, k, x: an.x, y: -an.y}}, layer, DXF.aci(inf.cor || L_.cor));
      });
    }
  });
}

function gerarDXF(S, osm, ruasIn) {
  const cf = CFG.dxf, den = +cf.escala || 1000, ke = 1000 / den;
  DXF.setMtext(cf.mtext !== false);
  const sb = cf.simbBlocos || (typeof projAtivo === 'function' && projAtivo());   // o módulo Projeto precisa dos símbolos como blocos para editá-los
  const ct = S.b.getCenter(), Z = Math.floor((ct.lng + 180) / 6) + 1, cc = utm(ct.lat, ct.lng, Z);
  const org = cf.origem === 'rel' ? [Math.round(cc[0]), Math.round(cc[1])] : [0, 0];
  const P = (la, lo) => { const [x, y] = utm(la, lo, Z); return [cc[0] + (x - cc[0]) * ke - org[0], cc[1] + (y - cc[1]) * ke - org[1]]; };
  DXF.ctx = {Z, cc, ke, org};
  if (typeof projReset === 'function') projReset();
  DXF.setHook(typeof projHook === 'function' ? projHook : null);
  const body = [], layers = new Map(), blocks = new Map(), cont = {}, lts = new Map();
  // tipo de linha (tracejado/pontilhado) criado a partir do padrão em px da tela
  const ltDe = dash => {
    const p = String(dash || '').split(/[ ,]+/).map(Number).filter(x => x > 0); if (!p.length) return null;
    const pat = p.length % 2 ? [...p, ...p] : p, nome = 'CTW_' + pat.join('_').replace(/\./g, 'p');
    if (!lts.has(nome)) lts.set(nome, pat.map((v, k) => (k % 2 ? -v : v) * MPX));
    return nome;
  };
  const lay = (nome, cor) => { nome = san(nome); if (!layers.has(nome)) layers.set(nome, DXF.aci(cor || '#ffffff')); return nome; };
  const ids = S.ids;

  // linhas
  for (const t of LNS) {
    const g = ids[t]; if (!g?.length) continue;
    const d = D[t], cfc = CFG.cam[t]; cont[t] = g.length;
    for (const [k, lst] of agrupar(t, g)) {
      const est = estEf(t, k), r = kIdx(k) >= 0 ? cfc.rules[kIdx(k)] : null;
      const L1 = lay(r && r.camada ? r.camada : cf.camadas[t], r && r.camada ? est.cor : cfc.base.cor);
      const ac = DXF.aci(est.cor), col = ac !== layers.get(L1) ? ac : null;
      const vis = cf.estiloLinha !== false, w = vis ? est.larg * MPX : 0, lt = vis ? ltDe(est.dash) : null;
      const cas = vis && est.casing ? DXF.aci(est.casingCor) : null;
      for (const i of lst) for (const ring of geo(d, i)) {
        const pts = ring.map(q => { const p = P(q[0], q[1]); return [p[0], p[1], 0]; });
        if (cas != null) DXF.wEnt(body, {t: 'PLINE', pts, closed: false, w: (est.larg + 2 * est.casingW) * MPX}, L1, cas);
        DXF.wEnt(body, {t: 'PLINE', pts, closed: false, w, lt}, L1, col);
      }
    }
  }
  // pontos (postes/instalações), como blocos com atributos ou entidades soltas
  const defs = new Map();
  const defSimbolo = (t, k, est) => {
    const key = t + '|' + k; let s = defs.get(key); if (s) return s;
    const bl = est.forma === 'bloco' ? BLOCOS[est.bloco] : null;
    if (bl) {
      const b = blocoBase(bl), sc = est.blocoModo === 'original' ? est.blocoK : (est.tam * MPX) / (bl.max || 1);
      s = {nome: san(bl.nome), sc, custom: true, ents: bl.ents.map(e => DXF.xfEnt(e, DXF.T(1, 0, 0, 1, -b[0], -b[1]))),
        att: bl.att.map(a => ({...a, p: [a.p[0] - b[0], a.p[1] - b[1]]}))};
    } else s = {nome: san('CTW_' + t + '_' + (kIdx(k) < 0 ? 'BASE' : kIdx(k) + 1) + (typeof k === 'string' ? '_' + k.slice(k.indexOf('|') + 2) : '')), sc: 1, custom: false, ents: DXF.formaEnts(est, MPX), att: []};
    defs.set(key, s); return s;
  };
  const plano = [];
  for (const t of PTS) {
    const g = ids[t]; if (!g?.length) continue;
    const d = D[t], cfc = CFG.cam[t]; cont[t] = g.length;
    for (const [k, lst] of agrupar(t, g)) {
      const est = estEf(t, k), r = kIdx(k) >= 0 ? cfc.rules[kIdx(k)] : null;
      const L1 = lay(r && r.camada ? r.camada : cf.camadas[t], r && r.camada ? est.cor : cfc.base.cor);
      const ac = DXF.aci(est.cor), col = ac !== layers.get(L1) ? ac : null;
      const def = defSimbolo(t, k, est), tags = cf.atributos ? parseAtrib(est.atrib) : [];
      if (sb) {
        let b = blocks.get(def.nome);
        if (!b) { b = {nome: def.nome, ents: def.ents, att: new Map(def.att.map(a => [DXF.tagOk(a.tag), a]))}; blocks.set(def.nome, b); }
        for (const a of tags) { const tg = DXF.tagOk(a.tag); if (!b.att.has(tg)) b.att.set(tg, {tag: tg, p: [0, 0], h: .5 / (def.sc || 1), def: '', prompt: tg, flags: cf.attInvisivel ? 1 : 0}); }
      }
      plano.push({t, k, lst, est, L1, col, def, tags, d});
    }
  }
  for (const {t, lst, est, L1, col, def, tags, d} of plano) {
    const blk = sb ? blocks.get(def.nome) : null, exprs = new Map(tags.map(a => [DXF.tagOk(a.tag), a.expr]));
    for (const i of lst) {
      const [x, y] = P(d.Y[i], d.X[i]);
      const rotDeg = -((est.girar && d.na >= 0 ? angDe(d, i) * ANG_SENTIDO : 0) + est.angOff);
      if (blk) {
        const att = [], th = rotDeg * RAD, cs = Math.cos(th), sn = Math.sin(th);
        if (cf.atributos) for (const a of blk.att.values()) {
          const ex = exprs.get(a.tag);
          const v = toStr(ex ? ev(ex, t, i) : colOf(d, d.rows[i], a.tag));
          att.push({tag: a.tag, val: v, p: [x + (a.p[0] * cs - a.p[1] * sn) * def.sc, y + (a.p[0] * sn + a.p[1] * cs) * def.sc], h: a.h * def.sc, rot: rotDeg, flags: a.flags});
        }
        DXF.wInsert(body, def.nome, L1, x, y, def.sc, rotDeg, att, col);
      } else {
        const th = rotDeg * RAD, M = DXF.T(def.sc * Math.cos(th), def.sc * Math.sin(th), -def.sc * Math.sin(th), def.sc * Math.cos(th), x, y);
        for (const e of def.ents) DXF.wEnt(body, DXF.xfEnt(e, M), L1, col);
      }
    }
  }
  // arruamento com largura real, ajustado aos postes (só bordas do pavimento)
  const ruasR = ruasIn || null;
  if (ruasR) {
    const Q = (x, y) => [cc[0] + (x - cc[0]) * ke - org[0], cc[1] + (y - cc[1]) * ke - org[1]];
    const Lr = lay(cf.camadas.ruas, cf.ruasCor), Lt = lay(cf.camadas.txtRuas, cf.ruasCor), H = cf.ruasH || 1.5;
    const escreve = (lista, camada) => { for (const b of lista) {
      const pts = b.pts.map(p => { const q = Q(p[0], p[1]); return [q[0], q[1], 0]; });
      if (cf.ruasSaida === 'linhas') { const n = pts.length; for (let i = 0; i + 1 < n + (b.fechado ? 1 : 0); i++) DXF.wEnt(body, {t: 'LINE', a: pts[i], b: pts[(i + 1) % n]}, camada); }
      else DXF.wEnt(body, {t: 'PLINE', pts, closed: !!b.fechado}, camada);
    } };
    escreve(ruasR.bordas, Lr); cont.ruas = ruasR.bordas.length;
    if (ruasR.orig) { escreve(ruasR.orig, lay(cf.camadas.ruasOrig, '#7a869a')); }
    if (cf.ruasNomes) {
      const feito = new Set();
      for (const v of ruasR.vias) {
        if (!v.nome) continue;
        const r = v.pts.map(p => Q(p[0], p[1]));
        let kb = 0, lb = -1;
        for (let k = 0; k + 1 < r.length; k++) { const l = Math.hypot(r[k + 1][0] - r[k][0], r[k + 1][1] - r[k][1]); if (l > lb) { lb = l; kb = k; } }
        if (lb < H * 2) continue;
        const a = r[kb], z = r[kb + 1], mx = (a[0] + z[0]) / 2, my = (a[1] + z[1]) / 2, ch = v.nome + '|' + Math.round(mx / (40 * ke)) + '|' + Math.round(my / (40 * ke));
        if (feito.has(ch)) continue; feito.add(ch);
        let th = Math.atan2(z[1] - a[1], z[0] - a[0]);
        if (th > Math.PI / 2) th -= Math.PI; else if (th < -Math.PI / 2) th += Math.PI;
        DXF.wEnt(body, {t: 'TEXT', p: [mx, my], h: H, s: v.nome, rot: th / RAD, hj: 1, vj: 2}, Lt);
      }
    }
  }
  // rótulos
  if (cf.rotulos) for (const t of Object.keys(D)) if (ids[t]?.length) dxfRotulos(t, ids[t], P, body, lay);
  // arruamento e edificações
  if (osm) {
    const o = filtrarOSM(S, osm);
    if (cf.ruasModo === 'eixo') cont.ruas = o.ruas.length; cont.edif = o.edif.length;
    const Lr = lay(cf.camadas.ruas, cf.ruasCor), Lt = lay(cf.camadas.txtRuas, cf.ruasCor), H = cf.ruasH || 1.5;
    for (const w of o.ruas) {
      const r = w.pts.map(q => { const p = P(q[0], q[1]); return [p[0], p[1], 0]; });
      DXF.wEnt(body, {t: 'PLINE', pts: r, closed: false}, Lr);
      if (!cf.ruasNomes || !w.nome) continue;
      let kb = 0, lb = -1;
      for (let k = 0; k + 1 < r.length; k++) { const l = Math.hypot(r[k + 1][0] - r[k][0], r[k + 1][1] - r[k][1]); if (l > lb) { lb = l; kb = k; } }
      if (lb < H * 2) continue;
      const a = r[kb], z = r[kb + 1]; let th = Math.atan2(z[1] - a[1], z[0] - a[0]);
      if (th > Math.PI / 2) th -= Math.PI; else if (th < -Math.PI / 2) th += Math.PI;
      DXF.wEnt(body, {t: 'TEXT', p: [(a[0] + z[0]) / 2 - Math.sin(th) * 1.2, (a[1] + z[1]) / 2 + Math.cos(th) * 1.2], h: H, s: w.nome, rot: th / RAD, hj: 1, vj: 2}, Lt);
    }
    const Le = lay(cf.camadas.edif, cf.edifCor);
    for (const w of o.edif) {
      const r = w.pts.map(q => { const p = P(q[0], q[1]); return [p[0], p[1], 0]; });
      if (r.length > 2 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
      DXF.wEnt(body, {t: 'PLINE', pts: r, closed: true}, Le);
    }
  }
  if (typeof projFinal === 'function') projFinal(body, lay, blocks);   // anotações e blocos inseridos no módulo Projeto
  DXF.setHook(null);
  const blq = [...blocks.values()].map(b => ({nome: b.nome, ents: b.ents, att: [...b.att.values()]}));
  const txtDxf = DXF.build([...layers.entries()], blq, body, cf.fonte, [...lts, ...(typeof projLts === 'function' ? projLts() : [])]); DXF.setMtext(false);
  return {txt: txtDxf, cont, Z, org, ruasR, blq, layers, cc, ke};
}

async function baixarDXF() {
  if (!SEL) { alert('Selecione uma área primeiro (retângulo ou polígono).'); return; }
  if (SEL.dados === undefined) { alert('A seleção ainda está sendo lida. Tente novamente em instantes.'); return; }
  await selAtualizar();   // inclui o que foi carregado/ligado depois de desenhar a área (ex.: KML)
  const cf = CFG.dxf; let osm = null, osm2 = null, ruasR = null, aviso = '', r;
  const pista = cf.ruas && cf.ruasModo !== 'eixo';
  progIni('Preparando o DXF...');
  try {
    try {
      if (pista) { progSet('Baixando as ruas do OpenStreetMap...', null); osm2 = await ruasOSM2(SEL, (m, f) => progSet(m, f)); }
      if ((cf.ruas && !pista) || cf.edif) { progSet('Baixando dados do OpenStreetMap...', null); osm = await ruasOSM(SEL, cf.edif); }
    } catch (err) { aviso = ' (arruamento indisponível: ' + err.message + ')'; alert('Não foi possível baixar o OpenStreetMap (' + err.message + ').\nO DXF será gerado sem ruas/edificações. Tente novamente em instantes ou com uma área menor.'); osm = osm2 = null; }
    if (osm2 && !osm2.ways.length) aviso = ' (o OpenStreetMap não tem vias nesta área)';
    if (osm2) {
      const {Z, cc} = projDXF(SEL);
      if (RP.R && RP.S === SEL && RP.sig && RP.sig === sigRuas()) { ruasR = RP.R; progSet('Usando o arruamento da prévia...', 0.9); }   // o DXF sai idêntico ao que está na tela
      else {
        const postes = usarSel(() => postesSel(SEL, Z));
        ruasR = await calcularRuas(SEL, osm2, postes, Z, cc, (m, f) => progSet(m, 0.1 + 0.8 * f));
      }
    }
    progSet('Gerando o DXF...', 0.93); await new Promise(r => setTimeout(r, 30));
    r = usarSel(() => gerarDXF(SEL, osm, ruasR));
  } catch (e) { alert('Falha ao gerar o DXF: ' + e.message); console.error(e); return; }
  finally { progFim(); }
  baixar(`projeto_1-${+cf.escala || 1000}.dxf`, r.txt, 'application/dxf');
  if (r.ruasR) { RP.R = r.ruasR; relatorioRuas(r.ruasR); SEL.ruasR = r.ruasR; }
  $('#st').textContent = 'DXF gerado [' + VERSAO + '] (UTM fuso ' + r.Z + (SEL.b.getCenter().lat < 0 ? 'S' : 'N') + (r.org[0] ? ', origem ' + r.org.join(' / ') : '') + '): ' +
    Object.entries(r.cont).map(([k, n]) => (NOME[k] || (k === 'ruas' ? (r.ruasR ? 'Bordas de pista' : 'Vias') : 'Edificações')) + ' ' + n).join(' | ') + aviso;
}

// ================= quantitativo e GeoJSON =================
function quantitativo(S) {
  const rows = [];
  for (const t of Object.keys(D)) {
    const g = S.ids[t]; if (!g?.length) continue;
    const d = D[t], ex = CFG.quant[t], m = new Map(), ln = LINHA(t);
    for (const i of g) {
      const k = (ex ? toStr(ev(ex, t, i)) : '') || '(sem valor)';
      const e = m.get(k) || m.set(k, {n: 0, m: 0}).get(k);
      e.n++; if (ln) e.m += compr(d, i);
    }
    for (const [k, e] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR', {numeric: true}))) rows.push([NOME[t], k, e.n, ln ? e.m : null]);
  }
  return rows;
}
const fmtBR = (v, n = 1) => v == null ? '' : v.toLocaleString('pt-BR', {minimumFractionDigits: n, maximumFractionDigits: n});
function mostrarQuant() {
  if (!SEL) { alert('Selecione uma área primeiro.'); return; }
  const rows = usarSel(() => quantitativo(SEL)), box = $('#dxq');
  if (!rows.length) { box.replaceChildren(mk('small', null, 'Nenhum elemento na seleção.')); return; }
  const tb = mk('table', {class: 'qt'}, mk('tr', null, ...['Camada', 'Grupo', 'Qtd', 'Metros'].map(h => mk('th', null, h))),
    ...rows.map(r => mk('tr', null, mk('td', null, r[0]), mk('td', null, r[1]), mk('td', {class: 'n'}, r[2]), mk('td', {class: 'n'}, fmtBR(r[3])))));
  box.replaceChildren(mk('div', {class: 'qs'}, tb), mk('button', {onclick: () => {
    const csv = '﻿Camada;Grupo;Quantidade;Comprimento (m)\n' + rows.map(r => [r[0], '"' + String(r[1]).replace(/"/g, '""') + '"', r[2], fmtBR(r[3])].join(';')).join('\n') + '\n';
    baixar('quantitativo.csv', csv, 'text/csv;charset=utf-8');
  }}, 'Baixar quantitativo (CSV)'));
}
function baixarGeoJSON() {
  if (!SEL) { alert('Selecione uma área primeiro.'); return; }
  const feats = [];
  usarSel(() => {
  for (const t of Object.keys(D)) {
    const d = D[t], lin = LINHA(t);
    for (const i of SEL.ids[t] || []) {
      const props = {camada: NOME[t]};
      d.h.forEach((n, j) => { if (n !== 'GEOMETRIA_WKT') props[n] = d.rows[i][j]; });
      let g;
      if (lin) { const rs = geo(d, i).map(r => r.map(q => [q[1], q[0]])); g = rs.length > 1 ? {type: 'MultiLineString', coordinates: rs} : {type: 'LineString', coordinates: rs[0]}; }
      else g = {type: 'Point', coordinates: [d.X[i], d.Y[i]]};
      feats.push({type: 'Feature', properties: props, geometry: g});
    }
  }
  });
  baixar('selecao.geojson', JSON.stringify({type: 'FeatureCollection', features: feats}), 'application/geo+json');
  $('#st').textContent = 'GeoJSON gerado: ' + feats.length + ' elementos';
}

// ================= painel de exportação =================
function renderOpcoesRuas() {
  const cf = CFG.dxf, M = salvar, o = $('#arro'); if (!o) return; o.replaceChildren();
  const MR = () => { salvar(); previaAuto(); };   // opções do arruamento: a prévia na tela se atualiza sozinha
    o.append(fr('Incluir no DXF', ctl(cf, 'ruas', {t: 'chk', re: false, on: () => { M(); if (!$('#dxp').hidden) abrirDxp(); }})));
    o.append(fr('Pré-visualizar no mapa', ctl(cf, 'ruasPrevia', {t: 'chk', re: false, on: () => { M(); if (cf.ruasPrevia) previaAuto(true); else limparPrevia(); }}), 'Mostra na tela como o arruamento vai ficar e o atualiza sozinho a cada mudança abaixo. Clique num poste da prévia para definir o lado da rua, ignorá-lo ou indicar onde ele deve aparecer.'));
    o.append(fr('Desenho das ruas', ctl(cf, 'ruasModo', {t: 'sel', re: false, o: [['pista', 'Pista com largura real (só as bordas)'], ['eixo', 'Eixo simples (como antes)']], on: () => { MR(); renderOpcoesRuas(); }}), 'Pista: calcula o pavimento pela largura real da via e desenha apenas as duas bordas, sem eixo.'));
    if (cf.ruasModo !== 'eixo') {
      o.append(fr('Ajustar as ruas aos postes', ctl(cf, 'ruasAjustar', {t: 'chk', re: false, on: () => { MR(); renderOpcoesRuas(); }}), 'Só a rua se move, como um bloco rígido (sem criar curvas): desliza o eixo e/ou estreita a pista para o símbolo do poste ficar fora; se não der, a folga diminui até o centro do poste ficar fora.'));
      if (cf.ruasAjustar) o.append(fr('Folga extra além do símbolo (m)', ctl(cf, 'ruasMargem', {t: 'num', min: 0, max: 3, step: .1}, MR)),
        fr('Deslocamento máximo da rua (m)', ctl(cf, 'ruasMaxDesl', {t: 'num', min: 1, max: 30, step: .5}, MR)),
        fr('Largura mínima da pista (% da original)', ctl(cf, 'ruasLargMin', {t: 'num', min: 30, max: 100, step: 5}, MR), 'Se mover o eixo não bastar, a pista pode ficar mais estreita até este limite. O eixo nunca ganha curvas: a rua inteira só desliza.'),
        fr('Incluir a pista original em outra camada', ctl(cf, 'ruasOriginal', {t: 'chk'}, MR)));
      o.append(mk('details', {class: 'sec'}, mk('summary', null, 'Larguras das pistas (m)'),
        mk('small', null, 'Valem quando o OpenStreetMap não informa width nem lanes.'),
        ...[['arterial', 'vias expressas/arteriais'], ['principal', 'principais/secundárias'], ['residencial', 'residenciais'], ['calma', 'vias de convivência'], ['servico', 'serviço/acesso'], ['pedestre', 'calçadões/caminhos'], ['outros', 'outras']].map(([k, l]) => fr(l[0].toUpperCase() + l.slice(1), ctl(cf.ruasLarg, k, {t: 'num', min: 1.5, max: 40, step: .5}, MR))),
        fr('Largura de cada faixa (lanes)', ctl(cf, 'ruasFaixa', {t: 'num', min: 2.5, max: 4.5, step: .1}, MR))));
    }
    if (cf.ruasModo !== 'eixo') o.append(fr('Suavizar esquinas e emendas (raio, m)', ctl(cf, 'ruasRaio', {t: 'num', min: 0, max: 8, step: .5}, MR), 'Arredonda as esquinas como o meio-fio real e remove bicos e barrigas nas emendas. 0 = sem suavização.'),
      fr('Juntar trechos em ruas contínuas', ctl(cf, 'ruasEncadear', {t: 'chk'}, MR), 'Trechos ligados sem cruzamento recebem o mesmo deslocamento e a mesma largura (sem degraus).'));
    o.append(fr('Bordas no DXF como', ctl(cf, 'ruasSaida', {t: 'sel', o: [['pline', 'Polilinhas (contorno)'], ['linhas', 'Linhas soltas (LINE)']]}, M), 'Polilinhas: cada contorno é uma polilinha única. Linhas soltas: cada segmento vira uma entidade LINE.'),
      fr('Nomes das ruas', ctl(cf, 'ruasNomes', {t: 'chk'}, M)),
      fr('Altura do texto', ctl(cf, 'ruasH', {t: 'num', min: .2, step: .1}, M)));
    for (const [k, l] of [['principais', 'vias principais'], ['residenciais', 'vias residenciais'], ['servico', 'vias de serviço'], ['pedestre', 'caminhos/pedestres'], ['outros', 'outras']])
      o.append(fr('  ' + l, ctl(cf.ruasTipos, k, {t: 'chk'}, MR)));
}

function abrirDxp() {
  const cf = CFG.dxf, M = salvar, o = $('#dxo'); o.replaceChildren();
  o.append(fr('Textos como MTEXT', ctl(cf, 'mtext', {t: 'chk'}, M), 'Rótulos saem como MTEXT (DXF versão R2000). Desmarque para TEXT simples (R12).'));
  o.append(fr('Escala', ctl(cf, 'escala', {t: 'sel', o: [['1000', '1:1000 (1:1, em metros)'], ['500', '1:500 (vãos 2× maiores)']]}, M)),
    fr('Coordenadas', ctl(cf, 'origem', {t: 'sel', o: [['abs', 'UTM absolutas'], ['rel', 'Relativas ao centro da área']]}, M)),
    fr('Símbolos como blocos (INSERT)', ctl(cf, 'simbBlocos', {t: 'chk'}, M)),
    fr('Atributos nos blocos (ATTRIB)', ctl(cf, 'atributos', {t: 'chk'}, M)),
    fr('Incluir rótulos', ctl(cf, 'rotulos', {t: 'chk'}, M)),
    fr('Incluir arruamento (OpenStreetMap)', ctl(cf, 'ruas', {t: 'chk', re: false, on: () => { M(); renderOpcoesRuas(); }})));
  o.append(mk('div', {style: 'margin:4px 0'}, mk('button', {onclick: () => pjAba('arr')}, 'Configurar as ruas…')));
  o.append(fr('Incluir edificações (OSM)', ctl(cf, 'edif', {t: 'chk'}, M)));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nBR = v => (+v || 0).toLocaleString('pt-BR');
const mb = v => (v / 1048576).toFixed(1) + ' MB';
function montarDS(t, h, rows, instalar = true) {
  const ant = D[t], d = novo(); d.h = h.slice(); d.arqs = []; d.db = true; prep(t, d);
  D[t] = d;
  const n = d.h.length;
  for (const r of rows) { while (r.length < n) r.push(''); add(t, r); }
  if (!instalar) { if (ant) D[t] = ant; else delete D[t]; }
  return d;
}
function comD(dados, fn) {
  const salvo = {...D};
  for (const k of Object.keys(D)) delete D[k];
  Object.assign(D, dados); invalidar();
  try { return fn(); } finally { for (const k of Object.keys(D)) delete D[k]; Object.assign(D, salvo); invalidar(); }
}
// reavalia a seleção com os dados atuais (KML carregado/ligado depois de desenhar a área, camadas ligadas/desligadas)
async function selAtualizar() {
  if (!SEL) return;
  if (SEL.dados) await window.NG.atualizarKml(SEL.dados);
  SEL.ids = usarSel(() => selIds(SEL));
}
const usarSel = fn => SEL && SEL.dados ? comD(SEL.dados, fn) : fn();
