/* Organizar e Anotar poste (origem: CTWeb). */
// =====================================================================================
// projorg.js — Projeto: ORGANIZAR (alinhar, distribuir, girar, mover, alinhar a uma linha)
// e ANOTAR POSTE (padrão do ANOTACAO_POSTE.lsp: MANTER / INSTALAR / REAPLICAR / REMOVER).
// Tudo trabalha em metros reais (como as anotações do projeto) e nunca altera os dados.
// =====================================================================================
PJ.orgOpt = PJ.orgOpt || {ref: 'caixa', piv: 'centro', ang: 90, gap: 0, mover: true, dist: 1, lado: 'auto', alinhaAng: true};
PJ.orgAcao = null;   // ferramenta de pontos: {acao: 'mover'|'girar'|'linha', pts: []}
PJ.ap = null;        // estado do "Anotar poste"

const orgRuas = () => { const c = CFG.dxf.camadas || {}; return [c.ruas, c.ruasOrig, c.txtRuas].filter(Boolean).map(san); };
function pjSelSoRuas() {   // a seleção é só de arruamento (pistas e nomes de rua)?
  if (!PJ.sels.length) return false;
  const R = orgRuas();
  return PJ.sels.every(s => { if (s.k !== 'E' && s.k !== 'T') return false; const it = PJ.items.find(i => i.k === s.k && i.key === s.key); return !!it && R.includes(it.L); });
}

