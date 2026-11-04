/* Módulo Projeto (origem: CTWeb, otimizado para o NeoGrid). */
// ================= módulo Projeto =================
// Mostra só a área selecionada, na escala do DXF (textos com a altura real do desenho), e permite editar tudo
// visualmente: textos (editor estilo MTEXT dentro do mapa), linhas de rede e arruamento, blocos, cores, anotações,
// localizar e substituir, seleção múltipla. As edições ficam em CFG.dxf.projeto (nunca alteram os dados) e são
// aplicadas na tela e no DXF por um gancho (DXF.setHook) no gerador, então o que se vê é exatamente o que sai.
const PJ = {on: false, items: [], defs: new Map(), layers: new Map(), cap: null, sels: [], tool: 'sel', hist: [], fut: [], usados: new Map(),
  osm: null, ruasR: null, hit: [], cv: null, g: null, c: null, tmp: null, drag: null, lib: new Map(), osmVis: false,
  keyN: new Map(), gmap: new Map(), espaco: false, pan: false, ed: null, busca: {q: '', r: '', caso: false, palavra: false, regex: false, esc: 'todos', res: [], i: -1}, alca: null};
const PRJ = () => {
  const c = CFG.dxf, p = c.projeto || (c.projeto = {});
  p.t = p.t || {}; p.s = p.s || {}; p.i = p.i || {}; p.e = p.e || {}; p.cam = p.cam || {}; p.ex = p.ex || []; p.fav = p.fav || []; p.seq = p.seq || 1; p.fundo = p.fundo || 'mapa';
  return p;
};
const pjNEd = p => Object.keys(p.t).length + Object.keys(p.s).length + Object.keys(p.i).length + Object.keys(p.e).length + Object.keys(p.cam).length;
function projTemEdicao() { const p = PRJ(); return !!(pjNEd(p) || p.ex.length); }
function projAtivo() { const p = PRJ(); return PJ.on || Object.keys(p.i).length > 0 || p.ex.some(x => x.t === 'BLOCO'); }
const sk = s => s.k + ':' + (s.k === 'X' ? s.id : s.key);
const pjSel1 = () => PJ.sels.length === 1 ? PJ.sels[0] : null;
const pjGrupo = arr => {   // anotações do mesmo grupo (ex.: Anotar poste) são selecionadas juntas
  const gs = new Set(arr.filter(s => s.k === 'X').map(s => (PRJ().ex.find(x => x.id === s.id) || {}).grp).filter(Boolean)); if (!gs.size) return arr;
  const out = [...arr]; for (const x of PRJ().ex) if (x.grp && gs.has(x.grp) && !out.some(s => s.k === 'X' && s.id === x.id)) out.push({k: 'X', id: x.id}); return out;
};

// ---------- coordenadas: desenho (DXF) <-> metros reais (UTM) ----------
const pjMundo = (X, Y, c = DXF.ctx) => [c.cc[0] + (X + c.org[0] - c.cc[0]) / c.ke, c.cc[1] + (Y + c.org[1] - c.cc[1]) / c.ke];
const pjDxf = (x, y, c = DXF.ctx) => [c.cc[0] + (x - c.cc[0]) * c.ke - c.org[0], c.cc[1] + (y - c.cc[1]) * c.ke - c.org[1]];
const pjQ = w => Math.round(w[0] * 4) + ',' + Math.round(w[1] * 4);   // chave com resolução de 25 cm
function projReset() { PJ.keyN = new Map(); PJ.gmap = new Map(); PJ.ltUsed = new Map(); }
function pjUnico(base) { const n = PJ.keyN.get(base) || 0; PJ.keyN.set(base, n + 1); return n ? base + '#' + n : base; }
function pjChaveG(gk) {   // um rótulo (texto + balão + chamada); rótulos sobrepostos recebem sufixo
  const base = 'G|' + gk.t + '|' + gk.li + '|' + pjQ(pjMundo(gk.x, gk.y)); let l = PJ.gmap.get(base);
  if (!l) PJ.gmap.set(base, l = []);
  let n = l.indexOf(gk.i); if (n < 0) { l.push(gk.i); n = l.length - 1; }
  return n ? base + '#' + n : base;
}
const pjChaveS = it => it.key + '|' + (it.e.gk ? it.e.gk.k : 0);
function pjChaveE(e, L) {
  const q = p => pjQ(pjMundo(p[0], p[1]));
  if (e.t === 'LINE') return 'E|' + L + '|L|' + q(e.a) + '|' + q(e.b);
  if (e.t === 'PLINE') return 'E|' + L + '|P|' + e.pts.length + '|' + q(e.pts[0]) + '|' + q(e.pts[e.pts.length - 1]);
  if (e.t === 'CIRCLE' || e.t === 'ARC') return 'E|' + L + '|' + e.t[1] + '|' + q(e.p) + '|' + Math.round(e.r * 10) + '|' + Math.round(e.a0 || 0);
  return 'E|' + L + '|' + e.t + '|' + q(e.pts ? e.pts[0] : e.p || [0, 0]);
}
const pjSelecionavelE = e => e.t === 'LINE' || e.t === 'PLINE' || e.t === 'CIRCLE' || e.t === 'ARC';

// ---------- biblioteca de blocos (símbolos do CTWeb + DXF importados) ----------
function pjBBox(ents) {
  let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const e of ents || []) {
    if (e.a) { add(e.a[0], e.a[1]); add(e.b[0], e.b[1]); }
    else if (e.t === 'CIRCLE' || e.t === 'ARC') { add(e.p[0] - e.r, e.p[1] - e.r); add(e.p[0] + e.r, e.p[1] + e.r); }
    else if (e.pts) for (const p of e.pts) add(p[0], p[1]);
    else if (e.p) add(e.p[0], e.p[1]);
  }
  return x0 > x1 ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}
const pjExt = ents => { const b = pjBBox(ents); return Math.max(b[2] - b[0], b[3] - b[1]) || 1; };
const FORMAS_PJ = [['circ', 'Círculo'], ['quad', 'Quadrado'], ['ret', 'Retângulo'], ['losango', 'Losango'], ['tri', 'Triângulo'], ['cruz', 'Cruz'], ['linha', 'Traço']];
function projLib(id) {   // 'B:nome' (bloco importado) ou 'F:forma' (símbolo do CTWeb)
  if (PJ.lib.has(id)) return PJ.lib.get(id);
  let r = null;
  if (id.startsWith('B:') && BLOCOS[id.slice(2)]) {
    const bl = BLOCOS[id.slice(2)], b = blocoBase(bl), ents = bl.ents.map(e => DXF.xfEnt(e, DXF.T(1, 0, 0, 1, -b[0], -b[1])));
    r = {nome: san(bl.nome), ents, ext: pjExt(ents)};
  } else if (id.startsWith('D:')) {   // bloco já existente no desenho (símbolo de uma camada)
    const d = PJ.defs.get(id.slice(2)); if (d && d.ents && d.ents.length) r = {nome: d.nome, ents: d.ents, ext: pjExt(d.ents) || 1};
  } else if (id.startsWith('F:')) {
    const ents = DXF.formaEnts({forma: id.slice(2), tam: 1}, 1);
    r = {nome: san('CTW_F_' + id.slice(2)), ents, ext: 1};
  }
  if (r) PJ.lib.set(id, r);
  return r;
}
const pjDef = nome => PJ.defs.get(nome) || [...PJ.lib.values()].find(d => d.nome === nome) || null;
const pjNomeLib = id => id.startsWith('B:') || id.startsWith('D:') ? id.slice(2) : (FORMAS_PJ.find(f => 'F:' + f[0] === id) || [0, id])[1];
const pjTodosLib = () => [...FORMAS_PJ.map(f => ({id: 'F:' + f[0], nome: f[1], grupo: 'Símbolos do CTWeb'})), ...Object.keys(BLOCOS).map(n => ({id: 'B:' + n, nome: n, grupo: 'Blocos importados (DXF)'}))];

// ---------- aplicação das edições (tela e DXF) ----------
const pjMv = (p, A, cs, sn, dm, ke) => { const px = p[0] - A[0], py = p[1] - A[1]; return [A[0] + px * cs - py * sn + dm[0] * ke, A[1] + px * sn + py * cs + dm[1] * ke]; };
function projAplicaT(it) {
  const P = PRJ(), c = DXF.ctx, cam = P.cam[it.L], ov = P.t[it.key], s = P.s[pjChaveS(it)];
  if ((cam && cam.oculto) || (ov && ov.del)) return null;
  let e = it.e, col = it.col;
  const cp = () => { if (e === it.e) e = {...e}; return e; };
  if (cam && cam.cor) col = DXF.aci(cam.cor);
  if (cam && cam.h) cp().h = cam.h;
  if (ov) {
    if (ov.cor) col = DXF.aci(ov.cor);
    if (ov.h) cp().h = ov.h;
    if (ov.hj != null) cp().hj = ov.hj;
    const rd = ov.rot || 0, dm = ov.dm || [0, 0];
    if (rd || dm[0] || dm[1]) {
      const A = it.e.gk ? [it.e.gk.x, it.e.gk.y] : it.e.p, r = rd * RAD;
      cp().p = pjMv(it.e.p, A, Math.cos(r), Math.sin(r), dm, c.ke); e.rot = (it.e.rot || 0) + rd;
    }
  }
  if (s != null) cp().s = s;
  if (e.s === '' || e.s == null) return null;
  return {e, L: it.L, col};
}
// ---------- tipos de linha (tracejado etc.) com escala ----------
const PJ_LT = {cont: ['Contínua', null], dash: ['Tracejada (DASHED)', [.5, -.25]], dash2: ['Tracejada longa', [1, -.4]], dashdot: ['Traço e ponto (DASHDOT)', [.5, -.2, 0, -.2]], dot: ['Pontilhada (DOT)', [0, -.25]], center: ['Eixo (CENTER)', [.8, -.2, .15, -.2]], phantom: ['Fantasma (PHANTOM)', [1, -.2, .15, -.2, .15, -.2]]};
PJ.lts = new Map(); PJ.ltUsed = new Map();
function projLts() { return [...PJ.ltUsed]; }
function pjLtNome(lt) {   // {tipo, esc} -> nome do tipo de linha no DXF ('CONTINUOUS' para contínua); null = como veio
  if (!lt || !lt.tipo || lt.tipo === 'orig') return null;
  const d = PJ_LT[lt.tipo]; if (!d) return null; if (!d[1]) return 'CONTINUOUS';
  const esc = lt.esc > 0 ? +lt.esc : 1, nome = 'CTW_P_' + lt.tipo + '_' + String(esc).replace('.', 'p');
  const pat = d[1].map(v => +(v * esc).toFixed(4)); PJ.lts.set(nome, pat); PJ.ltUsed.set(nome, pat); return nome;
}
function projAplicaE(it) {
  const r = projAplicaE0(it); if (!r || r.e.gk) return r;
  const ov = PRJ().e[it.key]; if (!ov || !ov.lt || !/^(LINE|PLINE|CIRCLE|ARC)$/.test(r.e.t)) return r;
  const n = pjLtNome(ov.lt); return n ? {...r, e: {...r.e, lt: n}} : r;
}
function projAplicaE0(it) {
  const P = PRJ(), c = DXF.ctx, cam = P.cam[it.L];
  if (cam && cam.oculto) return null;
  let col = it.col; if (cam && cam.cor) col = DXF.aci(cam.cor);
  const e = it.e;
  if (e.gk) {   // balão / chamada de um rótulo: acompanha o texto
    const ov = P.t[it.key]; if (ov && ov.del) return null;
    if (!ov || (!ov.rot && !(ov.dm && (ov.dm[0] || ov.dm[1])))) return {e, L: it.L, col};
    const A = [e.gk.x, e.gk.y], r = (ov.rot || 0) * RAD, cs = Math.cos(r), sn = Math.sin(r), dm = ov.dm || [0, 0], M = p => pjMv(p, A, cs, sn, dm, c.ke);
    if (e.t === 'LINE') return {e: {...e, a: M(e.a), b: e.gk.leader ? e.b : M(e.b)}, L: it.L, col};   // a ponta presa ao ponto não se move
    return {e: {...e, pts: e.pts.map(p => [...M(p), p[2], p[3]].filter(v => v !== undefined))}, L: it.L, col};
  }
  const ov = P.e[it.key]; if (ov && ov.del) return null;
  if (!ov) return {e, L: it.L, col};
  if (ov.cor) col = DXF.aci(ov.cor);
  const dm = ov.dm || [0, 0], v = ov.v || {}, k = c.ke, off = (p, i) => { const a = v[i] || [0, 0]; return [p[0] + (dm[0] + a[0]) * k, p[1] + (dm[1] + a[1]) * k]; };
  if (e.t === 'LINE') return {e: {...e, a: off(e.a, 0), b: off(e.b, 1)}, L: it.L, col};
  if (e.t === 'PLINE') return {e: {...e, pts: e.pts.map((p, i) => { const q = off(p, i); return [q[0], q[1], p[2]]; }), w: ov.w != null ? ov.w : e.w}, L: it.L, col};
  if (e.t === 'CIRCLE' || e.t === 'ARC') return {e: {...e, p: off(e.p, 0)}, L: it.L, col};
  return {e, L: it.L, col};
}
function projAplicaI(it) {
  const P = PRJ(), c = DXF.ctx, ov = P.i[it.key], cam = P.cam[it.L];
  if ((cam && cam.oculto) || (ov && ov.del)) return null;
  const r = {name: it.name, L: it.L, x: it.x, y: it.y, sx: it.sx, rot: it.rot, att: it.att, col: it.col};
  if (cam && cam.cor && !(ov && ov.cor)) r.col = DXF.aci(cam.cor);
  if (!ov) return r;
  const dm = ov.dm || [0, 0], rd = ov.rot || 0, esc = ov.esc || 1, rr = rd * RAD, cs = Math.cos(rr), sn = Math.sin(rr);
  r.x = it.x + dm[0] * c.ke; r.y = it.y + dm[1] * c.ke; r.rot = (it.rot || 0) + rd;
  if (ov.cor) r.col = DXF.aci(ov.cor);
  if (ov.sub) {
    const lib = projLib(ov.sub), od = pjDef(it.name);
    if (lib) {
      const extOld = od && od.ents ? pjExt(od.ents) * it.sx : 0;
      r.name = lib.nome; r.sx = (extOld ? extOld / lib.ext : it.sx) * esc; r.att = [];
      PJ.usados.set(lib.nome, ov.sub);
    }
  } else {
    r.sx = it.sx * esc;
    if (it.att && it.att.length) r.att = it.att.map(a => {
      const px = (a.p[0] - it.x) * esc, py = (a.p[1] - it.y) * esc;
      return {...a, p: [it.x + px * cs - py * sn + dm[0] * c.ke, it.y + px * sn + py * cs + dm[1] * c.ke], h: a.h * esc, rot: (a.rot || 0) + rd};
    });
  }
  return r;
}
function projHook(kind, o) {
  if (kind === 'E') {
    const e = o.e;
    if (e.t === 'TEXT') {
      const it = {k: 'T', e, L: o.L, col: o.col, key: e.gk ? pjChaveG(e.gk) : pjUnico('T|' + o.L + '|' + pjQ(pjMundo(e.p[0], e.p[1])) + '|' + e.s)};
      if (PJ.cap) PJ.cap.push(it);
      return projAplicaT(it);
    }
    const it = {k: 'E', e, L: o.L, col: o.col, key: e.gk ? pjChaveG(e.gk) : pjUnico(pjChaveE(e, o.L))};
    if (PJ.cap) PJ.cap.push(it);
    return projAplicaE(it);
  }
  const it = {k: 'I', name: o.name, L: o.L, x: o.x, y: o.y, sx: o.sx, rot: o.rot, att: o.att, col: o.col, key: pjUnico('I|' + o.name + '|' + pjQ(pjMundo(o.x, o.y)))};
  if (PJ.cap) PJ.cap.push(it);
  return projAplicaI(it);
}
// anotações e blocos inseridos: escritos depois de todo o resto
function projFinal(body, lay, blocks) {
  DXF.setHook(null);
  const P = PRJ(), c = DXF.ctx;
  for (const [nome, id] of PJ.usados) if (!blocks.has(nome)) { const l = projLib(id); if (l) blocks.set(nome, {nome, ents: l.ents, att: new Map()}); }
  PJ.usados.clear();
  const Lx0 = lay(P.camadaAnot || 'ANOTACOES', '#ffffff');
  for (const ex of P.ex) {
    const Lx = ex.lay ? lay(ex.lay, ex.cor || '#ffffff') : Lx0, cam = P.cam[Lx];
    if (cam && cam.oculto) continue;
    const col = ex.cor ? DXF.aci(ex.cor) : (cam && cam.cor ? DXF.aci(cam.cor) : null);
    if (ex.t === 'TEXT') {
      const lines = String(ex.s).split('\n'), r = (ex.rot || 0) * RAD, p0 = pjDxf(ex.x, ex.y, c), lh = ex.h * (ex.ls || 1.25);
      lines.forEach((s, k) => { if (s) DXF.wEnt(body, {t: 'TEXT', p: [p0[0] + Math.sin(r) * k * lh, p0[1] - Math.cos(r) * k * lh], h: ex.h, s, rot: ex.rot || 0, hj: ex.hj || 0, vj: 2}, Lx, col); });
    } else if (ex.t === 'LINE' || ex.t === 'PLINE' || ex.t === 'SETA') {
      const pts = ex.pts.map(p => pjDxf(p[0], p[1], c));
      if (ex.t === 'PLINE') DXF.wEnt(body, {t: 'PLINE', pts: pts.map((p, i) => [p[0], p[1], (ex.pts[i] && ex.pts[i][2]) || 0]), closed: !!ex.closed, lt: pjLtNome(ex.lt)}, Lx, col);
      else {
        DXF.wEnt(body, {t: 'LINE', a: pts[0], b: pts[1], lt: ex.t === 'LINE' ? pjLtNome(ex.lt) : null}, Lx, col);
        if (ex.t === 'SETA') {
          const a = pts[0], b = pts[1], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d, hs = ex.tam || 2;
          DXF.wEnt(body, {t: 'SOLID', pts: [b, [b[0] - ux * hs - uy * hs * .3, b[1] - uy * hs + ux * hs * .3], [b[0] - ux * hs + uy * hs * .3, b[1] - uy * hs - ux * hs * .3]]}, Lx, col);
        }
      }
    } else if (ex.t === 'BLOCO') {
      const l = projLib(ex.lib); if (!l) continue;
      if (!blocks.has(l.nome)) blocks.set(l.nome, {nome: l.nome, ents: l.ents, att: new Map()});
      const p = pjDxf(ex.x, ex.y, c);
      DXF.wInsert(body, l.nome, Lx, p[0], p[1], (ex.tam || 3) / l.ext, ex.rot || 0, [], col);
    }
  }
}

