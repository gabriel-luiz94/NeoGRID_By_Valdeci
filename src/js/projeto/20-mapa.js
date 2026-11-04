/* Aplica ao mapa inteiro a mesma configuração do Projeto: regras, blocos, cores e rótulos.
   O renderizador do NeoGrid chama estas funções e guarda o resultado por elemento. */

const ngMapa = (() => {
  let versao = 1;
  const formasMapa = {ret: 'rectangle', quad: 'square', circ: 'circle', tri: 'triangle', linha: 'line', losango: 'square'};
  const compativel = new Map();   // store -> "dataset" no formato que as expressões esperam

  function dsDe(type, store) {
    let d = compativel.get(store);
    if (!d || d.h !== store.headers || d.h.length !== d.hi.size) {
      const g = n => store.headers.indexOf(n);
      d = {h: store.headers, hi: new Map(store.headers.map((n, j) => [n, j])), rows: store.rows, X: store.X, Y: store.Y,
        na: g('NU_ANGULO'), id: g('NU_PG_ID'), pi: store.headers.findIndex(n => /^NU_PG_INI/.test(n)), pf: store.headers.findIndex(n => /^NU_PG_FIN/.test(n)),
        w: store.wkt, len: new Map(), mp: new Map(), by: new Map(),
        // geometria já interpretada pelo NeoGrid (anéis de [lat, lon])
        geo: {get: i => store.getGeometry(i), set() {}, clear() {}, size: 0}};
      compativel.set(store, d);
    }
    return d;
  }
  function avaliar(fonte, type, store, index) {
    if (!fonte) return null;
    const c = Expr.compile(fonte); if (c.err) return null;
    const d = dsDe(type, store);
    CTX.t = type; CTX.d = d; CTX.i = index; CTX.r = store.rows[index];
    try { return c.fn(CTX); } catch (e) { return null; }
  }
  function regra(type, store, index) {
    const rs = CFG.cam[type].rules;
    for (const r of rs) if (r.on && r.expr && truthy(avaliar(r.expr, type, store, index))) return r;
    return null;
  }
  return {
    versao: () => versao,
    alterada() { versao++; compativel.clear(); window.NG?.mapaAlterado?.(); },
    temRegras: type => CFG.cam[type].rules.some(r => r.on && r.expr),
    /** Estilo efetivo do elemento: base da camada + primeira regra que combinar. */
    estilo(type, store, index) {
      const c = CFG.cam[type], r = c.rules.length ? regra(type, store, index) : null, e = r ? {...c.base, ...r.est} : c.base;
      const bl = e.bloco ? BLOCOS[e.bloco] : null;
      return {cor: e.cor, larg: e.larg, tam: e.tam, opac: e.opac, bordaW: e.bordaW, girar: e.girar !== false, blocoModo: e.blocoModo, blocoK: e.blocoK, bl, forma: formasMapa[e.forma] || 'rectangle'};
    },
    /** Linhas de texto dos rótulos ligados, com a cor do primeiro que apareceu. */
    rotulo(type, store, index) {
      const linhas = []; let cor = null, est = null;
      for (const l of CFG.cam[type].labels) {
        if (!l.on || !l.expr) continue;
        if (l.filtro && !truthy(avaliar(l.filtro, type, store, index))) continue;
        const v = avaliar(l.expr, type, store, index), s = v == null ? '' : toStr(v);
        for (const q of s.split('\n')) if (q.trim()) linhas.push(q.trim());
        if (s && !cor) { cor = l.cor; est = l; }
      }
      linhas.cor = cor;
      linhas.est = est;
      return linhas;
    },
    /** Estilo do KML, que o mapa também segue. */
    kml() {
      const p = CFG.cam.kmlp, l = CFG.cam.kmll;
      return {ponto: p.base.cor, linha: l.base.cor, raio: (p.base.tam || 10) / 2, larg: l.base.larg || 2, corKml: p.base.corKml !== false && l.base.corKml !== false, rotulos: p.labels.some(r => r.on) || l.labels.some(r => r.on)};
    },
    cores: () => Object.fromEntries(['poste', 'inst', 'bt', 'mt'].map(t => [t, CFG.cam[t].base.cor])),
    desenharBloco,
  };
})();
window.ngMapa = ngMapa;

// ---- ruas guardadas como camada de consulta do mapa (nunca baixa nada sozinha) ----
const ruasMapa = (() => {
  const grupo = L.layerGroup(), linhas = L.canvas({padding: .2});
  let ligada = false, seq = 0;
  async function atualizar() {
    if (!ligada) return;
    const s = ++seq;
    if (map.getZoom() < 14) { grupo.clearLayers(); window.NG.avisoRuasMapa('Aproxime o zoom para ver as ruas guardadas.'); return; }
    const b = map.getBounds(), tl = tilesDe({w: b.getWest(), e: b.getEast(), s: b.getSouth(), n: b.getNorth()}, 0);
    const vistos = new Set(), novas = []; let faltam = 0;
    for (const [ix, iy] of tl) {
      const t = await cacheLer(tlChave(ix, iy));
      if (s !== seq) return;
      if (!t) { faltam++; continue; }
      for (const w of t.ways) {
        if (vistos.has(w.i)) continue; vistos.add(w.i);
        novas.push(L.polyline(w.p, {renderer: linhas, color: '#ff9f1c', weight: 1.5, opacity: .8, interactive: false}));
      }
    }
    grupo.clearLayers(); novas.forEach(l => l.addTo(grupo));
    window.NG.avisoRuasMapa(faltam ? 'Parte desta área não tem ruas guardadas. Instale o pacote de ruas em Exportações.' : '');
  }
  map.on('moveend', atualizar);
  return {
    alternar() {
      ligada = !ligada;
      if (ligada) { grupo.addTo(map); atualizar(); } else { grupo.remove(); seq++; window.NG.avisoRuasMapa(''); }
      return ligada;
    },
  };
})();
