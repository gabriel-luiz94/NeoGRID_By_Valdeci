/* Pacote de Projeto: reúne, a partir do projeto aberto, DXF, prancha PDF vetorial,
   quantitativo, dados da área, GeoJSON, arquivo do projeto e resumo em um único entregável. */

const PACOTE_PADRAO = () => ({
  nome: '', cliente: '', responsavel: '', registro: '', observacoes: '',
  itens: {dxf: true, pdf: true, quant: true, dados: true, geojson: true, projeto: true, resumo: true},
  folha: 'A3', orient: 'l', ajuste: 'escala', pb: false, saida: 'zip',
});
const FOLHAS_PDF = {A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841]};
const PT_MM = 72 / 25.4;

// ---------------- PDF: contexto com a mesma interface usada pelo desenho em canvas ----------------
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const larguraHelv = (s, tam) => { let w = 0; for (const ch of String(s)) { const c = ch.codePointAt(0); w += c >= 32 && c <= 126 ? HELV[c - 32] : 556; } return w * tam / 1000; };
const nf = v => { const s = (Math.round(v * 100) / 100).toString(); return s === '-0' ? '0' : s; };
// Fontes PDF padrão usam WinAnsi: acentos do português entram direto; o restante vira "?".
const WIN_EXTRA = {'€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135, 'ˆ': 136, '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140, 'Ž': 142, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '˜': 152, '™': 153, 'š': 154, '›': 155, 'œ': 156, 'ž': 158, 'Ÿ': 159};
function textoPdf(s) {
  let o = '(';
  for (const ch of String(s)) {
    let c = ch.codePointAt(0);
    if (c > 255) c = WIN_EXTRA[ch] || 63;
    if (c < 32) c = 32;
    if (c === 40 || c === 41 || c === 92) o += '\\' + ch;
    else if (c > 126) o += '\\' + c.toString(8).padStart(3, '0');
    else o += String.fromCharCode(c);
  }
  return o + ')';
}
function corPdf(hex, pb) {
  let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '#000000');
  if (!m) return [0, 0, 0];
  let c = [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  const luma = .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
  if (pb) return [0, 0, 0];
  if (luma > .72) { const k = .55 / luma; c = c.map(v => v * k); }   // cor clara some no papel branco: escurece mantendo o tom
  return c;
}
class PdfG {
  constructor(alturaPt, pb) { this.H = alturaPt; this.pb = pb; this.o = [`1 0 0 -1 0 ${nf(alturaPt)} cm`, '1 J 1 j']; this.vetor = true; this._s = '#000000'; this._f = '#000000'; this.textAlign = 'left'; this.textBaseline = 'middle'; this._tam = 10; this._neg = false; this.x0 = 0; this.y0 = 0; this.tem = false; }
  set strokeStyle(v) { this._s = v; const c = corPdf(v, this.pb); this.o.push(`${nf(c[0])} ${nf(c[1])} ${nf(c[2])} RG`); }
  set fillStyle(v) { this._f = v; const c = corPdf(v, this.pb); this.o.push(`${nf(c[0])} ${nf(c[1])} ${nf(c[2])} rg`); }
  set lineWidth(v) { this.o.push(`${nf(v <= 1 ? .3 : v)} w`); }
  set font(v) { const m = /([\d.]+)px/.exec(v); this._tam = m ? +m[1] : 10; this._neg = /bold|700/.test(v); }
  setLineDash(p) { this.o.push(p && p.length ? `[${p.map(nf).join(' ')}] 0 d` : '[] 0 d'); }
  save() { this.o.push('q'); }
  restore() { this.o.push('Q'); }
  translate(x, y) { this.o.push(`1 0 0 1 ${nf(x)} ${nf(y)} cm`); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.o.push(`${c.toFixed(5)} ${s.toFixed(5)} ${(-s).toFixed(5)} ${c.toFixed(5)} 0 0 cm`); }
  beginPath() { this.tem = false; }
  moveTo(x, y) { this.o.push(`${nf(x)} ${nf(y)} m`); this.tem = true; }
  lineTo(x, y) { this.o.push(`${nf(x)} ${nf(y)} ${this.tem ? 'l' : 'm'}`); this.tem = true; }
  closePath() { this.o.push('h'); }
  rect(x, y, w, h) { this.o.push(`${nf(x)} ${nf(y)} ${nf(w)} ${nf(h)} re`); this.tem = true; }
  arc(cx, cy, r, a0, a1, anti) {
    let d = a1 - a0;
    if (anti) { while (d > 0) d -= 2 * Math.PI; } else { while (d < 0) d += 2 * Math.PI; }
    const n = Math.max(4, Math.ceil(Math.abs(d) / (Math.PI / 12)));
    for (let i = 0; i <= n; i++) { const a = a0 + d * i / n, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a); i ? this.lineTo(x, y) : (this.tem ? this.lineTo(x, y) : this.moveTo(x, y)); }
  }
  stroke() { this.o.push('S'); }
  fill() { this.o.push('f'); }
  clip() { this.o.push('W n'); }
  fillRect(x, y, w, h) { this.o.push(`${nf(x)} ${nf(y)} ${nf(w)} ${nf(h)} re f`); }
  strokeRect(x, y, w, h) { this.o.push(`${nf(x)} ${nf(y)} ${nf(w)} ${nf(h)} re S`); }
  measureText(s) { return {width: larguraHelv(s, this._tam)}; }
  fillText(s, x, y) {
    const w = larguraHelv(s, this._tam), dx = this.textAlign === 'right' ? -w : this.textAlign === 'center' ? -w / 2 : 0;
    const dy = this.textBaseline === 'middle' ? this._tam * .35 : this.textBaseline === 'top' ? this._tam * .75 : 0;
    // A matriz da página inverte o eixo Y; o texto precisa desinverter para não sair espelhado.
    this.o.push(`BT /${this._neg ? 'F2' : 'F1'} ${nf(this._tam)} Tf 1 0 0 -1 ${nf(x + dx)} ${nf(y + dy)} Tm ${textoPdf(s)} Tj ET`);
  }
  get conteudo() { return this.o.join('\n'); }
}
async function comprimir(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  const st = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(st).arrayBuffer());
}
async function montarPdf(paginas, meta) {
  const enc = new TextEncoder(), lat1 = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  const partes = [], offs = []; let pos = 0;
  const put = b => { const u = typeof b === 'string' ? lat1(b) : b; partes.push(u); pos += u.length; };
  const obj = (n, corpo) => { offs[n] = pos; put(`${n} 0 obj\n`); corpo(); put('\nendobj\n'); };
  put('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');
  const n = paginas.length, kids = paginas.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Count ${n} /Kids [${kids}] >>`));
  obj(3, () => put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  obj(4, () => put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  for (let i = 0; i < n; i++) {
    const p = paginas[i], np = 5 + i * 2, nc = np + 1;
    obj(np, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${nf(p.w)} ${nf(p.h)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${nc} 0 R >>`));
    const cru = lat1(p.conteudo), z = await comprimir(cru);
    obj(nc, () => { put(`<< /Length ${(z || cru).length}${z ? ' /Filter /FlateDecode' : ''} >>\nstream\n`); put(z || cru); put('\nendstream'); });
  }
  const nInfo = 5 + n * 2;
  obj(nInfo, () => put(`<< /Title ${textoPdf(meta.titulo || 'Projeto')} /Producer (NeoGrid) >>`));
  const xr = pos, tot = nInfo + 1;
  let t = `xref\n0 ${tot}\n0000000000 65535 f \n`;
  for (let i = 1; i < tot; i++) t += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  put(t + `trailer\n<< /Size ${tot} /Root 1 0 R /Info ${nInfo} 0 R >>\nstartxref\n${xr}\n%%EOF\n`);
  const out = new Uint8Array(pos); let k = 0; for (const u of partes) { out.set(u, k); k += u.length; }
  void enc;
  return out;
}