// ---------- captura, abertura e saída ----------
// Painel de etapas: mostra o que está acontecendo, há quanto tempo e permite sair sem esperar.
const ETAPAS = {
  ctl: null, ctlRuas: null, itens: [], tm: 0,
  abrir(itens) {
    this.ctl = new AbortController(); this.ctlRuas = new AbortController();
    this.ctl.signal.addEventListener('abort', () => this.ctlRuas.abort());
    this.itens = itens.map(([id, nome]) => ({id, nome, st: 'esp', txt: '', f: null, t0: 0, t1: 0}));
    $('#etapas').hidden = false; this.pintar();
    clearInterval(this.tm); this.tm = setInterval(() => this.pintar(), 500);
    $('#etapas-cancela').onclick = () => { this.ctl.abort(); };
    $('#etapas-pula').onclick = () => { this.ctlRuas.abort(); };
  },
  set(id, st, txt, f) {
    const e = this.itens.find(i => i.id === id); if (!e) return;
    if (st === 'run' && !e.t0) e.t0 = Date.now();
    if (st !== 'run' && !e.t1) e.t1 = Date.now();
    e.st = st; if (txt != null) e.txt = txt; e.f = f ?? null;
    this.pintar();
  },
  pintar() {
    const seg = e => { const ms = (e.t1 || Date.now()) - e.t0; return e.t0 ? (ms < 1000 ? '' : Math.round(ms / 1000) + ' s') : ''; };
    const ic = {ok: '✓', run: '●', esp: '○', erro: '!', pula: '–'};
    $('#etapas-l').replaceChildren(...this.itens.map(e => mk('div', {class: 'etapa etapa-' + e.st},
      mk('span', {class: 'etapa-ic', 'aria-hidden': 'true'}, ic[e.st]),
      mk('div', {class: 'etapa-c'}, mk('b', null, e.nome), e.txt ? mk('small', null, e.txt) : '',
        e.st === 'run' ? mk('span', {class: 'etapa-barra' + (e.f == null ? ' ind' : '')}, mk('i', {style: e.f == null ? '' : 'width:' + Math.round(e.f * 100) + '%'})) : ''),
      mk('span', {class: 'etapa-t'}, seg(e)))));
    const ruasAtiva = this.itens.some(e => (e.id === 'ruas' || e.id === 'pistas') && e.st === 'run');
    $('#etapas-pula').hidden = !ruasAtiva;
  },
  fechar(espera = 500) { clearInterval(this.tm); this.pintar(); setTimeout(() => { $('#etapas').hidden = true; }, espera); },
};
const ehAbort = e => e && (e.name === 'AbortError' || e.message === 'cancelado');
async function projGerar(refazRuas) {
  const cf = CFG.dxf, pista = cf.ruas && cf.ruasModo !== 'eixo';
  if (refazRuas || PJ.osm === undefined) { PJ.osm = null; PJ.ruasR = null; }
  const contagem = Object.entries(SEL.ids || {}).filter(([, v]) => v.length).map(([t, v]) => nBR(v.length) + ' ' + NOME[t].toLowerCase()).join(' · ');
  const precisaRuas = PJ.osm === null && PJ.ruasR === null && (cf.ruas || cf.edif);
  if (precisaRuas) ETAPAS.abrir([['area', 'Área lida'], ...(precisaRuas ? [['ruas', 'Ruas do OpenStreetMap'], ...(pista ? [['pistas', 'Pistas ajustadas aos postes']] : [])] : []), ['desenho', 'Montando o desenho']]);
  ETAPAS.set('area', 'ok', contagem || 'nenhum elemento');
  let falhaRuas = '';
  try {
    if (precisaRuas) {
      const sinal = ETAPAS.ctlRuas.signal;
      try {
        if (pista) {
          ETAPAS.set('ruas', 'run', 'Procurando nas ruas guardadas...');
          const osm2 = await ruasOSM2(SEL, (m, f) => ETAPAS.set('ruas', 'run', m, f), sinal);
          ETAPAS.set('ruas', 'ok', nBR(osm2.ways.length) + ' vias' + (osm2.baixados ? ` · ${osm2.baixados} ladrilho(s) baixado(s)` : ' guardadas neste computador'));
          const {Z, cc} = projDXF(SEL);
          if (RP.R && RP.S === SEL && RP.sig && RP.sig === sigRuas()) { PJ.ruasR = RP.R; ETAPAS.set('pistas', 'ok', 'reaproveitadas da prévia'); }
          else {
            ETAPAS.set('pistas', 'run', 'Preparando as ruas...');
            const postes = usarSel(() => postesSel(SEL, Z));
            PJ.ruasR = await calcularRuas(SEL, osm2, postes, Z, cc, (m, f) => ETAPAS.set('pistas', 'run', m, f), sinal);
            Object.assign(RP, {S: SEL, Z, cc, osm2, postes, R: PJ.ruasR, sig: sigRuas()}); PREV.calc = 'ok'; PREV.osm = osm2.ways.length;
            ETAPAS.set('pistas', 'ok', `${nBR(PJ.ruasR.rel.ok)} postes livres, ${nBR(PJ.ruasR.rel.centro + PJ.ruasR.rel.impossivel)} a conferir`);
          }
        }
        if ((cf.ruas && !pista) || cf.edif) { ETAPAS.set('ruas', 'run', 'Baixando...'); PJ.osm = await ruasOSM(SEL, cf.edif, sinal); ETAPAS.set('ruas', 'ok'); }
      } catch (err) {
        if (ETAPAS.ctl.signal.aborted) throw err;
        const pulou = ehAbort(err);
        falhaRuas = pulou ? 'Projeto aberto sem arruamento, por sua escolha.' : 'Projeto aberto sem arruamento: ' + err.message;
        for (const id of ['ruas', 'pistas']) { const e = ETAPAS.itens.find(i => i.id === id); if (e && e.st !== 'ok') ETAPAS.set(id, pulou ? 'pula' : 'erro', pulou ? 'pulado' : (id === 'ruas' ? 'servidores indisponíveis' : '')); }
        if (!pulou) window.NG.avisar(falhaRuas + ' Para não depender dos servidores, instale o pacote de ruas (Exportações ou aba Ruas). Você pode tentar de novo na aba Ruas.');
      }
    }
    ETAPAS.set('desenho', 'run', 'Gerando textos, blocos e linhas...');
    await new Promise(r => setTimeout(r, 30));
    PJ.cap = []; PJ.usados.clear();
    let r;
    try { r = usarSel(() => gerarDXF(SEL, PJ.osm, PJ.ruasR)); } finally { DXF.setHook(null); }
    PJ.items = PJ.cap; PJ.cap = null;
    PJ.defs = new Map(r.blq.map(b => [b.nome, b])); PJ.layers = r.layers; PJ.c = {...DXF.ctx};
    ETAPAS.set('desenho', 'ok', nBR(PJ.items.length) + ' itens');
    if (falhaRuas) $('#st').textContent = falhaRuas;
  } finally { PJ.cap = null; if (precisaRuas) ETAPAS.fechar(falhaRuas ? 2500 : 500); }
}
async function projAbrir() {
  if (!SEL) { $('#prj').hidden = false; prjUI(); $('#st').textContent = 'Marque primeiro a área do projeto (Retângulo ou Polígono).'; return; }
  if (SEL.dados === undefined) { alert('A seleção ainda está sendo lida. Tente novamente em instantes.'); return; }
  if (PJ.on) return;
  await selAtualizar();
  // As edições ficam salvas entre sessões: ao mudar de área, não deixa as antigas vazarem para o desenho novo.
  const b0 = SEL.b, sigArea = [b0.getSouth(), b0.getWest(), b0.getNorth(), b0.getEast()].map(v => v.toFixed(6)).join(',') + (SEL.poly ? '|p' + SEL.poly.length : '');
  const P0 = PRJ();
  if (P0.areaSig && P0.areaSig !== sigArea && projTemEdicao() && confirm('O último projeto tem edições feitas em outra área.\n\nOK: começar limpo nesta área (as edições anteriores são descartadas; use "Salvar projeto" antes se precisar delas).\nCancelar: manter as edições.')) {
    CFG.dxf.projeto = cfgPadrao().dxf.projeto;
  }
  PRJ().areaSig = sigArea;
  PJ.osm = undefined; PJ.lib.clear();
  try { await projGerar(true); } catch (e) {
    if (ehAbort(e)) { $('#st').textContent = 'Criação do projeto cancelada.'; return; }
    alert('Falha ao abrir o projeto: ' + e.message); console.error(e); return;
  }
  PJ.on = true; PJ.aba = 'edi'; PJ.pausa = false; PJ.sels = []; PJ.tool = 'sel'; PJ.hist = []; PJ.fut = []; PJ.pan = false; PJ.busca.res = []; PJ.busca.i = -1;
  window.NG.modoProjeto(true); try { map.closePopup(); achado.clearLayers(); } catch (e) {}
  PJ.osmVis = map.hasLayer(osmGrp); if (PJ.osmVis) map.removeLayer(osmGrp);
  PJ.cv = mk('canvas', {id: 'pjc', style: 'position:absolute;left:0;top:0;z-index:450;pointer-events:none'});
  map.getContainer().appendChild(PJ.cv); PJ.g = PJ.cv.getContext ? PJ.cv.getContext('2d') : null;
  map.on('move zoom viewreset resize zoomend moveend', pjAgendar);
  const mc = map.getContainer();
  mc.addEventListener('mousedown', pjDown, true); mc.addEventListener('dblclick', pjDbl, true);
  map.on('click', pjClique); map.on('mousemove', pjMouse);
  document.addEventListener('keydown', pjTecla, true); document.addEventListener('keyup', pjTeclaSolta, true);
  $('#prj').hidden = false; prjUI(); pjPainel(); pjDesenhar(); ngCamadasPintar();
  $('#st').textContent = 'Projeto: a área aparece na escala 1:' + (+CFG.dxf.escala || 1000) + '. Clique para selecionar (Ctrl soma), arraste uma área para selecionar vários, duplo clique edita o texto.';
}
function projSair() {
  if (!PJ.on) return;
  pjFechaEditor(true);
  if (PJ.aba === 'arr' || PJ.pausa) { try { edtDesligar(); EDT.fant.clearLayers(); EDT.vtx.clearLayers(); if (map.hasLayer(osmGrp)) map.removeLayer(osmGrp); } catch (e) {} PJ.pausa = false; }
  PJ.aba = 'edi';
  PJ.on = false; PJ.tool = 'sel'; PJ.tmp = null; PJ.drag = null; PJ.sels = [];
  map.off('move zoom viewreset resize zoomend moveend', pjAgendar); map.off('click', pjClique); map.off('mousemove', pjMouse);
  const mc = map.getContainer(); mc.removeEventListener('mousedown', pjDown, true); mc.removeEventListener('dblclick', pjDbl, true);
  document.removeEventListener('keydown', pjTecla, true); document.removeEventListener('keyup', pjTeclaSolta, true);
  PJ.cv?.remove(); PJ.cv = null; PJ.g = null;
  window.NG.modoProjeto(false); if (PJ.osmVis) map.addLayer(osmGrp);
  map.doubleClickZoom.enable(); mc.style.cursor = '';
  if (typeof modoFim === 'function') modoFim();
  salvar(); desenhar(); prjUI();
}
function projSairFerr() {   // Esc: sai da ferramenta → desliga a mão (pan) → limpa a seleção; depois disso o Esc fecha o painel
  if (!PJ.on) return false;
  if (PJ.ed) { pjFechaEditor(true); return true; }
  if (PJ.tool && PJ.tool !== 'sel') { PJ.tool = 'sel'; PJ.tmp = null; if (typeof pjOrgCancela === 'function') pjOrgCancela(); map.doubleClickZoom.enable(); map.getContainer().style.cursor = ''; modoFim(); pjPainel(); pjDesenhar(); return true; }
  if (PJ.tmp) { PJ.tmp = null; pjDesenhar(); return true; }
  if (PJ.pan) { PJ.pan = false; map.getContainer().style.cursor = ''; modoFim(); pjPainel(); return true; }
  if (PJ.sels.length) { PJ.sels = []; pjPainel(); pjDesenhar(); return true; }
  return false;
}

