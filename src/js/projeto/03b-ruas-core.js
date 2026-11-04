/* Cálculo das pistas, sem acesso à tela: roda no Web Worker para a janela seguir respondendo. */
async function calcRuasCore(p, cb) {
  const {vias, postes, area, org, o, ops} = p;
  RUAS.init(ClipperLib);
  const trechos = vias.length;
  if (o.encadear) vias.splice(0, vias.length, ...RUAS.encadear(vias));
  const adj = o.ajustar && postes.length;
  const viasBase = vias.map(v => ({...v, pts: v.pts.map(q => q.slice())}));   // rua original, sem ajustes (camada "pista original")
  const alvos = adj ? postes.filter(q => q.regra && q.regra.ax != null && Math.hypot(q.x - q.regra.ax, q.y - q.regra.ay) > 0.05).map(q => ({x: q.x, y: q.y, vx: q.x - q.regra.ax, vy: q.y - q.regra.ay})) : [];
  if (alvos.length) { cb('Deslocando o arruamento para as posições escolhidas...', 0.08); RUAS.deformar(vias, alvos); }
  let res = {vias: vias.map(v => ({...v, pts0: v.pts, pts: v.pts.map(q => q.slice())})), rel: {total: postes.length, ok: 0, centro: 0, impossivel: 0, ignorados: 0, lista: [], todos: []}, ign: []};
  const sub = (a, b) => (m, f) => cb(m, a + (b - a) * (f ?? 0));
  if (adj) res = await RUAS.ajustar(vias, postes, {margem: o.margem, maxDesl: o.maxDesl, larguraMin: o.larguraMin, cb: sub(0.1, 0.4)});
  const opsE = ops.filter(q => q.t === 'mv' || q.t === 'rot' || q.t === 'sua'), opsL = ops.filter(q => q.t === 'larg'), opsB = ops.filter(q => /^(bmv|blarg|bsua|vtx|vdel|vins)$/.test(q.t));
  if (opsE.length || opsL.length) { cb('Aplicando o ajuste fino...', 0.41); if (opsE.length) RUAS.editar(res.vias, opsE); if (opsL.length) RUAS.larguraVia(res.vias, opsL); }
  cb(`Fechando emendas (${vias.length} ruas, ${trechos} trechos)...`, 0.42);
  const discos = RUAS.fecharJuncoes(res.vias, {maxDesl: o.maxDesl});
  if (adj) res.rel = RUAS.avaliarPostes(res.vias, postes.filter(q => !(q.regra && (q.regra.ign || q.regra.ax != null))), res.ign);
  const bordas = await RUAS.bordas(res.vias, area, org, {raio: o.raio, discos, cb: sub(0.45, 0.95)});
  if (opsB.length) RUAS.editarBordas(bordas, opsB, res.vias.map(v => v.pts));
  let orig = null;
  if (o.original && adj) {
    const cp = viasBase.map(v => ({...v, pts0: v.pts, pts: v.pts.map(q => q.slice())}));
    orig = await RUAS.bordas(cp, area, org, {raio: o.raio, discos: RUAS.fecharJuncoes(cp, {}), cb: sub(0.95, 1)});
  }
  return {vias: res.vias, rel: res.rel, bordas, orig};
}