// ---------------- prancha: desenha o projeto (com as edições) em folhas ----------------
function pacotePintar(g, tr, caixa) {
  const P = PRJ();
  const dentro = (a, b) => !caixa || !(a[0] > caixa[2] || b[0] < caixa[0] || a[1] > caixa[3] || b[1] < caixa[1]);
  const bbEnt = e => { const b = pjBBox([e]); return b && isFinite(b[0]) ? b : null; };
  for (const it of PJ.items) if (it.k === 'E') {
    const r = projAplicaE(it); if (!r) continue;
    const bb = bbEnt(r.e); if (bb && !dentro([bb[0], bb[1]], [bb[2], bb[3]])) continue;
    // No papel, a largura de tela das redes cobriria os textos: limitada a 0,5 mm.
    const ent = r.e.w > .5 ? {...r.e, w: .5} : r.e;
    pjEnt(g, tr, ent, pjCorHex(ent.c != null ? ent.c : r.col, it.L), ent.w ? ent.w * tr.k : 1);
  }
  for (const it of PJ.items) if (it.k === 'I') {
    const r = projAplicaI(it); if (!r) continue;
    if (!dentro([r.x - 30, r.y - 30], [r.x + 30, r.y + 30])) continue;
    const def = pjDef(r.name); if (!def) continue;
    const c = Math.cos(r.rot * RAD), s = Math.sin(r.rot * RAD), M = DXF.T(r.sx * c, r.sx * s, -r.sx * s, r.sx * c, r.x, r.y);
    for (const e of def.ents) { const q = DXF.xfEnt(e, M); pjEnt(g, tr, q, pjCorHex(q.c != null && q.c > 0 ? q.c : r.col, r.L), 1); }
  }
  for (const it of PJ.items) if (it.k === 'T') {
    const r = projAplicaT(it); if (!r || !dentro(r.e.p, r.e.p)) continue;
    pjTexto(g, tr, r.e, pjCorHex(r.col, it.L));
  }
  const Lx0 = san(P.camadaAnot || 'ANOTACOES');
  for (const ex of P.ex) {
    const Lx = ex.lay ? san(ex.lay) : Lx0;
    if (P.cam[Lx] && P.cam[Lx].oculto) continue;
    const hx = ex.cor || (P.cam[Lx] && P.cam[Lx].cor) || '#000000';
    if (ex.t === 'TEXT') pjTexto(g, tr, {p: pjDxf(ex.x, ex.y, PJ.c), h: ex.h, s: ex.s || ' ', rot: ex.rot || 0, hj: ex.hj || 0, ls: ex.ls}, hx);
    else if (ex.t === 'BLOCO') {
      const l = projLib(ex.lib); if (!l) continue;
      const w = pjDxf(ex.x, ex.y, PJ.c), sx = (ex.tam || 3) / l.ext, rr = (ex.rot || 0) * RAD, M = DXF.T(sx * Math.cos(rr), sx * Math.sin(rr), -sx * Math.sin(rr), sx * Math.cos(rr), w[0], w[1]);
      for (const e of l.ents) pjEnt(g, tr, DXF.xfEnt(e, M), hx, 1);
    } else if (ex.t === 'PLINE') {
      pjEnt(g, tr, {t: 'PLINE', pts: ex.pts.map(q => { const w = pjDxf(q[0], q[1], PJ.c); return [w[0], w[1], q[2] || 0]; }), closed: !!ex.closed, lt: pjLtNome(ex.lt)}, hx, 1);
    } else {
      const pts = ex.pts.map(q => { const w = pjDxf(q[0], q[1], PJ.c); return tr.T(w[0], w[1]); });
      g.strokeStyle = hx; g.fillStyle = hx; g.lineWidth = 1; g.beginPath(); pts.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.stroke();
      if (ex.t === 'SETA') {
        const a = pts[0], b = pts[1], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d, hs = Math.max(4, (ex.tam || 2) * tr.k);
        g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(b[0] - ux * hs - uy * hs * .3, b[1] - uy * hs + ux * hs * .3); g.lineTo(b[0] - ux * hs + uy * hs * .3, b[1] - uy * hs - ux * hs * .3); g.closePath(); g.fill();
      }
    }
  }
}
function pacoteCaixaArea() {   // caixa da área selecionada em unidades do desenho
  const {Z} = projDXF(SEL), b = SEL.b;
  const cantos = (SEL.poly ? SEL.poly.map(q => Array.isArray(q) ? q : [q.lat, q.lng]) : [[b.getSouth(), b.getWest()], [b.getSouth(), b.getEast()], [b.getNorth(), b.getEast()], [b.getNorth(), b.getWest()]])
    .map(([la, lo]) => { const u = utm(la, lo, Z); return pjDxf(u[0], u[1], PJ.c); });
  return {cantos, x0: Math.min(...cantos.map(q => q[0])), x1: Math.max(...cantos.map(q => q[0])), y0: Math.min(...cantos.map(q => q[1])), y1: Math.max(...cantos.map(q => q[1])), Z};
}
function pacoteCarimbo(g, o) {
  const {W, H, m, pac, den, n, tot, data, zona, resumo, legenda} = o, f = PT_MM;
  const wc = Math.min(W - 2 * m, 170), hc = 34, x = W - m - wc, y = H - m - hc;
  g.strokeStyle = '#000000'; g.fillStyle = '#000000'; g.lineWidth = 1; g.setLineDash([]);
  g.strokeRect(m * f, m * f, (W - 2 * m) * f, (H - 2 * m) * f);
  g.strokeRect(x * f, y * f, wc * f, hc * f);
  const lin = (xa, ya, xb, yb) => { g.beginPath(); g.moveTo(xa * f, ya * f); g.lineTo(xb * f, yb * f); g.stroke(); };
  const txt = (s, xt, yt, tam, neg) => { g.font = (neg ? 'bold ' : '') + tam * f + 'px Arial'; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(s, xt * f, yt * f); };
  lin(x, y + 12, x + wc, y + 12); lin(x, y + 23, x + wc, y + 23); lin(x + wc * .62, y + 12, x + wc * .62, y + hc);
  txt('PROJETO', x + 2, y + 3.4, 2, false); txt(pac.nome || 'Projeto sem nome', x + 2, y + 9, 4.2, true);
  txt('CLIENTE', x + 2, y + 15, 2, false); txt(pac.cliente || '—', x + 2, y + 20, 3, false);
  txt('RESPONSÁVEL TÉCNICO', x + 2, y + 26, 2, false); txt((pac.responsavel || '—') + (pac.registro ? ' · ' + pac.registro : ''), x + 2, y + 31, 2.8, false);
  const xd = x + wc * .62 + 2;
  txt('ESCALA', xd, y + 15, 2, false); txt('1:' + Math.round(den).toLocaleString('pt-BR'), xd, y + 20, 3.2, true);
  txt('FOLHA', xd + 28, y + 15, 2, false); txt(n + '/' + tot, xd + 28, y + 20, 3.2, true);
  txt('DATA', xd, y + 26, 2, false); txt(data, xd, y + 31, 2.8, false);
  txt('DATUM', xd + 28, y + 26, 2, false); txt('SIRGAS 2000 · UTM ' + zona, xd + 28, y + 31, 2.2, false);
  // norte
  const nx = x - 10, ny = H - m - 18;
  g.beginPath(); g.moveTo(nx * f, (ny - 8) * f); g.lineTo((nx + 3) * f, (ny + 4) * f); g.lineTo(nx * f, (ny + 1.5) * f); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(nx * f, (ny - 8) * f); g.lineTo((nx - 3) * f, (ny + 4) * f); g.lineTo(nx * f, (ny + 1.5) * f); g.closePath(); g.stroke();
  g.font = 'bold ' + 3.2 * f + 'px Arial'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('N', nx * f, (ny - 9.5) * f);
  // barra de escala: 5 divisões com passo "redondo"
  const passos = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000], mReal = passos.find(v => v * 1000 / den >= 8) || 5000, seg = mReal * 1000 / den;
  const bx = m + 6, by = H - m - 8;
  for (let i = 0; i < 5; i++) { if (i % 2 === 0) g.fillRect((bx + i * seg) * f, (by - 1.6) * f, seg * f, 1.6 * f); g.strokeRect((bx + i * seg) * f, (by - 1.6) * f, seg * f, 1.6 * f); }
  g.font = 2.2 * f + 'px Arial'; g.textAlign = 'center';
  for (let i = 0; i <= 5; i++) g.fillText(String(mReal * i), (bx + i * seg) * f, (by - 2.6) * f);
  g.textAlign = 'left'; g.fillText('metros', (bx + 5 * seg + 3) * f, by * f);
  if (legenda && legenda.length) {
    const lx = m + 6; let ly = H - m - 16;
    for (const l of legenda.slice().reverse()) { txt(l, lx, ly, 2.4, false); ly -= 3.6; }
  }
  void resumo;
}
async function pacotePdf(pac) {
  const area = pacoteCaixaArea(), [a, b] = FOLHAS_PDF[pac.folha] || FOLHAS_PDF.A3, W = pac.orient === 'p' ? b : a, H = pac.orient === 'p' ? a : b;
  const m = 8, hRod = 40, fw = W - 2 * m, fh = H - 2 * m - hRod;   // quadro útil em mm
  const larg = area.x1 - area.x0, alt = area.y1 - area.y0, denProj = +CFG.dxf.escala || 1000;
  // Uma unidade do desenho equivale a 1 mm no papel na escala do projeto.
  let k = 1, cols = 1, rows = 1;
  if (pac.ajuste === 'folha') k = Math.min(fw / larg, fh / alt, 4);
  else { const sob = 6; cols = larg <= fw ? 1 : Math.ceil((larg - sob) / (fw - sob)); rows = alt <= fh ? 1 : Math.ceil((alt - sob) / (fh - sob)); }
  const den = denProj / k, tot = cols * rows, paginas = [], f = PT_MM;
  if (tot > 60) throw new Error(`A área precisaria de ${tot} folhas em ${pac.folha}. Use uma folha maior ou "Ajustar a uma folha".`);
  const zona = area.Z + (SEL.b.getCenter().lat < 0 ? 'S' : 'N'), data = new Date().toLocaleDateString('pt-BR');
  const cont = Object.entries(SEL.ids || {}).filter(([, v]) => v.length).map(([t, v]) => NOME[t] + ': ' + v.length.toLocaleString('pt-BR'));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const g = new PdfG(H * f, pac.pb), qW = fw / k, qH = fh / k, sob = 6 / k;
    const x0 = tot === 1 ? (area.x0 + area.x1) / 2 - qW / 2 : area.x0 + c * (qW - sob), yTopo = tot === 1 ? (area.y0 + area.y1) / 2 + qH / 2 : area.y1 - r * (qH - sob);
    const tr = {k: k * f, T: (X, Y) => [(m + (X - x0) * k) * f, (m + (yTopo - Y) * k) * f]};
    const caixa = [x0 - 2, yTopo - qH - 2, x0 + qW + 2, yTopo + 2];
    g.save(); g.beginPath(); g.rect(m * f, m * f, fw * f, fh * f); g.clip();
    pacotePintar(g, tr, caixa);
    g.strokeStyle = '#000000'; g.lineWidth = 1; g.setLineDash([4, 2]); g.beginPath();
    area.cantos.forEach((q, i) => { const p = tr.T(q[0], q[1]); i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }); g.closePath(); g.stroke(); g.setLineDash([]);
    g.restore();
    pacoteCarimbo(g, {W, H, m, pac, den, n: paginas.length + 1, tot, data, zona, legenda: cont});
    paginas.push({w: W * f, h: H * f, conteudo: g.conteudo});
    await new Promise(res => setTimeout(res, 0));
  }
  return {bytes: await montarPdf(paginas, {titulo: pac.nome}), folhas: tot, den};
}

