/* Aplica ao mapa inteiro a mesma configuração do Projeto: regras, blocos, cores e rótulos.
   O renderizador do NeoGrid chama estas funções e guarda o resultado por elemento. */

// Rótulos da camada ligados no mapa? Pontos e linhas do KML respondem juntos à chave "kml".
const rotuloLigado = g => CFG.mapa?.rot?.[KML(g) ? 'kml' : g] !== false;

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
      if (!rotuloLigado(type)) { linhas.cor = null; linhas.est = null; return linhas; }
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
      return {
        ponto: p.base.cor,
        linha: l.base.cor,
        raio: (p.base.tam || 10) / 2,
        larg: l.base.larg || 2,
        opac: l.base.opac ?? 0.9,
        corKml: p.base.corKml !== false && l.base.corKml !== false,
        largKml: l.base.largKml === true,
        opacKml: l.base.opacKml === true,
        rotulos: rotuloLigado('kml') && (p.labels.some(r => r.on) || l.labels.some(r => r.on)),
      };
    },
    cores: () => ({...Object.fromEntries(['poste', 'inst', 'bt', 'mt'].map(t => [t, CFG.cam[t].base.cor])), kml: CFG.cam.kmll.base.cor, ruas: CFG.mapa.ruas.cor}),
    rotuloLigado,
    /** Liga ou desliga os rótulos de uma camada no mapa (poste, inst, bt, mt, kml, ruas). */
    definirRotulo(grupo, on) {
      if (!(grupo in CFG.mapa.rot)) return;
      CFG.mapa.rot[grupo] = !!on; salvar();
      if (grupo === 'ruas') ruasMapa.redesenhar();
      else this.alterada();
    },
    desenharBloco,
  };
})();
window.ngMapa = ngMapa;

// ---- ruas guardadas como camada de consulta do mapa (nunca baixa nada sozinha) ----
const ruasMapa = (() => {
  const grupo = L.layerGroup(), linhas = L.canvas({padding: .2});
  let ligada = false, pausada = false, seq = 0, avisar = false, avisoNaTela = false;
  // Só quem acabou de ligar a camada recebe avisos: ligada desde a abertura, ela não incomoda.
  const aviso = texto => {
    const mostrar = avisar ? texto : '';
    if (!mostrar && !avisoNaTela) return;
    avisoNaTela = !!mostrar; window.NG.avisoRuasMapa(mostrar);
  };
  function aplicar() {
    if (ligada && !pausada) { grupo.addTo(map); disparar(); } else { grupo.remove(); seq++; aviso(''); }
  }
  async function atualizar() {
    if (!ligada || pausada) return;
    const s = ++seq;
    if (map.getZoom() < 14) { grupo.clearLayers(); aviso('Aproxime o zoom para ver as ruas guardadas.'); return; }
    const b = map.getBounds(), tl = tilesDe({w: b.getWest(), e: b.getEast(), s: b.getSouth(), n: b.getNorth()}, 0);
    const vistos = new Set(), novas = [], est = CFG.mapa.ruas; let faltam = 0;
    // Nome da rua: um rótulo por nome, no trecho mais longo que aparece na tela.
    const comNome = window.NG.rotulosGerais?.() !== false && rotuloLigado('ruas') && map.getZoom() >= (est.rotMinZ || 17);
    const maiorPorNome = new Map();
    for (const [ix, iy] of tl) {
      const t = await cacheLer(tlChave(ix, iy));
      if (s !== seq) return;
      if (!t) { faltam++; continue; }
      for (const w of t.ways) {
        if (vistos.has(w.i)) continue; vistos.add(w.i);
        const linha = L.polyline(w.p, {renderer: linhas, color: est.cor, weight: est.larg, opacity: est.opac, interactive: false});
        novas.push(linha);
        const nome = comNome && w.t && w.t.name;
        if (!nome) continue;
        const tam = w.p.length > 1 ? hav(w.p[0][0], w.p[0][1], w.p[w.p.length - 1][0], w.p[w.p.length - 1][1]) : 0;
        const atual = maiorPorNome.get(nome);
        if (!atual || tam > atual.tam) maiorPorNome.set(nome, {linha, tam});
      }
    }
    grupo.clearLayers(); novas.forEach(l => l.addTo(grupo));
    let n = 0;
    for (const [nome, {linha}] of maiorPorNome) {
      if (n++ >= 150) break;
      linha.bindTooltip(nome.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]), {permanent: true, direction: 'center', className: 'ruas-label', opacity: .92});
    }
    document.documentElement.style.setProperty('--ruas-rotulo', est.rotCor || '#ffe2b8');
    aviso(faltam ? 'Parte desta área não tem ruas guardadas. Instale o pacote de ruas em Exportações.' : '');
  }
  let emCurso = Promise.resolve();
  const disparar = () => { emCurso = atualizar().catch(e => console.warn('[ruas]', e)); };
  map.on('moveend', disparar);
  return {
    definir(on, comAviso = false) {
      avisar = on && comAviso;
      if (on === ligada) { if (avisar) disparar(); else aviso(''); return; }
      ligada = on; aplicar();
    },
    pausar(on) { pausada = on; aplicar(); },   // com o projeto aberto, só o desenho dele aparece
    ligada: () => ligada,
    redesenhar() { if (ligada && !pausada) disparar(); },   // estilo ou rótulos mudaram
    nomes: () => grupo.getLayers().filter(l => l.getTooltip && l.getTooltip()).length,
    desenhadas: () => grupo.getLayers().length,
    noMapa: () => map.hasLayer(grupo),
    pronto: () => emCurso,   // a impressão espera as ruas da folha
  };
})();
window.ngRuasMapa = ruasMapa;
syncCamadaRuas();