// ---------- histórico ----------
const pjFoto = () => { const p = PRJ(); return JSON.stringify({t: p.t, s: p.s, i: p.i, e: p.e, cam: p.cam, ex: p.ex, seq: p.seq, fav: p.fav}); };
function pjSnap() { PJ.hist.push(pjFoto()); if (PJ.hist.length > 100) PJ.hist.shift(); PJ.fut = []; }
function pjRestaura(j) { const p = PRJ(); p.t = {}; p.s = {}; p.i = {}; p.e = {}; p.cam = {}; p.ex = []; Object.assign(p, JSON.parse(j)); }
function pjValidaSel() { const p = PRJ(); PJ.sels = PJ.sels.filter(s => s.k !== 'X' || p.ex.find(x => x.id === s.id)); }
function pjDesfazer() { if (!PJ.hist.length) return; PJ.fut.push(pjFoto()); pjRestaura(PJ.hist.pop()); pjValidaSel(); salvar(); pjPainel(); pjDesenhar(); }
function pjRefazer() { if (!PJ.fut.length) return; PJ.hist.push(pjFoto()); pjRestaura(PJ.fut.pop()); pjValidaSel(); salvar(); pjPainel(); pjDesenhar(); }

// ---------- transformação tela <-> desenho ----------
function pjTr() {
  const c = PJ.c, z = map.getZoom(), ct = SEL.b.getCenter(), c0 = map.latLngToContainerPoint(ct);
  const ppm = 256 * 2 ** z / (40075016.686 * Math.cos(ct.lat * RAD)), k = ppm / c.ke, X0 = c.cc[0] - c.org[0], Y0 = c.cc[1] - c.org[1];
  return {k, c0, X0, Y0, T: (X, Y) => [c0.x + (X - X0) * k, c0.y - (Y - Y0) * k], I: (px, py) => [X0 + (px - c0.x) / k, Y0 - (py - c0.y) / k]};
}
const pjMundoDePx = (tr, px, py) => { const d = tr.I(px, py); return pjMundo(d[0], d[1], PJ.c); };
function pjIrPara(sel) {   // centraliza o mapa no elemento
  const h = PJ.hit.find(q => sk(q.s) === sk(sel)); if (!h) return;
  const sz = map.getSize(), cx = (h.bb[0] + h.bb[2]) / 2, cy = (h.bb[1] + h.bb[3]) / 2;
  map.panBy([cx - sz.x / 2, cy - sz.y / 2], {animate: false});
}

// ---------- desenho ----------
function pjCorHex(aci, L) {
  let a = aci; if (a == null || !(a > 0 && a < 256)) a = PJ.layers.get(L);
  let h = DXF.aciHex(a) || '#ffffff';
  if (PRJ().fundo === 'branco' && h.toLowerCase() === '#ffffff') h = '#000000';
  return h;
}
function pjBulge(a, b) {
  const th = 4 * Math.atan(a[2]), dx = b[0] - a[0], dy = b[1] - a[1], cd = Math.hypot(dx, dy), out = [];
  if (!cd) return out;
  const r = cd / (2 * Math.sin(th / 2)), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, h = Math.sqrt(Math.max(0, r * r - cd * cd / 4)) * (Math.abs(th) > Math.PI ? -1 : 1) * Math.sign(th);
  const cx = mx - dy / cd * h, cy = my + dx / cd * h, a0 = Math.atan2(a[1] - cy, a[0] - cx), n = Math.max(2, Math.ceil(Math.abs(th) / (Math.PI / 12)));
  for (let q = 1; q < n; q++) { const an = a0 + th * q / n; out.push([cx + Math.abs(r) * Math.cos(an), cy + Math.abs(r) * Math.sin(an)]); }
  return out;
}
function pjEnt(g, tr, e, hex, wpx) {   // desenha uma entidade; devolve os pontos de tela (para o teste de clique)
  const T = tr.T; let pts = null;
  g.strokeStyle = hex; g.fillStyle = hex; g.lineWidth = Math.max(1, wpx || 1);
  const pat = e.lt && PJ.lts.get(e.lt); if (g.setLineDash) g.setLineDash(pat ? pat.map(v => Math.max(Math.abs(v) * tr.k, 1.2)) : []);
  switch (e.t) {
    case 'LINE': { const a = T(e.a[0], e.a[1]), b = T(e.b[0], e.b[1]); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); pts = [a, b]; break; }
    case 'PLINE': {
      const P = e.pts; g.beginPath(); pts = [];
      g.lineWidth = e.w ? Math.max(1, e.w * tr.k) : 1;
      for (let i = 0; i < P.length; i++) {
        const p = T(P[i][0], P[i][1]); pts.push(p); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]);
        const nx = P[(i + 1) % P.length];
        if (P[i][2] && (i + 1 < P.length || e.closed)) for (const q of pjBulge(P[i], nx)) { const s = T(q[0], q[1]); g.lineTo(s[0], s[1]); pts.push(s); }
      }
      if (e.closed) { g.closePath(); pts.push(pts[0]); } g.stroke(); break;
    }
    case 'SOLID': { const p = e.pts, q = [p[0], p[1], p[3] || p[2], p[2]]; g.beginPath(); q.forEach((v, i) => { const s = T(v[0], v[1]); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); }); g.closePath(); g.fill(); break; }
    case 'CIRCLE': { const c = T(e.p[0], e.p[1]), r = Math.max(.5, e.r * tr.k); g.beginPath(); g.arc(c[0], c[1], r, 0, 6.2832); g.stroke(); pts = Array.from({length: 25}, (_, i) => [c[0] + r * Math.cos(i * .2618), c[1] + r * Math.sin(i * .2618)]); break; }
    case 'ARC': {
      const c = T(e.p[0], e.p[1]), r = Math.max(.5, e.r * tr.k); g.beginPath(); g.arc(c[0], c[1], r, -e.a0 * RAD, -e.a1 * RAD, true); g.stroke();
      let d = ((e.a1 - e.a0) % 360 + 360) % 360 || 360; pts = Array.from({length: 13}, (_, i) => { const a = (e.a0 + d * i / 12) * RAD; return [c[0] + r * Math.cos(a), c[1] - r * Math.sin(a)]; }); break;
    }
    case 'POINT': { const c = T(e.p[0], e.p[1]); g.fillRect(c[0] - 1, c[1] - 1, 2, 2); break; }
  }
  if (g.setLineDash) g.setLineDash([]);
  return pts;
}
// fator entre a altura do texto no DXF (h) e o tamanho da fonte (em) vista no CAD com arial.ttf; ajustável em "Escala, fonte e fundo"
const pjFonteK = () => { const k = +PRJ().fonteK; return k > .3 && k < 3 ? k : 1.25; };
const pjLinhas = s => String(s).split('\n');
function pjTexto(g, tr, e, hex) {   // desenha um texto (várias linhas, alinhamento, rotação) e devolve a caixa para clique
  const p = tr.T(e.p[0], e.p[1]), hp = e.h * tr.k, a = -(e.rot || 0) * RAD, hj = e.hj || 0, ls = pjLinhas(e.s), lh = hp * (e.ls || 1.25);
  if (hp < 1 && !g.vetor) {   // ilegível nesta escala: só a caixa de clique, sem medir nem desenhar letras
    const w = hp * .6 * Math.max(...ls.map(l => l.length)), x0 = hj === 2 ? -w : hj === 1 || hj === 4 ? -w / 2 : 0, y0 = -6, y1 = (ls.length - 1) * lh + 6, cs = Math.cos(a), sn = Math.sin(a);
    const co = [[x0 - 3, y0], [x0 + w + 3, y0], [x0 + w + 3, y1], [x0 - 3, y1]].map(q => [p[0] + q[0] * cs - q[1] * sn, p[1] + q[0] * sn + q[1] * cs]);
    return {tipo: 'rect', px: p[0], py: p[1], a, x0: x0 - 3, x1: x0 + w + 3, y0, y1, co, bb: [Math.min(co[0][0], co[1][0], co[2][0], co[3][0]), Math.min(co[0][1], co[1][1], co[2][1], co[3][1]), Math.max(co[0][0], co[1][0], co[2][0], co[3][0]), Math.max(co[0][1], co[1][1], co[2][1], co[3][1])]};
  }
  g.save(); g.translate(p[0], p[1]); g.rotate(a);
  const fv = e.fv;
  g.font = (fv && fv.i ? 'italic ' : '') + (fv && fv.n ? '700 ' : '') + Math.max(1, hp * pjFonteK()) + 'px ' + (fv && fv.f ? '"' + fv.f + '", Arial' : 'Arial'); g.textBaseline = 'middle'; g.textAlign = hj === 2 ? 'right' : hj === 1 || hj === 4 ? 'center' : 'left'; g.fillStyle = hex;
  let w = 0;
  ls.forEach((l, k) => { const lw = g.measureText ? g.measureText(l).width : hp * .6 * l.length; if (lw > w) w = lw; if (hp >= 2.5 || g.vetor) { if (fv && fv.h && g.strokeText) { g.strokeStyle = fv.hc || '#03080c'; g.lineWidth = fv.hw || 3; g.lineJoin = 'round'; g.strokeText(l, 0, k * lh); } g.fillText(l, 0, k * lh); } else g.fillRect(hj === 2 ? -lw : 0, k * lh - .5, lw, 1); });
  g.restore();
  const x0 = hj === 2 ? -w : hj === 1 || hj === 4 ? -w / 2 : 0, y0 = -Math.max(hp / 2, 4) - 2, y1 = (ls.length - 1) * lh + Math.max(hp / 2, 4) + 2;
  const co = [[x0 - 3, y0], [x0 + w + 3, y0], [x0 + w + 3, y1], [x0 - 3, y1]].map(q => [p[0] + q[0] * Math.cos(a) - q[1] * Math.sin(a), p[1] + q[0] * Math.sin(a) + q[1] * Math.cos(a)]);
  return {tipo: 'rect', px: p[0], py: p[1], a, x0: x0 - 3, x1: x0 + w + 3, y0, y1, co, bb: [Math.min(...co.map(q => q[0])), Math.min(...co.map(q => q[1])), Math.max(...co.map(q => q[0])), Math.max(...co.map(q => q[1]))]};
}
const pjBBpts = pts => [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))];
function pjLinhaDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
function pjAnel() { return SEL.poly ? SEL.poly.map(q => map.latLngToContainerPoint(L.latLng(q[0], q[1]))) : [SEL.b.getSouthWest(), SEL.b.getNorthWest(), SEL.b.getNorthEast(), SEL.b.getSouthEast()].map(q => map.latLngToContainerPoint(q)); }
// Redesenho no máximo uma vez por quadro: arrastar o mapa dispara dezenas de eventos.
let pjRaf = 0;
function pjAgendar() { if (!pjRaf) pjRaf = requestAnimationFrame(() => { pjRaf = 0; pjDesenhar(); }); }
function pjDesenhar() {
  if (!PJ.on || !PJ.cv) return;
  const sz = map.getSize(), dpr = window.devicePixelRatio || 1, g = PJ.g;
  if (PJ.cv.width !== Math.round(sz.x * dpr) || PJ.cv.height !== Math.round(sz.y * dpr)) { PJ.cv.width = Math.round(sz.x * dpr); PJ.cv.height = Math.round(sz.y * dpr); PJ.cv.style.width = sz.x + 'px'; PJ.cv.style.height = sz.y + 'px'; }
  PJ.hit = [];
  if (!g || !SEL) return;
  DXF.ctx = PJ.c;
  const P = PRJ(), tr = pjTr(), fundo = PJ.pausa ? 'mapa' : P.fundo, trava = L_ => !!(P.cam[L_] && P.cam[L_].trava);
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, sz.x, sz.y);
  const anel = pjAnel(), cam = () => { g.beginPath(); anel.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)); g.closePath(); };
  if (fundo !== 'sem') {
    g.save(); g.beginPath(); g.rect(0, 0, sz.x, sz.y); anel.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)); g.closePath();
    g.fillStyle = 'color-mix(in srgb, ' + (getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#070b10') + ' 80%, transparent)'; g.fill('evenodd'); g.restore();
    if (fundo === 'escuro' || fundo === 'branco') { g.save(); cam(); g.fillStyle = fundo === 'escuro' ? '#0e1621' : '#ffffff'; g.fill(); g.restore(); }
  }
  g.save(); cam(); g.strokeStyle = COR_DESTAQUE(); g.lineWidth = 2; g.stroke(); g.restore();
  const edKeys = PJ.ed ? new Set(PJ.ed.keys) : null, H = [];
  // Só o que cruza a tela é desenhado: com dezenas de milhares de itens, é o que mantém o mapa fluido.
  const vA = tr.I(0, 0), vB = tr.I(sz.x, sz.y), vX0 = Math.min(vA[0], vB[0]), vX1 = Math.max(vA[0], vB[0]), vY0 = Math.min(vA[1], vB[1]), vY1 = Math.max(vA[1], vB[1]);
  const foraDaTela = (x0, y0, x1, y1) => x1 < vX0 || x0 > vX1 || y1 < vY0 || y0 > vY1;
  // 1) geometria (linhas de rede, arruamento, balões)
  const Lruas = PJ.pausa ? new Set([san(CFG.dxf.camadas.ruas), san(CFG.dxf.camadas.ruasOrig || 'RUAS_ORIGINAL'), san(CFG.dxf.camadas.txtRuas)]) : null;   // na aba Arruamento as pistas vêm da prévia ao vivo
  for (const it of PJ.items) if (it.k === 'E') {
    if (Lruas && Lruas.has(it.L)) continue;
    const r = projAplicaE(it); if (!r) continue;
    if (r.e === it.e) { const bb = it.bbTela || (it.bbTela = pjBBox([it.e])); if (bb && foraDaTela(bb[0], bb[1], bb[2], bb[3])) continue; }
    if (edKeys && it.e.gk && edKeys.has('T:' + it.key)) { /* balão acompanha o texto em edição */ }
    const pts = pjEnt(g, tr, r.e, pjCorHex(r.e.c != null ? r.e.c : r.col, it.L), r.e.w ? r.e.w * tr.k : 1);
    if (pts && !it.e.gk && pjSelecionavelE(it.e) && !trava(it.L)) H.push({s: {k: 'E', key: it.key}, tipo: 'segs', pts, bb: pjBBpts(pts), L: it.L});
  }
  // 2) blocos
  for (const it of PJ.items) if (it.k === 'I') {
    const r = projAplicaI(it); if (!r) continue;
    const mI = 40 * (r.sx || 1); if (foraDaTela(r.x - mI, r.y - mI, r.x + mI, r.y + mI)) continue;
    const def = pjDef(r.name), M = DXF.T(r.sx * Math.cos(r.rot * RAD), r.sx * Math.sin(r.rot * RAD), -r.sx * Math.sin(r.rot * RAD), r.sx * Math.cos(r.rot * RAD), r.x, r.y);
    let qs = [];
    if (def) for (const e of def.ents) { const q = DXF.xfEnt(e, M); qs.push(q); pjEnt(g, tr, q, pjCorHex(q.c != null && q.c > 0 ? q.c : r.col, r.L), 1); }
    const p = tr.T(r.x, r.y), bb = qs.length ? pjBBox(qs) : [r.x, r.y, r.x, r.y], c1 = tr.T(bb[0], bb[1]), c2 = tr.T(bb[2], bb[3]);
    const hb = [Math.min(c1[0], c2[0], p[0]) - 5, Math.min(c1[1], c2[1], p[1]) - 5, Math.max(c1[0], c2[0], p[0]) + 5, Math.max(c1[1], c2[1], p[1]) + 5];
    if (!trava(it.L)) H.push({s: {k: 'I', key: it.key}, tipo: 'box', bb: hb, px: p[0], py: p[1], L: it.L});
  }
  // 3) textos
  for (const it of PJ.items) if (it.k === 'T') {
    if (Lruas && Lruas.has(it.L)) continue;
    const r = projAplicaT(it); if (!r) continue;
    const mT = (r.e.h || 1) * (String(r.e.s).length + 4); if (foraDaTela(r.e.p[0] - mT, r.e.p[1] - mT, r.e.p[0] + mT, r.e.p[1] + mT)) continue;
    if (edKeys && edKeys.has('T:' + it.key)) { const hh = pjTexto({save() {}, restore() {}, translate() {}, rotate() {}, fillText() {}, fillRect() {}, measureText: g.measureText && (s => g.measureText(s))}, tr, r.e, '#000'); if (!trava(it.L)) H.push({s: {k: 'T', key: it.key}, ...hh, L: it.L}); continue; }
    const corFv = it.e.fv && r.col === it.col && P.fundo !== 'branco' ? it.e.fv.c : null;   // cor exata do estilo, sem a aproximação da paleta do CAD
    const hh = pjTexto(g, tr, r.e, corFv || pjCorHex(r.col, it.L));
    if (!trava(it.L)) H.push({s: {k: 'T', key: it.key}, ...hh, L: it.L});
  }
  // 4) anotações
  const Lx0 = san(P.camadaAnot || 'ANOTACOES');
  for (const ex of P.ex) {
    const Lx = ex.lay ? san(ex.lay) : Lx0, hexAn = ex => ex.cor || (P.cam[Lx] && P.cam[Lx].cor) || (P.fundo === 'branco' ? '#000000' : '#ffffff');
    if (P.cam[Lx] && P.cam[Lx].oculto) continue;
    const hx = hexAn(ex), s = {k: 'X', id: ex.id}, lock = trava(Lx);
    if (ex.t === 'TEXT') {
      if (edKeys && edKeys.has('X:' + ex.id)) continue;
      const w = pjDxf(ex.x, ex.y, PJ.c), hh = pjTexto(g, tr, {p: w, h: ex.h, s: ex.s || ' ', rot: ex.rot || 0, hj: ex.hj || 0, ls: ex.ls}, hx);
      if (!lock) H.push({s, ...hh, L: Lx});
    } else if (ex.t === 'BLOCO') {
      const l = projLib(ex.lib); if (!l) continue;
      const w = pjDxf(ex.x, ex.y, PJ.c), sx = (ex.tam || 3) / l.ext, rr = (ex.rot || 0) * RAD;
      const M = DXF.T(sx * Math.cos(rr), sx * Math.sin(rr), -sx * Math.sin(rr), sx * Math.cos(rr), w[0], w[1]), qs = l.ents.map(e => DXF.xfEnt(e, M));
      for (const q of qs) pjEnt(g, tr, q, hx, 1);
      const bb = pjBBox(qs), c1 = tr.T(bb[0], bb[1]), c2 = tr.T(bb[2], bb[3]), p = tr.T(w[0], w[1]);
      if (!lock) H.push({s, tipo: 'box', bb: [Math.min(c1[0], c2[0]) - 5, Math.min(c1[1], c2[1]) - 5, Math.max(c1[0], c2[0]) + 5, Math.max(c1[1], c2[1]) + 5], px: p[0], py: p[1], L: Lx});
    } else if (ex.t === 'PLINE') {
      const ent = {t: 'PLINE', pts: ex.pts.map(q => { const w = pjDxf(q[0], q[1], PJ.c); return [w[0], w[1], q[2] || 0]; }), closed: !!ex.closed, lt: pjLtNome(ex.lt)};
      const pts = pjEnt(g, tr, ent, hx, 1.5);
      if (pts && !lock) H.push({s, tipo: 'segs', pts, bb: pjBBpts(pts), L: Lx});
    } else {
      const pts = ex.pts.map(q => { const w = pjDxf(q[0], q[1], PJ.c); return tr.T(w[0], w[1]); });
      g.strokeStyle = hx; g.fillStyle = hx; g.lineWidth = 1.5; g.beginPath(); pts.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.stroke();
      if (ex.t === 'SETA') {
        const a = pts[0], b = pts[1], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d, hs = Math.max(6, (ex.tam || 2) * tr.k);
        g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(b[0] - ux * hs - uy * hs * .3, b[1] - uy * hs + ux * hs * .3); g.lineTo(b[0] - ux * hs + uy * hs * .3, b[1] - uy * hs - ux * hs * .3); g.closePath(); g.fill();
      }
      if (!lock) H.push({s, tipo: 'segs', pts, bb: pjBBpts(pts), L: Lx});
    }
  }
  PJ.hit = H;
  if (typeof pjOrgDesenha === 'function') pjOrgDesenha(g, tr);
  // elemento em criação (linha elástica)
  if (PJ.tmp && PJ.tmp.pts.length) {
    const q = PJ.tmp.pts.map(p => { const w = pjDxf(p[0], p[1], PJ.c); return tr.T(w[0], w[1]); });
    if (PJ.tmp.mouse) q.push(PJ.tmp.mouse);
    g.save(); g.strokeStyle = '#22d3ee'; g.setLineDash([5, 4]); g.lineWidth = 1.5; g.beginPath(); q.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); g.restore();
  }
  // seleção: contorno, vértices da linha selecionada e alça de rotação
  const set = new Set(PJ.sels.map(sk));
  if (set.size) {
    g.save(); g.strokeStyle = '#22d3ee'; g.fillStyle = '#22d3ee'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
    for (const h of H) if (set.has(sk(h.s))) {
      if (h.tipo === 'segs') { g.setLineDash([]); g.lineWidth = 3; g.globalAlpha = .55; g.beginPath(); h.pts.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.stroke(); g.globalAlpha = 1; g.lineWidth = 1.5; g.setLineDash([4, 3]); }
      else if (h.tipo === 'box') g.strokeRect(h.bb[0], h.bb[1], h.bb[2] - h.bb[0], h.bb[3] - h.bb[1]);
      else { g.beginPath(); h.co.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.closePath(); g.stroke(); }
    }
    g.restore();
    const un = pjSel1(), vts = un && un.k === 'E' ? pjVertices(un, tr) : null;
    if (vts) { g.save(); g.fillStyle = '#0d1117'; g.strokeStyle = '#22d3ee'; g.lineWidth = 1.5; for (const v of vts) { g.fillRect(v.x - 4, v.y - 4, 8, 8); g.strokeRect(v.x - 4, v.y - 4, 8, 8); } g.restore(); }
    PJ.vts = vts;
    const pv = un && (un.k === 'T' || un.k === 'I' || (un.k === 'X' && !pjOv(un, false).pts)) ? pjPivo(tr) : null;
    if (pv) {
      PJ.alca = [pv[0], pv[1] - 34];
      g.save(); g.strokeStyle = '#22d3ee'; g.fillStyle = '#0d1117'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(pv[0], pv[1]); g.lineTo(PJ.alca[0], PJ.alca[1]); g.stroke();
      g.beginPath(); g.arc(PJ.alca[0], PJ.alca[1], 6, 0, 6.2832); g.fill(); g.stroke(); g.restore();
    } else PJ.alca = null;
  } else { PJ.alca = null; PJ.vts = null; }
  // retângulo de seleção por área
  const d = PJ.drag;
  if (d && d.modo === 'box' && d.movido) {
    const x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0), jan = d.x1 >= d.x0;
    g.save(); g.fillStyle = jan ? 'rgba(34,130,255,.15)' : 'rgba(60,200,120,.15)'; g.strokeStyle = jan ? '#3b9bff' : '#3cc878'; g.lineWidth = 1.2; g.setLineDash(jan ? [] : [6, 4]);
    g.fillRect(x0, y0, w, h); g.strokeRect(x0, y0, w, h); g.restore();
  }
}
// pontos de giro e vértices da seleção (em pixels)
function pjPivo(tr) {
  const s = pjSel1(); if (!s) return null;
  if (s.k === 'T') {
    const it = PJ.items.find(i => i.k === 'T' && i.key === s.key); if (!it || !projAplicaT(it)) return null;
    const ov = PRJ().t[s.key], A = it.e.gk ? [it.e.gk.x, it.e.gk.y] : it.e.p, dm = (ov && ov.dm) || [0, 0], ke = PJ.c.ke;
    return tr.T(A[0] + dm[0] * ke, A[1] + dm[1] * ke);
  }
  if (s.k === 'I') { const it = PJ.items.find(i => i.k === 'I' && i.key === s.key); const r = it && projAplicaI(it); return r ? tr.T(r.x, r.y) : null; }
  const ex = PRJ().ex.find(x => x.id === s.id); if (!ex || ex.pts) return null;
  const w = pjDxf(ex.x, ex.y, PJ.c); return tr.T(w[0], w[1]);
}
function pjVertices(s, tr) {
  const it = PJ.items.find(i => i.k === 'E' && i.key === s.key); if (!it) return null;
  const r = projAplicaE(it); if (!r) return null; const e = r.e;
  const ps = e.t === 'LINE' ? [e.a, e.b] : e.t === 'PLINE' ? e.pts : null; if (!ps) return null;
  return ps.map((p, i) => { const q = tr.T(p[0], p[1]); return {x: q[0], y: q[1], i}; });
}

