/* Painel de estilos, rótulos e blocos (origem: CTWeb). */
const SP = {aba: 'camadas', sub: 'ap', l: 0};
function mk(tag, p, ...k) {
  const e = document.createElement(tag);
  if (p) for (const [a, v] of Object.entries(p)) {
    if (a === 'class') e.className = v; else if (a === 'style') e.style.cssText = v;
    else if (a.startsWith('on')) e[a] = v; else if (v === true) e.setAttribute(a, ''); else if (v !== false && v != null) e.setAttribute(a, v);
  }
  for (const c of k.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const fr = (rot, e, dica) => mk('label', {class: 'fr', title: dica || ''}, mk('span', null, rot), e);
function ctl(o, k, sp, ch) {
  let e;
  const done = () => { sp.on && sp.on(); ch && ch(); if (sp.re) renderSP(); };
  switch (sp.t) {
    case 'chk': e = mk('input', {type: 'checkbox'}); e.checked = !!o[k]; e.onchange = () => { o[k] = e.checked; done(); }; break;
    case 'num': e = mk('input', {type: 'number', min: sp.min, max: sp.max, step: sp.step || 1}); e.value = o[k]; e.oninput = () => { const v = parseFloat(e.value); if (isFinite(v)) { o[k] = v; done(); } }; break;
    case 'cor': e = mk('input', {type: 'color'}); e.value = /^#[0-9a-f]{6}$/i.test(o[k]) ? o[k] : '#000000'; e.oninput = () => { o[k] = e.value; done(); }; break;
    case 'sel': e = mk('select'); for (const [v, l] of sp.o) e.append(mk('option', {value: v}, l)); e.value = o[k]; e.onchange = () => { o[k] = e.value; done(); }; break;
    case 'area': e = mk('textarea', {rows: sp.rows || 2}); e.value = o[k] || ''; e.oninput = () => { o[k] = e.value; done(); }; break;
    default: e = mk('input', {type: 'text'}); e.value = o[k] ?? ''; e.oninput = () => { o[k] = e.value; done(); };
  }
  return e;
}
const sec = (titulo, ...kids) => mk('details', {class: 'sec', open: true}, mk('summary', null, titulo), ...kids);
const amostra = t => ULT && ULT.t === t ? ULT : (D[t] && D[t].rows.length ? {t, i: 0} : null);
function campos(t) {
  const d = D[t];
  const lista = d ? d.h : (window.NG?.campos?.(t) || []);
  return lista.filter(n => n !== 'GEOMETRIA_WKT');
}
function editorExpr(o, k, t, {rows = 2, M, filtro = false, presets = [], multicampos = false}) {
  const ta = mk('textarea', {rows, spellcheck: 'false', class: 'mono'}); ta.value = o[k] || '';
  const st = mk('div', {class: 'ex-st'});
  const atualiza = () => {
    const src = ta.value;
    if (!src.trim()) { st.textContent = filtro ? '(vazio: vale para todos os elementos)' : '(vazio)'; st.className = 'ex-st'; return; }
    const c = Expr.compile(src);
    if (c.err) { st.textContent = 'Erro: ' + c.err; st.className = 'ex-st err'; return; }
    const am = amostra(t);
    if (!am) { st.textContent = 'Expressão válida (carregue os dados para ver a prévia)'; st.className = 'ex-st'; return; }
    const v = ev(src, t, am.i);
    st.className = 'ex-st ok';
    st.textContent = 'Prévia: ' + (v === null ? 'NULL' : typeof v === 'string' ? '"' + v.replace(/\n/g, '↵') + '"' : String(v));
  };
  let tm;
  ta.oninput = () => { o[k] = ta.value; atualiza(); clearTimeout(tm); tm = setTimeout(M, 250); };
  const ins = txt => {
    const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
    ta.value = ta.value.slice(0, a) + txt + ta.value.slice(b); ta.focus(); ta.selectionStart = ta.selectionEnd = a + txt.length; ta.oninput();
  };
  const sCampo = mk('select', {title: 'Inserir campo'}, mk('option', {value: ''}, '+ campo'), campos(t).map(n => mk('option', {value: n}, n)));
  sCampo.onchange = () => { if (sCampo.value) ins('"' + sCampo.value + '"'); sCampo.value = ''; };
  const sFn = mk('select', {title: 'Inserir função'}, mk('option', {value: ''}, '+ função'),
    Expr.DOC.map(([g, l]) => mk('optgroup', {label: g}, l.map(([s, d]) => mk('option', {value: s}, s + '   — ' + d)))));
  sFn.onchange = () => { if (sFn.value) ins(sFn.value); sFn.value = ''; };

  // Vários campos de uma vez: marque na lista, escolha o separador e insira.
  let painel = null;
  if (multicampos) {
    const am = amostra(t);
    const exemplo = nome => {
      if (!am) return '';
      const d = D[am.t];
      const j = d?.h?.indexOf(nome) ?? -1;
      const v = j >= 0 ? d?.rows?.[am.i]?.[j] : '';
      return v == null || v === '' ? '' : String(v).replace(/\s+/g, ' ').slice(0, 32);
    };
    const filtroCampo = mk('input', {type: 'search', class: 'ex-campos-filtro', placeholder: 'Filtrar campos…'});
    const separador = mk('select', {class: 'ex-campos-sep', title: 'Separador entre os campos'},
      [["'\\n'", 'Nova linha'], ["' · '", '·'], ["' - '", '-'], ["', '", ', '], ["' / '", '/']].map(([v, l]) => mk('option', {value: v}, l)));
    const itens = campos(t).map(nome => {
      const ck = mk('input', {type: 'checkbox', value: nome});
      const ex = exemplo(nome);
      const item = mk('label', {class: 'ex-campo'}, ck, mk('span', null, nome), ex ? mk('small', null, 'ex.: ' + ex) : null);
      item.dataset.busca = `${nome} ${ex}`.toLowerCase();
      return item;
    });
    filtroCampo.oninput = () => {
      const q = filtroCampo.value.trim().toLowerCase();
      itens.forEach(item => { item.hidden = Boolean(q) && !item.dataset.busca.includes(q); });
    };
    const inserir = mk('button', {type: 'button', class: 'p'}, 'Inserir');
    inserir.onclick = () => {
      const escolhidos = itens.filter(item => item.querySelector('input').checked).map(item => item.querySelector('input').value);
      if (!escolhidos.length) { filtroCampo.focus(); return; }
      const sep = separador.value;
      const juncao = escolhidos.map(nome => '"' + nome + '"').join(' || ' + sep + ' || ');
      // Acrescenta ao fim: previsível mesmo com o texto fora de foco/cursor.
      const atual = ta.value.trim();
      ta.value = atual ? `${atual} || ${sep} || ${juncao}` : juncao;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      ta.oninput();
      itens.forEach(item => { item.querySelector('input').checked = false; });
      painel.hidden = true;
    };
    const fechar = mk('button', {type: 'button', class: 'prj-link'}, 'Fechar');
    fechar.onclick = () => { painel.hidden = true; };
    painel = mk('div', {class: 'ex-campos', hidden: true},
      mk('div', {class: 'ex-campos-head'}, filtroCampo, separador, inserir, fechar),
      mk('div', {class: 'ex-campos-lista'}, ...itens));
    filtroCampo.addEventListener('keydown', event => { if (event.key === 'Escape') painel.hidden = true; });
  }

  const tools = [sCampo];
  if (painel) {
    const btn = mk('button', {type: 'button', class: 'ex-campos-btn', title: 'Inserir vários campos de uma vez'}, '+ campos…');
    btn.onclick = () => {
      painel.hidden = !painel.hidden;
      if (!painel.hidden) painel.querySelector('.ex-campos-filtro')?.focus();
    };
    tools.push(btn);
  }
  tools.push(sFn);
  if (presets.length) {
    const sP = mk('select', {title: 'Modelos'}, mk('option', {value: ''}, 'Modelos…'), presets.map(([n, e], q) => mk('option', {value: q}, n)));
    sP.onchange = () => { if (sP.value !== '') { ta.value = presets[+sP.value][1]; ta.oninput(); } sP.value = ''; };
    tools.push(sP);
  }
  atualiza();
  return mk('div', {class: 'ex'}, ta, mk('div', {class: 'ex-tools'}, ...tools), painel, st);
}
const PRESETS = {
  poste: [['Altura/esforço + barramento + material (padrão)', EX_POSTE], ['Somente o ID', '"NU_PG_ID"'], ['Altura/esforço', `"NU_ALTURA" || '/' || "NU_ESFORCO"`],
    ['ID + altura/esforço', `"NU_PG_ID" || '\\n' || "NU_ALTURA" || '/' || "NU_ESFORCO"`], ['Com instalações do poste', `"NU_PG_ID" || if(n_inst() > 0, '\\n' || inst_attr('NU_INSTALA', ', '), '')`]],
  inst: [['Tipo e placa (padrão)', EX_INST], ['Somente placa', '"DE_PLACA"'], ['Nº da instalação', '"NU_INSTALA"'], ['Tipo, placa e poste', `coalesce("TIPO_INSTA","TIPO_SIGLA") || '\\n' || "DE_PLACA" || '\\nPoste ' || "NU_PG_ID"`]],
  bt: [['Condutor e metragem (padrão)', EX_REDE], ['Somente metragem', `format_number($length, 1) || ' m'`], ['Somente condutor', `uniq_join('/', "CONDUTOR_A","CONDUTOR_B","CONDUTOR_C")`], ['Nº do trecho', '"NU_TRECHO"']],
};
PRESETS.mt = PRESETS.bt;

// Nomes amigáveis das colunas mais comuns (as demais aparecem pelo próprio nome).
const NOMES_CAMPO = {
  NU_PG_ID: 'Nº do poste', DE_BARRAMENTO: 'Barramento', DE_BARRAMEN: 'Barramento',
  NU_ALTURA: 'Altura', NU_ESFORCO: 'Esforço', MATERIAL: 'Material', CD_INDD_MATERIAL_PG_DESC: 'Material',
  TIPO_PG: 'Tipo do poste', CD_TIPO_PG_DESC: 'Tipo do poste', POSSE: 'Posse', TIPO_LOCAL: 'Local',
  NU_INSTALA: 'Nº da instalação', NU_INSTALACAO_MT_ID: 'Nº da instalação',
  DE_PLACA: 'Placa', DE_PLACA_ANTIGA: 'Placa antiga',
  TIPO_INSTA: 'Tipo de instalação', TIPO_SIGLA: 'Tipo (sigla)',
  KVA_TOTAL: 'Potência total (kVA)', QTD_UCS: 'Qtd. de UCs', QTD_VIP: 'Qtd. VIP',
  CONDUTOR_A: 'Condutor A', CONDUTOR_B: 'Condutor B', CONDUTOR_C: 'Condutor C', CONDUTOR_N: 'Neutro',
  NU_COMPRIMENTO_REAL: 'Comprimento', SHP_LENGTH: 'Comprimento',
  NU_TRECHO: 'Nº do trecho', NU_TRECHO_MT_ID: 'Nº do trecho', NU_TRECHO_BT_ID: 'Nº do trecho',
  ALIM: 'Alimentador', NU_ALIMENTADOR_MT_ID: 'Alimentador', FASE: 'Fases', CD_FASE: 'Fases',
  NU_ANGULO: 'Ângulo', UTD: 'UTD', SE: 'Subestação', SE_ID: 'Subestação',
  NOME: 'Nome', DESCRICAO: 'Descrição', PASTA: 'Pasta', GRUPO: 'Grupo',
};
const nomeCampo = nome => NOMES_CAMPO[nome] || nome;

/** Valor de exemplo da coluna na amostra atual (só para a lista de campos). */
function exemploCampo(t, nome) {
  const am = amostra(t);
  if (!am) return '';
  const d = D[am.t];
  const j = d?.h?.indexOf(nome) ?? -1;
  const v = j >= 0 ? d?.rows?.[am.i]?.[j] : '';
  return v == null || v === '' ? '' : String(v).replace(/\s+/g, ' ').slice(0, 32);
}

/** Expressão gerada a partir das caixas marcadas (o rótulo sempre usa `expr`). */
function exprDeCampos(L) {
  const lista = (L.campos || []).filter(Boolean);
  if (!lista.length) return '';
  const sep = L.sepCampo || "'\\n'";
  const valor = n => L.prefixoCampo === true
    ? `if(length(coalesce("${n}", '')) > 0, "${n}" || ': ' || "${n}", '')`
    : `"${n}"`;
  return lista.map(valor).join(' || ' + sep + ' || ');
}

function editorCampos(L, t, M) {
  const nomes = campos(t);
  const wrap = mk('div', {class: 'rot-campos'});
  if (!nomes.length) {
    wrap.append(mk('p', {class: 'hint'}, 'Carregue uma base para escolher os campos.'));
    return wrap;
  }
  if (!Array.isArray(L.campos)) L.campos = [];
  const marcados = new Set(L.campos);
  const previa = mk('div', {class: 'ex-st'});
  const atualiza = () => {
    if (!L.expr) { previa.className = 'ex-st'; previa.textContent = 'Marque os campos que devem aparecer no rótulo.'; return; }
    const am = amostra(t);
    if (!am) { previa.className = 'ex-st'; previa.textContent = 'Texto válido. A prévia aparece ao carregar os dados da área.'; return; }
    const v = ev(L.expr, t, am.i);
    previa.className = 'ex-st ok';
    previa.textContent = 'Prévia: ' + (v === null ? 'NULL' : typeof v === 'string' ? '"' + v.replace(/\n/g, '↵') + '"' : String(v));
  };
  const aplicar = () => {
    L.montagem = 'campos';
    L.campos = nomes.filter(n => marcados.has(n));
    L.expr = exprDeCampos(L);
    atualiza();
    M();
  };
  const lista = mk('div', {class: 'rot-campos-lista'});
  for (const nome of nomes) {
    const ck = mk('input', {type: 'checkbox', checked: marcados.has(nome)});
    ck.onchange = () => { if (ck.checked) marcados.add(nome); else marcados.delete(nome); aplicar(); };
    const ex = exemploCampo(t, nome);
    lista.append(mk('label', {class: 'rot-campo'}, ck,
      mk('span', null, nomeCampo(nome), nomeCampo(nome) === nome ? '' : mk('i', {class: 'rot-col'}, nome)),
      ex ? mk('small', null, 'ex.: ' + ex) : null));
  }
  const sep = mk('select', {title: 'Separador entre os campos'},
    [["'\\n'", 'Nova linha'], ["' · '", '·'], ["' - '", '-'], ["', '", ', '], ["' / '", '/']].map(([v, l]) => mk('option', {value: v}, l)));
  sep.value = L.sepCampo || "'\\n'";
  sep.onchange = () => { L.sepCampo = sep.value; aplicar(); };
  const prefixo = mk('input', {type: 'checkbox', checked: L.prefixoCampo === true});
  prefixo.onchange = () => { L.prefixoCampo = prefixo.checked; aplicar(); };
  const limpar = mk('button', {type: 'button', class: 'prj-link', onclick: () => {
    marcados.clear();
    lista.querySelectorAll('input').forEach(i => { i.checked = false; });
    aplicar();
  }}, 'Limpar');
  wrap.append(
    mk('p', {class: 'hint'}, 'Marque os campos que devem aparecer no mapa.'),
    mk('div', {class: 'rot-campos-topo'},
      mk('label', {class: 'rot-op'}, mk('span', null, 'Separador'), sep),
      mk('label', {class: 'rot-op'}, mk('span', null, 'Com o nome do campo'), prefixo),
      limpar),
    lista,
    previa);
  atualiza();
  return wrap;
}

function abrirSP(aba) { if (aba) SP.aba = aba; $('#sp').hidden = false; document.body.classList.add('sp-open'); renderSP(); }
function fecharSP() { $('#sp').hidden = true; document.body.classList.remove('sp-open'); }
function renderSP() {
  const c = $('#spc'), top = c.scrollTop; c.replaceChildren();
  const paginas = {camadas: pagCamadas, poste: pagCam, inst: pagCam, bt: pagCam, mt: pagCam, kmlp: pagCam, kmll: pagCam, ruas: pagRuas, blocos: pagBlocos, exp: pagExp, ger: pagGeral};
  if (!paginas[SP.aba]) SP.aba = 'camadas';
  $('#spt').replaceChildren(...[['camadas', 'Camadas'], ['poste', 'Postes'], ['inst', 'Instalações'], ['bt', 'Rede BT'], ['mt', 'Rede MT'], ['kmlp', 'KML pontos'], ['kmll', 'KML linhas e áreas'], ['ruas', 'Arruamento'], ['blocos', 'Blocos'], ['exp', 'DXF'], ['ger', 'Geral']]
    .map(([k, l]) => mk('button', {class: SP.aba === k ? 'on' : '', onclick: () => { SP.aba = k; SP.l = 0; renderSP(); }}, l)));
  paginas[SP.aba](c);
  c.scrollTop = top;
}

// ---------- camadas: o que aparece no mapa, num só lugar ----------
const SP_GRUPOS = [['poste', 'Postes', 'poste'], ['inst', 'Instalações', 'inst'], ['bt', 'Rede BT', 'bt'], ['mt', 'Rede MT', 'mt'], ['kml', 'KML', 'kmlp'], ['ruas', 'Arruamento offline', 'ruas']];
function spAtualizar() { window.NG.camadasPintar?.(); renderSP(); }
function pagCamadas(c) {
  const NG = window.NG, cores = ngMapa.cores(), gerais = NG.rotulosGerais();
  c.append(mk('p', {class: 'hint'}, 'O que aparece no mapa e com que aparência. A legenda do mapa liga e desliga as mesmas opções. Camada desligada também fica fora do Projeto e da entrega.'));
  const geral = mk('input', {type: 'checkbox'}); geral.checked = gerais;
  geral.onchange = () => { NG.definirRotulosGerais(geral.checked); spAtualizar(); };
  c.append(sec('Rótulos', fr('Rótulos no mapa (chave geral)', geral, 'Desligado, nenhum rótulo aparece no mapa, qualquer que seja a opção de cada camada.')));
  const tabela = mk('div', {class: 'sp-cam'},
    mk('span', {class: 'sp-cam-h'}, 'Camada'), mk('span', {class: 'sp-cam-h'}, 'Mostrar'), mk('span', {class: 'sp-cam-h'}, 'Rótulos'), mk('span', {class: 'sp-cam-h'}, ''));
  for (const [g, nome, aba] of SP_GRUPOS) {
    let mostrar;
    if (g === 'kml' && !NG.temKml()) {
      mostrar = mk('button', {type: 'button', title: 'O KML vale só enquanto o programa estiver aberto', onclick: () => NG.abrirKml()}, 'Importar…');
    } else {
      mostrar = mk('input', {type: 'checkbox', 'data-sp-mostrar': g}); mostrar.checked = g === 'kml' ? NG.kmlLigado() : ngCamadaLigada(g);
      mostrar.onchange = async () => { await ngLigarCamada(g, mostrar.checked); spAtualizar(); };
    }
    const rot = mk('input', {type: 'checkbox', 'data-sp-rotulo': g, title: gerais ? '' : 'A chave geral de rótulos está desligada'}); rot.checked = ngMapa.rotuloLigado(g); rot.disabled = !gerais;
    rot.onchange = () => { ngMapa.definirRotulo(g, rot.checked); spAtualizar(); };
    tabela.append(mk('span', {class: 'sp-cam-n'}, mk('i', {style: `--c:${cores[g] || '#888'}`}), nome), mostrar, rot,
      mk('button', {type: 'button', onclick: () => { SP.aba = aba; SP.sub = 'ap'; renderSP(); }}, 'Estilo…'));
  }
  c.append(sec('Camadas no mapa', tabela));
  const op = NG.kmlOpcoes(), kmlChk = (k, rotulo) => {
    const e = mk('input', {type: 'checkbox'}); e.checked = op[k];
    e.onchange = () => { NG.kmlOpcao(k, e.checked); };
    return fr(rotulo, e);
  };
  c.append(sec('KML: o que exibir', kmlChk('showPoints', 'Pontos'), kmlChk('showLines', 'Linhas'), kmlChk('showPolygons', 'Áreas / polígonos'),
    mk('p', {class: 'hint'}, 'Vale para o mapa e para o DXF. O KML não fica salvo: ao reabrir o programa, importe de novo.'),
    mk('button', {type: 'button', onclick: () => NG.abrirKml()}, 'Arquivos KML…')));
}

// ---------- arruamento offline no mapa ----------
function pagRuas(c) {
  const e = CFG.mapa.ruas, M = () => { salvar(); ruasMapa.redesenhar(); ngMapa.alterada(); };
  c.append(mk('p', {class: 'hint'}, 'Aparência das ruas guardadas (offline) no mapa. O arruamento do DXF, com pistas e larguras, é configurado no Projeto e na aba DXF.'));
  c.append(sec('Linhas', fr('Cor', ctl(e, 'cor', {t: 'cor'}, M)), fr('Largura (px)', ctl(e, 'larg', {t: 'num', min: .5, max: 10, step: .5}, M)),
    fr('Opacidade', ctl(e, 'opac', {t: 'num', min: .1, max: 1, step: .05}, M))));
  c.append(sec('Nomes das ruas', fr('Mostrar nomes', ctl(CFG.mapa.rot, 'ruas', {t: 'chk'}, () => { M(); window.NG.camadasPintar?.(); }), 'Também liga e desliga pelo botão Aa ao lado de Arruamento, na legenda.'),
    fr('Cor dos nomes', ctl(e, 'rotCor', {t: 'cor'}, M)), fr('Zoom mínimo', ctl(e, 'rotMinZ', {t: 'num', min: 14, max: 20, step: 1}, M))));
  c.append(mk('button', {class: 'mt', onclick: () => { CFG.mapa.ruas = cfgPadrao().mapa.ruas; M(); renderSP(); }}, 'Restaurar padrão do arruamento'));
}
function pagCam(c) {
  const t = SP.aba;
  if (SP.sub === 'gr' && !KML(t)) SP.sub = 'ap';
  c.append(mk('div', {class: 'sub'}, ...[['ap', 'Aparência'], ['rg', 'Regras'], ['rt', 'Rótulos'], ...(KML(t) ? [['gr', 'Pastas/grupos']] : [])].map(([k, l]) => mk('button', {class: SP.sub === k ? 'on' : '', onclick: () => { SP.sub = k; renderSP(); }}, l))));
  if (!D[t]) c.append(mk('p', {class: 'hint'}, 'A prévia das expressões usa os dados da área selecionada: marque uma área para vê-la.'));
  ({ap: pagAp, rg: pagRg, rt: pagRt, gr: pagGrupos})[SP.sub](c, t);
}
function formEstilo(c, t, o, M) {
  const on = M;
  if (LINHA(t)) {
    c.append(fr('Cor', ctl(o, 'cor', {t: 'cor'}, on)), ...(KML(t) && 'corKml' in o ? [fr('Usar a cor do próprio KML', ctl(o, 'corKml', {t: 'chk'}, on), 'Cada elemento usa a cor definida no arquivo KML. Desligado: vale a cor ao lado.')] : []), fr('Largura (px)', ctl(o, 'larg', {t: 'num', min: .5, step: .5}, on)),
      fr('Estilo do traço', ctl(o, 'dash', {t: 'sel', o: [['', 'Contínuo'], ['8 4', 'Tracejado'], ['2 3', 'Pontilhado'], ['10 3 2 3', 'Traço e ponto']]}, on)),
      fr('Opacidade', ctl(o, 'opac', {t: 'num', min: 0, max: 1, step: .05}, on)),
      fr('Extremidade', ctl(o, 'cap', {t: 'sel', o: [['round', 'Arredondada'], ['butt', 'Reta'], ['square', 'Quadrada']]}, on)),
      fr('Contorno (casing)', ctl(o, 'casing', {t: 'chk', re: true}, on)));
    if (o.casing) c.append(fr('Cor do contorno', ctl(o, 'casingCor', {t: 'cor'}, on)), fr('Espessura de cada lado', ctl(o, 'casingW', {t: 'num', min: .5, step: .5}, on)));
    c.append(fr('Escalar com o zoom', ctl(o, 'zoomEsc', {t: 'chk'}, on)));
    return;
  }
  const f = o.forma;
  c.append(fr('Forma', ctl(o, 'forma', {t: 'sel', re: true, o: [['ret', 'Retângulo'], ['quad', 'Quadrado'], ['circ', 'Círculo'], ['losango', 'Losango'], ['tri', 'Triângulo'], ['cruz', 'Cruz'], ['linha', 'Linha (chave)'], ['bloco', 'Bloco DXF']]}, on)));
  if (f === 'ret') c.append(fr('Largura (px)', ctl(o, 'tam', {t: 'num', min: 1}, on)), fr('Altura (px)', ctl(o, 'tamh', {t: 'num', min: 1}, on)));
  else if (f === 'bloco') {
    const nomes = Object.keys(BLOCOS);
    c.append(fr('Bloco', ctl(o, 'bloco', {t: 'sel', o: [['', nomes.length ? '(escolha)' : '(importe em "Blocos DXF")'], ...nomes.map(n => [n, n])]}, on)),
      fr('Tamanho do bloco', ctl(o, 'blocoModo', {t: 'sel', re: true, o: [['ajustar', 'Ajustar ao tamanho (px)'], ['original', 'Real (1 unidade = 1 m)']]}, on)));
    c.append(o.blocoModo === 'original' ? fr('Fator de escala', ctl(o, 'blocoK', {t: 'num', min: .001, step: .1}, on)) : fr('Tamanho (px)', ctl(o, 'tam', {t: 'num', min: 1}, on)));
  } else c.append(fr(f === 'linha' || f === 'cruz' ? 'Comprimento (px)' : 'Tamanho (px)', ctl(o, 'tam', {t: 'num', min: 1}, on)));
  if (f === 'linha' || f === 'cruz') c.append(fr('Espessura (px)', ctl(o, 'larg', {t: 'num', min: .5, step: .5}, on)));
  c.append(fr(f === 'bloco' ? 'Cor (traço padrão)' : 'Cor', ctl(o, 'cor', {t: 'cor'}, on)));
  if (KML(t) && 'corKml' in o) c.append(fr('Usar a cor do próprio KML', ctl(o, 'corKml', {t: 'chk'}, on), 'Cada pasta/elemento do KML usa a cor definida no arquivo. Desligado: vale a cor acima.'));
  if (f !== 'linha' && f !== 'cruz') c.append(fr('Cor da borda', ctl(o, 'borda', {t: 'cor'}, on)), fr('Espessura da borda', ctl(o, 'bordaW', {t: 'num', min: 0, step: .5}, on)));
  c.append(fr('Opacidade', ctl(o, 'opac', {t: 'num', min: 0, max: 1, step: .05}, on)),
    fr('Girar com NU_ANGULO', ctl(o, 'girar', {t: 'chk'}, on)), fr('Rotação extra (°)', ctl(o, 'angOff', {t: 'num', step: 5}, on)),
    fr('Escalar com o zoom', ctl(o, 'zoomEsc', {t: 'chk'}, on)),
    fr('Atributos no DXF (TAG ou TAG=expressão, um por linha)', ctl(o, 'atrib', {t: 'area', rows: 3}, on), 'Viram atributos (ATTRIB) do bloco inserido no DXF, legíveis por rotinas LISP.'));
}
async function pagGrupos(c, t) {
  c.append(mk('p', {class: 'hint'}, 'Marque as pastas/grupos do KML que devem aparecer no mapa e no DXF. Vale para pontos e linhas do KML.'));
  const lista = mk('div'); c.append(lista);
  let gs = new Map();
  const fonte = SEL?.dados || D;
  for (const k of ['kmlp', 'kmll']) { const d = fonte[k]; if (d && d.gr >= 0) for (const r of d.rows) gs.set(r[d.gr], (gs.get(r[d.gr]) || 0) + 1); }
  if (!gs.size) { lista.append(mk('p', {class: 'hint'}, 'Nenhum KML importado.')); return; }
  const ks = [...gs.keys()].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
  lista.append(mk('div', {style: 'display:flex;gap:6px;margin-bottom:6px'},
    mk('button', {onclick: () => { CFG.kml.ocultos = {}; mudou(t); renderSP(); }}, 'Marcar todos'),
    mk('button', {onclick: () => { for (const g of ks) CFG.kml.ocultos[g] = true; mudou(t); renderSP(); }}, 'Desmarcar todos')));
  for (const g of ks) {
    const ck = mk('input', {type: 'checkbox'}); ck.checked = !CFG.kml.ocultos[g];
    ck.onchange = () => { if (ck.checked) delete CFG.kml.ocultos[g]; else CFG.kml.ocultos[g] = true; mudou(t); };
    lista.append(mk('label', {style: 'display:flex;gap:8px;align-items:center;padding:2px 0'}, ck, mk('span', {style: 'flex:1'}, g || '(sem grupo)'), mk('span', {class: 'mut'}, nBR(gs.get(g)))));
  }
}
function pagAp(c, t) {
  const M = () => mudou(t);
  c.append(mk('p', {class: 'hint'}, 'Aparência padrão da camada. Use a aba "Regras" para estilos condicionais.'));
  formEstilo(c, t, CFG.cam[t].base, M);
  c.append(mk('button', {class: 'mt', onclick: () => { if (confirm('Restaurar o padrão desta camada (aparência, regras e rótulos)?')) { CFG.cam[t] = cfgPadrao().cam[t]; mudou(t); renderSP(); } }}, 'Restaurar padrão da camada'));
}
function pagRg(c, t) {
  const cf = CFG.cam[t], M = () => mudou(t);
  c.append(mk('p', {class: 'hint'}, 'A primeira regra cuja expressão for verdadeira define a aparência do elemento; os demais usam a aparência padrão. Os campos de cada regra mostram o valor efetivo e só gravam o que você alterar.'));
  cf.rules.forEach((r, k) => {
    const card = mk('div', {class: 'card'});
    const mover = d => { const n = k + d; if (n < 0 || n >= cf.rules.length) return; [cf.rules[k], cf.rules[n]] = [cf.rules[n], cf.rules[k]]; M(); renderSP(); };
    card.append(mk('div', {class: 'ch'}, ctl(r, 'on', {t: 'chk'}, M), ctl(r, 'nome', {t: 'txt'}, M),
      mk('button', {title: 'Subir', onclick: () => mover(-1)}, '↑'), mk('button', {title: 'Descer', onclick: () => mover(1)}, '↓'),
      mk('button', {title: 'Excluir', onclick: () => { cf.rules.splice(k, 1); M(); renderSP(); }}, '✕')));
    card.append(editorExpr(r, 'expr', t, {rows: 2, M, filtro: true}));
    const alvo = new Proxy(r.est, {get: (o, key) => key in o ? o[key] : cf.base[key], set: (o, key, v) => { o[key] = v; return true; }});
    formEstilo(card, t, alvo, M);
    card.append(fr('Camada DXF (opcional)', ctl(r, 'camada', {t: 'txt'}, M), 'Em branco: usa a camada padrão da exportação. Ex.: REDE_MT_CAA4'));
    card.append(mk('button', {onclick: () => { r.est = {}; M(); renderSP(); }}, 'Limpar ajustes da regra'));
    c.append(card);
  });
  c.append(mk('button', {class: 'p', onclick: () => { cf.rules.push({nome: 'Regra ' + (cf.rules.length + 1), on: true, expr: '', est: {}, camada: ''}); renderSP(); }}, '+ Nova regra'));
}
function novoRot(t) {
  const ln = LINHA(t);
  return ROT({nome: 'Novo rótulo', expr: '', montagem: 'campos', campos: [], cor: '#ffffff', camada: 'TXT_' + t.toUpperCase(), prior: 3,
    ...(ln ? {modo: 'alinhado', lado: 'acima', dist: 1, alinh: 'cen'} : {})});
}
function pagRt(c, t) {
  const cf = CFG.cam[t], M = () => mudou(t), labs = cf.labels, ln = LINHA(t);
  SP.l = Math.max(0, Math.min(SP.l, labs.length - 1));
  // Lista com caixa de seleção: marcar = aparece no mapa.
  const lista = mk('div', {class: 'rot-lista'});
  labs.forEach((L, k) => {
    const ck = mk('input', {type: 'checkbox', checked: L.on !== false, title: 'Mostrar este rótulo no mapa'});
    ck.onchange = () => { L.on = ck.checked; M(); renderSP(); };
    lista.append(mk('div', {class: 'rot-item' + (k === SP.l ? ' is-sel' : '') + (L.on === false ? ' is-off' : '')},
      ck,
      mk('button', {type: 'button', class: 'rot-nome', title: 'Editar este rótulo', onclick: () => { SP.l = k; renderSP(); }}, L.nome || 'Rótulo ' + (k + 1))));
  });
  lista.append(mk('button', {type: 'button', class: 'p rot-novo', onclick: () => { labs.push(novoRot(t)); SP.l = labs.length - 1; M(); renderSP(); }}, '+ Novo'));
  c.append(lista);
  if (!labs.length) { c.append(mk('p', {class: 'hint'}, 'Nenhum rótulo nesta camada.')); return; }
  const L = labs[SP.l];

  // Rótulos simples ("CAMPO") já abrem no modo de caixas.
  if (!L.montagem) {
    const simples = /^\s*"([A-Z0-9_]+)"\s*$/.exec(L.expr || '');
    if (simples && campos(t).includes(simples[1])) { L.campos = [simples[1]]; L.montagem = 'campos'; }
    else L.montagem = 'expr';
  }
  const montagem = L.montagem === 'campos' ? 'campos' : 'expr';

  c.append(mk('div', {class: 'ch'},
    mk('button', {onclick: () => { labs.splice(SP.l + 1, 0, {...L, nome: L.nome + ' (cópia)'}); SP.l++; M(); renderSP(); }}, 'Duplicar'),
    mk('button', {onclick: () => { labs.splice(SP.l, 1); M(); renderSP(); }}, 'Excluir')));
  const abas = mk('div', {class: 'sub'},
    mk('button', {class: montagem === 'campos' ? 'on' : '', onclick: () => { L.montagem = 'campos'; if (!Array.isArray(L.campos)) L.campos = []; renderSP(); }}, 'Por campos'),
    mk('button', {class: montagem === 'expr' ? 'on' : '', onclick: () => { L.montagem = 'expr'; renderSP(); }}, 'Expressão'));
  c.append(sec('Conteúdo',
    fr('Ativo', ctl(L, 'on', {t: 'chk'}, M)), fr('Nome', ctl(L, 'nome', {t: 'txt', re: false}, M)),
    abas,
    montagem === 'campos'
      ? editorCampos(L, t, M)
      : [mk('div', {class: 'lab'}, 'Texto do rótulo (expressão; use \'\\n\' para quebrar linha)'),
         editorExpr(L, 'expr', t, {rows: 4, M, presets: PRESETS[t], multicampos: true})],
    mk('div', {class: 'lab'}, 'Filtro (opcional): só rotula elementos em que a expressão for verdadeira'),
    editorExpr(L, 'filtro', t, {rows: 2, M, filtro: true})));
  c.append(sec('Texto',
    fr('Fonte', ctl(L, 'fonte', {t: 'sel', o: FONTES.map(f => [f, f])}, M)), fr('Tamanho (px)', ctl(L, 'tam', {t: 'num', min: 5, max: 60}, M)),
    fr('Negrito', ctl(L, 'neg', {t: 'chk'}, M)), fr('Itálico', ctl(L, 'ital', {t: 'chk'}, M)), fr('Cor', ctl(L, 'cor', {t: 'cor'}, M)),
    fr('Alinhamento do texto', ctl(L, 'alinh', {t: 'sel', o: [['esq', 'Esquerda'], ['cen', 'Centralizado'], ['dir', 'Direita']]}, M)),
    fr('Espaçamento entre linhas', ctl(L, 'esp', {t: 'num', min: .8, max: 3, step: .05}, M)),
    mk('div', {class: 'lab'}, 'Cor por expressão (opcional, ex.: if("NU_ALTURA" > 12, \'#ff0000\', \'#ffffff\'))'),
    editorExpr(L, 'corExpr', t, {rows: 1, M, filtro: true}),
    fr('Contorno (halo)', ctl(L, 'halo', {t: 'chk'}, M)), fr('Cor do halo', ctl(L, 'haloCor', {t: 'cor'}, M)), fr('Espessura do halo', ctl(L, 'haloW', {t: 'num', min: 0, max: 12, step: .5}, M))));
  const bal = [fr('Estilo', ctl(L, 'bal', {t: 'sel', re: true, o: [['nenhum', 'Sem fundo'], ['caixa', 'Caixa'], ['arred', 'Caixa arredondada'], ['balao', 'Balão com ponta'], ['linha', 'Caixa com linha-guia']]}, M))];
  if (L.bal !== 'nenhum') bal.push(fr('Cor de fundo', ctl(L, 'balFill', {t: 'cor'}, M)), fr('Opacidade do fundo', ctl(L, 'balOp', {t: 'num', min: 0, max: 1, step: .05}, M)),
    fr('Cor da borda', ctl(L, 'balBorda', {t: 'cor'}, M)), fr('Espessura da borda', ctl(L, 'balBW', {t: 'num', min: 0, max: 8, step: .5}, M)));
  bal.push(fr('Margem interna (px)', ctl(L, 'pad', {t: 'num', min: 0, max: 20, step: .5}, M)));
  c.append(sec('Fundo / balão', ...bal));
  const alinhado = ln && L.modo === 'alinhado', pos = [];
  if (ln) pos.push(fr('Orientação', ctl(L, 'modo', {t: 'sel', re: true, o: [['alinhado', 'Alinhado à linha'], ['horizontal', 'Horizontal']]}, M)),
    fr('Ao longo da linha', ctl(L, 'ancora', {t: 'sel', o: [['meio', 'No meio'], ['ini', 'Perto do início'], ['fim', 'Perto do fim']]}, M)));
  if (alinhado) pos.push(fr('Lado', ctl(L, 'lado', {t: 'sel', o: [['acima', 'Acima da linha'], ['abaixo', 'Abaixo da linha'], ['sobre', 'Sobre a linha']]}, M)));
  else pos.push(fr('Posição', ctl(L, 'pos', {t: 'sel', o: [['dir', 'À direita'], ['esq', 'À esquerda'], ['cima', 'Acima'], ['baixo', 'Abaixo'], ['centro', 'Centro'], ['ne', 'Nordeste'], ['no', 'Noroeste'], ['se', 'Sudeste'], ['so', 'Sudoeste']]}, M)));
  pos.push(fr('Distância (px)', ctl(L, 'dist', {t: 'num', min: -50, max: 200}, M)), fr('Deslocamento X (px)', ctl(L, 'dx', {t: 'num', min: -300, max: 300}, M)), fr('Deslocamento Y (px)', ctl(L, 'dy', {t: 'num', min: -300, max: 300}, M)));
  if (!alinhado) {
    pos.push(fr('Rotação', ctl(L, 'rot', {t: 'sel', re: true, o: [['nenhuma', 'Fixa'], ['angulo', ln ? 'Seguir a linha' : 'Seguir NU_ANGULO'], ['expr', 'Por expressão (graus)']]}, M)), fr('Rotação extra (°)', ctl(L, 'rotOff', {t: 'num', min: -360, max: 360, step: 5}, M)));
    if (L.rot === 'expr') pos.push(editorExpr(L, 'rotExpr', t, {rows: 1, M, filtro: true}));
  }
  c.append(sec('Posição e rotação', ...pos));
  c.append(sec('Visibilidade', fr('Zoom mínimo', ctl(L, 'minZ', {t: 'num', min: 10, max: 22, step: .5}, M)), fr('Zoom máximo', ctl(L, 'maxZ', {t: 'num', min: 10, max: 24, step: .5}, M)),
    fr('Evitar sobreposição', ctl(L, 'colisao', {t: 'chk'}, M)), fr('Prioridade (menor = primeiro)', ctl(L, 'prior', {t: 'num', min: 0, max: 99}, M), 'Rótulos com a mesma prioridade disputam espaço em igualdade; os trechos mais longos vencem.')));
  c.append(sec('Exportação DXF', fr('Camada do texto', ctl(L, 'camada', {t: 'txt'}, M)), fr('Altura do texto (un. do desenho)', ctl(L, 'dxfH', {t: 'num', min: .1, step: .1}, M)), fr('Fator de largura', ctl(L, 'dxfW', {t: 'num', min: .2, max: 3, step: .1}, M))));
}

// ---------- blocos DXF ----------
function pagBlocos(c) {
  c.append(mk('p', {class: 'hint'}, 'Importe um DXF (ASCII) com blocos ou com um símbolo desenhado. Depois, em Postes/Instalações → Aparência, escolha a forma "Bloco DXF". Suporta LINE, CIRCLE, ARC, POLYLINE/LWPOLYLINE, SOLID, TEXT/MTEXT, POINT, INSERT aninhado e ATTDEF.'));
  c.append(mk('button', {class: 'p', onclick: () => $('#arqdxf').click()}, 'Importar DXF…'));
  const nomes = Object.keys(BLOCOS);
  if (!nomes.length) c.append(mk('p', {class: 'hint'}, 'Nenhum bloco importado.'));
  for (const n of nomes) {
    const bl = BLOCOS[n], cvs = mk('canvas', {width: 72, height: 72, class: 'bprev'});
    const card = mk('div', {class: 'card bloc'}, cvs, mk('div', {class: 'bi'},
      mk('b', null, n), mk('div', {class: 'mut'}, `${bl.ents.length} entidades · ${bl.att.length} atributos · ${bl.max.toFixed(2)} un.`),
      Object.keys(bl.un || {}).length ? mk('div', {class: 'mut warn'}, 'Ignorado: ' + Object.entries(bl.un).map(([k, v]) => `${k} (${v})`).join(', ')) : null,
      fr('Origem no centro do desenho', ctl(bl, 'centro', {t: 'chk', on: () => { salvar(); desenhar(); previaBloco(cvs, bl); }})),
      mk('button', {onclick: () => { delete BLOCOS[n]; salvar(); desenhar(); renderSP(); }}, 'Remover')));
    c.append(card); previaBloco(cvs, bl);
  }
}
function previaBloco(cvs, bl) {
  const c = cvs.getContext('2d'); if (!c || !c.clearRect) return;
  c.clearRect(0, 0, 72, 72); c.fillStyle = '#0f2230'; c.fillRect(0, 0, 72, 72);
  const b = blocoBase(bl), cx = (bl.bb[0] + bl.bb[2]) / 2, cy = (bl.bb[1] + bl.bb[3]) / 2;
  // centraliza o desenho na prévia, qualquer que seja o ponto-base
  const est = {...ESTP(), cor: '#f2a900', bordaW: 1.5, blocoModo: 'ajustar', opac: 1};
  const dx = (cx - b[0]) / bl.max * 56, dy = (cy - b[1]) / bl.max * 56;
  desenharBloco(c, est, bl, 36 - dx, 36 + dy, 0, 56, 1);
}
async function importarDXF(files) {
  let n = 0;
  for (const f of files) {
    try {
      const imp = DXF.importar(DXF.parseAll(await f.text()), f.name);
      for (const [nome, bl] of Object.entries(imp)) { BLOCOS[nome] = bl; n++; }
    } catch (e) { alert('Não foi possível ler ' + f.name + ': ' + e.message); }
  }
  $('#st').textContent = n ? n + ' bloco(s) importado(s)' : 'Nenhum bloco encontrado no arquivo';
  SP.aba = 'blocos'; abrirSP(); salvar(); desenhar();
}

// ---------- exportação (ajustes persistentes) ----------
function pagExp(c) {
  const cf = CFG.dxf, M = () => salvar();
  c.append(mk('p', {class: 'hint'}, 'Nomes de camadas e aparência do arquivo DXF. As opções de cada entrega ficam na aba Entregar do Projeto.'));
  c.append(sec('Nomes das camadas no DXF', ...Object.entries({poste: 'Postes', inst: 'Instalações', bt: 'Rede BT', mt: 'Rede MT', ruas: 'Arruamento', txtRuas: 'Nomes das ruas', edif: 'Edificações'}).map(([k, l]) => fr(l, ctl(cf.camadas, k, {t: 'txt'}, M)))));
  c.append(sec('Aparência no DXF', fr('Espessura, tracejado e contorno das linhas como na tela', ctl(cf, 'estiloLinha', {t: 'chk'}, M),
    'A largura da linha da rede (px) vira largura da polilinha no DXF e o tracejado vira tipo de linha. Desligue se prefere polilinhas finas e contínuas.'),
    mk('p', {class: 'hint'}, 'Formas, tamanhos, cores, rotação, blocos, camada e rótulos de cada regra já valem no DXF. Camadas desmarcadas na tela não são exportadas. Opacidade não existe no DXF R12.')));
  c.append(sec('Fonte dos textos no DXF', fr('Fonte', ctl(cf, 'fonte', {t: 'sel', o: [['arial.ttf', 'Arial'], ['arialbd.ttf', 'Arial Negrito'], ['calibri.ttf', 'Calibri'], ['romans.shx', 'RomanS (SHX)'], ['txt', 'txt (SHX padrão)']]}, M),
    'Define o estilo STANDARD do DXF, usado por todos os textos. Fontes TrueType precisam estar instaladas no computador que abrir o desenho.')));
  c.append(sec('Cores no DXF', fr('Arruamento', ctl(cf, 'ruasCor', {t: 'cor'}, M)), fr('Edificações', ctl(cf, 'edifCor', {t: 'cor'}, M)),
    mk('p', {class: 'hint'}, 'A cor das demais camadas vem da cor padrão de cada camada (aproximada para a paleta ACI do CAD).')));
  c.append(sec('Agrupamento do quantitativo (expressão)', ...Object.keys(TIPOS).map(t => mk('div', null, mk('div', {class: 'lab'}, NOME[t]), editorExpr(CFG.quant, t, t, {rows: 2, M})))));
}

// ---------- geral ----------
async function baixar(nome, texto, mime) { return window.NG.salvarArquivo(nome, texto, mime); }
function pagGeral(c) {
  c.append(sec('Configuração',
    mk('p', {class: 'hint'}, 'Estilos, regras, rótulos, blocos e opções de exportação ficam salvos no NeoGrid. Exporte um arquivo para levar a outra máquina ou compartilhar com a equipe.'),
    mk('button', {onclick: () => baixar('neogrid_estilos_projeto.json', JSON.stringify({CFG, BLOCOS}, null, 1), 'application/json')}, 'Exportar configuração (.json)'),
    mk('button', {onclick: () => $('#arqcfg').click()}, 'Importar configuração…'),
    mk('button', {onclick: () => { if (confirm('Restaurar toda a configuração do projeto para o padrão?')) { CFG = cfgPadrao(); for (const k of Object.keys(BLOCOS)) delete BLOCOS[k]; Object.assign(BLOCOS, blocosPadrao()); normalizarCfg(); mudou(); renderSP(); } }}, 'Restaurar tudo ao padrão')));
  const lm = () => { limEstilo(); salvar(); };
  c.append(sec('Limites de Pernambuco',
    mk('p', {class: 'hint'}, 'Dados do IBGE embutidos (funcionam sem internet), simplificados para o desenho.'),
    fr('Cor do limite do estado', ctl(CFG.limites, 'estCor', {t: 'cor'}, lm)), fr('Espessura do limite do estado', ctl(CFG.limites, 'estW', {t: 'num', min: .5, max: 10, step: .5}, lm)),
    fr('Cor dos limites municipais', ctl(CFG.limites, 'munCor', {t: 'cor'}, lm)), fr('Espessura dos limites municipais', ctl(CFG.limites, 'munW', {t: 'num', min: .5, max: 8, step: .5}, lm)),
    fr('Limites municipais tracejados', ctl(CFG.limites, 'munTrac', {t: 'chk'}, lm)),
    fr('Mostrar nomes dos municípios', ctl(CFG.limites, 'rot', {t: 'chk'}, lm)), fr('Cor dos nomes', ctl(CFG.limites, 'rotCor', {t: 'cor'}, lm))));
}
function importarCfg(f) {
  f.text().then(s => {
    const j = JSON.parse(s);
    CFG = mesclar(cfgPadrao(), j.CFG || j); normalizarCfg(); syncCamadaRuas();
    for (const k of Object.keys(BLOCOS)) delete BLOCOS[k];
    for (const [k, b] of Object.entries(j.BLOCOS || {})) BLOCOS[k] = DXF.prepBloco(b);
    mudou(); renderSP();
    $('#st').textContent = 'Configuração importada';
  }).catch(e => alert('Arquivo de configuração inválido: ' + e.message));
}
