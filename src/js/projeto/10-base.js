/* Base do módulo Projeto: configuração, datasets e expressões (origem: CTWeb). */
const map = window.NG.map;
const COR_DESTAQUE = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f5a524';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const {toNum, toStr, truthy} = Expr;
const num = v => toNum(v) ?? 0;
const RAD = Math.PI / 180, MPX = 0.2645833; // MPX = metros por pixel de tela a 1:1000
const ESC = 1000, ANG_SENTIDO = 1, MINZ = 15, MAX = 20000, LMAX = 4000;
const TIPOS = {kmlp: /_kmlp\.csv$/i, kmll: /_kmll\.csv$/i, poste: /poste/i, bt: /rede_?bt/i, mt: /rede_?mt/i, inst: /instala/i};
const NOME = {poste: 'Poste', bt: 'Rede BT', mt: 'Rede MT', inst: 'Instalação', kmlp: 'KML · pontos', kmll: 'KML · linhas'};
const LINHA = t => t === 'bt' || t === 'mt' || t === 'kmll';
const PTS = ['poste', 'inst', 'kmlp'], LNS = ['mt', 'bt', 'kmll'], TODOS = ['poste', 'inst', 'bt', 'mt', 'kmlp', 'kmll'];
const KML = t => t === 'kmlp' || t === 'kmll';
const REDE = [/NU_TRECHO/, /NU_INSTALA/, /CONDUTOR|CABO/, /^CD_FASE$/];
const DEF = {
  poste: [/^NU_PG_ID$/, /^NU_ANGULO$/, /NU_ALTURA/, /NU_ESFORCO/, /DE_BARRAMEN/, /NU_INSTALA/],
  bt: REDE, mt: REDE, inst: [/^TIPO_INSTA$/, /^DE_PLACA$/, /NU_INSTALA/, /^NU_PG_ID$/],
  kmlp: [/^NOME$/, /^DESCRICAO$/, /^PASTA$/], kmll: [/^NOME$/, /^DESCRICAO$/, /^PASTA$/]
};
const D = {}, ativo = {poste: true, bt: true, mt: true, inst: true, kmlp: true, kmll: true};
let avisou = false, ULT = null;
const VERSAO = 'v20.0 · 29/10/2026';
const LC = new Map(), ESTC = new Map(), BLOCOS = {};

/** Blocos DXF do estilo padrão (só os usados pelas regras). */
function blocosPadrao() {
  const out = {};
  if (typeof ESTILO_PADRAO !== 'undefined' && ESTILO_PADRAO && ESTILO_PADRAO.blocos) {
    for (const [nome, bl] of Object.entries(ESTILO_PADRAO.blocos)) {
      try { out[nome] = DXF.prepBloco({...bl}); } catch { /* bloco inválido no padrão */ }
    }
  }
  return out;
}
Object.assign(BLOCOS, blocosPadrao());