// ---------- informações de um item selecionado ----------
const orgW = (X, Y) => pjMundo(X, Y, PJ.c);
function orgCaixa(s) {   // caixa do item em metros reais [x0,y0,x1,y1]
  const h = PJ.hit.find(q => sk(q.s) === sk(s)); if (!h) return null;
  const tr = pjTr(), a = pjMundoDePx(tr, h.bb[0], h.bb[1]), b = pjMundoDePx(tr, h.bb[2], h.bb[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
function orgVertices(s) {   // vértices efetivos (metros) de linhas/polilinhas; null para o resto
  const P = PRJ();
  if (s.k === 'E') {
    const it = PJ.items.find(i => i.k === 'E' && i.key === s.key), r = it && projAplicaE(it); if (!r) return null;
    const e = r.e; if (e.t === 'LINE') return [e.a, e.b].map(p => orgW(p[0], p[1])); if (e.t === 'PLINE') return e.pts.map(p => orgW(p[0], p[1])); return null;
  }
  if (s.k === 'X') { const ex = P.ex.find(x => x.id === s.id); return ex && ex.pts ? ex.pts.map(p => [p[0], p[1]]) : null; }
  return null;
}
function orgAncora(s) {   // {W: [x,y] metros, rot: graus, poly: bool}
  const P = PRJ(), ke = PJ.c.ke;
  if (s.k === 'T') {
    const its = PJ.items.filter(i => i.k === 'T' && i.key === s.key); if (!its.length) return null;
    const it = its[0], ov = P.t[s.key] || {}, A = it.e.gk ? [it.e.gk.x, it.e.gk.y] : it.e.p, dm = ov.dm || [0, 0];
    return {W: orgW(A[0] + dm[0] * ke, A[1] + dm[1] * ke), rot: (it.e.rot || 0) + (ov.rot || 0)};
  }
  if (s.k === 'I') { const it = PJ.items.find(i => i.k === 'I' && i.key === s.key), r = it && projAplicaI(it); return r ? {W: orgW(r.x, r.y), rot: r.rot || 0} : null; }
  const vs = orgVertices(s);
  if (vs && vs.length) return {W: [vs.reduce((a, p) => a + p[0], 0) / vs.length, vs.reduce((a, p) => a + p[1], 0) / vs.length], rot: 0, poly: true};
  if (s.k === 'E') {
    const it = PJ.items.find(i => i.k === 'E' && i.key === s.key), r = it && projAplicaE(it); if (!r || !r.e.p) return null;
    return {W: orgW(r.e.p[0], r.e.p[1]), rot: 0, poly: true, circ: true};
  }
  const ex = P.ex.find(x => x.id === s.id); return ex && ex.x != null ? {W: [ex.x, ex.y], rot: ex.rot || 0} : null;
}
const orgMover = (s, dx, dy) => pjMoveSel(s, pjBase(s), dx, dy);
function orgGirarEm(s, pv, deg) {   // gira o item em torno de pv (metros) — posição e rotação própria
  const a = deg * RAD, cs = Math.cos(a), sn = Math.sin(a), P = PRJ();
  const R = p => [pv[0] + (p[0] - pv[0]) * cs - (p[1] - pv[1]) * sn, pv[1] + (p[0] - pv[0]) * sn + (p[1] - pv[1]) * cs];
  const an = orgAncora(s); if (!an) return;
  if (an.poly) {
    const vs = orgVertices(s);
    if (s.k === 'X') { const ex = P.ex.find(x => x.id === s.id); ex.pts = ex.pts.map(p => { const q = R(p); return [q[0], q[1], ...p.slice(2)]; }); }
    else if (vs) { const o = pjOv(s, true); o.v = o.v || {}; vs.forEach((w, i) => { const q = R(w), v0 = o.v[i] || [0, 0]; o.v[i] = [v0[0] + q[0] - w[0], v0[1] + q[1] - w[1]]; }); }
    else { const q = R(an.W); orgMover(s, q[0] - an.W[0], q[1] - an.W[1]); }   // círculo/arco: só o centro
    return;
  }
  const q = R(an.W);
  if (s.k === 'X') { const ex = P.ex.find(x => x.id === s.id); ex.x = q[0]; ex.y = q[1]; ex.rot = (ex.rot || 0) + deg; return; }
  const o = pjOv(s, true), dm = o.dm || [0, 0]; o.dm = [dm[0] + q[0] - an.W[0], dm[1] + q[1] - an.W[1]]; o.rot = (o.rot || 0) + deg;
}
function orgUniao(cx) { let u = null; for (const c of cx) if (c) u = u ? [Math.min(u[0], c[0]), Math.min(u[1], c[1]), Math.max(u[2], c[2]), Math.max(u[3], c[3])] : [...c]; return u; }
function orgItens() {   // {s, bb} com caixa válida
  pjDesenhar();
  return PJ.sels.map(s => ({s, bb: orgCaixa(s)})).filter(q => q.bb);
}
const orgFim = msg => { salvar(); pjDesenhar(); pjPainel(); if (msg) $('#st').textContent = msg; };

// ---------- alinhar / distribuir ----------
function orgAlinhar(modo) {
  const it = orgItens(); if (it.length < 2) { $('#st').textContent = 'Selecione 2 ou mais elementos para alinhar.'; return; }
  const o = PJ.orgOpt, ref = o.ref === 'primeiro' ? it[0].bb : o.ref === 'ultimo' ? it[it.length - 1].bb : orgUniao(it.map(q => q.bb));
  pjSnap();
  for (const q of it) {
    const b = q.bb; let dx = 0, dy = 0;
    if (modo === 'esq') dx = ref[0] - b[0]; else if (modo === 'dir') dx = ref[2] - b[2]; else if (modo === 'cx') dx = (ref[0] + ref[2]) / 2 - (b[0] + b[2]) / 2;
    else if (modo === 'topo') dy = ref[3] - b[3]; else if (modo === 'base') dy = ref[1] - b[1]; else if (modo === 'cy') dy = (ref[1] + ref[3]) / 2 - (b[1] + b[3]) / 2;
    if (dx || dy) orgMover(q.s, dx, dy);
  }
  orgFim('Alinhados ' + it.length + ' elemento(s).');
}
function orgDistribuir(eixo) {
  const it = orgItens(); if (it.length < 3 && !PJ.orgOpt.gap) { $('#st').textContent = 'Para distribuir selecione 3 ou mais elementos (ou informe o espaçamento fixo).'; return; }
  const h = eixo === 'h', lo = b => h ? b[0] : b[1], hi = b => h ? b[2] : b[3];
  it.sort((a, b) => h ? lo(a.bb) - lo(b.bb) : hi(b.bb) - hi(a.bb));   // horizontal: esq→dir; vertical: de cima para baixo
  pjSnap();
  const soma = it.reduce((a, q) => a + (hi(q.bb) - lo(q.bb)), 0), gap = PJ.orgOpt.gap > 0 ? +PJ.orgOpt.gap : (h ? hi(it[it.length - 1].bb) - lo(it[0].bb) - soma : hi(it[0].bb) - lo(it[it.length - 1].bb) - soma) / (it.length - 1);
  let pos = h ? lo(it[0].bb) : hi(it[0].bb);
  for (const q of it) {
    const w = hi(q.bb) - lo(q.bb);
    if (h) { const d = pos - lo(q.bb); if (d) orgMover(q.s, d, 0); pos += w + gap; }
    else { const d = pos - hi(q.bb); if (d) orgMover(q.s, 0, d); pos -= w + gap; }
  }
  orgFim('Distribuídos ' + it.length + ' elementos' + (h ? ' na horizontal' : ' na vertical') + ' (espaço ' + gap.toFixed(2) + ' m).');
}

// ---------- girar / igualar rotação ----------
function orgGirar(deg, pv) {
  const it = orgItens(); if (!it.length) return;
  const o = PJ.orgOpt;
  if (!pv) {
    if (o.piv === 'primeiro') { const a = orgAncora(PJ.sels[0]); pv = a && a.W; }
    else if (o.piv === 'proprio') pv = null;
    else { const u = orgUniao(it.map(q => q.bb)); pv = u && [(u[0] + u[2]) / 2, (u[1] + u[3]) / 2]; }
  }
  pjSnap();
  for (const q of it) { const a = orgAncora(q.s); if (!a) continue; orgGirarEm(q.s, pv || a.W, deg); }
  orgFim('Seleção girada ' + deg + '°.');
}
function orgIgualarRot() {
  const base = orgAncora(PJ.sels[0]); if (!base || base.poly) { $('#st').textContent = 'O primeiro elemento precisa ser texto, bloco ou anotação de texto.'; return; }
  pjSnap();
  for (const s of PJ.sels.slice(1)) { const a = orgAncora(s); if (!a || a.poly) continue; const d = ((base.rot - a.rot) % 360 + 540) % 360 - 180; if (d) orgGirarEm(s, a.W, d); }
  orgFim('Rotação igualada à do primeiro elemento (' + (base.rot || 0).toFixed(1) + '°).');
}

// ---------- ferramenta de pontos: mover / girar em torno de um ponto / alinhar a uma linha ----------
const ORG_DICA = {
  mover: 'Mover: clique no ponto-base e depois no ponto de destino (Esc cancela)',
  girar: 'Girar: clique no ponto que será o centro da rotação (Esc cancela)',
  linha: 'Alinhar à linha: clique na linha ou polilinha de referência (Esc cancela)'};
function orgPonto(acao) {
  if (!PJ.sels.length) { $('#st').textContent = 'Selecione primeiro o que será ' + (acao === 'mover' ? 'movido' : acao === 'girar' ? 'girado' : 'alinhado') + '.'; return; }
  PJ.pan = false; PJ.tool = 'orgponto'; PJ.tmp = null; PJ.orgAcao = {acao, pts: [], sels: [...PJ.sels]};
  modoSet(ORG_DICA[acao]); map.getContainer().style.cursor = 'crosshair'; map.doubleClickZoom.disable(); pjPainel(); pjDesenhar();
}
function orgPontoFim() { PJ.orgAcao = null; PJ.tool = 'sel'; modoFim(); map.getContainer().style.cursor = ''; map.doubleClickZoom.enable(); }
function orgSegmentos(s) {
  const vs = orgVertices(s); if (!vs || vs.length < 2) return [];
  const out = []; for (let i = 1; i < vs.length; i++) out.push([vs[i - 1], vs[i]]);
  if (s.k === 'E') { const it = PJ.items.find(i => i.k === 'E' && i.key === s.key); if (it && it.e.closed) out.push([vs[vs.length - 1], vs[0]]); }
  else { const ex = PRJ().ex.find(x => x.id === s.id); if (ex && ex.closed) out.push([vs[vs.length - 1], vs[0]]); }
  return out;
}
function orgMaisPerto(segs, p) {
  let best = null;
  for (const [a, b] of segs) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-12, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)), f = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(p[0] - f[0], p[1] - f[1]);
    if (!best || d < best.d) best = {d, f, ux: dx / Math.sqrt(l2), uy: dy / Math.sqrt(l2), a, b};
  }
  return best;
}
function orgAlinharLinha(segs, sels) {
  const o = PJ.orgOpt, alvo = sels.filter(s => { const a = orgAncora(s); return a && !a.poly; });
  if (!alvo.length) { $('#st').textContent = 'A seleção não tem textos, blocos ou anotações de texto para alinhar.'; return; }
  pjSnap();
  for (const s of alvo) {
    const a = orgAncora(s), n = orgMaisPerto(segs, a.W); if (!n) continue;
    let ang = Math.atan2(n.uy, n.ux) / RAD; while (ang > 90) ang -= 180; while (ang <= -90) ang += 180;   // sempre legível
    const d = ((ang - a.rot) % 360 + 540) % 360 - 180; if (d) orgGirarEm(s, a.W, d);
  }
  if (o.mover) {
    pjDesenhar();
    const ke = PJ.c.ke, dist = (+o.dist || 0) / ke;
    for (const s of alvo) {
      const bb = orgCaixa(s); if (!bb) continue;
      const C = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], n = orgMaisPerto(segs, C); if (!n) continue;
      let ang = Math.atan2(n.uy, n.ux); if (ang > Math.PI / 2) ang -= Math.PI; if (ang <= -Math.PI / 2) ang += Math.PI;
      const nx = -Math.sin(ang), ny = Math.cos(ang);   // "para cima" do texto
      const lado = o.lado === 'acima' ? 1 : o.lado === 'abaixo' ? -1 : (((C[0] - n.f[0]) * nx + (C[1] - n.f[1]) * ny) >= 0 ? 1 : -1);
      orgMover(s, n.f[0] + lado * nx * dist - C[0], n.f[1] + lado * ny * dist - C[1]);
    }
  }
  orgFim(alvo.length + ' texto(s) alinhado(s) à linha' + (o.mover ? ' (a ' + o.dist + ' un. do desenho)' : '') + '.');
}
function pjOrgClique(e) {
  const A = PJ.orgAcao;
  if (PJ.tool === 'orgponto' && A) {
    const px = e.containerPoint.x, py = e.containerPoint.y, w = pjMundoDePx(pjTr(), px, py);
    if (A.acao === 'mover') {
      A.pts.push(w);
      if (A.pts.length === 2) { const d = [A.pts[1][0] - A.pts[0][0], A.pts[1][1] - A.pts[0][1]]; pjSnap(); for (const s of A.sels) orgMover(s, d[0], d[1]); orgPontoFim(); orgFim('Seleção movida.'); }
      else $('#st').textContent = 'Agora clique no ponto de destino.';
    } else if (A.acao === 'girar') {
      const deg = +PJ.orgOpt.ang || 0; orgPontoFim(); orgGirar(deg, w);
    } else if (A.acao === 'linha') {
      const hs = pjHitsEm(px, py).filter(h => (h.s.k === 'E' || h.s.k === 'X') && !A.sels.some(q => sk(q) === sk(h.s)) && orgSegmentos(h.s).length);
      if (!hs.length) { $('#st').textContent = 'Nenhuma linha ou polilinha ali: clique sobre a linha de referência.'; return true; }
      const segs = orgSegmentos(hs[0].s), sels = A.sels; orgPontoFim(); orgAlinharLinha(segs, sels);
    }
    return true;
  }
  if (PJ.tool === 'anota' && PJ.ap) { apClique(e); return true; }
  return false;
}

