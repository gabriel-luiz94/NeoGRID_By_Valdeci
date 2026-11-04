// Funções puras em metros (UTM). Usa o ClipperLib embutido (ou RUAS.init(ClipperLib) nos testes).
const RUAS = (() => {
  let CL = typeof ClipperLib !== 'undefined' ? ClipperLib : null;
  const init = c => { CL = c; };
  const ESC_C = 1000; // Clipper trabalha em inteiros: 1 unidade = 1 mm
  const LARG = {motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8, residential: 7, unclassified: 7, living_street: 5, service: 4.5, track: 3.5,
    pedestrian: 3, footway: 2, path: 2, cycleway: 2, steps: 2, bridleway: 2, corridor: 2, outros: 6};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const base = hw => String(hw || '').replace(/_link$/, '');
  // largura real da pista (m): tag width > faixas × largura da faixa > padrão do tipo
  function largura(tags, o) {
    tags = tags || {};
    const tab = {...LARG, ...(o && o.larguras || {})}, fx = (o && o.faixa) || 3.2;
    const w = parseFloat(String(tags.width || tags.est_width || '').replace(',', '.'));
    if (w > 0) return clamp(w, 1.5, 40);
    const ln = parseInt(tags.lanes, 10), pad = tab[base(tags.highway)] ?? tab.outros;
    if (ln > 0 && !(ln === 1 && tags.oneway !== 'yes')) return clamp(ln * fx, 1.5, 40);
    return clamp(pad, 1.5, 40);
  }
  // ---- geometria básica ----
  function densificar(pts, passo) {
    const x = [pts[0][0]], y = [pts[0][1]], s = [0], orig = [0];
    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1][0], ay = pts[k - 1][1], bx = pts[k][0], by = pts[k][1], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      const n = Math.max(1, Math.ceil(L / passo));
      for (let q = 1; q <= n; q++) { x.push(ax + (bx - ax) * q / n); y.push(ay + (by - ay) * q / n); s.push(s[s.length - 1] + L / n); }
      orig.push(x.length - 1);
    }
    return {x, y, s, n: x.length, S: s[s.length - 1], orig};
  }
  function normais(P) {
    const nx = new Float64Array(P.n), ny = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(P.n - 1, i + 1);
      let tx = P.x[b] - P.x[a], ty = P.y[b] - P.y[a]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      nx[i] = -ty; ny[i] = tx; // normal à esquerda
    }
    return {nx, ny};
  }
  // ponto mais próximo sobre a polilinha: devolve s, distância assinada (esquerda +) e se é extremidade
  function projetar(P, px, py) {
    let best = 1e18, bs = 0, be = 0;
    for (let i = 0; i + 1 < P.n; i++) {
      const ax = P.x[i], ay = P.y[i], dx = P.x[i + 1] - ax, dy = P.y[i + 1] - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = clamp(t, 0, 1);
      const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(px - qx, py - qy);
      if (d < best) { best = d; bs = P.s[i] + t * (P.s[i + 1] - P.s[i]); be = (dx * (py - ay) - dy * (px - ax)) >= 0 ? d : -d; }
    }
    return {s: bs, e: be, d: best};
  }
  const suave = u => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

  // junta trechos ligados por um nó simples (sem cruzamento) numa rua contínua
  function encadear(vias) {
    const key = p => Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2), cmp = pts => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; };
    let L = vias.map(v => ({...v, pts: v.pts.slice(), len: cmp(v.pts), ok: true}));
    const cls = v => String(v.hwTipo || '').replace(/_link$/, '');
    for (let rod = 0; rod < 50; rod++) {
      const ext = new Map(), inter = new Map();
      L.forEach((v, i) => {
        if (!v.ok) return;
        for (const [fim, p] of [[0, v.pts[0]], [1, v.pts[v.pts.length - 1]]]) { const k = key(p); (ext.get(k) || ext.set(k, []).get(k)).push({i, fim}); }
        for (let q = 1; q < v.pts.length - 1; q++) { const k = key(v.pts[q]); inter.set(k, (inter.get(k) || 0) + 1); }
      });
      const usado = new Set(); let mudou = false;
      for (const [k, es] of ext) {
        if (es.length !== 2 || inter.get(k) || es[0].i === es[1].i || usado.has(es[0].i) || usado.has(es[1].i)) continue;
        let a = L[es[0].i], b = L[es[1].i];
        if (cls(a) !== cls(b) || (a.nome && b.nome && a.nome !== b.nome)) continue;
        const pa = es[0].fim ? a.pts.slice() : a.pts.slice().reverse(), pb = es[1].fim ? b.pts.slice().reverse() : b.pts.slice();
        const n = pa.length, ua = [pa[n - 2][0] - pa[n - 1][0], pa[n - 2][1] - pa[n - 1][1]], ub = [pb[1][0] - pb[0][0], pb[1][1] - pb[0][1]];
        const cosv = (ua[0] * ub[0] + ua[1] * ub[1]) / ((Math.hypot(...ua) * Math.hypot(...ub)) || 1);
        if (cosv > -0.5) continue;   // curva fechada demais: é uma esquina, não continuação
        a.pts = pa.concat(pb.slice(1)); a.hw = (a.hw * a.len + b.hw * b.len) / (a.len + b.len); a.nome = a.len >= b.len ? (a.nome || b.nome) : (b.nome || a.nome); a.len += b.len; b.ok = false;
        usado.add(es[0].i); usado.add(es[1].i); mudou = true;
      }
      if (!mudou) break;
    }
    return L.filter(v => v.ok);
  }

  // ---- ajuste RÍGIDO de cada via: só desloca o eixo (sem criar curvas) e/ou estreita a pista ----
  const distPoli = (pts, x, y) => {
    let best = 1e18;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0], ay = pts[i][1], dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0; t = clamp(t, 0, 1);
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy); if (d < best) best = d;
    }
    return best;
  };
  // lado "canônico": independe da ordem dos pontos desenhados (orienta a rua de oeste para leste, ou de sul para norte)
  const canon = v => { const p = v.pts0 || v.pts, a = p[0], b = p[p.length - 1], dx = b[0] - a[0], dy = b[1] - a[1]; return (dx > 1e-6 || (Math.abs(dx) <= 1e-6 && dy >= 0)) ? 1 : -1; };
  // distância assinada (esquerda do sentido de desenho = +)
  const distPoliS = (pts, x, y) => {
    let best = 1e18, sg = 1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0], ay = pts[i][1], dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0; t = clamp(t, 0, 1);
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy); if (d < best) { best = d; sg = (dx * (y - ay) - dy * (x - ax)) >= 0 ? 1 : -1; }
    }
    return sg * best;
  };
  let _t = Date.now();
  const esp = async () => { if (Date.now() - _t > 40) { await new Promise(r => setTimeout(r, 0)); _t = Date.now(); } };
  // situação de cada poste frente às vias já ajustadas (as coordenadas dos pontos nunca mudam)
  function avaliarPostes(saida, postes, ign) {
    const Cs = 40, gs = new Map(), ci = (x, y) => Math.floor(x / Cs) + ',' + Math.floor(y / Cs);
    saida.forEach((v, vi) => {
      for (let i = 0; i + 1 < v.pts.length; i++) {
        const a = v.pts[i], b = v.pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 15)), seen = new Set();
        for (let q = 0; q <= n; q++) { const kk = ci(a[0] + (b[0] - a[0]) * q / n, a[1] + (b[1] - a[1]) * q / n); if (!seen.has(kk)) { seen.add(kk); (gs.get(kk) || gs.set(kk, []).get(kk)).push([vi, i]); } }
      }
    });
    const rel = {total: postes.length, ok: 0, centro: 0, impossivel: 0, alvo: 0, ignorados: (ign || []).filter(p => !(p.regra && p.regra.ax != null)).length, lista: [], todos: []};
    postes.forEach(p => {
      const cx = Math.floor(p.x / Cs), cy = Math.floor(p.y / Cs), seen = new Set(); let ed = 1e9, bv = -1, lado = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [vi, i] of gs.get((cx + a) + ',' + (cy + b)) || []) {
        const id = vi * 1e7 + i; if (seen.has(id)) continue; seen.add(id);
        const q = saida[vi].pts, ax = q[i][0], ay = q[i][1], dx = q[i + 1][0] - ax, dy = q[i + 1][1] - ay, l2 = dx * dx + dy * dy;
        let t = l2 ? ((p.x - ax) * dx + (p.y - ay) * dy) / l2 : 0; t = clamp(t, 0, 1);
        const d = Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy) - saida[vi].hw;
        if (d < ed) { ed = d; bv = vi; lado = ((dx * (p.y - ay) - dy * (p.x - ax)) >= 0 ? 1 : -1) * canon(saida[vi]); }
      }
      let st = ed >= (p.r || 0) ? 'ok' : ed >= 0 ? 'centro' : 'impossivel';
      const req = p.regra && p.regra.lado;
      const ladoErrado = !!req && bv >= 0 && lado !== req;
      if (ladoErrado) st = 'impossivel';
      if (p.regra && p.regra.alvo) st = 'alvo';   // posição escolhida pelo usuário: a rua foi ajustada para o poste aparecer onde ele indicou
      rel[st]++;
      const item = {id: p.id, t: p.t, key: p.key, st, dist: ed, x: p.x, y: p.y, lado, ladoErrado, regra: p.regra || null};
      rel.todos.push(item);
      if (st !== 'ok') rel.lista.push(item);
    });
    for (const p of ign || []) { const al = p.regra && p.regra.ax != null; if (al) rel.alvo++; rel.todos.push({id: p.id, t: p.t, key: p.key, st: al ? 'alvo' : 'ign', dist: null, x: p.x, y: p.y, lado: 0, regra: p.regra}); }
    return rel;
  }
  // ---- posição escolhida pelo usuário: cada poste com alvo pede que a rua ao redor se desloque do vetor (poste - alvo),
  // de modo que o poste (que não se move) fique, em relação à rua, onde o alvo estava. O deslocamento é uma função suave da posição
  // (inteiro perto do poste e se dissipando com a distância), por isso ruas que se encontram continuam ligadas e sem degraus.
  function deformar(vias, alvos, opt) {
    const o = Object.assign({passo: 4}, opt || {});
    const A = alvos.map(a => { const m = Math.hypot(a.vx, a.vy); const R1 = Math.max(35, 3 * m), R2 = R1 + Math.max(70, 4 * m); return {...a, R1, R2}; });
    const w = (a, d) => { if (d <= a.R1) return 1; if (d >= a.R2) return 0; const t = (d - a.R1) / (a.R2 - a.R1); return 1 - t * t * (3 - 2 * t); };
    const desl = (x, y) => {
      let sx = 0, sy = 0, S = 0;
      for (const a of A) { const k = w(a, Math.hypot(x - a.x, y - a.y)); if (k > 0) { sx += k * a.vx; sy += k * a.vy; S += k; } }
      const n = Math.max(1, S); return [sx / n, sy / n];
    };
    for (const v of vias) {
      const dens = [v.pts[0]];
      for (let k = 1; k < v.pts.length; k++) {
        const a = v.pts[k - 1], b = v.pts[k], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / o.passo));
        for (let q = 1; q <= n; q++) dens.push(q === n ? b : [a[0] + (b[0] - a[0]) * q / n, a[1] + (b[1] - a[1]) * q / n]);
      }
      v.pts = dens.map(p => { const [dx, dy] = desl(p[0], p[1]); return [p[0] + dx, p[1] + dy]; });
    }
    return vias;
  }
  // ---- ajuste fino manual: operações locais (mover / girar / suavizar) sobre o arruamento já ajustado ----
  // op: {t:'mv', x, y, vx, vy, R} | {t:'rot', x, y, ang(rad), R} | {t:'sua', x, y, R, f(0..1)}  (x,y = centro da operação, R = alcance, m)
  // O efeito é uma função suave da posição (pleno perto do centro, nulo além de R): ruas que se encontram continuam ligadas.
  const pesoOp = (R, d) => { const a = 0.3 * R; if (d <= a) return 1; if (d >= R) return 0; const t = (d - a) / (R - a); return 1 - t * t * (3 - 2 * t); };
  function campoOp(op) {
    if (op.t === 'mv') return (x, y) => { const w = pesoOp(op.R, Math.hypot(x - op.x, y - op.y)); return [x + w * op.vx, y + w * op.vy]; };
    if (op.t === 'rot') return (x, y) => {
      const rx = x - op.x, ry = y - op.y, w = pesoOp(op.R, Math.hypot(rx, ry)), a = op.ang * w, c = Math.cos(a), s = Math.sin(a);
      return [op.x + rx * c - ry * s, op.y + rx * s + ry * c];
    };
    return (x, y) => [x, y];
  }
  function editar(vias, ops, opt) {
    const o = Object.assign({passo: 2.5}, opt || {});
    for (const op of ops || []) {
      const f = campoOp(op);
      if (op.t === 'mv' && op.R >= 1e8) { for (const v of vias) v.pts = v.pts.map(p => [p[0] + op.vx, p[1] + op.vy]); continue; }   // mover todo o arruamento
      for (const v of vias) {
        let perto = false;
        for (const p of v.pts) if (Math.hypot(p[0] - op.x, p[1] - op.y) < op.R) { perto = true; break; }
        if (!perto) continue;
        // densifica só onde precisa (a via inteira, em passo curto) para a deformação ficar suave
        const dens = [v.pts[0]];
        for (let k = 1; k < v.pts.length; k++) {
          const a = v.pts[k - 1], b = v.pts[k], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / o.passo));
          for (let q = 1; q <= n; q++) dens.push(q === n ? b : [a[0] + (b[0] - a[0]) * q / n, a[1] + (b[1] - a[1]) * q / n]);
        }
        let pts = dens;
        if (op.t === 'sua') {
          const iter = Math.round(4 + 26 * (op.f ?? 0.5));
          for (let it = 0; it < iter; it++) {
            const nv = pts.map(p => p);
            for (let k = 1; k < pts.length - 1; k++) {
              const w = pesoOp(op.R, Math.hypot(pts[k][0] - op.x, pts[k][1] - op.y)); if (!w) continue;
              nv[k] = [pts[k][0] + 0.5 * w * ((pts[k - 1][0] + pts[k + 1][0]) / 2 - pts[k][0]), pts[k][1] + 0.5 * w * ((pts[k - 1][1] + pts[k + 1][1]) / 2 - pts[k][1])];
            }
            pts = nv;
          }
        } else pts = pts.map(p => f(p[0], p[1]));
        v.pts = pts.map(p => [p[0], p[1]]);
      }
    }
    return vias;
  }
  // ---- largura por rua: alarga/estreita as duas bordas ou só uma (o eixo se desloca meia diferença para o lado mexido) ----
  // op: {t:'larg', x, y, lado: 0(ambos)|+1|-1 (sinal relativo ao lado do ponto clicado, medido no sentido canônico da via), d (m: quanto cada borda mexida se afasta; <0 estreita)}
  function larguraVia(vias, ops) {
    for (const op of ops || []) {
      let best = null;
      for (const v of vias) { const dd = distPoli(v.pts, op.x, op.y); if (dd <= v.hw + 3 && (!best || dd < best.d)) best = {d: dd, v}; }
      if (!best) continue;
      const v = best.v, cn = canon(v);
      if (!op.lado) { v.hw = Math.max(0.6, v.hw + op.d); continue; }
      const nd = Math.max(-(v.hw - 0.6) * 2, op.d), sg = op.lado * cn;   // sg: lado em relação ao sentido do desenho da via
      const n = v.pts.length, P = v.pts.map(p => p.slice());
      for (let i = 0; i < n; i++) {
        const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L, ny = dx / L;   // normal à esquerda do sentido de desenho
        v.pts[i] = [P[i][0] + sg * nx * nd / 2, P[i][1] + sg * ny * nd / 2];
      }
      v.hw = v.hw + nd / 2;
    }
    return vias;
  }
  // ---- edição direta das bordas (polilinhas do contorno) ----
  // op: {t:'bmv', x, y, vx, vy, R} | {t:'blarg', x, y, d, R} | {t:'bsua', x, y, R, f} | {t:'vtx', x, y, x1, y1} | {t:'vdel', x, y} | {t:'vins', x, y}
  // Cada operação age só na borda (e no lado) mais próxima do ponto: a janela é medida pelo comprimento ao longo da própria borda.
  function editarBordas(bordas, ops, eixos) {
    const nearest = (x, y, lim) => {
      let best = null;
      bordas.forEach((b, bi) => {
        const P = b.pts, n = P.length, m = b.fechado ? n : n - 1;
        for (let i = 0; i < m; i++) {
          const a = P[i], c = P[(i + 1) % n], dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy;
          let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = clamp(t, 0, 1);
          const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
          if (d < lim && (!best || d < best.d)) best = {d, bi, i, t, px: a[0] + t * dx, py: a[1] + t * dy};
        }
      });
      return best;
    };
    const densB = (b, passo) => {
      const P = b.pts, n = P.length, m = b.fechado ? n : n - 1, out = [P[0]];
      for (let i = 0; i < m; i++) {
        const a = P[i], c = P[(i + 1) % n], L = Math.hypot(c[0] - a[0], c[1] - a[1]), k = Math.max(1, Math.ceil(L / passo));
        for (let q = 1; q <= k; q++) { if (b.fechado && i === m - 1 && q === k) break; out.push(q === k ? c : [a[0] + (c[0] - a[0]) * q / k, a[1] + (c[1] - a[1]) * q / k]); }
      }
      return out;
    };
    const vtxMaisPerto = (b, x, y) => { let bi = -1, bd = 1e9; b.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; bi = i; } }); return {i: bi, d: bd}; };
    for (const op of ops || []) {
      if (op.t === 'vtx' || op.t === 'vdel' || op.t === 'vins') {
        const nb = nearest(op.x, op.y, 3); if (!nb) continue; const b = bordas[nb.bi];
        if (op.t === 'vins') { if (Math.hypot(nb.px - b.pts[nb.i][0], nb.py - b.pts[nb.i][1]) > 0.05 && Math.hypot(nb.px - b.pts[(nb.i + 1) % b.pts.length][0], nb.py - b.pts[(nb.i + 1) % b.pts.length][1]) > 0.05) b.pts.splice(nb.i + 1, 0, [op.x, op.y]); continue; }
        const vm = vtxMaisPerto(b, op.x, op.y); if (vm.d > 1.5) continue;
        if (op.t === 'vdel') { if (b.pts.length > (b.fechado ? 3 : 2)) b.pts.splice(vm.i, 1); }
        else b.pts[vm.i] = [op.x1, op.y1];
        continue;
      }
      const nb = nearest(op.x, op.y, 15); if (!nb) continue; const b = bordas[nb.bi];
      const P = densB(b, 2), n = P.length, fech = b.fechado;
      let k0 = 0, bd = 1e9; P.forEach((p, i) => { const d = Math.hypot(p[0] - nb.px, p[1] - nb.py); if (d < bd) { bd = d; k0 = i; } });
      // comprimento ao longo da borda a partir do ponto clicado (pelo caminho mais curto, nos dois sentidos)
      const seg = i => Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]), arc = new Array(n).fill(Infinity); arc[k0] = 0;
      for (let q = 1, a = 0; q < n; q++) { const i = (k0 + q) % n; if (!fech && k0 + q >= n) break; a += seg((i - 1 + n) % n); arc[i] = Math.min(arc[i], a); }
      for (let q = 1, a = 0; q < n; q++) { const i = (k0 - q + n) % n; if (!fech && k0 - q < 0) break; a += seg(i); arc[i] = Math.min(arc[i], a); }
      const W = arc.map(s => pesoOp(op.R, s)), NP = P.map(p => p.slice());
      if (op.t === 'bmv') for (let i = 0; i < n; i++) { NP[i][0] += W[i] * op.vx; NP[i][1] += W[i] * op.vy; }
      else if (op.t === 'blarg') {
        // sentido "para fora" da pista: o lado da normal que mais se afasta dos eixos das ruas
        const nor = i => { const a = P[(i - 1 + n) % n], c = P[(i + 1) % n], dx = c[0] - a[0], dy = c[1] - a[1], L = Math.hypot(dx, dy) || 1; return [-dy / L, dx / L]; };
        const [nx0, ny0] = nor(k0), dA = distEixos(eixos, P[k0][0] + nx0, P[k0][1] + ny0), dB = distEixos(eixos, P[k0][0] - nx0, P[k0][1] - ny0), sg = dA >= dB ? 1 : -1;
        for (let i = 0; i < n; i++) if (W[i] > 0) { const [nx, ny] = nor(i); NP[i][0] += sg * nx * op.d * W[i]; NP[i][1] += sg * ny * op.d * W[i]; }
      } else if (op.t === 'bsua') {
        let Q = P.map(p => p.slice()); const iter = Math.round(4 + 26 * (op.f ?? 0.5));
        for (let it = 0; it < iter; it++) {
          const R2 = Q.map(p => p.slice());
          for (let i = 0; i < n; i++) { if (!W[i] || (!fech && (i === 0 || i === n - 1))) continue; const a = Q[(i - 1 + n) % n], c = Q[(i + 1) % n]; R2[i] = [Q[i][0] + 0.5 * W[i] * ((a[0] + c[0]) / 2 - Q[i][0]), Q[i][1] + 0.5 * W[i] * ((a[1] + c[1]) / 2 - Q[i][1])]; }
          Q = R2;
        }
        for (let i = 0; i < n; i++) NP[i] = Q[i];
      }
      b.pts = NP;
    }
    return bordas;
  }
  // lado (+1/-1, estável) do ponto em relação à via: usado para tratar só uma borda
  const ladoCanon = (v, x, y) => { let best = 1e18, sg = 1; for (let i = 0; i + 1 < v.pts.length; i++) { const a = v.pts[i], b = v.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = clamp(t, 0, 1); const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); if (d < best) { best = d; sg = (dx * (y - a[1]) - dy * (x - a[0])) >= 0 ? 1 : -1; } } return sg * canon(v); };
  const distEixos = (eixos, x, y) => { let b = 1e9; for (const pts of eixos || []) b = Math.min(b, distPoli(pts, x, y)); return b; };
  async function ajustar(vias, postes, opt) {
    const o = Object.assign({maxDesl: 4, margem: 0.2, larguraMin: 0.65, passo: 0.25}, opt || {}), cb = o.cb || (() => {});
    const ign = postes.filter(p => p.regra && (p.regra.ign || p.regra.ax != null)); postes = postes.filter(p => !(p.regra && (p.regra.ign || p.regra.ax != null)));   // posição escolhida: a rua já foi deformada para ela (deformar)
    const alvos = postes.filter(p => p.regra && p.regra.ax != null);
    const nosCont = new Map(), chave = (x, y) => Math.round(x * 2) + ',' + Math.round(y * 2);
    for (const v of vias) for (const p of v.pts) { const k = chave(p[0], p[1]); nosCont.set(k, (nosCont.get(k) || 0) + 1); }
    let rMax = 1; for (const p of postes) rMax = Math.max(rMax, p.r || 0);
    const C = 50, gp = new Map(), cp = (x, y) => Math.floor(x / C) + ',' + Math.floor(y / C);
    postes.forEach((p, k) => { const kk = cp(p.x, p.y); (gp.get(kk) || gp.set(kk, []).get(kk)).push(k); });
    const clear = (p, lv) => { const c0 = (p.r || 0) + o.margem; return [c0, c0 * .5, c0 * .2, .05][lv]; };
    // 1ª passada: quais postes cada rua alcança, e qual é a rua mais próxima de cada poste (a regra de lado vale para ela)
    const info = vias.map(v => {
      const hw = v.hw, hwMin = Math.max(1.2, o.larguraMin * hw);
      let x0 = 1e18, x1 = -1e18, y0 = 1e18, y1 = -1e18;
      for (const p of v.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      const junc = nosCont.get(chave(...v.pts[0])) > 1 || nosCont.get(chave(...v.pts[v.pts.length - 1])) > 1;
      let cap = junc ? Math.min(o.maxDesl, 0.9 * hwMin) : o.maxDesl;   // nas junções a pista ainda tem de se sobrepor à vizinha
      for (const p of alvos) {   // poste com posição escolhida: o deslocamento necessário pode passar do limite comum
        const d = distPoli(v.pts, p.x, p.y);
        if (d < hw + o.maxDesl + 40) { const need = Math.abs(distPoliS(v.pts, p.x, p.y) - distPoliS(v.pts, p.regra.ax, p.regra.ay)) + 0.3; cap = Math.max(cap, Math.min(need, junc ? 0.9 * hwMin : 20)); }
      }
      const R = hw + cap + rMax + o.margem + 1, perto = [], vistos = new Set();
      for (let cx = Math.floor((x0 - R) / C); cx <= Math.floor((x1 + R) / C); cx++) for (let cy = Math.floor((y0 - R) / C); cy <= Math.floor((y1 + R) / C); cy++)
        for (const k of gp.get(cx + ',' + cy) || []) if (!vistos.has(k)) {
          vistos.add(k); const p = postes[k], d = distPoli(v.pts, p.x, p.y);
          if (d - hw - cap < (p.r || 0) + o.margem || (p.regra && (p.regra.lado || p.regra.ax != null) && d < hw + cap + 15)) perto.push({p, k, d0: d});
        }
      return {hw, hwMin, cap, perto};
    });
    const proxima = new Map();
    info.forEach((f, vi) => { for (const q of f.perto) { const m = proxima.get(q.k); if (!m || q.d0 < m.d) proxima.set(q.k, {vi, d: q.d0}); } });
    const saida = [];
    for (let vi = 0; vi < vias.length; vi++) {
      await esp(); cb(`Ajustando ruas ao redor dos postes (${vi + 1}/${vias.length})`, (vi + 1) / vias.length);
      const v = vias[vi], {hw, hwMin, cap, perto} = info[vi], cn = canon(v);
      const r = {...v, pts0: v.pts, pts: v.pts.map(p => p.slice()), hwOrig: hw, tx: 0, ty: 0, nivel: 0};
      saida.push(r);
      if (!perto.length) continue;
      const cand = [[0, 0]], passo = Math.max(o.passo, cap / 14);
      for (let tx = -cap; tx <= cap + 1e-9; tx += passo) for (let ty = -cap; ty <= cap + 1e-9; ty += passo) if ((tx || ty) && Math.hypot(tx, ty) <= cap + 1e-9) cand.push([tx, ty]);
      for (const q of perto) if (q.p.regra && q.p.regra.ax != null) { const tx = q.p.x - q.p.regra.ax, ty = q.p.y - q.p.regra.ay; if (Math.hypot(tx, ty) <= cap + 0.31) cand.push([tx, ty]); }   // deslocamento exato que leva o poste ao ponto indicado
      const sd = cand.map(([tx, ty]) => perto.map(q => distPoliS(v.pts, q.p.x - tx, q.p.y - ty)));   // distância assinada de cada poste à via deslocada
      const req = perto.map(q => q.p.regra && q.p.regra.lado && proxima.get(q.k)?.vi === vi ? q.p.regra.lado * cn : 0);
      const alvoS = perto.map(q => q.p.regra && q.p.regra.ax != null && proxima.get(q.k)?.vi === vi ? distPoliS(v.pts, q.p.regra.ax, q.p.regra.ay) : null);   // onde o poste deve aparecer em relação à rua
      const folga = (i, j, lv) => alvoS[j] != null ? 1e9 : (req[j] && sd[i][j] * req[j] <= 0) ? -1e9 : Math.abs(sd[i][j]) - clear(perto[j].p, lv);
      const errAlvo = i => { let e = 0; for (let j = 0; j < perto.length; j++) if (alvoS[j] != null) e = Math.max(e, Math.abs(sd[i][j] - alvoS[j])); return e; };
      let achou = false;
      for (let lv = 0; lv < 4 && !achou; lv++) {
        let best = 1e18, bi = -1, bh = hw;
        cand.forEach((t, i) => {
          let hmax = hw; for (let j = 0; j < perto.length; j++) hmax = Math.min(hmax, folga(i, j, lv));
          if (hmax < hwMin) return;
          const cost = Math.hypot(t[0], t[1]) + 1.5 * (hw - hmax) + 50 * errAlvo(i);
          if (cost < best - 1e-9) { best = cost; bi = i; bh = hmax; }
        });
        if (bi >= 0) { r.tx = cand[bi][0]; r.ty = cand[bi][1]; r.hw = bh; r.nivel = lv; achou = true; }
      }
      if (!achou) {   // sem solução: pista mais estreita permitida e o deslocamento que menos "invade" os postes
        let best = -1e18, bi = 0;
        cand.forEach((t, i) => { let m = 1e18; for (let j = 0; j < perto.length; j++) m = Math.min(m, Math.abs(sd[i][j]) - hwMin - (req[j] && sd[i][j] * req[j] <= 0 ? 50 : 0)); const sc = m - 0.01 * Math.hypot(t[0], t[1]); if (sc > best) { best = sc; bi = i; } });
        r.tx = cand[bi][0]; r.ty = cand[bi][1]; r.hw = hwMin; r.nivel = 4;
      }
      r.pts = v.pts.map(p => [p[0] + r.tx, p[1] + r.ty]);
    }
    return {vias: saida, rel: avaliarPostes(saida, postes, ign), ign};
  }
  // emendas: pontas que chegam em outra rua (T) vão até o eixo ajustado dela; esquinas se encontram num ponto comum;
  // fins de rua ganham ponta arredondada (disco). Só o arruamento muda; os pontos (postes) nunca são movidos.
  function fecharJuncoes(vias, opt) {
    const o = Object.assign({maxDesl: 4}, opt || {}), key = p => Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2);
    const orig = v => v.pts0 || v.pts, ends = new Map(), inter = new Map(), discos = [];
    vias.forEach((v, i) => {
      const q = orig(v);
      for (const fim of [0, 1]) { const k = key(q[fim ? q.length - 1 : 0]); (ends.get(k) || ends.set(k, []).get(k)).push({i, fim}); }
      for (let j = 1; j < q.length - 1; j++) { const k = key(q[j]); (inter.get(k) || inter.set(k, []).get(k)).push(i); }
    });
    const dirFim = (v, fim) => { const p = v.pts, n = p.length, a = fim ? p[n - 1] : p[0], b = fim ? p[n - 2] : p[1]; const dx = a[0] - b[0], dy = a[1] - b[1], L = Math.hypot(dx, dy) || 1; return {p: a, d: [dx / L, dy / L]}; };
    const moverFim = (v, fim, t) => {
      const {p, d} = dirFim(v, fim), n = v.pts.length, np = [p[0] + t * d[0], p[1] + t * d[1]];
      if (t < 0) { const q = fim ? v.pts[n - 2] : v.pts[1]; if (-t > Math.hypot(p[0] - q[0], p[1] - q[1]) * 0.9) return false; }
      if (fim) v.pts[n - 1] = np; else v.pts[0] = np; return true;
    };
    for (const [k, es] of ends) {
      const hosts = (inter.get(k) || []);
      if (hosts.length) {   // T: vai até o eixo da rua que passa
        for (const e of es) {
          const v = vias[e.i], {p, d} = dirFim(v, e.fim); let best = null;
          for (const h of new Set(hosts)) { if (h === e.i) continue; const H = vias[h].pts;
            for (let j = 0; j + 1 < H.length; j++) {
              const ex = H[j + 1][0] - H[j][0], ey = H[j + 1][1] - H[j][1], den = d[0] * ey - d[1] * ex; if (Math.abs(den) < 1e-9) continue;
              const wx = H[j][0] - p[0], wy = H[j][1] - p[1], t = (wx * ey - wy * ex) / den, u = (wx * d[1] - wy * d[0]) / den;
              if (u >= -0.001 && u <= 1.001 && Math.abs(t) <= 2 * (o.maxDesl + v.hw + vias[h].hw) && (!best || Math.abs(t) < Math.abs(best))) best = t;
            } }
          if (best != null) moverFim(v, e.fim, best);
        }
      } else if (es.length === 1) { const {p} = dirFim(vias[es[0].i], es[0].fim); discos.push({x: p[0], y: p[1], r: vias[es[0].i].hw }); }
      else {   // esquina/bifurcação: ponto comum (mínimos quadrados entre as retas das pontas)
        const L = es.map(e => ({e, ...dirFim(vias[e.i], e.fim)})); let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
        for (const l of L) { const m11 = 1 - l.d[0] * l.d[0], m12 = -l.d[0] * l.d[1], m22 = 1 - l.d[1] * l.d[1]; a11 += m11; a12 += m12; a22 += m22; b1 += m11 * l.p[0] + m12 * l.p[1]; b2 += m12 * l.p[0] + m22 * l.p[1]; }
        const det = a11 * a22 - a12 * a12; let Q;
        if (Math.abs(det) > 1e-6) Q = [(a22 * b1 - a12 * b2) / det, (a11 * b2 - a12 * b1) / det]; else Q = [L.reduce((s, l) => s + l.p[0], 0) / L.length, L.reduce((s, l) => s + l.p[1], 0) / L.length];
        let rr = 0, cx = 0, cy = 0, n = 0;
        for (const l of L) {
          const t = (Q[0] - l.p[0]) * l.d[0] + (Q[1] - l.p[1]) * l.d[1], v = vias[l.e.i]; rr = Math.max(rr, v.hw);
          if (Math.abs(t) <= 2 * (o.maxDesl + v.hw)) moverFim(v, l.e.fim, t);
          const f = dirFim(v, l.e.fim).p; cx += f[0]; cy += f[1]; n++;
        }
        discos.push({x: cx / n, y: cy / n, r: rr});
      }
    }
    return discos;
  }
  function simplificar(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let md = 0, mi = -1; const [ax, ay] = pts[a], dx = pts[b][0] - ax, dy = pts[b][1] - ay, l2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) { let t = l2 ? ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2 : 0; t = clamp(t, 0, 1); const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy); if (d > md) { md = d; mi = i; } }
      if (md > tol && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // recorta um anel (caminho fechado repetindo o 1º ponto) pela área, segmento a segmento (o recorte de caminho aberto do Clipper falha em alguns pontos de partida)
  async function recortarAnel(ring, clip, CL) {
    let cx0 = 1e18, cy0 = 1e18, cx1 = -1e18, cy1 = -1e18; for (const p of clip) { cx0 = Math.min(cx0, p.X); cx1 = Math.max(cx1, p.X); cy0 = Math.min(cy0, p.Y); cy1 = Math.max(cy1, p.Y); }
    const pieces = []; let cur = null;
    const igual = (a, b) => Math.abs(a.X - b.X) <= 1 && Math.abs(a.Y - b.Y) <= 1;
    for (let i = 0; i + 1 < ring.length; i++) {
      if (i % 400 === 0) await esp();
      const a = ring[i], b = ring[i + 1];
      if (Math.max(a.X, b.X) < cx0 || Math.min(a.X, b.X) > cx1 || Math.max(a.Y, b.Y) < cy0 || Math.min(a.Y, b.Y) > cy1) { cur = null; continue; }
      const c = new CL.Clipper(), pt = new CL.PolyTree();
      c.AddPath([a, b], CL.PolyType.ptSubject, false); c.AddPaths([clip], CL.PolyType.ptClip, true);
      c.Execute(CL.ClipType.ctIntersection, pt, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
      const rs = CL.Clipper.OpenPathsFromPolyTree(pt);
      if (!rs.length) { cur = null; continue; }
      for (const r of rs) {
        if (r.length < 2) continue;
        if (cur && igual(cur[cur.length - 1], r[0])) cur.push(...r.slice(1)); else { cur = r.slice(); pieces.push(cur); }
      }
      if (rs.length !== 1 || !igual(rs[0][rs[0].length - 1], b)) cur = null;   // saiu da área dentro deste segmento
    }
    if (pieces.length > 1 && igual(pieces[pieces.length - 1][pieces[pieces.length - 1].length - 1], pieces[0][0])) { const u = pieces.pop(); pieces[0] = u.concat(pieces[0].slice(1)); }
    return pieces.filter(p => p.length >= 2).map(p => ({pts: p, fechado: p.length > 3 && igual(p[0], p[p.length - 1])}));
  }
  // ---- pavimento: buffer + união; devolve só as bordas, recortadas pela área ----
  async function bordas(vias, area, org, opt) {
    const cb = (opt && opt.cb) || (() => {});
    // org: [x0,y0] para manter inteiros pequenos; area: polígono [[x,y]] ou null
    const S = ESC_C, ox = org[0], oy = org[1];
    const grupos = new Map();
    for (const v of vias) {
      if (v.pts.length < 2) continue;
      const k = Math.round(v.hw * 20) / 20;
      (grupos.get(k) || grupos.set(k, []).get(k)).push(simplificar(v.pts, 0.1).map(p => ({X: Math.round((p[0] - ox) * S), Y: Math.round((p[1] - oy) * S)})));
    }
    const todos = new CL.Paths();
    for (const [hw, paths] of grupos) {
      await esp(); cb('Calculando a largura da pista...', 0.2);
      const co = new CL.ClipperOffset(2, 25);
      co.AddPaths(paths, CL.JoinType.jtRound, CL.EndType.etOpenButt);
      const sol = new CL.Paths(); co.Execute(sol, hw * S);
      for (const p of sol) todos.push(p);
    }
    for (const dc of (opt && opt.discos) || []) {
      const n = clamp(Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - 0.025 / Math.max(dc.r, 0.1)))), 24, 72), c = [];
      for (let q = 0; q < n; q++) { const an = 2 * Math.PI * q / n; c.push({X: Math.round((dc.x - ox + dc.r * Math.cos(an)) * S), Y: Math.round((dc.y - oy + dc.r * Math.sin(an)) * S)}); }
      if (!CL.Clipper.Orientation(c)) c.reverse(); todos.push(c);
    }
    await esp(); cb('Unindo as pistas...', 0.45);
    const cl = new CL.Clipper(); let uni = new CL.Paths();
    cl.AddPaths(todos, CL.PolyType.ptSubject, true);
    cl.Execute(CL.ClipType.ctUnion, uni, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
    // limpeza global: fechamento (raio = curva do meio-fio nas esquinas, preenche entradas e picos) e abertura leve (apara picos para fora)
    const off = (paths, d) => { const co = new CL.ClipperOffset(2, 25); co.AddPaths(paths, CL.JoinType.jtRound, CL.EndType.etClosedPolygon); const r = new CL.Paths(); co.Execute(r, d * S); return r; };
    let hmin = 1e9; for (const v of vias) hmin = Math.min(hmin, v.hw);
    const rf = Math.max(0, Math.min((opt && opt.raio) || 0, 8)), ra = Math.min(0.9, 0.4 * hmin);
    await esp(); cb('Suavizando esquinas e emendas...', 0.6);
    if (rf > 0.05) uni = off(off(uni, rf), -rf);
    if (ra > 0.05) uni = off(off(uni, -ra), ra);
    const aneis = [];
    const clip = area ? [area.map(p => ({X: Math.round((p[0] - ox) * S), Y: Math.round((p[1] - oy) * S)}))] : null;
    let nr = 0;
    for (const r of uni) {
      await esp(); cb('Recortando as bordas pela área...', 0.7 + 0.3 * (++nr / uni.length));
      if (r.length < 3) continue;
      const aberto = r.concat([r[0]]);
      if (!clip) { aneis.push({pts: simplificar(r.map(p => [p.X / S + ox, p.Y / S + oy]).concat([[r[0].X / S + ox, r[0].Y / S + oy]]), 0.04).slice(0, -1), fechado: true}); continue; }
      for (const q0 of await recortarAnel(aberto, clip[0], CL)) {
        const q = simplificar(q0.pts.map(p => [p.X / S + ox, p.Y / S + oy]), 0.04);
        aneis.push({pts: q0.fechado ? q.slice(0, -1) : q, fechado: q0.fechado});
      }
    }
    return aneis;
  }
  // recorta uma polilinha por um retângulo (Liang-Barsky), devolvendo os pedaços internos
  function recortarRet(pts, x0, y0, x1, y1) {
    const out = []; let cur = null;
    for (let k = 0; k + 1 < pts.length; k++) {
      let [ax, ay] = pts[k], [bx, by] = pts[k + 1]; const dx = bx - ax, dy = by - ay; let t0 = 0, t1 = 1, ok = true;
      for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
        if (p === 0) { if (q < 0) { ok = false; break; } } else { const r = q / p; if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; } }
      }
      if (!ok) { cur = null; continue; }
      const pa = [ax + t0 * dx, ay + t0 * dy], pb = [ax + t1 * dx, ay + t1 * dy];
      if (cur && t0 === 0) cur.push(pb); else { cur = [pa, pb]; out.push(cur); }
      if (t1 < 1) cur = null;
    }
    return out;
  }
  return {init, largura, recortarRet, encadear, fecharJuncoes, avaliarPostes, ajustar, deformar, editar, campoOp, larguraVia, editarBordas, ladoCanon, bordas, densificar, projetar, simplificar, LARG};
})();
'use strict';