// ---------------- quantitativo com as anotações do projeto ----------------
function pacoteAnotacoes() {
  const m = new Map(), rot = {'01_INSTALANDO': 'Instalar', '01_REAPLICANDO': 'Reaplicar', '01_REMOVER': 'Remover'}, a = pacoteCaixaArea();
  for (const ex of PRJ().ex) {
    if (ex.t !== 'TEXT' || !rot[ex.lay]) continue;
    const w = pjDxf(ex.x, ex.y, PJ.c);
    if (w[0] < a.x0 || w[0] > a.x1 || w[1] < a.y0 || w[1] > a.y1) continue;   // anotação de outra área não entra na conta
    for (const l of String(ex.s || '').split('\n').map(s => s.trim()).filter(Boolean)) {
      const k = rot[ex.lay] + '|' + l; m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return [...m.entries()].map(([k, n]) => { const [acao, item] = k.split('|'); return [acao, item, n]; }).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR') || a[1].localeCompare(b[1], 'pt-BR', {numeric: true}));
}
function pacoteQuantCsv() {
  const q = v => { v = v == null ? '' : String(v); return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const ocultas = new Set(Object.keys(NOME).filter(camadaOculta).map(t => NOME[t]));
  const base = usarSel(() => quantitativo(SEL)).filter(r => !ocultas.has(r[0])), an = pacoteAnotacoes();
  let s = '﻿REDE EXISTENTE NA ÁREA\nCamada;Grupo;Quantidade;Comprimento (m)\n' + base.map(r => [r[0], q(r[1]), r[2], fmtBR(r[3])].join(';')).join('\n') + '\n';
  if (an.length) s += '\nSERVIÇOS ANOTADOS NO PROJETO\nAção;Item;Quantidade\n' + an.map(r => [r[0], q(r[1]), r[2]].join(';')).join('\n') + '\n';
  return {texto: s, linhas: base.length + an.length, anotados: an.length};
}
function pacoteDadosCsv() {
  return usarSel(() => {
    const out = [];
    for (const t of Object.keys(D)) {
      const ids = SEL.ids[t]; if (!ids || !ids.length || camadaOculta(t)) continue;
      const d = D[t], rows = ids.map(i => d.rows[i]);
      out.push({nome: `dados/${t}.csv`, texto: csvTexto(d.h, rows), n: rows.length});
    }
    return out;
  });
}
function pacoteGeojson() {
  return usarSel(() => {
    const feats = [];
    for (const t of Object.keys(D)) {
      if (camadaOculta(t)) continue;
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
    return JSON.stringify({type: 'FeatureCollection', features: feats});
  });
}
function pacoteResumo(pac, arqs, avisos) {
  const c = SEL.b.getCenter(), wm = (SEL.b.getEast() - SEL.b.getWest()) * 111320 * Math.cos(c.lat * RAD), hm = (SEL.b.getNorth() - SEL.b.getSouth()) * 111320;
  const L_ = ['PACOTE DE PROJETO - NEOGRID', '', `Projeto: ${pac.nome || '(sem nome)'}`, `Cliente: ${pac.cliente || '-'}`, `Responsável: ${pac.responsavel || '-'}${pac.registro ? ' (' + pac.registro + ')' : ''}`, `Gerado em: ${new Date().toLocaleString('pt-BR')}`, `Escala do desenho: 1:${+CFG.dxf.escala || 1000}`,
    `Área: aprox. ${Math.round(wm)} x ${Math.round(hm)} m (${SEL.poly ? 'polígono' : 'retângulo'})`, `Centro: ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`, `Base de origem: ${window.NG.origemDados()}`, '', 'ELEMENTOS NA ÁREA'];
  for (const [t, v] of Object.entries(SEL.ids || {})) if (v.length) L_.push(`  ${NOME[t]}: ${v.length.toLocaleString('pt-BR')}`);
  const P = PRJ(); L_.push('', `EDIÇÕES DO PROJETO: ${pjNEd(P)} alteração(ões), ${P.ex.length} anotação(ões)`);
  if (pac.observacoes) L_.push('', 'OBSERVAÇÕES', pac.observacoes);
  if (avisos.length) L_.push('', 'AVISOS', ...avisos.map(a => '  - ' + a));
  L_.push('', 'ARQUIVOS', ...arqs.map(a => '  ' + a));
  return '﻿' + L_.join('\r\n') + '\r\n';
}

// ---------------- geração do pacote ----------------
let pacoteOcupado = false;
async function pacoteGerar(aoProgresso) {
  if (!PJ.on) throw new Error('Abra o projeto da área antes de gerar o pacote.');
  const pac = CFG.pacote, it = pac.itens, files = [], avisos = [];
  const base = (pac.nome || 'projeto').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'projeto';
  const passo = (m, f) => { aoProgresso && aoProgresso(m, f); return new Promise(r => setTimeout(r, 15)); };
  if (it.dxf) {
    await passo('Gerando o DXF…', .1);
    const r = usarSel(() => gerarDXF(SEL, PJ.osm, PJ.ruasR));
    DXF.ctx = PJ.c;
    files.push({name: `${base}.dxf`, text: r.txt});
    if (!PJ.ruasR && CFG.dxf.ruas && CFG.dxf.ruasModo !== 'eixo') avisos.push('O DXF saiu sem arruamento: as ruas do OpenStreetMap não estavam disponíveis.');
  }
  if (it.pdf) {
    await passo('Desenhando a prancha em PDF…', .3);
    const p = await pacotePdf(pac);
    files.push({name: `${base}_prancha_${pac.folha}.pdf`, bytes: p.bytes});
    if (p.folhas > 1) avisos.push(`A prancha ocupou ${p.folhas} folhas ${pac.folha} na escala 1:${Math.round(p.den)}.`);
  }
  if (it.quant) { await passo('Calculando o quantitativo…', .55); files.push({name: `${base}_quantitativo.csv`, text: pacoteQuantCsv().texto}); }
  if (it.dados) { await passo('Exportando os dados da área…', .65); for (const a of pacoteDadosCsv()) files.push({name: a.nome, text: a.texto}); }
  if (it.geojson) { await passo('Gerando o GeoJSON…', .75); files.push({name: `${base}.geojson`, text: pacoteGeojson()}); }
  if (it.projeto) { await passo('Salvando o arquivo do projeto…', .85); files.push({name: `${base}.neogrid-projeto.json`, text: JSON.stringify(pjArquivo())}); }
  if (!files.length) throw new Error('Marque ao menos um item para o pacote.');
  if (it.resumo) { const nomes = files.map(f => f.name).concat(['LEIA-ME.txt']); files.push({name: 'LEIA-ME.txt', text: pacoteResumo(pac, nomes, avisos)}); }
  await passo('Gravando o pacote…', .95);
  return {base, files, avisos};
}
function pacotePainel() {
  const box = $('#pacc'), pac = CFG.pacote = mesclar(PACOTE_PADRAO(), CFG.pacote); box.replaceChildren();
  const M = salvar, res = mk('div', {class: 'pac-res'});
  box.append(mk('div', {class: 'card'}, mk('b', null, 'Identificação'),
    fr('Nome do projeto', ctl(pac, 'nome', {t: 'txt'}, M)), fr('Cliente', ctl(pac, 'cliente', {t: 'txt'}, M)),
    fr('Responsável técnico', ctl(pac, 'responsavel', {t: 'txt'}, M)), fr('Registro (CREA/CFT)', ctl(pac, 'registro', {t: 'txt'}, M)),
    fr('Observações', ctl(pac, 'observacoes', {t: 'txt'}, M))));
  box.append(mk('div', {class: 'card'}, mk('b', null, 'O que entra no pacote'),
    ...[['dxf', 'DXF do projeto (com as edições)'], ['pdf', 'Prancha em PDF vetorial'], ['quant', 'Quantitativo (rede + serviços anotados)'], ['dados', 'Dados da área em CSV (por camada)'], ['geojson', 'GeoJSON da área'], ['projeto', 'Arquivo do projeto (reabre no NeoGrid)'], ['resumo', 'Resumo LEIA-ME.txt']].map(([k, l]) => fr(l, ctl(pac.itens, k, {t: 'chk'}, M)))));
  box.append(mk('div', {class: 'card'}, mk('b', null, 'Prancha'),
    fr('Folha', ctl(pac, 'folha', {t: 'sel', o: Object.keys(FOLHAS_PDF).map(k => [k, k])}, M)),
    fr('Orientação', ctl(pac, 'orient', {t: 'sel', o: [['l', 'Paisagem'], ['p', 'Retrato']]}, M)),
    fr('Enquadramento', ctl(pac, 'ajuste', {t: 'sel', o: [['escala', 'Manter a escala do projeto (várias folhas se precisar)'], ['folha', 'Ajustar a uma folha']]}, M)),
    fr('Preto e branco', ctl(pac, 'pb', {t: 'chk'}, M))));
  box.append(mk('div', {class: 'card'}, fr('Salvar como', ctl(pac, 'saida', {t: 'sel', o: [['zip', 'Arquivo .zip'], ['pasta', 'Pasta com os arquivos']]}, M))));
  const go = mk('button', {class: 'p', onclick: async () => {
    if (pacoteOcupado) return;
    pacoteOcupado = true; go.disabled = true; res.replaceChildren(); progIni('Montando o pacote…');
    try {
      const r = await pacoteGerar((m, f) => progSet(m, f));
      const salvo = await window.NG.salvarPacote(r.base, pac.saida, r.files);
      if (!salvo || !salvo.saved) { if (salvo && salvo.error) throw new Error(salvo.error); $('#st').textContent = 'Geração do pacote cancelada.'; return; }
      $('#st').textContent = 'Pacote gerado em ' + salvo.path;
      res.append(mk('div', {class: 'card'}, mk('b', null, `Pacote pronto: ${r.files.length} arquivo(s)`), mk('small', {style: 'display:block;word-break:break-all;margin:4px 0'}, salvo.path),
        ...r.avisos.map(a => mk('small', {class: 'warn', style: 'display:block'}, a)),
        mk('button', {onclick: () => window.desktop && window.desktop.revealFile(salvo.path)}, 'Mostrar na pasta')));
      window.NG.registrarExportacao(r.base, salvo.path, r.files.length);
    } catch (e) { console.error(e); res.append(mk('div', {class: 'card'}, mk('small', {class: 'warn'}, 'Falha ao gerar o pacote: ' + e.message))); }
    finally { pacoteOcupado = false; go.disabled = false; progFim(); }
  }}, 'Gerar pacote');
  box.append(go, res);
}