// ---------------- configuração padrão ----------------
const FONTES = ['Inter Variable', 'Segoe UI', 'Arial', 'Verdana', 'Tahoma', 'Calibri', 'Consolas', 'Courier New', 'Times New Roman', 'Georgia', 'Impact'];
const ESTP = () => ({forma: 'ret', tam: 14, tamh: 7, cor: '#fbbf24', borda: '#08141c', bordaW: 1, larg: 3, opac: 1, girar: true, angOff: 0, zoomEsc: true, bloco: '', blocoModo: 'ajustar', blocoK: 1, atrib: ''});
const ESTL = () => ({cor: '#2dd4bf', larg: 2.8, dash: '', opac: 1, cap: 'round', casing: false, casingCor: '#000000', casingW: 1.5, zoomEsc: true});
const ROT = o => Object.assign({
  on: true, nome: 'Rótulo', filtro: '', expr: '', fonte: 'Inter Variable', tam: 11, neg: true, ital: false, cor: '#ffffff', corExpr: '', halo: true, haloCor: '#03080c', haloW: 3,
  alinh: 'esq', esp: 1.1, bal: 'nenhum', balFill: '#17303f', balOp: .9, balBorda: '#ffffff', balBW: 1, pad: 1,
  pos: 'dir', modo: 'horizontal', lado: 'acima', ancora: 'meio', dist: 10, dx: 0, dy: 0, rot: 'nenhuma', rotExpr: '', rotOff: 0,
  minZ: 17, maxZ: 22, colisao: true, prior: 0, camada: 'TXT', dxfH: 1.5, dxfW: 1
}, o);
const EX_POSTE = `if("NU_ALTURA" IS NULL AND "NOME" IS NOT NULL, "NOME", sigla(coalesce("TIPO_PG","CD_TIPO_PG_DESC")) || coalesce("NU_ALTURA",'?') || '/' || coalesce("NU_ESFORCO",'?') || '\\n' || "DE_BARRAMENTO" || '\\n' || coalesce("MATERIAL","CD_INDD_MATERIAL_PG_DESC"))`;
const EX_INST = `coalesce("TIPO_INSTA","TIPO_SIGLA","NU_TIPO_INSTALACAO_MT_ID_DESC") || '\\n' || "DE_PLACA"`;
const EX_REDE = `uniq_join('/', "CONDUTOR_A","CONDUTOR_B","CONDUTOR_C") || if(length(uniq_join('', "CONDUTOR_N")) > 0, ' + N ' || "CONDUTOR_N", '') || if(length(uniq_join('/', "CONDUTOR_A","CONDUTOR_B","CONDUTOR_C")) > 0, ' · ', '') || format_number(coalesce(nullif(to_real("NU_COMPRIMENTO_REAL"),0), nullif(to_real("SHP_LENGTH"),0), $length), 1) || ' m'`;
const EXI = `upper(coalesce("TIPO_INSTA","TIPO_SIGLA","NU_TIPO_INSTALACAO_MT_ID_DESC",''))`;
function cfgPadrao() {
  const base = {
    v: 2,
    cam: {
      poste: {base: {...ESTP(), atrib: 'NU_PG_ID\nNU_ALTURA\nNU_ESFORCO\nDE_BARRAMENTO'}, rules: [],
        labels: [ROT({nome: 'Altura/esforço', expr: EX_POSTE, cor: '#ffe08a', dist: 9, camada: 'TXT_POSTES'})]},
      inst: {base: {...ESTP(), forma: 'circ', tam: 10, cor: '#a78bfa', bordaW: 1.5, girar: false, zoomEsc: false, atrib: 'NU_INSTALA\nTIPO_INSTA\nDE_PLACA'},
        rules: [
          {nome: 'Chave fusível religadora', on: true, expr: EXI + " LIKE 'CHAVE FUSIVEL RELIGADORA%'", est: {forma: 'quad', tam: 14, bordaW: 1.5}, camada: ''},
          {nome: 'Transformador', on: true, expr: EXI + " LIKE 'TRAFO%'", est: {forma: 'tri', tam: 18}, camada: ''},
          {nome: 'Chave', on: true, expr: EXI + " LIKE 'CHAVE%'", est: {forma: 'linha', tam: 20, larg: 4, girar: true}, camada: ''}],
        labels: [ROT({nome: 'Tipo e placa', expr: EX_INST, cor: '#f1f5f9', alinh: 'dir', pos: 'esq', dist: 12, dy: -3, prior: 1, camada: 'TXT_INSTALACOES'})]},
      kmlp: {base: {...ESTP(), forma: 'circ', tam: 10, cor: '#f472b6', borda: '#08141c', bordaW: 1.5, girar: false, zoomEsc: false, corKml: true, atrib: 'NOME\nDESCRICAO\nPASTA'}, rules: [],
        labels: [ROT({nome: 'Nome', expr: '"NOME"', cor: '#ffe08a', dist: 9, minZ: 17, camada: 'TXT_KML'})]},
      kmll: {base: {...ESTL(), cor: '#38bdf8', larg: 2, corKml: true}, rules: [],
        labels: [ROT({nome: 'Nome', expr: '"NOME"', cor: '#ffd9a0', modo: 'alinhado', lado: 'acima', dist: 1, alinh: 'cen', minZ: 18, prior: 2, camada: 'TXT_KML'})]},
      bt: {base: ESTL(), rules: [],
        labels: [ROT({nome: 'Condutor e metragem', expr: EX_REDE, cor: '#a7f3b8', modo: 'alinhado', lado: 'abaixo', dist: 1, alinh: 'cen', prior: 2, camada: 'TXT_BT'})]},
      mt: {base: {...ESTL(), cor: '#fb7185', larg: 5}, rules: [],
        labels: [ROT({nome: 'Condutor e metragem', expr: EX_REDE, cor: '#ffb4b4', modo: 'alinhado', lado: 'acima', dist: 1, alinh: 'cen', prior: 2, camada: 'TXT_MT'})]}
    },
    dxf: {
      escala: '1000', origem: 'abs', simbBlocos: true, atributos: true, attInvisivel: true, rotulos: true,
      ruas: true, ruasModo: 'pista', ruasAjustar: true, ruasMargem: 0.2, ruasMaxDesl: 4, ruasRaio: 3, ruasEncadear: true, regrasPoste: {}, ruasLargMin: 65, ruasFaixa: 3.2, ruasOriginal: false, ruasPrevia: true, ruasEdit: [], ruasSaida: 'pline', mtext: true, projeto: {t: {}, s: {}, i: {}, cam: {}, ex: [], seq: 1, fundo: 'mapa'}, ruasLarg: {arterial: 13, principal: 9, residencial: 7, calma: 5, servico: 4.5, pedestre: 2.5, outros: 6}, ruasNomes: true, ruasH: 1.5, ruasTipos: {principais: true, residenciais: true, servico: true, pedestre: false, outros: false}, edif: false,
      camadas: {poste: 'POSTES', inst: 'INSTALACOES', bt: 'REDE_BT', mt: 'REDE_MT', kmlp: 'KML_PONTOS', kmll: 'KML_LINHAS', ruas: 'ARRUAMENTO', ruasOrig: 'ARRUAMENTO_ORIGINAL', txtRuas: 'TXT_RUAS', edif: 'EDIFICACOES'},
      fonte: 'arial.ttf', estiloLinha: true, ruasCor: '#c0c0c0', edifCor: '#808080'
    },
    quant: {
      poste: `coalesce("TIPO_PG","CD_TIPO_PG_DESC") || ' ' || "NU_ALTURA" || '/' || "NU_ESFORCO"`,
      inst: `coalesce("TIPO_INSTA","TIPO_SIGLA","NU_TIPO_INSTALACAO_MT_ID_DESC")`,
      bt: `uniq_join('/', "CONDUTOR_A","CONDUTOR_B","CONDUTOR_C")`,
      mt: `uniq_join('/', "CONDUTOR_A","CONDUTOR_B","CONDUTOR_C")`,
      kmlp: `coalesce("GRUPO","NOME")`, kmll: `coalesce("GRUPO","NOME")`
    },
    lod: {on: true, zRare: 8, zMT: 12, zBT: 13.5, zRot: 14.5, palavras: 'RELIGAD,FRONTEIRA,INTERLIG,FRONT', raras: EXI + " LIKE '%RELIGAD%' OR " + EXI + " LIKE '%FRONTEIRA%' OR " + EXI + " LIKE '%INTERLIG%' OR " + EXI + " LIKE '%FRONT%'"},
    kml: {ocultos: {}},
    // Exibição no mapa: rótulos de cada camada (a chave geral "Rótulos" vale por cima) e o arruamento offline.
    mapa: {rot: {poste: true, inst: true, bt: true, mt: true, kml: true, ruas: true},
      ruas: {cor: '#ff9f1c', larg: 1.5, opac: .8, rotCor: '#ffe2b8', rotMinZ: 17}},
    limites: {est: false, mun: false, estCor: '#ffd166', estW: 3, munCor: '#9aa5ad', munW: 1, munTrac: false, rot: true, rotCor: '#e6eef5'},
    geral: {lembrar: true, perguntarPasta: false, perguntarAbrir: true}
  };
  // Estilo da equipe (src/js/projeto/estilo-padrao.js) por cima do padrão estrutural.
  if (typeof ESTILO_PADRAO === 'undefined' || !ESTILO_PADRAO || !ESTILO_PADRAO.cfg) return base;
  return mesclar(base, JSON.parse(JSON.stringify(ESTILO_PADRAO.cfg)));
}
function mesclar(a, b) {
  if (b === undefined || b === null) return a;
  if (Array.isArray(a) || typeof a !== 'object' || a === null) return b;
  if (typeof b !== 'object' || Array.isArray(b)) return a;
  const o = {...a};
  for (const k of Object.keys(b)) o[k] = k in a ? mesclar(a[k], b[k]) : b[k];
  return o;
}
let CFG = cfgPadrao();
function normalizarCfg() {
  for (const t of Object.keys(TIPOS)) {
    const c = CFG.cam[t];
    c.base = {...(LINHA(t) ? ESTL() : ESTP()), ...c.base};
    c.rules = (c.rules || []).map(r => ({nome: 'Regra', on: true, expr: '', camada: '', ...r, est: r.est || {}}));
    c.labels = (c.labels || []).map(l => ROT(l));
  }
}