// ---------- seleção, arraste, área ----------
function pjTesta(h, px, py) {
  if (h.tipo === 'segs') { for (let i = 0; i + 1 < h.pts.length; i++) if (pjLinhaDist(px, py, h.pts[i], h.pts[i + 1]) < 6) return true; return false; }
  if (h.tipo === 'box') return px >= h.bb[0] - 3 && px <= h.bb[2] + 3 && py >= h.bb[1] - 3 && py <= h.bb[3] + 3;
  const dx = px - h.px, dy = py - h.py, lx = dx * Math.cos(h.a) + dy * Math.sin(h.a), ly = -dx * Math.sin(h.a) + dy * Math.cos(h.a);
  return lx >= h.x0 && lx <= h.x1 && ly >= h.y0 && ly <= h.y1;
}
const pjHitsEm = (px, py) => PJ.hit.filter(h => pjTesta(h, px, py)).reverse();   // do mais ao topo para o mais ao fundo
function pjSegRet(a, b, r) {   // segmento a-b cruza o retângulo r = [x0,y0,x1,y1]?
  const dentro = p => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  if (dentro(a) || dentro(b)) return true;
  const cr = (p, q, u, v) => { const d = (q[0] - p[0]) * (v[1] - u[1]) - (q[1] - p[1]) * (v[0] - u[0]); if (!d) return false; const t = ((u[0] - p[0]) * (v[1] - u[1]) - (u[1] - p[1]) * (v[0] - u[0])) / d, w = ((u[0] - p[0]) * (q[1] - p[1]) - (u[1] - p[1]) * (q[0] - p[0])) / d; return t >= 0 && t <= 1 && w >= 0 && w <= 1; };
  const c = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
  return c.some((p, i) => cr(a, b, p, c[(i + 1) % 4]));
}
function pjPontoEmPoli(p, co) { let d = false; for (let i = 0, j = co.length - 1; i < co.length; j = i++) if ((co[i][1] > p[1]) !== (co[j][1] > p[1]) && p[0] < (co[j][0] - co[i][0]) * (p[1] - co[i][1]) / (co[j][1] - co[i][1]) + co[i][0]) d = !d; return d; }
function pjAreaSel(d) {   // janela (→ direita): só o que está todo dentro; cruzamento (← esquerda): tudo que o retângulo toca
  const r = [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)], jan = d.x1 >= d.x0, g = new Map();
  for (const h of PJ.hit) {
    const k = sk(h.s), o = g.get(k) || g.set(k, {s: h.s, ok: jan, toca: false}).get(k);
    const dentro = h.bb[0] >= r[0] && h.bb[2] <= r[2] && h.bb[1] >= r[1] && h.bb[3] <= r[3];
    let toca = !(h.bb[2] < r[0] || h.bb[0] > r[2] || h.bb[3] < r[1] || h.bb[1] > r[3]);
    if (toca && h.tipo === 'segs') toca = h.pts.some((p, i) => i && pjSegRet(h.pts[i - 1], p, r));
    if (toca && h.tipo === 'rect') toca = h.co.some((p, i) => pjSegRet(h.co[(i + 3) % 4], p, r)) || (h.px >= r[0] && h.px <= r[2] && h.py >= r[1] && h.py <= r[3]) || [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].some(p => pjPontoEmPoli(p, h.co));
    if (jan && !dentro) o.ok = false;
    if (toca) o.toca = true;
  }
  return [...g.values()].filter(o => jan ? o.ok : o.toca).map(o => o.s);
}
function pjOv(s, criar) {
  const P = PRJ();
  if (s.k === 'T') return P.t[s.key] || (criar ? (P.t[s.key] = {}) : null);
  if (s.k === 'I') return P.i[s.key] || (criar ? (P.i[s.key] = {}) : null);
  if (s.k === 'E') return P.e[s.key] || (criar ? (P.e[s.key] = {}) : null);
  return P.ex.find(x => x.id === s.id) || null;
}
const pjBase = s => { const o = pjOv(s, false); return s.k === 'X' ? JSON.parse(JSON.stringify(o)) : {dm: [...((o && o.dm) || [0, 0])]}; };
function pjMoveSel(s, base, dxm, dym) {
  if (s.k === 'X') { const ex = pjOv(s, false); if (ex.pts) ex.pts = base.pts.map(p => [p[0] + dxm, p[1] + dym, ...p.slice(2)]); else { ex.x = base.x + dxm; ex.y = base.y + dym; } }
  else pjOv(s, true).dm = [base.dm[0] + dxm, base.dm[1] + dym];
}
function pjDown(ev) {
  if (!PJ.on || PJ.pausa || !SEL) return;
  if (ev.target.closest && ev.target.closest('.leaflet-control,.leaflet-popup,#modo,#pj-ed')) return;
  const r = map.getContainer().getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top, tr = pjTr();
  const ini = (d) => { PJ.drag = d; ev.stopPropagation(); ev.preventDefault(); document.addEventListener('mousemove', pjArrasta); document.addEventListener('mouseup', pjSolta); };
  if (ev.button === 1 || (ev.button === 0 && (PJ.espaco || PJ.pan))) { ini({modo: 'pan', x: ev.clientX, y: ev.clientY}); map.getContainer().style.cursor = 'grabbing'; return; }
  if (ev.button !== 0 || (PJ.tool && PJ.tool !== 'sel')) return;
  const un = pjSel1();
  if (PJ.alca && Math.hypot(px - PJ.alca[0], py - PJ.alca[1]) < 9) {
    const pv = pjPivo(tr), o = pjOv(un, false) || {};
    ini({modo: 'rot', pv, a0: Math.atan2(-(py - pv[1]), px - pv[0]), rot0: o.rot || 0}); return;
  }
  if (PJ.vts && un && un.k === 'E') {
    const v = PJ.vts.find(q => Math.hypot(px - q.x, py - q.y) < 7);
    if (v) { const o = pjOv(un, true); ini({modo: 'vtx', i: v.i, x0: px, y0: py, tr, v0: (o.v && o.v[v.i]) ? [...o.v[v.i]] : [0, 0]}); return; }
  }
  const hs = pjHitsEm(px, py), ctrl = ev.ctrlKey || ev.metaKey || ev.shiftKey;
  if (!hs.length) { ini({modo: 'box', x0: px, y0: py, x1: px, y1: py, ctrl, movido: false}); return; }
  const top = hs[0].s, ja = PJ.sels.some(q => sk(q) === sk(top)), era1 = PJ.sels.length === 1 && ja;
  if (ctrl) { PJ.sels = ja ? PJ.sels.filter(q => sk(q) !== sk(top)) : pjGrupo([...PJ.sels, top]); pjPainel(); pjDesenhar(); ev.stopPropagation(); ev.preventDefault(); return; }
  if (!ja) { PJ.sels = pjGrupo([top]); pjPainel(); }
  ini({modo: 'mov', x0: px, y0: py, tr, bases: PJ.sels.map(s => ({s, b: pjBase(s)})), cic: {hs, era1}, movido: false});
  pjDesenhar();
}
function pjArrasta(ev) {
  const d = PJ.drag; if (!d) return;
  if (d.modo === 'pan') { map.panBy([d.x - ev.clientX, d.y - ev.clientY], {animate: false}); d.x = ev.clientX; d.y = ev.clientY; return; }
  const r = map.getContainer().getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top, ke = PJ.c.ke;
  if (d.modo === 'box') { d.x1 = px; d.y1 = py; if (Math.hypot(px - d.x0, py - d.y0) > 4) d.movido = true; pjDesenhar(); return; }
  if (d.modo === 'mov') {
    if (!d.movido) { if (Math.hypot(px - d.x0, py - d.y0) < 3) return; d.movido = true; pjSnap(); }
    const dX = (px - d.x0) / d.tr.k / ke, dY = -(py - d.y0) / d.tr.k / ke;
    for (const q of d.bases) pjMoveSel(q.s, q.b, dX, dY);
  } else if (d.modo === 'vtx') {
    if (!d.movido) { if (Math.hypot(px - d.x0, py - d.y0) < 2) return; d.movido = true; pjSnap(); }
    const o = pjOv(pjSel1(), true); o.v = o.v || {}; o.v[d.i] = [d.v0[0] + (px - d.x0) / d.tr.k / ke, d.v0[1] - (py - d.y0) / d.tr.k / ke];
  } else if (d.modo === 'rot') {
    if (!d.movido) { d.movido = true; pjSnap(); }
    const a = Math.atan2(-(py - d.pv[1]), px - d.pv[0]); let dg = (a - d.a0) / RAD + d.rot0; dg = Math.round(dg * 2) / 2;
    if (ev.shiftKey) dg = Math.round(dg / 15) * 15;
    pjOv(pjSel1(), true).rot = dg;
  }
  pjDesenhar(); pjSincCampos();
}
function pjSolta(ev) {
  document.removeEventListener('mousemove', pjArrasta); document.removeEventListener('mouseup', pjSolta);
  const d = PJ.drag; PJ.drag = null; map.getContainer().style.cursor = PJ.pan || PJ.espaco ? 'grab' : '';
  if (!d) return;
  if (d.modo === 'box') {
    if (d.movido) { const novos = pjAreaSel(d); PJ.sels = pjGrupo(d.ctrl ? [...PJ.sels, ...novos.filter(n => !PJ.sels.some(q => sk(q) === sk(n)))] : novos); }
    else if (!d.ctrl) PJ.sels = [];
    pjPainel();
  } else if (d.modo === 'mov') {
    if (d.movido) salvar();
    else if (d.cic && d.cic.era1 && d.cic.hs.length > 1) {   // novo clique no que já estava selecionado: alterna para o objeto de baixo
      const i = d.cic.hs.findIndex(h => sk(h.s) === sk(PJ.sels[0]));
      PJ.sels = pjGrupo([d.cic.hs[(i + 1) % d.cic.hs.length].s]); pjPainel();
    }
  } else if (d.movido) salvar();
  pjDesenhar();
}
function pjSincCampos() { const e = $('#prj-rot'), s = pjSel1(); if (e && s) { const o = pjOv(s, false); if (o && document.activeElement !== e) e.value = (o.rot || 0); } }
function pjTeclaSolta(ev) { if (ev.code === 'Space' && PJ.espaco) { PJ.espaco = false; map.getContainer().style.cursor = PJ.pan ? 'grab' : ''; } }
function pjTecla(ev) {
  if (!PJ.on || PJ.pausa) return;
  const alvo = ev.target && ev.target.tagName, dig = /^(INPUT|TEXTAREA|SELECT)$/.test(alvo || '');
  const ctrl = ev.ctrlKey || ev.metaKey, k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (ctrl && k === 'f') { ev.preventDefault(); const f = $('#pj-q'); if (f) { const d = f.closest('details'); if (d) d.open = true; f.focus(); f.select(); } return; }
  if (dig) return;
  if (ctrl && k === 'z') { ev.preventDefault(); ev.shiftKey ? pjRefazer() : pjDesfazer(); return; }
  if (ctrl && k === 'y') { ev.preventDefault(); pjRefazer(); return; }
  if (ctrl && k === 'a') { ev.preventDefault(); PJ.sels = PJ.hit.reduce((a, h) => a.some(q => sk(q) === sk(h.s)) ? a : [...a, h.s], []); pjPainel(); pjDesenhar(); return; }
  if (ctrl && k === 'd') { ev.preventDefault(); pjDuplicar(); return; }
  if (ctrl && k === 'c') { ev.preventDefault(); pjCopiar(); return; }
  if (ctrl && k === 'v') { ev.preventDefault(); pjColar(); return; }
  if (ctrl && k === 'x') { ev.preventDefault(); if (pjCopiar()) pjExcluir(); return; }
  if (ev.code === 'Space') { ev.preventDefault(); if (!PJ.espaco) { PJ.espaco = true; map.getContainer().style.cursor = 'grab'; } return; }
  if (k === 'Delete' || k === 'Backspace') { if (PJ.sels.length) { ev.preventDefault(); pjExcluir(); } return; }
  if (k === 'F2' || k === 'Enter') { if (PJ.tmp && PJ.tool === 'pline') { ev.preventDefault(); pjFechaPline(); return; } const s = pjSel1(); if (s && (s.k === 'T' || (s.k === 'X' && pjOv(s, false).t === 'TEXT'))) { ev.preventDefault(); pjEditarTexto(s); } return; }
  if (k.startsWith('Arrow') && PJ.sels.length) {
    ev.preventDefault(); const st = (ev.shiftKey ? 5 : .5) / PJ.c.ke, dx = k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, dy = k === 'ArrowDown' ? -st : k === 'ArrowUp' ? st : 0;
    pjSnap(); for (const s of PJ.sels) pjMoveSel(s, pjBase(s), dx, dy); salvar(); pjDesenhar(); return;
  }
}