// ---------- cartão "Organizar" ----------
function pjOrgCartao() {
  if (!PJ.sels.length || pjSelSoRuas()) return mk('span');
  const o = PJ.orgOpt, n = PJ.sels.length;
  const btn = (t, f, tit) => mk('button', {onclick: f, title: tit || '', style: 'min-width:0'}, t);
  const sel = (v, opts, f) => { const s = mk('select', {style: 'width:100%'}, ...opts.map(([k, t]) => mk('option', {value: k}, t))); s.value = v; s.onchange = () => f(s.value); return s; };
  const grade = (...b) => mk('div', {style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px'}, ...b);
  const corpo = [];
  if (n >= 2) {
    corpo.push(mk('b', null, 'Alinhar'), grade(btn('⇤ Esquerda', () => orgAlinhar('esq')), btn('↔ Centro', () => orgAlinhar('cx')), btn('⇥ Direita', () => orgAlinhar('dir')),
      btn('⤒ Topo', () => orgAlinhar('topo')), btn('↕ Meio', () => orgAlinhar('cy')), btn('⤓ Base', () => orgAlinhar('base'))),
      fr('Em relação a', sel(o.ref, [['caixa', 'Caixa da seleção'], ['primeiro', 'Primeiro selecionado'], ['ultimo', 'Último selecionado']], v => { o.ref = v; })),
      mk('b', null, 'Distribuir'), mk('div', {style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px'}, btn('⇔ Horizontal', () => orgDistribuir('h'), 'Espaços iguais entre os elementos, da esquerda para a direita'), btn('⇕ Vertical', () => orgDistribuir('v'), 'Espaços iguais entre os elementos, de cima para baixo (justificar)')),
      fr('Espaçamento fixo (m, 0 = automático)', pjNum(o.gap || 0, v => { o.gap = v; }, 0, .1)));
  }
  corpo.push(mk('b', null, 'Girar'),
    fr('Ângulo (°, + anti-horário)', pjNum(o.ang, v => { o.ang = v; }, null, 1)),
    fr('Em torno de', sel(o.piv, [['centro', 'Centro da seleção'], ['primeiro', 'Primeiro selecionado'], ['proprio', 'De cada um (no lugar)'], ['ponto', 'Ponto clicado…']], v => { o.piv = v; })),
    mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, btn('Girar', () => { if (o.piv === 'ponto') orgPonto('girar'); else orgGirar(+o.ang || 0); }), btn('+90°', () => { o.ang = 90; pjPainel(); }), btn('−90°', () => { o.ang = -90; pjPainel(); }),
      n >= 2 ? btn('Igualar rotação', orgIgualarRot, 'Todos ficam com a rotação do primeiro selecionado') : ''),
    mk('b', null, 'Mover'), mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, btn('Mover por pontos…', () => orgPonto('mover'), 'Clique no ponto-base e no destino'), mk('small', null, 'ou setas do teclado (Shift = 5 m); Deslocar X/Y logo acima.')),
    mk('b', null, 'Alinhar texto a uma linha'),
    mk('label', {style: 'display:flex;gap:5px;align-items:center'}, mk('input', {type: 'checkbox', checked: !!o.mover, onchange: e => { o.mover = e.target.checked; pjPainel(); }}), 'Levar o texto até a linha (senão só gira)'),
    o.mover ? mk('div', {style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px'}, fr('Distância (un. do desenho)', pjNum(o.dist, v => { o.dist = v; }, 0, .1)), fr('Lado', sel(o.lado, [['auto', 'Onde está'], ['acima', 'Acima'], ['abaixo', 'Abaixo']], v => { o.lado = v; }))) : '',
    btn('Escolher a linha de referência…', () => orgPonto('linha'), 'Selecione os textos e depois clique na linha/polilinha: eles giram para ficar paralelos (sempre legíveis)'));
  return pjDet('Organizar (' + n + ')', true, ...corpo);
}

// ---------- barra de ferramentas agrupada ----------
function pjOrgFerramentas() {
  const cf = CFG.dxf;
  const ativo = k => k === 'pan' ? PJ.pan : k === 'sel' ? (PJ.tool === 'sel' && !PJ.pan) : PJ.tool === k;
  const b = (k, t, tit) => mk('button', {class: ativo(k) ? 'p' : '', title: tit || '', onclick: () => k === 'sel' ? (PJ.pan ? pjFerr('pan') : PJ.tool !== 'sel' && (PJ.tool === 'orgponto' ? orgPontoFim() : pjFerr(PJ.tool))) : pjFerr(k)}, t);
  const lin = (tit, ...bs) => mk('div', {style: 'display:grid;gap:4px'}, mk('small', null, tit), mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, ...bs));
  const fer = mk('div', {class: 'card', style: 'display:grid;gap:8px'}, mk('b', null, 'Ferramentas'),
    lin('Navegar', b('sel', 'Selecionar'), b('pan', 'Mover o mapa', 'Também: segure Espaço ou use o botão do meio do mouse')),
    lin('Desenhar', b('texto', '+ Texto'), b('linha', '+ Linha'), b('pline', '+ Polilinha'), b('seta', '+ Seta'), b('bloco', '+ Bloco')),
    lin('Postes', b('anota', 'Anotar poste', 'Monta a anotação do poste (manter / instalar / reaplicar / remover) como no ANOTAPOSTE')));
  if (PJ.tool === 'bloco') {
    if (!PJ.libNovo) PJ.libNovo = 'F:circ';
    fer.append(pjSeletor(PJ.libNovo, id => { PJ.libNovo = id; }), fr('Tamanho (un. do desenho)', pjNum(PJ.tamNovo || 3, n => { PJ.tamNovo = n; }, .1)));
  }
  const fi = mk('input', {type: 'file', accept: '.dxf', multiple: true, hidden: true, onchange: ev => pjImportar([...ev.target.files])});
  fer.append(lin('Edição', mk('button', {onclick: pjDesfazer, title: 'Ctrl+Z'}, 'Desfazer'), mk('button', {onclick: pjRefazer, title: 'Ctrl+Y'}, 'Refazer'),
    mk('button', {onclick: pjAjustarEscala, title: 'Aproxima o mapa até a escala do desenho (1:' + (+cf.escala || 1000) + ')'}, 'Zoom na escala')),
    mk('small', null, 'Clique seleciona (Ctrl soma); arrastar para a direita pega o que está dentro, para a esquerda tudo o que toca; duplo clique edita o texto; Espaço arrasta o mapa.'));
  return fer;
}

// ---------- cartão exclusivo do arruamento ----------
function pjCartaoRuas() {
  const P = PRJ(), S = PJ.sels, c = mk('div', {class: 'card', style: 'display:grid;gap:6px'});
  const itens = S.map(s => PJ.items.find(i => i.k === s.k && i.key === s.key)).filter(Boolean), so = itens.filter(i => i.k === 'E');
  c.append(mk('b', null, 'Arruamento' + (S.length > 1 ? ' (' + S.length + ')' : '')), mk('small', null, 'Camada ' + [...new Set(itens.map(i => i.L))].join(', ') + ' · arraste para mover; arraste os quadrados dos vértices para ajustar o traçado.'));
  const ov0 = P.e[S[0].key] || {}, mexe = f => { for (const s of S) f(pjOv(s, true), s); pjDesenhar(); };
  if (so.length) {
    c.append(fr('Cor', pjCorIn(ov0.cor || DXF.aciHex(so[0].col != null ? so[0].col : PJ.layers.get(so[0].L)), v => mexe(o => { o.cor = v; }))));
    if (so.every(i => i.e.t === 'PLINE')) c.append(fr('Espessura (un. do desenho)', pjNum(ov0.w != null ? ov0.w : (so[0].e.w || 0), n => mexe(o => { o.w = n; }), 0, .05)));
    c.append(...pjLtUI(() => ov0.lt, v => mexe(o => { o.lt = {...v}; })));
  }
  c.append(mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, mk('button', {class: 'p', onclick: () => pjAba('arr'), title: 'Abre a aba Arruamento: pistas, ajuste fino, opções e prévia'}, 'Ajustar o arruamento…'),
    mk('button', {onclick: () => { pjSnap(); for (const s of S) { const o = P.e[s.key]; if (o) delete o.v; } salvar(); pjDesenhar(); }}, 'Desfazer ajuste dos vértices'),
    mk('button', {onclick: pjRestaurar}, 'Restaurar original'), mk('button', {onclick: pjExcluir}, 'Excluir'), mk('button', {onclick: () => { PJ.sels = []; pjPainel(); pjDesenhar(); }}, 'Limpar seleção')));
  return c;
}

// =====================================================================================
// ANOTAR POSTE
// =====================================================================================
const AP_MODOS = [['m', 'Manter'], ['i', 'Instalar'], ['a', 'Reaplicar'], ['r', 'Remover']];
function apLarg(s, h) {   // largura aproximada do texto (un. do desenho)
  try {
    const g = (apLarg.c || (apLarg.c = document.createElement('canvas'))).getContext('2d');
    if (g && g.measureText) { g.font = '100px Arial'; const w = g.measureText(String(s)).width; if (w > 0) return 1.03 * w * (h * pjFonteK()) / 100; }
  } catch (e) { /* sem canvas */ }
  return 1.03 * String(s).length * h * .6;
}
function pjOrgFerr(t) { if (t === 'anota') { if (PJ.tool === 'anota') { pjOrgCancela(); PJ.tool = 'sel'; modoFim(); map.getContainer().style.cursor = ''; map.doubleClickZoom.enable(); pjPainel(); pjDesenhar(); return true; } apIniciar(); return true; } return false; }
function pjOrgCancela() { PJ.ap = null; if (PJ.orgAcao) PJ.orgAcao = null; }
function apIniciar() {
  PJ.pan = false; PJ.tmp = null; PJ.tool = 'anota'; PJ.orgAcao = null; PJ.ap = {passo: 1, base: null, src: null, campos: [], h: 1.3, alinhar: false};
  modoSet('Anotar poste · 1) clique no poste (bloco, círculo, linha...) ou no ponto do poste (Esc cancela)'); map.getContainer().style.cursor = 'crosshair'; map.doubleClickZoom.disable();
  pjPainel(); pjDesenhar();
}
function apBase(hs, w) {   // elemento-base do clique: centro, raio (m) e ângulo (graus, ou null)
  const ke = PJ.c.ke, pick = hs.find(h => h.s.k === 'I') || hs.find(h => h.s.k === 'E') || hs.find(h => h.s.k === 'X') || hs[0];
  const b = {c: w, r: 0, ang: null, desc: 'ponto clicado'};
  if (!pick) return b;
  const s = pick.s;
  if (s.k === 'I') {
    const it = PJ.items.find(i => i.k === 'I' && i.key === s.key), r = it && projAplicaI(it);
    if (r) { const def = pjDef(r.name), ext = def && def.ents ? pjExt(def.ents) * (r.sx || 1) : 0; b.c = orgW(r.x, r.y); b.r = ext / 2 / ke; b.ang = r.rot || 0; b.desc = 'bloco ' + r.name; }
  } else if (s.k === 'E' || s.k === 'X') {
    let ent = null;
    if (s.k === 'E') { const it = PJ.items.find(i => i.k === 'E' && i.key === s.key), r = it && projAplicaE(it); ent = r && r.e; }
    const segs = orgSegmentos(s);
    if (ent && (ent.t === 'CIRCLE' || ent.t === 'ARC')) { b.c = orgW(ent.p[0], ent.p[1]); b.r = ent.r / ke; b.desc = 'círculo'; }
    else if (segs.length) { const n = orgMaisPerto(segs, w); if (n) { b.ang = Math.atan2(n.uy, n.ux) / RAD; b.desc = 'linha (ângulo ' + (((b.ang % 180) + 180) % 180).toFixed(1) + '°)'; } }
    else if (s.k === 'X') { const ex = PRJ().ex.find(x => x.id === s.id); if (ex && ex.x != null) { b.c = [ex.x, ex.y]; b.ang = ex.rot || 0; b.desc = ex.t === 'BLOCO' ? 'bloco inserido' : 'texto'; } }
  } else if (s.k === 'T') { const bb = orgCaixa(s), a = orgAncora(s); if (bb) b.c = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]; if (a) b.ang = a.rot; b.desc = 'texto'; }
  return b;
}
function apFonte(h) {   // texto a anotar (T ou anotação de texto)
  const P = PRJ();
  if (h.s.k === 'T') {
    const its = PJ.items.filter(i => i.k === 'T' && i.key === h.s.key).sort((a, b) => (a.e.gk ? a.e.gk.k : 0) - (b.e.gk ? b.e.gk.k : 0)); if (!its.length) return null;
    const ef = projAplicaT(its[0]), linhas = its.map(i => { const v = P.s[pjChaveS(i)]; return v != null ? v : i.e.s; }).join('\n').split('\n');
    return {tipo: 'T', key: h.s.key, lines: linhas, h: ef ? ef.e.h : its[0].e.h, lay: its[0].L};
  }
  if (h.s.k === 'X') { const ex = P.ex.find(x => x.id === h.s.id); if (ex && ex.t === 'TEXT') return {tipo: 'X', id: ex.id, lines: String(ex.s).split('\n'), h: ex.h, lay: ex.lay || san(P.camadaAnot || 'ANOTACOES')}; }
  return null;
}
function apAbreTela(src) {
  const ap = PJ.ap; ap.src = src; ap.h = src.h || 1.3;
  ap.campos = src.lines.map(l => l.trim()).map((t, i) => ({ln: i, txt: t.toUpperCase(), modo: 'm'})).filter(c => c.txt !== '');
  if (!ap.campos.length) ap.campos = [{ln: 0, txt: '', modo: 'm'}];
  ap.alinhar = ap.base && ap.base.ang != null && ap.alinhar; ap.passo = 2.5;
  modoSet('Anotar poste · 2) defina as palavras no painel e confirme'); map.getContainer().style.cursor = ''; pjPainel();
}
function apClique(e) {
  const ap = PJ.ap, px = e.containerPoint.x, py = e.containerPoint.y, w = pjMundoDePx(pjTr(), px, py);
  if (ap.passo === 1) {
    ap.base = apBase(pjHitsEm(px, py), w); ap.passo = 2;
    modoSet('Anotar poste · 2) clique no texto a anotar (ou "Texto novo" no painel)'); $('#st').textContent = 'Poste: ' + ap.base.desc + '. Agora clique no texto a anotar.'; pjPainel(); pjDesenhar();
  } else if (ap.passo === 2) {
    const h = pjHitsEm(px, py).find(q => q.s.k === 'T' || (q.s.k === 'X' && (PRJ().ex.find(x => x.id === q.s.id) || {}).t === 'TEXT'));
    if (!h) { $('#st').textContent = 'Clique sobre um texto (ou use "Texto novo").'; return; }
    const src = apFonte(h); if (!src) return; apAbreTela(src);
  } else if (ap.passo === 3) {
    apCria(w);
  }
}
function pjOrgMouse(e) {
  const ap = PJ.ap; if (!ap || ap.passo !== 3 || PJ.tool !== 'anota') return;
  ap.prev = apGerar(ap, pjMundoDePx(pjTr(), e.containerPoint.x, e.containerPoint.y)); pjDesenhar();
}
function pjOrgDesenha(g, tr) {
  const ap = PJ.ap; if (!ap || ap.passo !== 3 || !ap.prev) return;
  g.save(); g.globalAlpha = .75;
  for (const x of ap.prev) {
    const hx = x.cor || (PRJ().fundo === 'branco' ? '#000000' : '#ffffff');
    if (x.t === 'TEXT') { const w = pjDxf(x.x, x.y, PJ.c); pjTexto(g, tr, {p: w, h: x.h, s: x.s || ' ', rot: x.rot || 0, hj: 0, ls: x.ls}, hx); }
    else pjEnt(g, tr, {t: 'PLINE', pts: x.pts.map(q => { const w = pjDxf(q[0], q[1], PJ.c); return [w[0], w[1], q[2] || 0]; }), closed: !!x.closed}, hx, 1.5);
  }
  g.restore();
}

// ---------- geometria do conjunto (porte do ap:gerar) ----------
function apLinhas(ap, modo) {
  const nl = Math.max(0, ...ap.campos.map(c => c.ln)) + 1, out = [];
  for (let k = 0; k < nl; k++) { const p = ap.campos.filter(c => c.ln === k && c.modo === modo && c.txt !== '').map(c => c.txt); if (p.length) out.push(p.join(' ')); }
  return out;
}
function apGerar(ap, w) {
  const ke = PJ.c.ke, h = +ap.h || 1.3, LS = 1.667, lm = apLinhas(ap, 'm'), li = apLinhas(ap, 'i'), la = apLinhas(ap, 'a'), lr = apLinhas(ap, 'r');
  if (!(lm.length || li.length || la.length || lr.length)) return [];
  const pady = .25 * h, padh = .5 * h, padx = .2 * h, e = .4 * h, ulin = .35 * h, c = 1.8 * h, k90 = Math.tan(Math.PI / 8);
  const hh = n => n ? h + (n - 1) * LS * h : 0, wd = L => L.length ? Math.max(...L.map(s => apLarg(s, h))) : 0;
  const wM = wd(lm), wI = wd(li), wA = wd(la), wR = wd(lr), hhM = hh(lm.length), hhI = hh(li.length), hhA = hh(la.length), hhR = hh(lr.length);
  const lyrBase = (ap.src && ap.src.lay && ap.src.lay !== 'ANOTACOES') ? san(ap.src.lay) : (PJ.layers.has('TXT_EXISTENTE') ? 'TXT_EXISTENTE' : '0');
  const lyrX = PJ.layers.has('TXT_EXISTENTE') ? 'TXT_EXISTENTE' : '0';
  const bl = []; let topH = 0, botH = 0, hP = 0;
  if (lm.length) bl.push({id: 'M', H: hhM + (lm.length === 1 ? ulin : 0), dT: h / 2, dB: h / 2 + (lm.length === 1 ? ulin : 0)});
  if (la.length) { topH = (li.length ? hhI : h) + 2 * pady; botH = hhA + 2 * pady; hP = topH + botH; } else if (li.length) hP = hhI + 2 * pady;
  if (hP) bl.push({id: 'P', H: hP, dT: pady + h / 2, dB: pady + h / 2});
  if (la.length) bl.push({id: 'A', H: hhA + 2 * padx, dT: padx + h / 2, dB: padx + h / 2});
  if (lr.length) bl.push({id: 'R', H: hhR + 2 * padx, dT: padx + h / 2, dB: padx + h / 2});
  const gl = []; for (let i = 0; i + 1 < bl.length; i++) gl.push(Math.max(.25 * h, c - bl[i].dB - bl[i + 1].dT));
  const tot = bl.reduce((a, b) => a + b.H, 0) + gl.reduce((a, b) => a + b, 0), wmax = Math.max(wI, wA);
  const xleft = -Math.max(lm.length ? wM + 2 * e : 0, hP ? wmax + 2 * padh : 0, la.length ? wA + 2 * padx : 0, lr.length ? wR + 2 * padx : 0) / 2;
  let ycur = tot / 2, gi = 0;
  const L = [], cand = [], box = [];   // peças locais (un. do desenho, y para cima)
  const txt = (lines, left, centroY, hhT, lay, cor) => L.push({t: 'TEXT', x: left, y: centroY + hhT / 2 - h / 2, s: lines.join('\n'), h, ls: LS, rot: 0, hj: 0, lay, cor: cor || ''});
  const lin = (pts, lay, cor, fech) => L.push({t: 'PLINE', pts, closed: !!fech, lay, cor: cor || ''});
  const Xmk = (x0, y0, x1, y1, lay) => { lin([[x0, y0, 0], [x1, y1, 0]], lay, '#ff0000'); lin([[x0, y1, 0], [x1, y0, 0]], lay, '#ff0000'); cand.push([x0, y0], [x1, y1], [x0, y1], [x1, y0]); box.push([x0, y0, x1, y1]); };
  for (const b of bl) {
    if (b.id === 'M') {
      const tcy = ycur - hhM / 2, left = xleft + e; txt(lm, left, tcy, hhM, lyrBase);
      const ymax = ycur, ymin = ycur - hhM, n = lm.length; let yl;
      if (n === 1) yl = ymin - .3 * h;
      else { const pitch = LS * h; if (n % 2 === 0) yl = (ymin + ymax) / 2; else { const kk = Math.floor(n / 2); yl = ymax - kk * pitch + (pitch - h) / 2; } }
      const x0 = left - e, x1 = left + wM + e; lin([[x0, yl, 0], [x1, yl, 0]], lyrBase, ''); cand.push([x0, yl], [x1, yl]);
    } else if (b.id === 'P') {
      const y1 = ycur, y0 = ycur - hP, x0 = xleft, xl = xleft + padh, x1 = xl + wmax + padh;
      if (la.length) { if (li.length) txt(li, xl, y1 - topH / 2, hhI, '01_INSTALANDO'); txt(la, xl, y0 + botH / 2, hhA, '01_REAPLICANDO'); } else txt(li, xl, y1 - hP / 2, hhI, '01_INSTALANDO');
      const r = Math.min(.5 * h, .2 * hP);
      lin([[x0 + r, y0, 0], [x1 - r, y0, k90], [x1, y0 + r, 0], [x1, y1 - r, k90], [x1 - r, y1, 0], [x0 + r, y1, k90], [x0, y1 - r, 0], [x0, y0 + r, k90]], '01_INSTALANDO', '', true);
      if (la.length) lin([[x0, y1 - topH, 0], [x1, y1 - topH, 0]], '01_INSTALANDO', '');
      box.push([x0, y0, x1, y1]);
    } else if (b.id === 'A' || b.id === 'R') {
      const A = b.id === 'A', lines = A ? la : lr, hT = A ? hhA : hhR, wT = A ? wA : wR, ycb = ycur - b.H / 2, left = xleft + padx;
      txt(lines, left, ycb, hT, A ? lyrX : '01_REMOVER', '#9b9b9b');
      Xmk(left - padx, ycb - hT / 2 - padx, left + wT + padx, ycb + hT / 2 + padx, A ? lyrX : '01_REMOVER');
    }
    ycur -= b.H + (gi < gl.length ? gl[gi] : 0); gi++;
  }
  // ângulo do conjunto
  let ang = 0; if (ap.alinhar && ap.base && ap.base.ang != null) { ang = ap.base.ang; while (ang > 90) ang -= 180; while (ang <= -90) ang += 180; }
  const cs = Math.cos(ang * RAD), sn = Math.sin(ang * RAD), loc2w = (x, y) => [w[0] + (cs * x - sn * y) / ke, w[1] + (sn * x + cs * y) / ke];
  // guia única: do ponto do conjunto mais próximo do poste até a borda do poste
  const bs = ap.base || {c: w, r: 0}, dx = (bs.c[0] - w[0]) * ke, dy = (bs.c[1] - w[1]) * ke, pl = [cs * dx + sn * dy, -sn * dx + cs * dy];
  for (const b of box) cand.push([Math.max(b[0], Math.min(b[2], pl[0])), Math.max(b[1], Math.min(b[3], pl[1]))]);
  let best = null; for (const q of cand) { const d = Math.hypot(q[0] - pl[0], q[1] - pl[1]); if (!best || d < best.d) best = {d, q}; }
  if (best && best.d > 1e-6) {
    const ux = (best.q[0] - pl[0]) / best.d, uy = (best.q[1] - pl[1]) / best.d, rr = (bs.r || 0) * ke;
    if (best.d > rr + 1e-6) L.push({t: 'PLINE', pts: [[best.q[0], best.q[1], 0], [pl[0] + ux * rr, pl[1] + uy * rr, 0]], closed: false, lay: lyrBase, cor: ''});
  }
  return L.map(x => {
    if (x.t === 'TEXT') { const p = loc2w(x.x, x.y); return {...x, x: p[0], y: p[1], rot: ang}; }
    return {...x, pts: x.pts.map(q => [...loc2w(q[0], q[1]), q[2] || 0].slice(0, q[2] ? 3 : 2))};
  });
}
function apCria(w) {
  const ap = PJ.ap, P = PRJ(), pcs = apGerar(ap, w); if (!pcs.length) { $('#st').textContent = 'Nenhuma palavra para criar.'; return; }
  pjSnap(); const g = 'g' + pjNovoId(), novos = [];
  for (const x of pcs) { const o = {...x, id: pjNovoId(), grp: g}; if (o.t === 'PLINE') o.pts = o.pts.map(q => q.length === 2 ? [q[0], q[1]] : q); novos.push(o); }
  P.ex.push(...novos);
  const s = ap.src;   // o texto original é substituído (como no LISP)
  if (s && s.tipo === 'T') (P.t[s.key] = P.t[s.key] || {}).del = true;
  else if (s && s.tipo === 'X') P.ex = P.ex.filter(x => x.id !== s.id);
  PJ.ap = null; PJ.tool = 'sel'; modoFim(); map.getContainer().style.cursor = ''; map.doubleClickZoom.enable();
  PJ.sels = novos.map(o => ({k: 'X', id: o.id})); salvar(); pjPainel(); pjDesenhar();
  $('#st').textContent = 'Anotação do poste criada (' + novos.length + ' peças agrupadas: arraste, gire ou apague o conjunto).';
}

// ---------- tela de campos (como a tela ALTERAR TEXTO do LISP) ----------
function apTela() {
  const ap = PJ.ap, c = mk('div', {class: 'card', style: 'display:grid;gap:7px'});
  const re = () => pjPainel();
  c.append(mk('b', null, 'Anotação do poste'), mk('small', null, 'Poste: ' + (ap.base ? ap.base.desc : '—') + '. L = número da linha. Enter no campo cria um novo logo abaixo, em nova linha.'));
  c.append(mk('div', {style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px'}, ...AP_MODOS.map(([k, n]) => mk('button', {style: 'min-width:0;padding:4px 2px;font-size:11px', title: 'Todos os campos em ' + n, onclick: () => { ap.campos.forEach(q => { q.modo = k; }); re(); }}, 'Todos ' + n.toLowerCase()))));
  ap.campos.forEach((q, i) => {
    const ln = mk('input', {type: 'number', value: q.ln + 1, min: 1, max: 99, style: 'width:100%', title: 'Linha', oninput: e => { q.ln = Math.max(0, (parseInt(e.target.value) || 1) - 1); }, onchange: () => { re(); }});
    const tx = mk('input', {type: 'text', value: q.txt, 'data-apf': i, style: 'width:100%', oninput: e => { q.txt = e.target.value.toUpperCase(); },
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (q.txt.trim() !== '') { ap.campos.splice(i + 1, 0, {ln: q.ln + 1, txt: '', modo: q.modo}); ap.foco = i + 1; re(); } } e.stopPropagation(); }});
    const sm = mk('select', {style: 'width:100%'}, ...AP_MODOS.map(([k, n]) => mk('option', {value: k}, n))); sm.value = q.modo; sm.onchange = () => { q.modo = sm.value; re(); };
    c.append(mk('div', {style: 'display:grid;grid-template-columns:44px 1fr 92px 26px;gap:4px;align-items:center'}, ln, tx, sm,
      mk('button', {title: 'Remover campo', style: 'min-width:0;padding:2px', onclick: () => { ap.campos.splice(i, 1); if (!ap.campos.length) ap.campos.push({ln: 0, txt: '', modo: 'm'}); re(); }}, '×')));
  });
  c.append(mk('div', {style: 'display:flex;gap:6px'}, mk('button', {onclick: () => { const u = ap.campos[ap.campos.length - 1]; ap.campos.push({ln: u ? u.ln : 0, txt: '', modo: 'm'}); ap.foco = ap.campos.length - 1; re(); }}, '+ Novo campo'),
    mk('button', {onclick: () => { const u = ap.campos[ap.campos.length - 1]; ap.campos.push({ln: (u ? u.ln : 0) + 1, txt: '', modo: 'm'}); ap.foco = ap.campos.length - 1; re(); }}, '+ Nova linha')));
  const res = AP_MODOS.map(([k, n]) => { const l = apLinhas(ap, k); return l.length ? n + ': ' + l.join(' / ') : ''; }).filter(Boolean);
  c.append(mk('small', null, res.length ? res.join('  ·  ') : 'Sem palavras ainda.'));
  const ha = ap.base && ap.base.ang != null;
  c.append(fr('Altura do texto (un. do desenho)', pjNum(ap.h, v => { ap.h = v; }, .1, .1)),
    mk('label', {style: 'display:flex;gap:5px;align-items:center;' + (ha ? '' : 'opacity:.5')}, mk('input', {type: 'checkbox', checked: !!ap.alinhar, disabled: !ha, onchange: e => { ap.alinhar = e.target.checked; }}), 'Alinhar ao ângulo do elemento' + (ha ? '' : ' (o elemento-base não tem ângulo)')));
  c.append(mk('div', {style: 'display:flex;gap:6px'}, mk('button', {class: 'p', onclick: () => {
      if (!apLinhas(ap, 'm').length && !apLinhas(ap, 'i').length && !apLinhas(ap, 'a').length && !apLinhas(ap, 'r').length) { $('#st').textContent = 'Digite ao menos uma palavra.'; return; }
      ap.passo = 3; ap.prev = null; modoSet('Anotar poste · 3) clique no local da anotação (a sombra mostra o resultado; Esc cancela)'); map.getContainer().style.cursor = 'crosshair'; pjPainel(); pjDesenhar(); }}, 'OK — indicar o local'),
    mk('button', {onclick: () => { pjOrgFerr('anota'); }}, 'Cancelar')));
  return c;
}
function apCartaoPassos() {
  const ap = PJ.ap, c = mk('div', {class: 'card', style: 'display:grid;gap:6px'});
  const t = {1: '1) Clique no poste: bloco, círculo, linha/polilinha (dá o ângulo) ou o ponto do poste.', 2: '2) Clique no texto a anotar (texto do projeto ou rótulo).', 3: '3) Clique no local da anotação. A sombra mostra o conjunto.'}[ap.passo];
  c.append(mk('b', null, 'Anotar poste'), mk('small', null, t));
  if (ap.base) c.append(mk('small', null, 'Poste: ' + ap.base.desc));
  const bs = [];
  if (ap.passo === 2) bs.push(mk('button', {class: 'p', onclick: () => apAbreTela({tipo: 'N', lines: [''], h: 1.3, lay: null})}, 'Texto novo (digitar)'));
  bs.push(mk('button', {onclick: () => pjOrgFerr('anota')}, 'Cancelar'));
  c.append(mk('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, ...bs));
  return c;
}