// ---------------- utilidades geográficas ----------------
function utm(lat, lon, Z) {
  const a = 6378137, f = 1 / 298.257222101, k0 = .9996, e2 = f * (2 - f), ep = e2 / (1 - e2);
  const p = lat * RAD, dl = (lon - ((Z - 1) * 6 - 180 + 3)) * RAD, sn = Math.sin(p), cs = Math.cos(p), tn = Math.tan(p);
  const N = a / Math.sqrt(1 - e2 * sn * sn), T = tn * tn, C = ep * cs * cs, A = dl * cs;
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p) - 35 * e2 ** 3 / 3072 * Math.sin(6 * p));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep) * A ** 5 / 120) + 500000;
  const y = k0 * (M + N * tn * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep) * A ** 6 / 720));
  return [x, lat < 0 ? y + 1e7 : y];
}
const hav = (la1, lo1, la2, lo2) => {
  const R = 6371008.8, p1 = la1 * RAD, p2 = la2 * RAD, dp = p2 - p1, dl = (lo2 - lo1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};
let tsv = 0;
function salvar() {
  clearTimeout(tsv);
  tsv = setTimeout(() => {
    window.NG.wsPut('cfg', {CFG, BLOCOS}).catch(() => {});
  }, 600);
}
function invalidar(t) {
  for (const k of (t ? [t] : Object.keys(D))) if (D[k]) { D[k].rc = []; D[k].rr = []; }
  for (const k of [...LC.keys()]) if (!t || k.startsWith(t + '|')) LC.delete(k);
  ESTC.clear();
}
// zoom mínimo em que algo é desenhado
const zMin = () => CFG.lod.on ? Math.min(MINZ, CFG.lod.zRare) : MINZ;
// instalação "rara" (religadora / fronteira): única camada visível nos zooms mais afastados
function rara(d, i) {
  const r = d.rr || (d.rr = []);
  let v = r[i]; if (v === undefined) { const x = ev(CFG.lod.raras, 'inst', i); v = r[i] = truthy(x); }
  return v;
}
// Com o projeto aberto, o desenho precisa ser refeito para o estilo novo aparecer.
let tRegen = 0;
function mudou(t) {
  invalidar(t); salvar(); desenhar();
  if (typeof PJ !== 'undefined' && PJ.on && !PJ.pausa) { clearTimeout(tRegen); tRegen = setTimeout(() => pjRegerar(), 300); }
}
// ---------------- dados ----------------
const idx = (d, re) => d.h.map((n, j) => re.test(n) && !/_DESC$|^GEOMETRIA_WKT$/.test(n) ? j : -1).filter(j => j >= 0);
const lig = (m, k, i) => { if (k == null || k === '') return; (m.get(k) || m.set(k, []).get(k)).push(i); };
function novo() { return {h: [], hi: new Map(), rows: [], X: [], Y: [], x0: [], y0: [], x1: [], y1: [], geo: new Map(), grid: new Map(), by: new Map(), mp: new Map(), sel: [], rc: [], len: new Map()}; }
function prep(t, d) {
  const g = n => d.h.indexOf(n);
  d.hi = new Map(d.h.map((n, j) => [n, j]));
  d.na = g('NU_ANGULO'); d.gx = g('GEO_X'); d.gy = g('GEO_Y'); d.w = g('GEOMETRIA_WKT');
  d.id = d.h.findIndex(n => /^NU_PG_ID$/.test(n));
  d.pi = d.h.findIndex(n => /^NU_PG_INI/.test(n));
  d.pf = d.h.findIndex(n => /^NU_PG_FIN/.test(n));
  d.nm = g('NOME'); d.gr = g('GRUPO'); d.ck = g('COR_KML'); d.lk = g('LARG_KML');
  d.ni = idx(d, /NU_INSTALA/)[0] ?? -1;
  d.sel = [...new Set(DEF[t].flatMap(re => idx(d, re)))].sort((a, b) => a - b);
}
function pt(d, r) {
  if (d.w >= 0 && r[d.w]) { const m = r[d.w].match(/(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/); if (m) return [+m[1], +m[2]]; }
  if (d.gx >= 0 && r[d.gx]) return [+String(r[d.gx]).replace(',', '.'), +String(r[d.gy]).replace(',', '.')];
  return null;
}
const RN = /(-?\d+\.?\d*(?:[eE][-+]?\d+)?)\s+(-?\d+\.?\d*(?:[eE][-+]?\d+)?)/g;
function bboxWkt(s) {
  let a = 1e9, b = 1e9, c = -1e9, e = -1e9, m; RN.lastIndex = 0;
  while ((m = RN.exec(s))) { const x = +m[1], y = +m[2]; if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > e) e = y; }
  return a > c ? null : [a, b, c, e];
}
function cel(d, k, i) { (d.grid.get(k) || d.grid.set(k, []).get(k)).push(i); }
function add(t, r) {
  const d = D[t], i = d.rows.push(r) - 1, lin = LINHA(t), p = pt(d, r);
  d.X[i] = p ? p[0] : NaN; d.Y[i] = p ? p[1] : NaN; d.x0[i] = d.y0[i] = d.x1[i] = d.y1[i] = NaN;
  if (lin) {
    lig(d.mp, r[d.pi], i); lig(d.mp, r[d.pf], i);
    const bb = d.w >= 0 && r[d.w] ? bboxWkt(r[d.w]) : null;
    if (!bb) return;
    [d.x0[i], d.y0[i], d.x1[i], d.y1[i]] = bb;
    if (!p) { d.X[i] = bb[0]; d.Y[i] = bb[1]; }
    const ax = Math.floor(bb[0] * 100), bx = Math.floor(bb[2] * 100), ay = Math.floor(bb[1] * 100), by = Math.floor(bb[3] * 100);
    if ((bx - ax + 1) * (by - ay + 1) > 3000) { cel(d, ax + ',' + ay, i); return; }
    for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) cel(d, x + ',' + y, i);
    return;
  }
  if (!p) return;
  if (Math.abs(p[0]) > 180 && !avisou) { avisou = true; alert('As coordenadas parecem UTM. Gere os CSVs com OUT_SR = 4326 (latitude/longitude).'); }
  cel(d, Math.floor(p[0] * 100) + ',' + Math.floor(p[1] * 100), i);
  if (t === 'poste') { if (d.id >= 0) d.by.set(r[d.id], i); }
  else if (t === 'kmlp') { if (d.nm >= 0) d.by.set(r[d.nm], i); }
  else { if (d.ni >= 0) d.by.set(r[d.ni], i); lig(d.mp, r[d.id], i); }
}
const corDe = t => CFG.cam[t].base.cor;
// ---------------- contexto das expressões ----------------
const CTX = {d: null, r: null, i: 0, t: '', fld(n) { const j = this.d.hi.get(n); if (j === undefined) return null; const v = this.r[j]; return v === undefined || v === '' ? null : v; }};
function ev(src, t, i) {
  if (!src) return null;
  const c = Expr.compile(src); if (c.err) return null;
  const d = D[t]; if (!d) return null;
  CTX.t = t; CTX.d = d; CTX.i = i; CTX.r = d.rows[i];
  try { return c.fn(CTX); } catch (e) { return null; }
}
const colOf = (d, r, n) => { const j = d.hi.get(n); return j === undefined ? null : (r[j] === '' ? null : r[j]); };
const attrOf = (dd, i, f) => dd && i != null ? colOf(dd, dd.rows[i], String(f).toUpperCase()) : null;
Expr.vars['$length'] = c => LINHA(c.t) ? comprGeo(c.d, c.i) : null;
Expr.vars['$x'] = c => c.d.X[c.i];
Expr.vars['$y'] = c => c.d.Y[c.i];
Expr.vars['$angle'] = c => c.d.na >= 0 ? toNum(c.r[c.d.na]) : null;
Expr.vars['$id'] = c => c.i + 1;
Expr.vars['@layer'] = c => c.t;
Expr.ctxFns.attribute = (c, f) => attrOf(c.d, c.i, f);
Expr.ctxFns.n_inst = c => { const l = D.inst && c.t === 'poste' ? D.inst.mp.get(c.r[c.d.id]) : null; return l ? l.length : 0; };
Expr.ctxFns.inst_attr = (c, f, sep) => {
  const l = D.inst && c.t === 'poste' ? D.inst.mp.get(c.r[c.d.id]) : null;
  return l ? [...new Set(l.map(k => attrOf(D.inst, k, f)).filter(Boolean))].join(sep == null ? ', ' : toStr(sep)) : null;
};
Expr.ctxFns.n_trechos = (c, tp) => { const g = D[String(tp || 'bt').toLowerCase()]; const l = g && c.t === 'poste' ? g.mp.get(c.r[c.d.id]) : null; return l ? l.length : 0; };
Expr.ctxFns.poste_attr = (c, f) => {
  if (!D.poste || c.t === 'poste') return null;
  const id = c.t === 'inst' ? c.r[c.d.id] : c.r[c.d.pi];
  return attrOf(D.poste, D.poste.by.get(id), f);
};
Expr.ctxFns.poste_ini = (c, f) => D.poste && LINHA(c.t) ? attrOf(D.poste, D.poste.by.get(c.r[c.d.pi]), f) : null;
Expr.ctxFns.poste_fin = (c, f) => D.poste && LINHA(c.t) ? attrOf(D.poste, D.poste.by.get(c.r[c.d.pf]), f) : null;