// ---------- ferramentas de inserção ----------
const PJ_FERR = {sel: 'Selecionar', pan: 'Mover o mapa', texto: 'Texto', linha: 'Linha', pline: 'Polilinha', seta: 'Seta', bloco: 'Bloco'};
const PJ_DICA = {
  pan: 'Projeto · Mover o mapa: arraste para deslocar (Esc volta a selecionar)',
  texto: 'Projeto · Texto: clique no mapa onde o texto deve ficar (Esc encerra)',
  linha: 'Projeto · Linha: clique no ponto inicial e depois no final; Shift trava em 15° (Esc encerra)',
  pline: 'Projeto · Polilinha: clique nos vértices; duplo clique ou Enter conclui; Shift trava em 15° (Esc encerra)',
  seta: 'Projeto · Seta: clique na origem e depois na ponta (Esc encerra)',
  bloco: 'Projeto · Bloco: clique no mapa para inserir o bloco escolhido (Esc encerra)'};
function pjFerr(t) {
  if (typeof pjOrgFerr === 'function' && pjOrgFerr(t)) return;
  if (t === 'pan') {
    PJ.pan = !PJ.pan; PJ.tool = 'sel'; PJ.tmp = null;
    if (PJ.pan) { modoSet(PJ_DICA.pan); map.getContainer().style.cursor = 'grab'; } else { modoFim(); map.getContainer().style.cursor = ''; }
    pjPainel(); return;
  }
  PJ.pan = false; PJ.tool = PJ.tool === t ? 'sel' : t; PJ.tmp = null;
  if (PJ.tool !== 'sel') { modoSet(PJ_DICA[PJ.tool]); map.getContainer().style.cursor = 'crosshair'; map.doubleClickZoom.disable(); }
  else { modoFim(); map.getContainer().style.cursor = ''; map.doubleClickZoom.enable(); }
  pjPainel(); pjDesenhar();
}
const pjNovoId = () => PRJ().seq++;
function pjPonto(e, ult) {   // clique do mapa -> metros reais; Shift trava o ângulo em passos de 15°
  const tr = pjTr(); let w = pjMundoDePx(tr, e.containerPoint.x, e.containerPoint.y);
  if (e.originalEvent && e.originalEvent.shiftKey && ult) {
    const dx = w[0] - ult[0], dy = w[1] - ult[1], d = Math.hypot(dx, dy), a = Math.round(Math.atan2(dy, dx) / (15 * RAD)) * 15 * RAD;
    w = [ult[0] + d * Math.cos(a), ult[1] + d * Math.sin(a)];
  }
  return w;
}
function pjClique(e) {
  if (!PJ.on || PJ.pausa || !PJ.tool || PJ.tool === 'sel') return;
  if (typeof pjOrgClique === 'function' && pjOrgClique(e)) return;
  const P = PRJ(), t = PJ.tool, ult = PJ.tmp && PJ.tmp.pts.length ? PJ.tmp.pts[PJ.tmp.pts.length - 1] : null, w = pjPonto(e, ult);
  if (t === 'texto') {
    pjSnap(); const ex = {id: pjNovoId(), t: 'TEXT', x: w[0], y: w[1], s: 'Texto', h: PJ.hNovo || pjAlturaPadrao(), rot: 0, cor: '', hj: 0};
    P.ex.push(ex); PJ.sels = [{k: 'X', id: ex.id}]; salvar(); pjPainel(); pjDesenhar(); setTimeout(() => PJ.on && pjEditarTexto(PJ.sels[0], true), 0);
  } else if (t === 'bloco') {
    const lib = PJ.libNovo || 'F:circ'; if (!projLib(lib)) { $('#st').textContent = 'Escolha um bloco na lista antes de inserir.'; return; }
    pjSnap(); const ex = {id: pjNovoId(), t: 'BLOCO', x: w[0], y: w[1], lib, tam: PJ.tamNovo || 3, rot: 0, cor: ''};
    P.ex.push(ex); PJ.sels = [{k: 'X', id: ex.id}]; salvar(); pjPainel(); pjDesenhar();
  } else if (t === 'linha' || t === 'seta') {
    if (!PJ.tmp) PJ.tmp = {pts: [w]};
    else { pjSnap(); const ex = {id: pjNovoId(), t: t === 'seta' ? 'SETA' : 'LINE', pts: [PJ.tmp.pts[0], w], cor: '', tam: 2}; P.ex.push(ex); PJ.tmp = null; PJ.sels = [{k: 'X', id: ex.id}]; salvar(); pjPainel(); }
    pjDesenhar();
  } else if (t === 'pline') {
    if (!PJ.tmp) PJ.tmp = {pts: []};
    PJ.tmp.pts.push(w); pjDesenhar();
  }
}
function pjFechaPline() {
  if (!PJ.tmp || PJ.tmp.pts.length < 2) { PJ.tmp = null; pjDesenhar(); return; }
  pjSnap(); const ex = {id: pjNovoId(), t: 'PLINE', pts: PJ.tmp.pts, cor: ''};
  PRJ().ex.push(ex); PJ.tmp = null; PJ.sels = [{k: 'X', id: ex.id}]; salvar(); pjPainel(); pjDesenhar();
}
function pjMouse(e) { if (PJ.on && !PJ.pausa && typeof pjOrgMouse === 'function') pjOrgMouse(e); if (!PJ.on || PJ.pausa || !PJ.tmp) return; PJ.tmp.mouse = [e.containerPoint.x, e.containerPoint.y]; pjDesenhar(); }
function pjDbl(ev) {
  if (!PJ.on || PJ.pausa || (PJ.tool && PJ.tool !== 'sel')) { if (PJ.on && PJ.tool === 'pline') { ev.stopPropagation(); pjFechaPline(); } return; }
  if (ev.target.closest && ev.target.closest('.leaflet-control,#pj-ed')) return;
  const r = map.getContainer().getBoundingClientRect(), hs = pjHitsEm(ev.clientX - r.left, ev.clientY - r.top), h = hs.find(q => q.s.k === 'T' || (q.s.k === 'X' && pjOv(q.s, false).t === 'TEXT'));
  if (!h) return;
  ev.stopPropagation(); ev.preventDefault(); PJ.sels = [h.s]; pjPainel(); pjEditarTexto(h.s);
}

