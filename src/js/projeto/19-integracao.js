/* Liga o motor do módulo Projeto ao NeoGrid: eventos do mapa, botões e configuração salva. */

const achado = L.layerGroup().addTo(map);
function desenhar() { if (PJ.on) pjAgendar(); ngMapa.alterada(); }

// Avisos do motor viram toasts do NeoGrid: não bloqueiam a janela como o alert do navegador.
const alert = m => window.NG.avisar(String(m));

function ligar() {
  map.on('click', e => {
    if (PJ.on) return;   // modo Projeto: parâmetros/popup congelados
    if (Date.now() < semClique) return;
    if (medir) { medPts.push(e.latlng); medirAtualiza(); return; }
    if (modo === 'poli') { polyPts.push(e.latlng); polyL?.remove(); polyL = L.polyline(polyPts, {color: COR_DESTAQUE(), weight: 2, dashArray: '5 4', interactive: false}).addTo(map); }
  });
  map.on('dblclick', () => {
    if (medir) { medPts.pop(); medirAtualiza(); medir = false; $('#mapMedir')?.classList.remove('is-active'); map.doubleClickZoom.enable(); map.getContainer().style.cursor = ''; return; }
    if (modo === 'poli') {
      while (polyPts.length > 1 && polyPts[polyPts.length - 1].equals(polyPts[polyPts.length - 2], 1e-9)) polyPts.pop();
      if (polyPts.length < 3) { $('#st').textContent = 'O polígono precisa de ao menos 3 vértices'; return; }
      const pts = polyPts.slice(); selFim(L.latLngBounds(pts), pts.map(p => [p.lat, p.lng]));
    }
  });
  map.on('mousedown', e => {
    if (modo !== 'ret' || e.originalEvent.button) return;
    dxA = e.latlng; selGrp.clearLayers(); selForma = L.rectangle([dxA, dxA], {color: COR_DESTAQUE(), weight: 2, fillOpacity: .08, interactive: false}).addTo(selGrp);
  });
  map.on('mousemove', e => {
    if (modo === 'ret' && dxA) selForma.setBounds([dxA, e.latlng]);
    else if (modo === 'poli' && polyPts.length) { polyL?.remove(); polyL = L.polyline([...polyPts, e.latlng], {color: COR_DESTAQUE(), weight: 2, dashArray: '5 4', interactive: false}).addTo(map); }
  });
  map.on('mouseup', e => {
    if (modo !== 'ret' || !dxA) return;
    const b = L.latLngBounds(dxA, e.latlng), c = b.getCenter(), wm = (b.getEast() - b.getWest()) * 111320 * Math.cos(c.lat * RAD), hm = (b.getNorth() - b.getSouth()) * 111320;
    if (wm < 2 || hm < 2) { selCancelar(); return; }
    selFim(b, null);
  });
  $('#modo-x').onclick = sairModos;
  $('#arqdxf').onchange = e => { importarDXF([...e.target.files]); e.target.value = ''; };
  $('#arqcfg').onchange = e => { if (e.target.files[0]) importarCfg(e.target.files[0]); e.target.value = ''; };
  $('#spx').onclick = fecharSP;
  $('#pjret').onclick = () => selIniciar('ret');
  $('#pjpol').onclick = () => selIniciar('poli');
  $('#pjcria').onclick = () => projAbrir();
  $('#pjestilos').onclick = () => abrirSP();
  $('#dxgo').onclick = baixarDXF;
  $('#dxqt').onclick = mostrarQuant;
  $('#dxgj').onclick = baixarGeoJSON;
  $('#arpv').onclick = () => mostrarArruamento();
  $('#arlp').onclick = reiniciarArruamento;
  $('#pjcl').onclick = limparPoligono;
  $('#lay-ruas').onchange = e => camadaRuas(e.target.checked, true);
  $('#arrg').onclick = () => guardarRuas(SEL?.b || map.getBounds());
  $('#arrl').onclick = apagarRuasGuardadas;
  $('#consx').onclick = () => { $('#cons').hidden = true; };
  $('#pjCamTodas').onclick = async () => {
    const ligar = !NG_CAMADAS.every(([t]) => ngCamadaLigada(t));
    for (const [t] of NG_CAMADAS) await ngLigarCamada(t, ligar);
  };
}

// Um painel lateral por vez, na coluna do painel de camadas: o mapa nunca fica coberto.
function ligarPaineis() {
  const paineis = ['#prj', '#sp', '#cons'].map(s => $(s));
  let travando = false;
  const atualizar = () => {
    const algum = paineis.some(p => !p.hidden);
    window.NG.colunaProjeto(algum);
    map.invalidateSize({pan: false});
  };
  new MutationObserver(muts => {
    if (travando) return;
    travando = true;
    try {
      const novo = muts.map(m => m.target).reverse().find(p => paineis.includes(p) && !p.hidden);
      // Estilos abre por cima do Projeto e devolve a ele ao fechar: o projeto continua ativo.
      if (novo && novo.id !== 'sp') for (const p of paineis) if (p !== novo) p.hidden = true;
      if (novo && novo.id === 'sp') $('#cons').hidden = true;
      if (!$('#sp').hidden) $('#prj').classList.add('prj-recuado'); else $('#prj').classList.remove('prj-recuado');
    } finally { travando = false; }
    atualizar();
  }).observe($('#ngPaineis'), {subtree: true, attributes: true, attributeFilter: ['hidden']});
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (sairModos()) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (!$('#sp').hidden) fecharSP();
    else if (!$('#cons').hidden) $('#cons').hidden = true;
  });
}