function wkt(s) {
  return s.replace(/^[A-Z]+\s*/, '').split(/\)\s*,\s*\(/).map(parte =>
    parte.replace(/[()]/g, '').split(',').map(c => { const [x, y] = c.trim().split(/\s+/); return [+y, +x]; }));
}
function geo(d, i) {
  let g = d.geo.get(i);
  if (!g) { if (d.geo.size > 60000) d.geo.clear(); g = wkt(d.rows[i][d.w]); d.geo.set(i, g); }
  return g; // anéis de [lat, lon]
}
function comprGeo(d, i) {
  let v = d.len.get(i);
  if (v === undefined) {
    v = 0; if (d.len.size > 200000) d.len.clear();
    for (const ring of geo(d, i)) for (let k = 1; k < ring.length; k++) v += hav(ring[k - 1][0], ring[k - 1][1], ring[k][0], ring[k][1]);
    d.len.set(i, v);
  }
  return v;
}
function compr(d, i) {
  const r = d.rows[i];
  return num(colOf(d, r, 'NU_COMPRIMENTO_REAL')) || num(colOf(d, r, 'SHP_LENGTH')) || comprGeo(d, i);
}
const angDe = (d, i) => d.na >= 0 ? num(d.rows[i][d.na]) : 0;

// ---------------- estilos (regras) ----------------
function regraDe(t, i) {
  const d = D[t]; let k = d.rc[i];
  if (k !== undefined) return k;
  const rs = CFG.cam[t].rules; k = -1;
  for (let q = 0; q < rs.length; q++) { const r = rs[q]; if (r.on && r.expr && truthy(ev(r.expr, t, i))) { k = q; break; } }
  d.rc[i] = k; return k;
}
// chave de grupo: número da regra (-1 = base) ou "regra|#cor" quando a cor vem do próprio KML
const kIdx = k => typeof k === 'string' ? parseInt(k, 10) : k;
function estEf(t, k) {
  const key = t + '|' + k; let e = ESTC.get(key);
  if (!e) {
    const c = CFG.cam[t], ri = kIdx(k);
    e = ri >= 0 && c.rules[ri] ? {...c.base, ...c.rules[ri].est} : {...c.base};
    if (typeof k === 'string') e.cor = k.slice(k.indexOf('|') + 1);
    ESTC.set(key, e);
  }
  return e;
}
const kmlOculto = (d, i) => d.gr >= 0 && CFG.kml.ocultos[d.rows[i][d.gr]];
function agrupar(t, ids) {
  const m = new Map(), c = CFG.cam[t], rs = c.rules, hasR = rs.length > 0, d = D[t];
  const kc = KML(t) && c.base.corKml && d.ck >= 0;
  for (const i of ids) {
    const r = hasR ? regraDe(t, i) : -1; let k = r;
    if (kc && !(r >= 0 && rs[r].est && rs[r].est.cor)) { const cor = d.rows[i][d.ck]; if (cor) k = r + '|' + cor; }
    (m.get(k) || m.set(k, []).get(k)).push(i);
  }
  return [...m.entries()].sort((a, b) => kIdx(a[0]) - kIdx(b[0]) || (String(a[0]) < String(b[0]) ? -1 : 1));
}
const MM_PX = 0.0002645833;
const zoomEscala = (lat, den = ESC) => Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / (den * MM_PX));
function irEscala(lat, lon, den = ESC) { map.setView([lat, lon], zoomEscala(lat, den)); }
const PAD = .25;
const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
cv.style.pointerEvents = 'none';
let ZS = 1, OX = 0, OY = 0, PX = 0, PY = 0, padX = 0, padY = 0, raf = 0, occ = new Map(), nl = 0, MPP = 1;
const medidas = new Map();
const pj = (lon, lat) => {
  const sn = Math.sin(lat * RAD);
  PX = (lon + 180) / 360 * ZS - OX;
  PY = (.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * ZS - OY;
};
const larg = (f, s) => {
  const k = f + '|' + s; let w = medidas.get(k);
  if (w === undefined) { w = ctx.measureText(s).width; if (medidas.size > 50000) medidas.clear(); medidas.set(k, w); }
  return w;
};
function livre(x0, y0, x1, y1) {
  for (let a = Math.floor(x0 / 64); a <= Math.floor(x1 / 64); a++) for (let b = Math.floor(y0 / 64); b <= Math.floor(y1 / 64); b++)
    for (const q of occ.get(a * 100000 + b) || []) if (x0 < q[2] && x1 > q[0] && y0 < q[3] && y1 > q[1]) return false;
  return true;
}
function ocupar(x0, y0, x1, y1) {
  const q = [x0, y0, x1, y1];
  for (let a = Math.floor(x0 / 64); a <= Math.floor(x1 / 64); a++) for (let b = Math.floor(y0 / 64); b <= Math.floor(y1 / 64); b++) {
    const k = a * 100000 + b; (occ.get(k) || occ.set(k, []).get(k)).push(q);
  }
}

const zfz = z => z >= 17 ? 1 : z >= 16 ? .64 : .43;
const blocoBase = bl => bl.centro ? [(bl.bb[0] + bl.bb[2]) / 2, (bl.bb[1] + bl.bb[3]) / 2] : bl.base;
function desenharBloco(c, est, bl, x, y, a, sz, mpp) {
  const s = est.blocoModo === 'original' ? est.blocoK / mpp : sz / (bl.max || 1), b = blocoBase(bl);
  c.save(); c.translate(x, y); c.rotate(a); c.scale(s, -s); c.translate(-b[0], -b[1]);
  c.globalAlpha = est.opac; c.lineWidth = Math.max(.5, est.bordaW || 1) / s; c.lineJoin = 'round';
  for (const p of bl.dp) {
    const col = (p.c && DXF.aciHex(p.c)) || est.cor;
    c.strokeStyle = col; c.fillStyle = col; c.beginPath();
    p.pts.forEach((q, k) => k ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]));
    if (p.closed) c.closePath();
    if (p.fill) c.fill(); else c.stroke();
  }
  c.restore();
}
// ---------------- rótulos ----------------
const fontOf = L => `${L.ital ? 'italic ' : ''}${L.neg ? '700' : '400'} ${L.tam}px "${L.fonte}",system-ui,sans-serif`;
const legivel = a => { a = Math.atan2(Math.sin(a), Math.cos(a)); return a > Math.PI / 2 ? a - Math.PI : a < -Math.PI / 2 ? a + Math.PI : a; };
const FR = {meio: .5, ini: .2, fim: .8};
function pontoAoLongo(xs, ys, tot, frac) {
  const alvo = tot * frac; let acc = 0;
  for (let k = 1; k < xs.length; k++) {
    const l = Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
    if (acc + l >= alvo || k === xs.length - 1) {
      const u = l ? Math.min(1, Math.max(0, (alvo - acc) / l)) : 0;
      return {x: xs[k - 1] + (xs[k] - xs[k - 1]) * u, y: ys[k - 1] + (ys[k] - ys[k - 1]) * u, ang: Math.atan2(ys[k] - ys[k - 1], xs[k] - xs[k - 1]), len: tot};
    }
    acc += l;
  }
  return null;
}
function ancoraPx(d, i, frac) {
  const ring = geo(d, i)[0]; if (!ring || ring.length < 2) return null;
  const xs = [], ys = []; let tot = 0;
  for (let k = 0; k < ring.length; k++) { pj(ring[k][1], ring[k][0]); xs.push(PX); ys.push(PY); if (k) tot += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]); }
  return pontoAoLongo(xs, ys, tot, FR[frac] ?? .5);
}
function rotInfo(t, li, i) {
  const key = t + '|' + li; let m = LC.get(key); if (!m) LC.set(key, m = new Map());
  let v = m.get(i); if (v !== undefined) return v;
  const L = CFG.cam[t].labels[li]; v = null;
  if (!L.filtro || truthy(ev(L.filtro, t, i))) {
    const lines = toStr(ev(L.expr, t, i)).split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length) v = {lines, cor: L.corExpr ? (toStr(ev(L.corExpr, t, i)) || null) : null, rot: L.rot === 'expr' ? (toNum(ev(L.rotExpr, t, i)) ?? 0) : 0};
  }
  m.set(i, v); return v;
}
// ângulo (rad, horário na tela) do texto em elementos não alinhados à linha
function rotPonto(L, inf, t, i, angLinha) {
  let a = 0;
  if (L.rot === 'angulo') a = LINHA(t) ? angLinha : (D[t].na >= 0 ? angDe(D[t], i) * RAD * ANG_SENTIDO : 0);
  else if (L.rot === 'expr') a = inf.rot * RAD;
  return legivel(a + L.rotOff * RAD);
}
// Posição da caixa de texto no sistema local do elemento (y para baixo), em qualquer unidade (U = unidades por px)
function layoutRot(L, n, lw, lh, U, kind, angAl, rotH) {
  const pad = L.pad * U, d = L.dist * U, dx = L.dx * U, dy = L.dy * U, bw = lw + 2 * pad, bh = n * lh + 2 * pad;
  let x, y, rot;
  if (kind === 'ln' && L.modo === 'alinhado') { rot = angAl; x = -bw / 2; y = L.lado === 'acima' ? -d - bh : L.lado === 'abaixo' ? d : -bh / 2; }
  else {
    rot = rotH; const q = .7 * d;
    switch (L.pos) {
      case 'esq': x = -d - bw; y = -bh / 2; break;
      case 'cima': x = -bw / 2; y = -d - bh; break;
      case 'baixo': x = -bw / 2; y = d; break;
      case 'centro': x = -bw / 2; y = -bh / 2; break;
      case 'ne': x = q; y = -q - bh; break;
      case 'no': x = -q - bw; y = -q - bh; break;
      case 'se': x = q; y = q; break;
      case 'so': x = -q - bw; y = q; break;
      default: x = d; y = -bh / 2;
    }
  }
  return {x: x + dx, y: y + dy, w: bw, h: bh, rot, pad};
}
// ponta do balão apontando para o elemento (0,0 no sistema local)
function calcTip(lay, r, U) {
  const {x, y, w, h} = lay;
  const cx = Math.max(x, Math.min(0, x + w)), cy = Math.max(y, Math.min(0, y + h));
  if (Math.hypot(cx, cy) < 3 * U) return null;
  const dx0 = -(x + w / 2), dy0 = -(y + h / 2);
  const side = Math.abs(dx0) * h > Math.abs(dy0) * w ? (dx0 > 0 ? 'r' : 'l') : (dy0 > 0 ? 'b' : 't');
  const bs = 8 * U, hor = side === 't' || side === 'b', lo = hor ? x : y, len = hor ? w : h;
  const a0 = lo + r + bs / 2, a1 = lo + len - r - bs / 2;
  const m = a1 > a0 ? Math.max(a0, Math.min(0, a1)) : lo + len / 2;
  return {side, a: m - bs / 2, b: m + bs / 2, x: 0, y: 0};
}
function pathBalao(c, x, y, w, h, r, tp) {
  const x2 = x + w, y2 = y + h;
  c.beginPath(); c.moveTo(x + r, y);
  if (tp && tp.side === 't') { c.lineTo(tp.a, y); c.lineTo(tp.x, tp.y); c.lineTo(tp.b, y); }
  c.lineTo(x2 - r, y); if (r) c.arcTo(x2, y, x2, y + r, r);
  if (tp && tp.side === 'r') { c.lineTo(x2, tp.a); c.lineTo(tp.x, tp.y); c.lineTo(x2, tp.b); }
  c.lineTo(x2, y2 - r); if (r) c.arcTo(x2, y2, x2 - r, y2, r);
  if (tp && tp.side === 'b') { c.lineTo(tp.b, y2); c.lineTo(tp.x, tp.y); c.lineTo(tp.a, y2); }
  c.lineTo(x + r, y2); if (r) c.arcTo(x, y2, x, y2 - r, r);
  if (tp && tp.side === 'l') { c.lineTo(x, tp.b); c.lineTo(tp.x, tp.y); c.lineTo(x, tp.a); }
  c.lineTo(x, y + r); if (r) c.arcTo(x, y, x + r, y, r);
  c.closePath();
}
function pintarRot(L, lines, ox, oy, rot, cor, lay, lh) {
  ctx.save(); ctx.translate(ox, oy); if (rot) ctx.rotate(rot);
  const {x, y, w, h, pad} = lay;
  if (L.bal !== 'nenhum') {
    const r = L.bal === 'arred' || L.bal === 'balao' ? Math.min(6, h / 2) : 0;
    pathBalao(ctx, x, y, w, h, r, L.bal === 'balao' ? calcTip(lay, r, 1) : null);
    ctx.globalAlpha = L.balOp; ctx.fillStyle = L.balFill; ctx.fill(); ctx.globalAlpha = 1;
    if (L.balBW > 0) { ctx.lineWidth = L.balBW; ctx.strokeStyle = L.balBorda; ctx.lineJoin = 'round'; ctx.stroke(); }
    if (L.bal === 'linha') {
      const px = Math.max(x, Math.min(0, x + w)), py = Math.max(y, Math.min(0, y + h));
      if (Math.hypot(px, py) > 2) {
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(0, 0); ctx.lineWidth = Math.max(1, L.balBW); ctx.strokeStyle = L.balBorda; ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 2, 0, 6.2832); ctx.fillStyle = L.balBorda; ctx.fill();
      }
    }
  }
  ctx.textAlign = L.alinh === 'dir' ? 'right' : L.alinh === 'cen' ? 'center' : 'left'; ctx.textBaseline = 'middle';
  const tx = L.alinh === 'dir' ? x + w - pad : L.alinh === 'cen' ? x + w / 2 : x + pad;
  ctx.lineJoin = 'round'; ctx.lineWidth = L.haloW; ctx.strokeStyle = L.haloCor; ctx.fillStyle = cor;
  lines.forEach((s, k) => { const yy = y + pad + (k + .5) * lh; if (L.halo && L.haloW > 0) ctx.strokeText(s, tx, yy); ctx.fillText(s, tx, yy); });
  ctx.restore();
}
function caixasRot(ox, oy, rot, x, y, w, h) {
  if (!rot || Math.abs(rot) < .01) return [[ox + x, oy + y, ox + x + w, oy + y + h]];
  const c = Math.cos(rot), s = Math.sin(rot), n = Math.max(1, Math.ceil(w / Math.max(8, h * .8))), r = h / 2 - 1, out = [];
  for (let k = 0; k < n; k++) { const lx = x + (k + .5) / n * w, ly = y + h / 2, wx = ox + lx * c - ly * s, wy = oy + lx * s + ly * c; out.push([wx - r, wy - r, wx + r, wy + r]); }
  return out;
}
function colocar(j) {
  if (nl >= LMAX) return;
  const {L, inf, an} = j, lines = inf.lines, f = fontOf(L);
  ctx.font = f;
  let lw = 0; for (const s of lines) lw = Math.max(lw, larg(f, s));
  const lh = L.tam * L.esp, ang = legivel(an.ang);
  const rotH = j.ln && L.modo === 'alinhado' ? 0 : rotPonto(L, inf, j.t, j.i, ang);
  const lay = layoutRot(L, lines.length, lw, lh, 1, j.ln ? 'ln' : 'pt', ang, rotH);
  const cx = caixasRot(an.x, an.y, lay.rot, lay.x, lay.y, lay.w, lay.h);
  if (L.colisao) for (const c of cx) if (!livre(c[0], c[1], c[2], c[3])) return;
  for (const c of cx) ocupar(c[0], c[1], c[2], c[3]);
  nl++;
  pintarRot(L, lines, an.x, an.y, lay.rot, inf.cor || L.cor, lay, lh);
}