// ---------- operações na seleção ----------
function pjExcluir() {
  if (!PJ.sels.length) return; pjSnap();
  for (const s of PJ.sels) { if (s.k === 'X') { const p = PRJ(); p.ex = p.ex.filter(x => x.id !== s.id); } else pjOv(s, true).del = true; }
  PJ.sels = []; salvar(); pjPainel(); pjDesenhar();
}
function pjRestaurar() {
  if (!PJ.sels.length) return; pjSnap(); const P = PRJ();
  for (const s of PJ.sels) {
    if (s.k === 'T') { delete P.t[s.key]; for (const k of Object.keys(P.s)) if (k.startsWith(s.key + '|')) delete P.s[k]; }
    else if (s.k === 'I') delete P.i[s.key]; else if (s.k === 'E') delete P.e[s.key];
  }
  salvar(); pjPainel(); pjDesenhar();
}
// ---------- copiar / colar / duplicar (textos, rótulos, blocos, linhas e anotações) ----------
// Tudo que é copiado vira ANOTAÇÃO do projeto (camada de anotações), com o aspecto atual (posição, cor, tipo de linha).
function pjLibDe(nome) {   // id da biblioteca ('F:forma' ou 'B:bloco') de um bloco já existente no desenho
  for (const f of FORMAS_PJ) if (san('CTW_F_' + f[0]) === nome) return 'F:' + f[0];
  for (const n of Object.keys(BLOCOS)) if (san(BLOCOS[n].nome || n) === nome || san(n) === nome) return 'B:' + n;
  return PJ.defs.has(nome) ? 'D:' + nome : null;
}
function pjCopiar(silencio) {
  const P = PRJ(), c = DXF.ctx, out = []; let pul = 0;
  const hexDe = (col, L) => pjCorHex(col, L);
  for (const s of PJ.sels) {
    if (s.k === 'X') { const o = pjOv(s, false); if (o) out.push(JSON.parse(JSON.stringify(o))); continue; }
    if (s.k === 'T') {
      const its = PJ.items.filter(i => i.k === 'T' && i.key === s.key).sort((a, b) => (a.e.gk ? a.e.gk.k : 0) - (b.e.gk ? b.e.gk.k : 0));
      const ef = its.map(i => projAplicaT(i)).filter(Boolean); if (!ef.length) { pul++; continue; }
      const w = pjMundo(ef[0].e.p[0], ef[0].e.p[1], c);
      out.push({t: 'TEXT', x: w[0], y: w[1], s: ef.map(q => q.e.s).join('\n'), h: ef[0].e.h, rot: ef[0].e.rot || 0, hj: ef[0].e.hj || 0, cor: hexDe(ef[0].col, its[0].L)});
      continue;
    }
    if (s.k === 'I') {
      const it = PJ.items.find(i => i.k === 'I' && i.key === s.key), r = it && projAplicaI(it); if (!r) { pul++; continue; }
      const id = pjLibDe(r.name), l = id && projLib(id); if (!l) { pul++; continue; }
      const w = pjMundo(r.x, r.y, c);
      out.push({t: 'BLOCO', x: w[0], y: w[1], lib: id, tam: (r.sx || 1) * l.ext, rot: r.rot || 0, cor: hexDe(r.col, r.L)}); continue;
    }
    if (s.k === 'E') {
      const it = PJ.items.find(i => i.k === 'E' && i.key === s.key), r = it && projAplicaE(it); if (!r) { pul++; continue; }
      const e = r.e, W = q => pjMundo(q[0], q[1], c), cor = hexDe(r.col, r.L), ov = P.e[s.key] || {};
      const ltOrig = ov.lt ? {...ov.lt} : null;
      if (e.t === 'LINE') out.push({t: 'LINE', pts: [W(e.a), W(e.b)], cor, lt: ltOrig});
      else if (e.t === 'PLINE') { const pts = e.pts.map(W); if (e.closed) pts.push(pts[0]); out.push({t: 'PLINE', pts, cor, lt: ltOrig}); }
      else if (e.t === 'CIRCLE' || e.t === 'ARC') {
        const a0 = e.t === 'ARC' ? e.a0 : 0, d = e.t === 'ARC' ? (((e.a1 - e.a0) % 360 + 360) % 360 || 360) : 360, n = 36, pts = [];
        for (let k = 0; k <= n; k++) { const a = (a0 + d * k / n) * RAD; pts.push(W([e.p[0] + e.r * Math.cos(a), e.p[1] + e.r * Math.sin(a)])); }
        out.push({t: 'PLINE', pts, cor, lt: ltOrig});
      } else pul++;
    }
  }
  PJ.clip = out; PJ.clipN = 0;
  if (!silencio) $('#st').textContent = out.length ? out.length + ' elemento(s) copiado(s) (Ctrl+V cola)' + (pul ? ' · ' + pul + ' não puderam ser copiados' : '') : 'Nada copiável na seleção' + (pul ? ' (' + pul + ' sem equivalente)' : '') + '.';
  return out.length;
}
function pjColar() {
  if (!PJ.clip || !PJ.clip.length) { $('#st').textContent = 'Nada copiado: selecione elementos e use Ctrl+C.'; return; }
  const P = PRJ(), n = (PJ.clipN = (PJ.clipN || 0) + 1), d = 2.5 * n / PJ.c.ke, novos = [];
  const gm = new Map();
  for (const o0 of PJ.clip) {
    const o = JSON.parse(JSON.stringify(o0)); o.id = pjNovoId();
    if (o.grp) { if (!gm.has(o.grp)) gm.set(o.grp, 'g' + pjNovoId()); o.grp = gm.get(o.grp); }
    if (o.pts) o.pts = o.pts.map(p => [p[0] + d, p[1] - d, ...p.slice(2)]); else { o.x += d; o.y -= d; }
    novos.push(o);
  }
  pjSnap(); P.ex.push(...novos); PJ.sels = novos.map(o => ({k: 'X', id: o.id})); salvar(); pjPainel(); pjDesenhar();
  $('#st').textContent = novos.length + ' elemento(s) colado(s) como anotação — arraste para a posição desejada.';
}
function pjDuplicar() { if (pjCopiar(true)) pjColar(); else $('#st').textContent = 'Nada para duplicar na seleção.'; }
function pjAlturaPadrao() { for (const t of Object.keys(CFG.cam)) for (const l of CFG.cam[t].labels || []) if (l.dxfH) return l.dxfH; return CFG.dxf.ruasH || 1.5; }
function pjAplicaAlturaGlobal(h) { for (const t of Object.keys(CFG.cam)) for (const l of CFG.cam[t].labels || []) l.dxfH = h; CFG.dxf.ruasH = h; PJ.hNovo = h; salvar(); }
async function pjRegerar() { const sels = PJ.sels; await projGerar(false); PJ.sels = sels; pjPainel(); pjDesenhar(); }
function pjAjustarEscala() { const c = SEL.b.getCenter(); irEscala(c.lat, c.lng, +CFG.dxf.escala || 1000); }

// ---------- textos: lista unificada (rótulos, textos soltos, anotações) ----------
function pjTextos() {
  const P = PRJ(), out = [];
  for (const it of PJ.items) if (it.k === 'T') {
    const cam = P.cam[it.L], ov = P.t[it.key]; if ((cam && cam.oculto) || (ov && ov.del)) continue;
    const ks = pjChaveS(it), v = P.s[ks];
    out.push({s: {k: 'T', key: it.key}, L: it.L, get: () => P.s[ks] != null ? P.s[ks] : it.e.s, set: x => { P.s[ks] = x; }});
  }
  for (const ex of P.ex) if (ex.t === 'TEXT') out.push({s: {k: 'X', id: ex.id}, L: san(P.camadaAnot || 'ANOTACOES'), get: () => ex.s, set: x => { ex.s = x; }});
  return out;
}
// ---------- editor de texto estilo MTEXT, dentro do mapa ----------
function pjEditarTexto(s, novo) {
  pjFechaEditor(true); if (!PJ.on) return;
  const P = PRJ(), tr = pjTr(); let its = [], ex = null, L_ = null;
  if (s.k === 'T') { its = PJ.items.filter(i => i.k === 'T' && i.key === s.key).sort((a, b) => (a.e.gk ? a.e.gk.k : 0) - (b.e.gk ? b.e.gk.k : 0)); if (!its.length) return; L_ = its[0].L; }
  else { ex = P.ex.find(x => x.id === s.id); if (!ex) return; L_ = san(P.camadaAnot || 'ANOTACOES'); }
  const snap = pjFoto(), h0 = PJ.hit.find(q => sk(q.s) === sk(s)); if (!h0) return;
  const ef = s.k === 'T' ? projAplicaT(its[0]) : null, e0 = ef ? ef.e : {h: ex.h, hj: ex.hj || 0, p: pjDxf(ex.x, ex.y, PJ.c)};
  const hex = s.k === 'T' ? pjCorHex(ef ? ef.col : null, L_) : (ex.cor || '#ffffff'), fpx = Math.max(13, Math.min(44, e0.h * tr.k * pjFonteK()));
  const texto = () => s.k === 'T' ? its.map(i => { const v = P.s[pjChaveS(i)]; return v != null ? v : i.e.s; }).join('\n') : ex.s;
  const ta = mk('textarea', {rows: Math.max(2, texto().split('\n').length), spellcheck: false, style: `display:block;width:${Math.max(200, Math.round((h0.bb[2] - h0.bb[0]) + 60))}px;font:${fpx}px Arial;color:${hex};background:rgba(13,17,23,.94);border:1px dashed #22d3ee;border-radius:3px;padding:4px 6px;resize:both;outline:none;line-height:1.25`});
  ta.value = texto();
  const aplica = () => {
    const ls = ta.value.split('\n');
    if (s.k === 'T') its.forEach((i, k) => { P.s[pjChaveS(i)] = k === its.length - 1 ? ls.slice(k).join('\n') : (ls[k] != null ? ls[k] : ''); });
    else ex.s = ta.value;
    pjDesenhar();
  };
  ta.oninput = aplica;
  const setProp = (k, v) => { if (s.k === 'T') { const o = pjOv(s, true); o[k] = v; } else ex[k] = v; pjDesenhar(); };
  const alt = pjNum(e0.h, n => setProp('h', n), .1, .1), cor = pjCorIn(hex, v => setProp('cor', v));
  alt.style.width = '64px'; cor.style.cssText = 'width:34px;height:26px;padding:0';
  const bt = (t, f, tit) => mk('button', {title: tit || '', onclick: f, style: 'padding:3px 9px'}, t);
  const bar = mk('div', {style: 'display:flex;gap:6px;align-items:center;background:#131920;border:1px solid #2a3542;border-radius:6px 6px 0 0;padding:5px 6px;flex-wrap:wrap'},
    mk('span', {style: 'color:#8b97a4;font-size:11px'}, 'Altura'), alt, cor, bt('⇤', () => setProp('hj', 0), 'Alinhar à esquerda'), bt('↔', () => setProp('hj', 1), 'Centralizar'), bt('⇥', () => setProp('hj', 2), 'Alinhar à direita'),
    bt('OK', () => pjFechaEditor(true), 'Ctrl+Enter'), bt('Cancelar', () => pjFechaEditor(false), 'Esc'));
  const wrap = mk('div', {id: 'pj-ed', style: `position:absolute;z-index:700;left:${Math.max(4, Math.min(h0.bb[0] - 4, map.getSize().x - 260))}px;top:${Math.max(4, h0.bb[1] - 36)}px;box-shadow:0 6px 22px rgba(0,0,0,.5)`}, bar, ta);
  map.getContainer().appendChild(wrap);
  const fora = ev => { if (!wrap.contains(ev.target)) pjFechaEditor(true); };
  ta.onkeydown = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); pjFechaEditor(false); } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); pjFechaEditor(true); } ev.stopPropagation(); };
  setTimeout(() => document.addEventListener('mousedown', fora, true), 0);
  PJ.ed = {s, keys: [sk(s)], snap, wrap, fora, novo};
  pjDesenhar(); ta.focus(); ta.select();
}
function pjFechaEditor(ok) {
  const ed = PJ.ed; if (!ed) return; PJ.ed = null;
  document.removeEventListener('mousedown', ed.fora, true); ed.wrap.remove();
  if (ok) { if (pjFoto() !== ed.snap) { PJ.hist.push(ed.snap); PJ.fut = []; salvar(); } }
  else { pjRestaura(ed.snap); if (ed.novo) { /* texto novo cancelado: mantém o padrão */ } }
  if (PJ.on) { pjPainel(); pjDesenhar(); }
}

// ---------- localizar e substituir ----------
function pjRegex() {
  const b = PJ.busca; if (!b.q) return null;
  try {
    let src = b.regex ? b.q : b.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (b.palavra) src = '(?<![\\p{L}\\p{N}_])(?:' + src + ')(?![\\p{L}\\p{N}_])';
    return new RegExp(src, 'gu' + (b.caso ? '' : 'i'));
  } catch (e) { return null; }
}
function pjBuscar() {
  const b = PJ.busca, re = pjRegex(); b.res = []; b.i = -1;
  if (!re) { b.msg = b.q ? 'Expressão inválida.' : ''; return; }
  const sel = new Set(PJ.sels.map(sk));
  for (const t of pjTextos()) {
    if (b.esc === 'sel' && !sel.has(sk(t.s))) continue;
    if (b.esc.startsWith('cam:') && t.L !== b.esc.slice(4)) continue;
    re.lastIndex = 0; if (re.test(t.get())) b.res.push(t);
  }
  b.msg = b.res.length + ' texto(s) encontrado(s)';
}
function pjLocalizar() {
  pjBuscar(); const b = PJ.busca;
  PJ.sels = b.res.map(t => t.s); if (b.res.length) { b.i = 0; pjIrPara(b.res[0].s); }
  pjPainel(); pjDesenhar();
}
function pjNavBusca(d) {
  const b = PJ.busca; if (!b.res.length) return;
  b.i = (b.i + d + b.res.length) % b.res.length; PJ.sels = [b.res[b.i].s]; pjIrPara(b.res[b.i].s); pjPainel(); pjDesenhar();
}
function pjSubstituir(todos) {
  const b = PJ.busca, re = pjRegex(); if (!re) return;
  if (!b.res.length) pjBuscar();
  const alvo = todos ? b.res : b.res.filter((_, i) => i === Math.max(0, b.i));
  if (!alvo.length) { $('#st').textContent = 'Nada para substituir. Use "Localizar" primeiro.'; return; }
  pjSnap(); let n = 0;
  for (const t of alvo) { const a = t.get(); re.lastIndex = 0; const novo = a.replace(re, () => { n++; return b.r; }); if (novo !== a) t.set(novo); }
  salvar(); pjBuscar(); $('#st').textContent = n + ' ocorrência(s) substituída(s) em ' + alvo.length + ' texto(s).';
  pjPainel(); pjDesenhar();
}
// ---------- limpeza: textos duplicados ----------
function pjDuplicados() {
  const P = PRJ(), vis = new Map(), dup = [];
  for (const it of PJ.items) if (it.k === 'T') {
    const r = projAplicaT(it); if (!r) continue;
    const k = it.L + '|' + r.e.s + '|' + Math.round(r.e.p[0] * 5) + '|' + Math.round(r.e.p[1] * 5) + '|' + Math.round(r.e.rot || 0);
    if (vis.has(k)) { if (!it.e.gk || vis.get(k) !== it.key) dup.push(it.key); } else vis.set(k, it.key);
  }
  return [...new Set(dup)];
}
function pjRemoverDuplicados() {
  const d = pjDuplicados(); if (!d.length) { $('#st').textContent = 'Nenhum texto duplicado encontrado.'; return; }
  pjSnap(); const P = PRJ(); for (const k of d) (P.t[k] = P.t[k] || {}).del = true;
  salvar(); $('#st').textContent = d.length + ' texto(s)/rótulo(s) duplicado(s) removido(s) do projeto (nos dados continuam existindo).'; pjPainel(); pjDesenhar();
}