// ---- Camadas sempre visíveis no painel: desligar aqui tira a entidade do mapa, do projeto e da entrega.
const NG_CAMADAS = [['poste', 'Postes'], ['bt', 'Rede BT'], ['mt', 'Rede MT'], ['inst', 'Instalações'], ['kml', 'KML'], ['ruas', 'Ruas']];
function ngNomesCamada(t) {
  const c = CFG.dxf.camadas, nomes = t === 'kml' ? [c.kmlp, c.kmll, 'TXT_KML'] : t === 'ruas' ? [c.ruas, c.ruasOrig, c.txtRuas] : [c[t], ...CFG.cam[t].labels.map(l => l.camada || ('TXT_' + t.toUpperCase()))];
  return nomes.filter(Boolean).map(san);
}
function ngCamadaLigada(t) {
  if (PJ.on) return !ngNomesCamada(t).every(n => PRJ().cam[n] && PRJ().cam[n].oculto);
  if (t === 'ruas') return camadaRuasLigada();
  if (t === 'kml') return ativo.kmlp !== false;
  return window.NG.camadaVisivel(t);
}
const camadaOculta = t => PJ.on && !ngCamadaLigada(KML(t) ? 'kml' : t);
async function ngLigarCamada(t, on) {
  if (t !== 'ruas' && t !== 'kml') window.NG.ligarCamada(t, on);
  if (t === 'kml') { ativo.kmlp = ativo.kmll = on; window.NG.kmlVisivel(on); }
  if (t === 'ruas' && !PJ.on) camadaRuas(on);
  if (PJ.on) {
    const P = PRJ();
    for (const n of ngNomesCamada(t)) (P.cam[n] = P.cam[n] || {}).oculto = !on;
  }
  // A área só traz o que estava ligado ao ser lida: ligar uma camada nova exige ler de novo.
  if (SEL && SEL.dados && t !== 'ruas' && t !== 'kml') {
    if (on && !SEL.dados[t] && window.NG.camadaTemDados(t)) {
      SEL.dados[t] = await window.NG.lerCamadaDS(t, SEL.b);
      SEL.ids = usarSel(() => selIds(SEL));
      if (PJ.on) await pjRegerar();
    } else if (!on && !PJ.on) {
      delete SEL.dados[t];
      SEL.ids = usarSel(() => selIds(SEL));
    }
  }
  salvar();
  if (PJ.on) { pjPainel(); pjDesenhar(); }
  ngCamadasPintar();
}
function ngCamadasPintar() {
  const caixa = $('#pjCamadasL'); if (!caixa) return;
  caixa.replaceChildren(...NG_CAMADAS.map(([t, nome]) => {
    const ch = mk('input', {type: 'checkbox', class: 'switch', onchange: e => ngLigarCamada(t, e.target.checked)}); ch.checked = ngCamadaLigada(t);
    return mk('label', {class: 'prj-cam'}, mk('span', null, nome), ch);
  }));
  const todas = NG_CAMADAS.every(([t]) => ngCamadaLigada(t));
  $('#pjCamTodas').textContent = todas ? 'Ocultar tudo' : 'Mostrar tudo';
}

function ngMigrarPaleta() {
  if ((CFG.v || 1) >= 2) return;
  const trocas = {poste: {cor: ['#f2a900', '#fbbf24'], borda: ['#10202b', '#08141c']}, inst: {cor: ['#e5e7eb', '#a78bfa'], borda: ['#10202b', '#08141c']}, bt: {cor: ['#22c55e', '#2dd4bf'], larg: [3, 2.8]}, mt: {cor: ['#ef4444', '#fb7185'], larg: [6, 5]}, kmlp: {cor: ['#ffd400', '#f472b6'], borda: ['#10202b', '#08141c']}, kmll: {cor: ['#ff9f1c', '#38bdf8'], larg: [3, 2]}};
  const antigasRegras = ['#a855f7', '#f97316', '#4ade80'];
  for (const [t, campos] of Object.entries(trocas)) {
    const c = CFG.cam[t]; if (!c) continue;
    for (const [k, [velho, novo]] of Object.entries(campos)) if (c.base[k] === velho) c.base[k] = novo;
    for (const r of c.rules || []) if (r.est && antigasRegras.includes(r.est.cor)) delete r.est.cor;
    for (const l of c.labels || []) {
      if (l.fonte === 'Segoe UI') l.fonte = 'Inter Variable';
      if (l.haloCor === '#000000') l.haloCor = '#03080c';
      if (t === 'inst' && l.cor === '#ffffff') l.cor = '#f1f5f9';
    }
  }
  CFG.v = 2;
}

async function ngIniciarProjeto() {
  try {
    const sv = await window.NG.wsGet('cfg');
    if (sv) {
      CFG = mesclar(cfgPadrao(), sv.CFG);
      for (const [k, b] of Object.entries(sv.BLOCOS || {})) BLOCOS[k] = DXF.prepBloco(b);
    } else window.NG.aplicarDesenhoNeoGrid();
  } catch (e) { console.warn('[projeto] configuração não restaurada', e); }
  CFG.pacote = mesclar(PACOTE_PADRAO(), CFG.pacote);
  normalizarCfg();
  ngMigrarPaleta();
  ligar(); ligarPaineis(); edtLigar(); projLigar(); limLigar(); limAplicar(); syncCamadaRuas();
  prjUI(); ngCamadasPintar();
  ngMapa.alterada();
}
// Usado pelo NeoGrid para saber se o clique no mapa pertence a uma ferramenta do projeto.
const ngCapturando = () => !!(modo || medir || PJ.on || (typeof EDT !== 'undefined' && EDT.tool));