// ---------- interface: painel lateral ----------
function pjNum(v, f, min, passo) {
  const i = mk('input', {type: 'number', value: v, step: passo || 'any', style: 'width:100%'}); if (min != null) i.min = min;
  i.oninput = () => { const n = parseFloat(String(i.value).replace(',', '.')); if (isFinite(n)) f(n); };
  i.onchange = () => { salvar(); };
  return i;
}
function pjCorIn(v, f) {
  const i = mk('input', {type: 'color', value: /^#[0-9a-f]{6}$/i.test(v || '') ? v : '#ffffff', style: 'width:100%;height:28px;padding:0'});
  i.oninput = () => f(i.value); i.onchange = () => salvar();
  return i;
}
function pjMiniatura(id) {
  const c = mk('canvas', {width: 30, height: 30, style: 'width:30px;height:30px;background:#0f2230;border-radius:4px;flex:none'}), l = projLib(id), g = c.getContext && c.getContext('2d');
  if (!g || !l || !g.clearRect) return c;
  const b = pjBBox(l.ents), s = 24 / (Math.max(b[2] - b[0], b[3] - b[1]) || 1), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const tr = {k: s, T: (X, Y) => [15 + (X - cx) * s, 15 - (Y - cy) * s]};
  g.clearRect(0, 0, 30, 30); for (const e of l.ents) pjEnt(g, tr, e, '#f2a900', 1);
  return c;
}
// lista de blocos pesquisável, com favoritos (★) no topo
function pjSeletor(atual, onPick, opc = {}) {
  const P = PRJ(), caixa = mk('div', {class: 'pj-sel', style: 'display:grid;gap:4px'});
  const q = mk('input', {type: 'search', placeholder: 'Pesquisar bloco…', style: 'width:100%'}), lista = mk('div', {style: 'max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:6px;background:var(--card2)'});
  let limite = 60;
  const fav = id => P.fav.includes(id);
  const alterna = id => { P.fav = fav(id) ? P.fav.filter(x => x !== id) : [...P.fav, id]; salvar(); desenhaLista(); };
  const linha = (it, vazio) => {
    const sel = (atual || '') === (vazio ? '' : it.id);
    const r = mk('div', {style: `display:flex;gap:8px;align-items:center;padding:4px 6px;cursor:pointer;${sel ? 'background:rgba(242,169,0,.18)' : ''}`, title: it && it.nome, onclick: () => { atual = vazio ? '' : it.id; onPick(atual); desenhaLista(); }});
    if (vazio) { r.append(mk('span', {style: 'flex:1'}, '(manter o bloco original)')); return r; }
    r.append(pjMiniatura(it.id), mk('span', {style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'}, it.nome),
      mk('button', {title: fav(it.id) ? 'Remover dos favoritos' : 'Adicionar aos favoritos', style: `border:0;background:none;font-size:17px;line-height:1;padding:0 3px;color:${fav(it.id) ? '#f2a900' : '#8b97a4'}`, onclick: ev => { ev.stopPropagation(); alterna(it.id); }}, fav(it.id) ? '★' : '☆'));
    return r;
  };
  function desenhaLista() {
    lista.replaceChildren();
    const t = q.value.trim().toLowerCase(), todos = pjTodosLib().filter(b => !t || b.nome.toLowerCase().includes(t));
    if (opc.vazio) lista.append(linha(null, true));
    const fs = todos.filter(b => fav(b.id)), resto = todos.filter(b => !fav(b.id));
    const grupo = (nome, arr) => { if (!arr.length) return; lista.append(mk('div', {style: 'padding:3px 6px;font-size:11px;color:var(--mut);background:var(--card)'}, nome + ' (' + arr.length + ')')); for (const b of arr.slice(0, limite)) lista.append(linha(b)); if (arr.length > limite) lista.append(mk('button', {style: 'width:100%', onclick: () => { limite += 80; desenhaLista(); }}, 'Mostrar mais ' + Math.min(80, arr.length - limite) + '…')); };
    grupo('★ Favoritos', fs);
    for (const g of ['Símbolos do CTWeb', 'Blocos importados (DXF)']) grupo(g, resto.filter(b => b.grupo === g));
    if (!todos.length) lista.append(mk('div', {style: 'padding:8px;color:var(--mut)'}, 'Nenhum bloco encontrado. Importe em Estilos, na aba Blocos.'));
  }
  q.oninput = () => { limite = 60; desenhaLista(); };
  caixa.append(q, lista); desenhaLista();
  return caixa;
}
function pjDet(titulo, aberto, ...filhos) { return mk('details', {class: 'sec', open: aberto || null}, mk('summary', null, titulo), mk('div', {style: 'display:grid;gap:6px;margin-top:6px'}, ...filhos)); }
function pjPainel() {
  const alvo = $('#prjc'); if (!alvo) return;
  const P = PRJ(), cf = CFG.dxf;
  const aberto = {}; alvo.querySelectorAll('details.sec').forEach(d => { aberto[d.firstChild.textContent] = d.open; });
  const ab = (t, pad) => t in aberto ? aberto[t] : pad;
  alvo.replaceChildren();
  // painel por contexto: tela do "Anotar poste" > só arruamento > ferramentas + propriedades + organizar
  if (PJ.ap && PJ.ap.passo === 2.5) { alvo.append(apTela()); if (PJ.ap.foco != null) { const f = alvo.querySelector('[data-apf="' + PJ.ap.foco + '"]'); if (f) f.focus(); PJ.ap.foco = null; } return; }
  if (pjSelSoRuas()) { alvo.append(pjCartaoRuas()); return; }
  alvo.append(pjOrgFerramentas());
  if (PJ.ap) alvo.append(apCartaoPassos());
  alvo.append(pjCartaoSel(), pjOrgCartao());
  // localizar e substituir
  const b = PJ.busca;
  const q = mk('input', {id: 'pj-q', type: 'search', value: b.q, placeholder: 'Localizar…', style: 'width:100%'}), r = mk('input', {type: 'text', value: b.r, placeholder: 'Substituir por…', style: 'width:100%'});
  q.oninput = () => { b.q = q.value; }; r.oninput = () => { b.r = r.value; };
  q.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); pjLocalizar(); } };
  const chk = (t, k) => mk('label', {style: 'display:flex;gap:5px;align-items:center'}, mk('input', {type: 'checkbox', checked: b[k], onchange: e => { b[k] = e.target.checked; }}), t);
  const camsT = [...new Set(PJ.items.filter(i => i.k === 'T').map(i => i.L))].sort();
  const esc = mk('select', {style: 'width:100%'}, mk('option', {value: 'todos'}, 'Em todos os textos'), mk('option', {value: 'sel'}, 'Só na seleção'), ...camsT.map(c => mk('option', {value: 'cam:' + c}, 'Camada ' + c)));
  esc.value = b.esc; esc.onchange = () => { b.esc = esc.value; };
  alvo.append(pjDet('Localizar e substituir', ab('Localizar e substituir', false), q, r,
    mk('div', {style: 'display:flex;gap:10px;flex-wrap:wrap'}, chk('Maiúsc./minúsc.', 'caso'), chk('Palavra inteira', 'palavra'), chk('Expressão regular', 'regex')), esc,
    mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, mk('button', {class: 'p', onclick: pjLocalizar}, 'Localizar tudo'), mk('button', {onclick: () => pjNavBusca(-1)}, '‹'), mk('button', {onclick: () => pjNavBusca(1)}, '›'),
      mk('button', {onclick: () => pjSubstituir(false)}, 'Substituir'), mk('button', {onclick: () => pjSubstituir(true)}, 'Substituir tudo')),
    mk('small', null, b.msg || 'Ctrl+F abre esta busca. Os textos encontrados ficam selecionados.' + (b.i >= 0 ? ' (' + (b.i + 1) + ' de ' + b.res.length + ')' : ''))));
  // escala, fonte, fundo
  const escI = pjNum(+cf.escala || 1000, n => { cf.escala = String(Math.round(n)); }, 1, 1);
  escI.onchange = async () => { salvar(); await pjRegerar(); };
  const alt = pjNum(PJ.hNovo || pjAlturaPadrao(), n => { PJ.hNovo = n; }, .1, .1);
  alt.onchange = async () => { pjSnap(); pjAplicaAlturaGlobal(PJ.hNovo); await pjRegerar(); };
  const fu = mk('select', {style: 'width:100%'}, ...[['mapa', 'Mapa de fundo (área em destaque)'], ['escuro', 'Fundo escuro liso'], ['branco', 'Fundo branco (como no papel)'], ['sem', 'Mapa inteiro, sem máscara']].map(([v, n]) => mk('option', {value: v, selected: P.fundo === v}, n)));
  fu.onchange = () => { P.fundo = fu.value; salvar(); pjDesenhar(); };
  alvo.append(pjDet('Escala, fonte e fundo', ab('Escala, fonte e fundo', true), fr('Escala 1:', escI, 'Textos e símbolos aparecem no tamanho que terão no desenho nessa escala'),
    fr('Altura padrão dos textos (un. do desenho)', alt, 'Aplica a todos os rótulos e aos nomes das ruas. Ex.: 1,3'),
    fr('Tamanho da fonte na tela (× altura)', (() => { const i = pjNum(pjFonteK(), n => { P.fonteK = n; pjDesenhar(); }, .5, .01); i.title = 'Só muda a visualização: ajuste até o texto da tela ficar do tamanho que aparece no CAD (padrão 1,25)'; return i; })(), 'Calibra a visualização com o CAD; não altera o DXF'), fr('Fundo', fu)));
  // camadas (texto, rede, arruamento, blocos)
  const ls = new Map(), Lx = san(P.camadaAnot || 'ANOTACOES');
  for (const it of PJ.items) { const o = ls.get(it.L) || ls.set(it.L, {t: 0, e: 0, i: 0}).get(it.L); o[it.k === 'T' ? 't' : it.k === 'I' ? 'i' : 'e']++; }
  for (const x of P.ex) { const Ln = x.lay ? san(x.lay) : Lx, o = ls.get(Ln) || ls.set(Ln, {t: 0, e: 0, i: 0}).get(Ln); o[x.t === 'TEXT' ? 't' : x.t === 'BLOCO' ? 'i' : 'e']++; if (!PJ.layers.has(Ln)) PJ.layers.set(Ln, 7); }
  if (ls.size) {
    const cam = [mk('small', null, 'Mostrar · travar · camada · cor · altura do texto (vazio = padrão). A cor vale para tudo da camada.')];
    for (const [L_, n] of [...ls.entries()].sort()) {
      const c = P.cam[L_] || {}, atual = DXF.aciHex(PJ.layers.get(L_)) || '#ffffff', mexe = f => { pjSnap(); const o = P.cam[L_] = P.cam[L_] || {}; f(o); salvar(); pjDesenhar(); };
      cam.push(mk('div', {style: 'display:grid;grid-template-columns:auto auto 1fr 44px 52px;gap:6px;align-items:center'},
        mk('input', {type: 'checkbox', checked: !c.oculto, title: 'Mostrar', onchange: e => mexe(o => { o.oculto = !e.target.checked; })}),
        mk('input', {type: 'checkbox', checked: !!c.trava, title: 'Travar (não seleciona nem move)', onchange: e => mexe(o => { o.trava = e.target.checked; })}),
        mk('span', {title: L_ + ' — ' + n.t + ' texto(s), ' + n.e + ' linha(s), ' + n.i + ' bloco(s)', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'}, L_ + ' (' + (n.t + n.e + n.i) + ')'),
        pjCorIn(c.cor || atual, v => { (P.cam[L_] = P.cam[L_] || {}).cor = v; pjDesenhar(); }),
        n.t ? pjNum(c.h || '', v => { (P.cam[L_] = P.cam[L_] || {}).h = v; pjDesenhar(); }, .1, .1) : mk('span')));
    }
    cam.push(mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, mk('button', {onclick: () => { pjSnap(); P.cam = {}; salvar(); pjPainel(); pjDesenhar(); }}, 'Limpar ajustes das camadas'),
      mk('button', {onclick: pjRemoverDuplicados, title: 'Mesmo texto, camada e posição repetidos (ex.: dado em duplicidade)'}, 'Remover textos duplicados (' + pjDuplicados().length + ')')));
    alvo.append(pjDet('Camadas do desenho', ab('Camadas do desenho', false), ...cam));
  }
  alvo.append(mk('div', {class: 'card', style: 'display:grid;gap:6px'},
    mk('small', null, pjNEd(P) + ' edição(ões) e ' + P.ex.length + ' anotação(ões). Tudo entra na entrega automaticamente.'),
    mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'},
      mk('button', {onclick: () => { if (!confirm('Desfazer todas as edições do projeto (textos, linhas, blocos, cores e anotações)?')) return; pjSnap(); const p = PRJ(); p.t = {}; p.s = {}; p.i = {}; p.e = {}; p.cam = {}; p.ex = []; PJ.sels = []; salvar(); pjPainel(); pjDesenhar(); }}, 'Reiniciar projeto'))));
}
function pjLtUI(get, set) {   // seletor de tipo de linha + escala
  const lt = get() || {}, sel = mk('select', {style: 'width:100%'}, mk('option', {value: 'orig'}, 'Como está'), ...Object.entries(PJ_LT).map(([k, v]) => mk('option', {value: k}, v[0])));
  sel.value = lt.tipo || 'orig';
  sel.onchange = () => { pjSnap(); set({tipo: sel.value, esc: (get() || {}).esc || 1}); salvar(); pjDesenhar(); };
  return [fr('Tipo de linha', sel), fr('Escala do tipo de linha', pjNum(lt.esc || 1, n => { set({tipo: (get() || {}).tipo || 'dash', esc: n}); pjDesenhar(); }, .05, .1))];
}
function pjCartaoSel() {
  const P = PRJ(), S = PJ.sels, c = mk('div', {class: 'card', style: 'display:grid;gap:6px'});
  if (!S.length) { c.append(mk('b', null, 'Seleção'), mk('small', null, 'Nada selecionado. Clique em um texto, bloco, linha ou anotação. Delete exclui, Ctrl+C/V copia e cola qualquer elemento, setas deslocam, Ctrl+A seleciona tudo.')); return c; }
  if (S.length > 1) return pjCartaoMulti(c);
  const s = S[0], rot = (o, set) => fr('Rotação (°)', (() => { const i = pjNum(o.rot || 0, n => { set(n); pjDesenhar(); }, null, .5); i.id = 'prj-rot'; return i; })());
  const acoes = (rest) => mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, mk('button', {onclick: () => pjCopiar(), title: 'Ctrl+C'}, 'Copiar'), mk('button', {onclick: () => pjColar(), title: 'Ctrl+V'}, 'Colar'), mk('button', {onclick: () => pjDuplicar(), title: 'Ctrl+D'}, 'Duplicar'), mk('button', {onclick: pjExcluir}, 'Excluir'), rest ? mk('button', {onclick: pjRestaurar}, 'Restaurar original') : null);
  if (s.k === 'T') {
    const its = PJ.items.filter(i => i.k === 'T' && i.key === s.key).sort((a, b) => (a.e.gk ? a.e.gk.k : 0) - (b.e.gk ? b.e.gk.k : 0));
    if (!its.length) { c.append(mk('small', null, 'Elemento fora da tela.')); return c; }
    const ov = P.t[s.key] || {}, ef = its.map(i => projAplicaT(i)).filter(Boolean), o = () => P.t[s.key] || (P.t[s.key] = {});
    c.append(mk('b', null, its[0].e.gk ? 'Rótulo (' + its.length + ' linha' + (its.length > 1 ? 's' : '') + ')' : 'Texto'), mk('small', null, 'Camada ' + its[0].L + ' · duplo clique no mapa edita no próprio desenho'),
      mk('button', {class: 'p', onclick: () => pjEditarTexto(s)}, 'Editar texto no mapa (F2)'),
      fr('Altura (un. do desenho)', pjNum((ef[0] && ef[0].e.h) || its[0].e.h, n => { o().h = n; pjDesenhar(); }, .1, .1)),
      fr('Cor', pjCorIn(ov.cor || DXF.aciHex(ef[0] ? (ef[0].col != null ? ef[0].col : PJ.layers.get(its[0].L)) : 7), v => { o().cor = v; pjDesenhar(); })), rot(ov, n => { o().rot = n; }), acoes(true));
  } else if (s.k === 'I') {
    const it = PJ.items.find(i => i.k === 'I' && i.key === s.key); if (!it) { c.append(mk('small', null, 'Elemento fora da tela.')); return c; }
    const ov = P.i[s.key] || {}, o = () => P.i[s.key] || (P.i[s.key] = {});
    c.append(mk('b', null, 'Bloco'), mk('small', null, 'Original: ' + it.name + (ov.sub ? ' → ' + pjNomeLib(ov.sub) : '') + ' · camada ' + it.L));
    c.append(mk('div', null, mk('span', {style: 'color:var(--mut);font-size:12px'}, 'Substituir por'),
      pjSeletor(ov.sub || '', id => { pjSnap(); if (id) o().sub = id; else delete o().sub; salvar(); pjDesenhar(); }, {vazio: true})),
      fr('Escala (×)', pjNum(ov.esc || 1, n => { o().esc = n; pjDesenhar(); }, .05, .1)),
      fr('Cor', pjCorIn(ov.cor || DXF.aciHex(it.col != null ? it.col : PJ.layers.get(it.L)), v => { o().cor = v; pjDesenhar(); })), rot(ov, n => { o().rot = n; }), acoes(true));
  } else if (s.k === 'E') {
    const it = PJ.items.find(i => i.k === 'E' && i.key === s.key); if (!it) { c.append(mk('small', null, 'Elemento fora da tela.')); return c; }
    const e = it.e, ov = P.e[s.key] || {}, o = () => P.e[s.key] || (P.e[s.key] = {}), nomes = {LINE: 'Linha', PLINE: e.closed ? 'Polilinha fechada' : 'Polilinha', CIRCLE: 'Círculo', ARC: 'Arco'};
    c.append(mk('b', null, nomes[e.t] + (e.pts ? ' (' + e.pts.length + ' vértices)' : '')), mk('small', null, 'Camada ' + it.L + ' · arraste para mover; arraste os quadrados dos vértices para ajustar o traçado.'),
      fr('Cor', pjCorIn(ov.cor || DXF.aciHex(it.col != null ? it.col : PJ.layers.get(it.L)), v => { o().cor = v; pjDesenhar(); })));
    if (e.t === 'PLINE') c.append(fr('Espessura (un. do desenho)', pjNum(ov.w != null ? ov.w : (e.w || 0), n => { o().w = n; pjDesenhar(); }, 0, .05)));
    if (/^(LINE|PLINE|CIRCLE|ARC)$/.test(e.t)) c.append(...pjLtUI(() => ov.lt, v => { o().lt = v; }));
    c.append(mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, mk('button', {onclick: () => { pjSnap(); delete o().v; salvar(); pjDesenhar(); }}, 'Desfazer ajuste dos vértices')), acoes(true));
  } else {
    const ex = P.ex.find(x => x.id === s.id); if (!ex) return c;
    const nomes = {TEXT: 'Anotação de texto', LINE: 'Linha', PLINE: 'Polilinha', SETA: 'Seta', BLOCO: 'Bloco inserido'};
    c.append(mk('b', null, nomes[ex.t]), mk('small', null, 'Camada ' + san(P.camadaAnot || 'ANOTACOES')));
    if (ex.t === 'TEXT') c.append(mk('button', {class: 'p', onclick: () => pjEditarTexto(s)}, 'Editar texto no mapa (F2)'), fr('Altura (un. do desenho)', pjNum(ex.h, n => { ex.h = n; pjDesenhar(); }, .1, .1)));
    if (ex.t === 'BLOCO') c.append(mk('div', null, mk('span', {style: 'color:var(--mut);font-size:12px'}, 'Bloco'), pjSeletor(ex.lib, id => { pjSnap(); ex.lib = id; salvar(); pjDesenhar(); })), fr('Tamanho (un. do desenho)', pjNum(ex.tam || 3, n => { ex.tam = n; pjDesenhar(); }, .1, .1)));
    if (ex.t === 'SETA') c.append(fr('Ponta da seta', pjNum(ex.tam || 2, n => { ex.tam = n; pjDesenhar(); }, .2, .2)));
    c.append(fr('Cor', pjCorIn(ex.cor || '#ffffff', v => { ex.cor = v; pjDesenhar(); })));
    if (ex.t === 'LINE' || ex.t === 'PLINE') c.append(...pjLtUI(() => ex.lt, v => { ex.lt = v; }));
    if (ex.t === 'TEXT' || ex.t === 'BLOCO') c.append(rot(ex, n => { ex.rot = n; }));
    c.append(mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, mk('button', {onclick: () => pjCopiar(), title: 'Ctrl+C'}, 'Copiar'), mk('button', {onclick: () => pjColar(), title: 'Ctrl+V'}, 'Colar'), mk('button', {onclick: () => pjDuplicar(), title: 'Ctrl+D'}, 'Duplicar'), mk('button', {onclick: pjExcluir}, 'Excluir')));
  }
  return c;
}
function pjCartaoMulti(c) {
  const P = PRJ(), S = PJ.sels, n = k => S.filter(s => s.k === k).length;
  c.append(mk('b', null, S.length + ' elementos selecionados'), mk('small', null, [n('T') && n('T') + ' texto(s)/rótulo(s)', n('I') && n('I') + ' bloco(s)', n('E') && n('E') + ' linha(s)', n('X') && n('X') + ' anotação(ões)'].filter(Boolean).join(' · ')));
  const corSel = v => { for (const s of S) { if (s.k === 'X') pjOv(s, false).cor = v; else pjOv(s, true).cor = v; } pjDesenhar(); };
  const altSel = h => { for (const s of S) { if (s.k === 'T') pjOv(s, true).h = h; else if (s.k === 'X' && pjOv(s, false).t === 'TEXT') pjOv(s, false).h = h; } pjDesenhar(); };
  let ox = 0, oy = 0, ltM = null;
  const xi = pjNum(0, v => { ox = v; }, null, .1), yi = pjNum(0, v => { oy = v; }, null, .1);
  c.append(fr('Cor de todos', pjCorIn('#ffffff', v => { if (!c._s) { pjSnap(); c._s = true; } corSel(v); })), n('T') + n('X') ? fr('Altura dos textos', pjNum('', v => { if (!c._h) { pjSnap(); c._h = true; } altSel(v); }, .1, .1)) : null,
    ...(S.some(s => s.k === 'E' || (s.k === 'X' && /^(LINE|PLINE)$/.test(pjOv(s, false).t))) ? pjLtUI(() => ltM, v => { ltM = v; for (const s of S) { if (s.k === 'E') pjOv(s, true).lt = {...v}; else if (s.k === 'X' && /^(LINE|PLINE)$/.test(pjOv(s, false).t)) pjOv(s, false).lt = {...v}; } }) : []),
    mk('div', {style: 'display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:end'}, fr('Deslocar X (m)', xi), fr('Y (m)', yi),
      mk('button', {onclick: () => { pjSnap(); for (const s of S) pjMoveSel(s, pjBase(s), ox, oy); salvar(); xi.value = 0; yi.value = 0; ox = oy = 0; pjDesenhar(); }}, 'Aplicar')),
    mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, mk('button', {onclick: () => pjCopiar(), title: 'Ctrl+C'}, 'Copiar'), mk('button', {onclick: () => pjColar(), title: 'Ctrl+V'}, 'Colar'), mk('button', {onclick: () => pjDuplicar(), title: 'Ctrl+D'}, 'Duplicar'), mk('button', {onclick: pjExcluir}, 'Excluir'), mk('button', {onclick: pjRestaurar}, 'Restaurar originais'),
      mk('button', {onclick: () => { PJ.sels = []; pjPainel(); pjDesenhar(); }}, 'Limpar seleção')));
  return c;
}
async function pjImportar(files) {
  let n = 0;
  for (const f of files) {
    try { const imp = DXF.importar(DXF.parseAll(await f.text()), f.name); for (const [nome, bl] of Object.entries(imp)) { BLOCOS[nome] = bl; n++; } }
    catch (e) { alert('Não foi possível ler ' + f.name + ': ' + e.message); }
  }
  PJ.lib.clear(); salvar(); $('#st').textContent = n ? n + ' bloco(s) importado(s): já aparecem nas listas de blocos (use a pesquisa e a estrela para favoritar).' : 'Nenhum bloco encontrado no arquivo';
  pjPainel();
}
// ---------- painel único: Área → Projeto (Edição | Arruamento | Exportar) ----------
function prjUI() {
  const on = PJ.on, a = PJ.aba || 'edi';
  const cria = $('#pjcria'); if (cria) { cria.hidden = on || !SEL; cria.disabled = !!(SEL && SEL.dados === undefined); }
  $('#pjtabs').hidden = !on;
  for (const b of document.querySelectorAll('#pjtabs button')) b.classList.toggle('on', on && b.dataset.aba === a);
  $('#prjc').hidden = !on || a !== 'edi'; $('#arr').hidden = !on || a !== 'arr'; $('#pac').hidden = !on || a !== 'pac'; $('#prj').classList.toggle('prj-on', on);
  for (const id of ['#pjret', '#pjpol']) { const b = $(id); if (b) b.disabled = false; }
}
let pjAbaOcupada = false;
async function pjAba(nova) {
  if (!PJ.on || pjAbaOcupada || nova === PJ.aba) return;
  pjAbaOcupada = true;
  try {
    const ant = PJ.aba; pjFechaEditor(true);
    if (ant === 'arr') {   // volta ao projeto: recoloca o desenho e refaz o projeto com o arruamento ajustado
      try { edtDesligar(); } catch (e) {}
      for (let n = 0; n < 200 && (prevOcupada || (typeof PREV !== 'undefined' && PREV.calc === 'pendente')); n++) await new Promise(r => setTimeout(r, 100));
      EDT.fant.clearLayers(); EDT.vtx.clearLayers(); if (map.hasLayer(osmGrp)) map.removeLayer(osmGrp);
      PJ.pausa = false;
      if ((RP.R && RP.S === SEL && PJ.ruasR !== RP.R) || PJ.cfgIni !== JSON.stringify(CFG.dxf.ruasEdit || [])) { const s = PJ.sels; await projGerar(true); PJ.sels = []; }
    } else if (ant === 'pac') {
      if (PJ.cfgExp !== pjCfgExp()) { await projGerar(true); PJ.sels = []; }
    }
    PJ.aba = nova;
    if (nova === 'arr') {
      PJ.pausa = true; PJ.cfgIni = JSON.stringify(CFG.dxf.ruasEdit || []); PJ.sels = []; PJ.tmp = null; PJ.drag = null;
      if (!map.hasLayer(osmGrp)) map.addLayer(osmGrp);
      map.getContainer().style.cursor = ''; map.dragging.enable(); modoFim();
      abrirArr(); prjUI(); pjDesenhar();
      if (RP.R && RP.S === SEL) desenharRuas(); else await mostrarArruamento();
      $('#st').textContent = 'Arruamento: a edição do projeto fica em pausa. Ajuste as pistas e volte para "Edição" para ver o resultado.';
    } else if (nova === 'pac') { PJ.cfgExp = pjCfgExp(); pacotePainel(); abrirDxp(); }
    prjUI();
    if (nova !== 'arr') { pjPainel(); pjDesenhar(); }
  } finally { pjAbaOcupada = false; prjUI(); }
}
const pjCfgExp = () => { const {projeto, ruasEdit, ...r} = CFG.dxf; return JSON.stringify(r); };
// ---------- salvar / abrir projeto em arquivo (.ctweb.json): backup independente do navegador ----------
function pjArquivo() {
  const P = PRJ(), ids = new Set([...P.fav, ...P.ex.map(x => x.lib), ...Object.values(P.i).map(o => o.sub)].filter(i => typeof i === 'string' && i.startsWith('B:')));
  const blocos = {}; for (const i of ids) if (BLOCOS[i.slice(2)]) blocos[i.slice(2)] = BLOCOS[i.slice(2)];
  const area = SEL ? {b: [SEL.b.getSouth(), SEL.b.getWest(), SEL.b.getNorth(), SEL.b.getEast()], poly: SEL.poly ? SEL.poly.map(q => Array.isArray(q) ? [q[0], q[1]] : [q.lat, q.lng]) : null} : null;
  return {ctweb: 'projeto', neogrid: 1, versao: VERSAO, salvoEm: new Date().toISOString(), area, dxf: CFG.dxf, cam: CFG.cam, blocos, pacote: CFG.pacote};
}
function pjSalvarArquivo() {
  const o = pjArquivo(), d = new Date(), z = n => String(n).padStart(2, '0');
  const nome = 'projeto_' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '_' + z(d.getHours()) + z(d.getMinutes()) + '.neogrid-projeto.json';
  baixar(nome, JSON.stringify(o), 'application/json');
  $('#st').textContent = 'Projeto salvo em ' + nome + ' (' + pjNEd(o.dxf.projeto) + ' edição(ões), ' + (o.dxf.projeto.ex || []).length + ' anotação(ões)' + (o.area ? ', com a área' : ', sem área marcada') + ').';
}
async function pjAbrirArquivo(file) {
  let o; try { o = JSON.parse(await file.text()); } catch (e) { alert('Arquivo inválido: ' + e.message); return; }
  if (!o || o.ctweb !== 'projeto' || !o.dxf || !o.dxf.projeto) { alert('Este arquivo não é um projeto do NeoGrid nem do CTWeb.'); return; }
  if (projTemEdicao() && !confirm('Abrir este arquivo substitui as edições atuais do projeto. Continuar?')) return;
  if (PJ.on) projSair();
  const proj = o.dxf.projeto; CFG.dxf = Object.assign(CFG.dxf, o.dxf, {projeto: proj}); PRJ();
  if (o.cam && confirm('Aplicar também os estilos e rótulos salvos no arquivo? (Cancelar mantém os estilos atuais)')) CFG.cam = o.cam;
  for (const [n, b] of Object.entries(o.blocos || {})) BLOCOS[n] = b;
  PJ.lib.clear(); salvar();
  if (o.area) { const b = L.latLngBounds([o.area.b[0], o.area.b[1]], [o.area.b[2], o.area.b[3]]); map.fitBounds(b.pad(.05), {animate: false}); await selFim(b, o.area.poly ? o.area.poly.map(q => L.latLng(q[0], q[1])) : null); }
  $('#prj').hidden = false; prjUI();
  if (o.pacote) CFG.pacote = {...CFG.pacote, ...o.pacote};
  if (SEL && SEL.dados !== undefined) await projAbrir();
  $('#st').textContent = 'Projeto aberto de ' + file.name + (o.area ? '' : ' — o arquivo não tem área: marque a área e crie o projeto.');
}
let tProjSalvo = 0;
function projLigar() {
  $('#pjsalva').onclick = pjSalvarArquivo;
  $('#pjabre').onclick = () => $('#pjarq').click();
  $('#pjarq').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) pjAbrirArquivo(f); };
  for (const b of document.querySelectorAll('#pjtabs button')) b.onclick = () => pjAba(b.dataset.aba);
  map.on('popupopen', () => { if (PJ.on && !PJ.pausa) map.closePopup(); });   // parâmetros congelados no modo Projeto
  $('#prjx').onclick = () => { $('#prj').hidden = true; };
  new MutationObserver(() => { if ($('#prj').hidden && PJ.on) projSair(); }).observe($('#prj'), {attributes: true, attributeFilter: ['hidden']});
}
