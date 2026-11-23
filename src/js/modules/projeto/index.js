/* Ponte entre o NeoGrid e o motor do módulo Projeto (scripts clássicos em js/projeto).
   O motor é carregado só no primeiro uso: quem não abre um projeto não paga por ele. */
import { $ } from '../../core/dom.js';
import { bus } from '../../core/bus.js';
import { library } from '../../data/library.js';
import { LAYER_META, LAYER_TYPES } from '../../data/schema.js';
import { toast } from '../../ui/toast.js';
import { settings, updateSetting } from '../../core/settings.js';
import { getKmlExportData, hasKmlData, kmlOpcoes, kmlVisivel, openKmlDialogFromApp, setKmlOpcao, setKmlVisible } from '../kml.js';
import { DEFAULT_DXF_SETTINGS, loadDxfSettings } from '../dxf/dxf-settings.js';

const MOTOR = [
  'estilo-padrao', '00-expr', '01-dxf', '02-clipper', '03-ruas', '03b-ruas-core', '10-base', '11-estilos', '12-selecao-dxf',
  '13-consulta', '14-limites', '15-arruamento', '16-projeto', '17-organizar-anotar', '18-pacote', '19-integracao', '20-mapa',
];
const AVISO_MUITOS = 1500000;
const CAP_AREA = 6000000;

let deps = {};
let motor = null;

function carregarScript(nome) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `js/projeto/${nome}.js`;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Falha ao carregar o módulo ${nome}.`));
    document.head.appendChild(script);
  });
}

export function carregarMotor() {
  if (!motor) {
    motor = (async () => {
      for (const nome of MOTOR) await carregarScript(nome);
      await ngIniciarProjeto();
    })().catch((error) => {
      motor = null;
      throw error;
    });
  }
  return motor;
}

const usaBanco = () => library.isDatabase();

async function lerCamadaBanco(type, bounds, limit, regions) {
  const payload = { type, limit };
  if (bounds) {
    payload.west = bounds.getWest();
    payload.east = bounds.getEast();
    payload.south = bounds.getSouth();
    payload.north = bounds.getNorth();
  }
  if (regions) payload.regions = regions;
  const response = await window.desktop.dbArea(payload);
  if (!response?.ok) throw new Error(response?.error || 'Falha ao ler a base.');
  return response.result;
}

function lerCamadaMemoria(type, bounds, limit) {
  const store = library.get(type);
  if (!store) return { h: [], rows: [], n: 0, corte: false };
  const ids = bounds
    ? store.collectInBounds({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() })
    : store.rows.map((_, index) => index);
  const corte = ids.length > limit;
  const rows = (corte ? ids.slice(0, limit) : ids).map((id) => store.rows[id].slice());
  return { h: store.headers.slice(), rows, n: rows.length, corte };
}

function lerCamada(type, bounds, limit = 200000, regional = '') {
  if (usaBanco()) return lerCamadaBanco(type, bounds, limit, regional ? [regional] : null);
  return Promise.resolve(lerCamadaMemoria(type, bounds, limit));
}

const wktLinha = (pts) => `LINESTRING (${pts.map(([lat, lon]) => `${lon} ${lat}`).join(', ')})`;

/** KML continua temporário: entra na área como conjunto de dados, nunca vai para o banco. */
function kmlParaDados() {
  const { features } = getKmlExportData();
  const pontos = [];
  const linhas = [];
  for (const feature of features || []) {
    const nome = feature.name || '';
    if (feature.kind === 'point') pontos.push([nome, '', 'KML', 'KML', String(feature.lon), String(feature.lat), '']);
    else if (feature.kind === 'line') linhas.push([nome, '', 'KML', 'KML', wktLinha(feature.pts), '', '']);
    else if (feature.kind === 'polygon') {
      for (const ring of feature.rings || []) linhas.push([nome, '', 'KML', 'KML', wktLinha(ring), '', '']);
    }
  }
  const dados = {};
  if (pontos.length) dados.kmlp = montarDS('kmlp', ['NOME', 'DESCRICAO', 'GRUPO', 'PASTA', 'GEO_X', 'GEO_Y', 'COR_KML'], pontos, false);
  if (linhas.length) dados.kmll = montarDS('kmll', ['NOME', 'DESCRICAO', 'GRUPO', 'PASTA', 'GEOMETRIA_WKT', 'COR_KML', 'LARG_KML'], linhas, false);
  return dados;
}

const visiveis = () => {
  const ativas = deps.mapView.getVisibleLayers();
  return LAYER_TYPES.filter((type) => ativas[type] && library.get(type)?.stats.count);
};

async function lerArea(bounds, aviso) {
  const camadas = visiveis();
  const dados = {};
  let total = 0;
  for (const type of camadas) {
    aviso?.(`Lendo ${library.get(type).meta.name} da área…`);
    const lido = await lerCamada(type, bounds, CAP_AREA);
    total += lido.n;
    if (total > AVISO_MUITOS && !confirm(`A área já tem ${total.toLocaleString('pt-BR')} elementos. Isso pode ser lento e usar muita memória. Continuar?`)) {
      throw new Error('cancelado');
    }
    dados[type] = montarDS(type, lido.h, lido.rows, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return Object.assign(dados, kmlParaDados());
}

async function atualizarKml(dados) {
  delete dados.kmlp;
  delete dados.kmll;
  Object.assign(dados, kmlParaDados());
}

async function overpassUm(url, consulta, timeoutMs) {
  const corpo = `data=${encodeURIComponent(consulta)}`;
  const cabecalhos = { 'Content-Type': 'application/x-www-form-urlencoded' };
  let texto;
  if (window.desktop?.fetchText) {
    const resposta = await window.desktop.fetchText({ url, body: corpo, headers: cabecalhos, timeoutMs });
    if (!resposta?.ok) throw new Error(resposta?.error || `HTTP ${resposta?.status}`);
    texto = resposta.text;
  } else {
    const resposta = await fetch(url, { method: 'POST', body: corpo, headers: cabecalhos, signal: AbortSignal.timeout(timeoutMs) });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    texto = await resposta.text();
  }
  const dados = JSON.parse(texto);
  if (!Array.isArray(dados.elements) || (dados.remark && /error|timed out/i.test(dados.remark))) {
    throw new Error(dados.remark || 'resposta incompleta');
  }
  return dados;
}

// Falhas recentes de cada servidor: quem falhou vai para o fim da fila nesta sessão.
const falhasServidor = new Map();
const INTERVALO_ENTRE_SERVIDORES = 8000;
const LIMITE_POR_SERVIDOR = 55000;

/** Consulta um servidor e, se ele demorar ou falhar, aciona o próximo; vale o primeiro que responder. */
function overpassUmaVolta(urls, consulta, { signal, aoServidor }) {
  const fila = [...urls].sort((a, b) => (falhasServidor.get(a) || 0) - (falhasServidor.get(b) || 0));
  return new Promise((resolve, reject) => {
    let acabou = false;
    let proximo = 0;
    let ativos = 0;
    let relogio = 0;
    const erros = [];
    const encerrar = (acao, valor) => {
      if (acabou) return;
      acabou = true;
      clearTimeout(relogio);
      signal?.removeEventListener('abort', aoCancelar);
      acao(valor);
    };
    const aoCancelar = () => encerrar(reject, new DOMException('cancelado', 'AbortError'));
    const iniciar = () => {
      if (acabou || proximo >= fila.length) return;
      const url = fila[proximo++];
      const host = new URL(url).hostname;
      ativos++;
      aoServidor?.(host);
      clearTimeout(relogio);
      relogio = setTimeout(iniciar, INTERVALO_ENTRE_SERVIDORES);
      overpassUm(url, consulta, LIMITE_POR_SERVIDOR).then((dados) => {
        falhasServidor.delete(url);
        encerrar(resolve, dados);
      }).catch((erro) => {
        ativos--;
        falhasServidor.set(url, (falhasServidor.get(url) || 0) + 1);
        erros.push(`${host}: ${erro.message}`);
        if (proximo < fila.length) iniciar();
        else if (!ativos) encerrar(reject, new Error(erros.join('; ')));
      });
    };
    if (signal?.aborted) { aoCancelar(); return; }
    signal?.addEventListener('abort', aoCancelar);
    iniciar();
  });
}

async function overpassCorrida(urls, consulta, opcoes = {}) {
  try {
    return await overpassUmaVolta(urls, consulta, opcoes);
  } catch (erro) {
    if (erro.name === 'AbortError') throw erro;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (opcoes.signal?.aborted) throw new DOMException('cancelado', 'AbortError');
    return overpassUmaVolta(urls, consulta, opcoes);
  }
}

/* ---- pacote de ruas offline ---- */

const pacoteRuas = { status: null, ocupado: false, etapa: '', fracao: null, erro: '' };
const GRAU_LADRILHO = 0.02;

async function ruasPackAtualizar() {
  if (!window.desktop?.ruasPackStatus) return null;
  pacoteRuas.status = await window.desktop.ruasPackStatus();
  pintarPacoteRuas();
  return pacoteRuas.status;
}

/** O pacote guarda as coordenadas como diferenças em milionésimos de grau. */
function expandirLadrilho(ladrilho) {
  for (const via of ladrilho.ways) {
    const d = via.d;
    const pontos = new Array(d.length / 2);
    let lat = 0;
    let lon = 0;
    for (let i = 0; i < d.length; i += 2) {
      lat += d[i];
      lon += d[i + 1];
      pontos[i / 2] = [lat / 1e6, lon / 1e6];
    }
    via.p = pontos;
    delete via.d;
  }
  return ladrilho;
}

/** Ladrilho do pacote. Dentro da cobertura, ausência significa "não há vias aqui", e não "falta baixar". */
async function ruasPackTile(chave) {
  const status = pacoteRuas.status;
  if (!status?.instalado) return null;
  const texto = await window.desktop.ruasPackTile(chave);
  if (texto) return expandirLadrilho(JSON.parse(texto));
  const [ix, iy] = chave.split(':').map(Number);
  const faixas = status.info?.cobertura;
  const dentro = Array.isArray(faixas) && faixas.some(([sul, norte, oeste, leste]) => (
    (iy + 1) * GRAU_LADRILHO > sul && iy * GRAU_LADRILHO < norte && (ix + 1) * GRAU_LADRILHO > oeste && ix * GRAU_LADRILHO < leste
  ));
  return dentro ? { v: 1, ways: [] } : null;
}

const fmtMb = (bytes) => `${(bytes / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} MB`;

function pintarPacoteRuas() {
  const { status, ocupado, etapa, fracao, erro } = pacoteRuas;
  const texto = !window.desktop?.ruasPackStatus
    ? 'Disponível só no aplicativo instalado.'
    : ocupado
      ? `${etapa}${fracao != null ? ` · ${Math.round(fracao * 100)}%` : ''}`
      : status?.instalado
        ? `Instalado: ${status.info.vias.toLocaleString('pt-BR')} vias, ${fmtMb(status.bytes)}, dados de ${status.info.data || 'data não informada'}. As áreas de Pernambuco não dependem mais da internet.`
        : 'Não instalado. Sem ele, cada área nova baixa as ruas dos servidores públicos, o que pode demorar minutos.';
  document.querySelectorAll('.ruas-pack').forEach((caixa) => {
    caixa.querySelector('.ruas-pack-texto').textContent = erro ? `Falha: ${erro}` : texto;
    caixa.querySelector('.ruas-pack-baixar').hidden = ocupado;
    caixa.querySelector('.ruas-pack-baixar').textContent = status?.instalado ? 'Atualizar' : 'Baixar (cerca de 445 MB)';
    caixa.querySelector('.ruas-pack-importar').hidden = ocupado;
    caixa.querySelector('.ruas-pack-exportar').hidden = ocupado || !status?.instalado;
    caixa.querySelector('.ruas-pack-cancelar').hidden = !ocupado;
  });
}

async function ruasPackAcao(acao) {
  if (pacoteRuas.ocupado) return;
  pacoteRuas.ocupado = true;
  pacoteRuas.erro = '';
  pacoteRuas.etapa = 'Preparando…';
  pacoteRuas.fracao = null;
  pintarPacoteRuas();
  try {
    const resposta = await acao();
    if (resposta?.saved) toast.success('Pacote de ruas exportado', resposta.path, { actionLabel: 'Mostrar na pasta', action: () => window.desktop.revealFile(resposta.path) });
    else if (resposta?.instalado) toast.success('Pacote de ruas instalado', 'As áreas de Pernambuco agora abrem sem depender da internet.');
  } catch (erro) {
    pacoteRuas.erro = String(erro?.message || erro);
  } finally {
    pacoteRuas.ocupado = false;
    await ruasPackAtualizar();
    if (typeof OSM2 !== 'undefined') OSM2.clear();
  }
}

function ligarPacoteRuas() {
  document.querySelectorAll('.ruas-pack').forEach((caixa) => {
    caixa.querySelector('.ruas-pack-baixar').addEventListener('click', () => ruasPackAcao(() => window.desktop.ruasPackDownload()));
    caixa.querySelector('.ruas-pack-importar').addEventListener('click', () => ruasPackAcao(() => window.desktop.ruasPackImport()));
    caixa.querySelector('.ruas-pack-exportar').addEventListener('click', () => ruasPackAcao(() => window.desktop.ruasPackExport()));
    caixa.querySelector('.ruas-pack-cancelar').addEventListener('click', () => window.desktop.ruasPackCancel());
  });
  window.desktop?.onRuasPackProgress?.((evento) => {
    pacoteRuas.etapa = evento.etapa;
    pacoteRuas.fracao = evento.fracao;
    pintarPacoteRuas();
  });
  ruasPackAtualizar().catch(console.error);
}

// Fora do app (modo de teste no navegador) o banco de trabalho cai no localStorage.
const ws = {
  async get(chave) {
    const texto = window.desktop?.wsGet ? await window.desktop.wsGet(chave) : localStorage.getItem(`ws:${chave}`);
    return texto ? JSON.parse(texto) : null;
  },
  async put(chave, valor) {
    const texto = JSON.stringify(valor);
    if (window.desktop?.wsPut) await window.desktop.wsPut(chave, texto);
    else localStorage.setItem(`ws:${chave}`, texto);
  },
  async delPrefix(prefixo) {
    if (window.desktop?.wsDeletePrefix) return window.desktop.wsDeletePrefix(prefixo);
    Object.keys(localStorage).filter((k) => k.startsWith(`ws:${prefixo}`)).forEach((k) => localStorage.removeItem(k));
    return 0;
  },
  async stats(prefixo) {
    return window.desktop?.wsStats ? window.desktop.wsStats(prefixo) : null;
  },
};

const FILTROS = {
  dxf: ['Desenho DXF', ['dxf']],
  csv: ['Planilha CSV', ['csv']],
  geojson: ['GeoJSON', ['geojson']],
  json: ['JSON', ['json']],
};

async function salvarArquivo(nome, texto, mime) {
  const ext = nome.split('.').pop().toLowerCase();
  if (window.desktop?.saveFile) {
    const [rotulo, extensoes] = FILTROS[ext] || ['Arquivo', [ext]];
    const salvo = await window.desktop.saveFile({
      defaultName: nome,
      title: `Salvar ${nome}`,
      content: texto,
      filters: [{ name: rotulo, extensions: extensoes }],
    });
    if (salvo?.error) toast.error('Falha ao salvar', salvo.error);
    if (salvo?.saved) {
      toast.success('Arquivo salvo', nome, salvo.path ? { actionLabel: 'Mostrar na pasta', action: () => window.desktop.revealFile(salvo.path) } : {});
    }
    return salvo;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([texto], { type: mime || 'text/plain' }));
  link.download = nome;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  return { saved: true };
}

function base64DeBytes(bytes) {
  const PASSO = 0x8000;
  let binario = '';
  for (let i = 0; i < bytes.length; i += PASSO) binario += String.fromCharCode.apply(null, bytes.subarray(i, i + PASSO));
  return btoa(binario);
}

async function salvarPacote(nomeBase, modo, arquivos) {
  if (!window.desktop?.packPick) return { saved: false, error: 'O pacote só pode ser gravado no aplicativo instalado.' };
  const escolha = await window.desktop.packPick(modo, nomeBase);
  if (escolha?.cancelled) return { saved: false };
  const files = arquivos.map((a) => (a.bytes ? { name: a.name, base64: base64DeBytes(a.bytes) } : { name: a.name, text: a.text }));
  return window.desktop.packWrite(escolha.path, modo, files);
}

/* ---- desenho configurado no NeoGrid -> estilos do projeto ---- */

const textoExpr = (valor) => `'${String(valor).replace(/'/g, "''")}'`;
const campoExpr = (campo) => `"${String(campo).toUpperCase().replace(/"/g, '')}"`;

function condicaoExpr({ field, operator, value }) {
  const campo = campoExpr(field);
  const texto = `upper(to_string(coalesce(${campo},'')))`;
  const valor = String(value ?? '');
  const alvo = textoExpr(valor.toUpperCase());
  switch (operator) {
    case 'contains': return `${texto} LIKE ${textoExpr(`%${valor.toUpperCase()}%`)}`;
    case 'notContains': return `NOT (${texto} LIKE ${textoExpr(`%${valor.toUpperCase()}%`)})`;
    case 'equals': return `${texto} = ${alvo}`;
    case 'notEquals': return `${texto} <> ${alvo}`;
    case 'startsWith': return `${texto} LIKE ${textoExpr(`${valor.toUpperCase()}%`)}`;
    case 'endsWith': return `${texto} LIKE ${textoExpr(`%${valor.toUpperCase()}`)}`;
    case 'in': return `(${valor.split(';').map((v) => `${texto} = ${textoExpr(v.trim().toUpperCase())}`).join(' OR ')})`;
    case 'empty': return `${campo} IS NULL`;
    case 'notEmpty': return `${campo} IS NOT NULL`;
    case 'gt': return `to_real(${campo}) > ${Number(valor) || 0}`;
    case 'gte': return `to_real(${campo}) >= ${Number(valor) || 0}`;
    case 'lt': return `to_real(${campo}) < ${Number(valor) || 0}`;
    case 'lte': return `to_real(${campo}) <= ${Number(valor) || 0}`;
    case 'regex': return `regexp_match(to_string(coalesce(${campo},'')), ${textoExpr(valor)})`;
    default: return '';
  }
}

export function regraParaExpr(regra) {
  const partes = (regra.conditions || []).map(condicaoExpr).filter(Boolean);
  return partes.join(regra.match === 'any' ? ' OR ' : ' AND ');
}

/** Primeira abertura: o projeto nasce com os blocos e regras já configurados no NeoGrid. */
function aplicarDesenhoNeoGrid() {
  const ajustes = loadDxfSettings();
  if (ajustes.library?.text) {
    try {
      const importados = DXF.importar(DXF.parseAll(ajustes.library.text), ajustes.library.name || 'biblioteca.dxf');
      for (const [nome, bloco] of Object.entries(importados)) BLOCOS[nome] = bloco;
    } catch (error) {
      console.warn('[projeto] biblioteca de blocos não importada', error);
    }
  }
  for (const type of ['poste', 'inst']) {
    const camada = CFG.cam[type];
    if (ajustes.blocks?.[type]) camada.base.bloco = ajustes.blocks[type];
    const regras = (ajustes.blockRules?.[type] || [])
      .filter((regra) => regra.block && regra.enabled !== false)
      .map((regra) => ({ nome: regra.name || 'Regra', on: true, expr: regraParaExpr(regra), camada: '', est: { bloco: regra.block } }))
      .filter((regra) => regra.expr);
    if (regras.length) camada.rules = [...regras, ...camada.rules];
  }
  for (const type of ['poste', 'inst', 'bt', 'mt']) {
    const modelo = ajustes.labels?.[type];
    if (modelo && modelo !== DEFAULT_DXF_SETTINGS.labels[type] && CFG.cam[type].labels[0]) CFG.cam[type].labels[0].expr = modeloParaExpr(modelo);
  }
}

const CAMPOS_CALCULADOS = {
  ASSINATURA: `sigla(coalesce("TIPO_PG","CD_TIPO_PG_DESC")) || coalesce("NU_ALTURA",'?') || '/' || coalesce("NU_ESFORCO",'?')`,
  CONDUTORES: `uniq_join('/', "CONDUTOR_A","CONDUTOR_B","CONDUTOR_C")`,
  COMPRIMENTO: `format_number(coalesce(nullif(to_real("NU_COMPRIMENTO_REAL"),0), nullif(to_real("SHP_LENGTH"),0), $length), 1)`,
};

/** "{CAMPO} texto" do construtor de rótulos do NeoGrid vira expressão do Projeto. */
export function modeloParaExpr(modelo) {
  const partes = [];
  let resto = String(modelo);
  while (resto) {
    const m = /\{([^{}]+)\}/.exec(resto);
    if (!m) { partes.push(textoExpr(resto)); break; }
    if (m.index) partes.push(textoExpr(resto.slice(0, m.index)));
    const campo = m[1].trim().toUpperCase();
    partes.push(CAMPOS_CALCULADOS[campo] ? `(${CAMPOS_CALCULADOS[campo]})` : `coalesce(${campoExpr(campo)},'')`);
    resto = resto.slice(m.index + m[0].length);
  }
  return partes.join(' || ');
}

/* ---- regionais ---- */

async function iniciarRegionais() {
  const caixa = $('#regionaisBox');
  if (!caixa) return;
  caixa.hidden = true;
  if (!usaBanco() || !window.desktop?.dbQuery) return;
  const resposta = await window.desktop.dbQuery('db:regions', {});
  const todas = resposta?.result?.all || [];
  estado.regionais = todas;
  if (!todas.length) return;
  const marcadas = new Set(resposta.result.selected?.length ? resposta.result.selected : todas);
  const lista = $('#regionaisLista');
  lista.replaceChildren(...todas.map((nome) => {
    const rotulo = document.createElement('label');
    rotulo.className = 'regional-item';
    const marca = document.createElement('input');
    marca.type = 'checkbox';
    marca.checked = marcadas.has(nome);
    marca.value = nome;
    const texto = document.createElement('span');
    texto.textContent = nome.replace(/^REGIONAL_/, '').replace(/_/g, ' ');
    texto.title = nome;
    rotulo.append(marca, texto);
    return rotulo;
  }));
  caixa.hidden = false;
}

async function aplicarRegionais() {
  const marcas = [...document.querySelectorAll('#regionaisLista input')];
  const escolhidas = marcas.filter((m) => m.checked).map((m) => m.value);
  // Nenhuma marcada significa não mostrar nada; todas marcadas dispensa o filtro.
  const filtro = escolhidas.length === marcas.length ? [] : (escolhidas.length ? escolhidas : ['\u0000nenhuma']);
  await window.desktop.dbQuery('db:set-regions', { regions: filtro });
  deps.mapView.renderer?.schedule();
}

const estado = { regionais: [] };

/* ---- interface ---- */

const LARGURA_PAINEL = 'neogrid.larguraPainel';

function ligarAlcaPainel() {
  const alca = $('#ngAlca');
  if (!alca) return;
  const raiz = document.documentElement;
  const salva = Number(localStorage.getItem(LARGURA_PAINEL));
  if (salva >= 320 && salva <= 900) raiz.style.setProperty('--prj-w', `${salva}px`);
  alca.addEventListener('pointerdown', (inicio) => {
    alca.setPointerCapture(inicio.pointerId);
    const x0 = inicio.clientX;
    const l0 = $('#ngPaineis').getBoundingClientRect().width;
    const mover = (e) => raiz.style.setProperty('--prj-w', `${Math.max(320, Math.min(Math.min(900, innerWidth - 420), l0 + e.clientX - x0))}px`);
    const soltar = () => {
      alca.removeEventListener('pointermove', mover);
      alca.removeEventListener('pointerup', soltar);
      localStorage.setItem(LARGURA_PAINEL, String(Math.round($('#ngPaineis').getBoundingClientRect().width)));
      deps.mapView.invalidate();
    };
    alca.addEventListener('pointermove', mover);
    alca.addEventListener('pointerup', soltar);
  });
}

async function abrirProjeto() {
  deps.navigate?.('map');
  try {
    await carregarMotor();
  } catch (error) {
    toast.error('Falha ao abrir o módulo Projeto', error.message);
    return;
  }
  $('#cons').hidden = true;
  $('#prj').hidden = false;
  prjUI();
}

async function abrirConsultaPainel() {
  deps.navigate?.('map');
  try {
    await carregarMotor();
    await abrirConsulta();
  } catch (error) {
    toast.error('Falha ao abrir a consulta', error.message);
  }
}

export function initProjeto(options) {
  deps = options;
  const { mapView } = deps;

  window.NG = {
    map: mapView.map,
    hasData: () => library.hasData(),
    temBanco: usaBanco,
    camadas: () => LAYER_TYPES.filter((type) => library.get(type)?.stats.count),
    regionais: () => estado.regionais,
    lerArea,
    lerCamada,
    atualizarKml,
    overpassCorrida,
    ruasPackTile,
    mapaAlterado: () => {
      mapView.renderer?.schedule();
      // Painel de camadas e legenda acompanham as cores de Estilos.
      const cores = window.ngMapa?.cores() || {};
      for (const [tipo, cor] of Object.entries(cores)) {
        document.documentElement.style.setProperty(`--layer-${tipo}`, cor);
        if (LAYER_META[tipo]) LAYER_META[tipo].color = cor;
      }
      mapView.updateLayerPanel?.();
      bus.emit('estilos:changed');
    },
    camadaVisivel: (tipo) => Boolean(mapView.getVisibleLayers()[tipo]),
    kmlVisivel: setKmlVisible,
    // Estilos → Camadas: um só lugar para o que aparece no mapa.
    kmlLigado: () => hasKmlData() && kmlVisivel(),
    temKml: hasKmlData,
    abrirKml: openKmlDialogFromApp,
    kmlOpcoes,
    kmlOpcao: setKmlOpcao,
    rotulosGerais: () => Boolean(settings.labels),
    definirRotulosGerais: (ligados) => updateSetting('labels', Boolean(ligados)),
    ligarCamada: (tipo, ligada) => mapView.setLayer(tipo, ligada),
    lerCamadaDS: async (tipo, bounds) => {
      const lido = await lerCamada(tipo, bounds, CAP_AREA);
      return montarDS(tipo, lido.h, lido.rows, false);
    },
    camadaTemDados: (tipo) => Boolean(library.get(tipo)?.stats.count),
    /** Colunas da camada carregada: a lista de campos do rótulo funciona sem marcar área. */
    campos: (tipo) => library.get(tipo)?.headers || [],
    avisoRuasMapa: (texto) => {
      if (texto) mapView.showNotice(texto, 'ruas-mapa');
      else mapView.hideNotice();
    },
    sql: async (consulta, max) => {
      const resposta = await window.desktop.dbSql(consulta, max);
      if (!resposta?.ok) throw new Error(resposta?.error || 'Falha na consulta.');
      return resposta.result;
    },
    wsGet: ws.get,
    wsPut: ws.put,
    wsDelPrefix: ws.delPrefix,
    wsStats: ws.stats,
    salvarArquivo,
    salvarPacote,
    aplicarDesenhoNeoGrid,
    avisar: (mensagem) => toast.info('Projeto', mensagem, { duration: 7000 }),
    focar: (lat, lon) => mapView.focusLatLng(lat, lon, 18),
    origemDados: () => library.dbInfo?.path || 'CSVs importados nesta sessão',
    registrarExportacao: (nome, caminho, arquivos) => library.addExport({ format: 'Pacote', name: nome, type: 'pacote', rows: arquivos, bytes: 0, path: caminho }),
    modoProjeto: (ligado) => {
      mapView.setProjectMode(ligado);
      window.ngRuasMapa?.pausar(ligado);
    },
    colunaProjeto: (ligada) => {
      const layout = document.querySelector('.map-layout');
      layout?.classList.toggle('is-prj', ligada);
      // Só o Projeto (e seus painéis) ativa o modo de teclado do projeto; o KML não.
      const projetoAberto = Boolean($('#prj') && (!$('#prj').hidden || !$('#sp').hidden));
      document.body.classList.toggle('is-projeto', Boolean(ligada) && projetoAberto);
      // O item ativo do menu é sincronizado pela casca (main.js), que também mantém o menu aberto.
    },
  };
  mapView.clickCapture = () => (typeof ngCapturando === 'function' ? ngCapturando() : false);

  $('#mapProjeto')?.addEventListener('click', abrirProjeto);
  $('#exportPacoteGo')?.addEventListener('click', abrirProjeto);
  $('#mapMedir')?.addEventListener('click', async () => {
    await carregarMotor();
    medirLigar(!medir);
  });
  $('#prjx')?.addEventListener('click', () => { $('#prj').hidden = true; });
  $('#mapStreets')?.addEventListener('click', async () => {
    await carregarMotor();
    camadaRuas(!camadaRuasLigada(), true);
  });
  bus.on('labels:open', async (aba) => {
    deps.navigate?.('map');
    await carregarMotor();
    abrirSP(typeof aba === 'string' ? aba : undefined);
  });
  document.querySelectorAll('[data-estilos-abrir]').forEach((botao) => {
    botao.addEventListener('click', () => bus.emit('labels:open', botao.dataset.estilosAbrir || undefined));
  });
  const marcarItem = (item, ligada) => {
    if (!item) return;
    item.classList.toggle('is-off', !ligada);
    const caixa = item.querySelector('input');
    if (caixa) caixa.checked = ligada;
  };
  const itemExtra = (nome) => document.querySelector(`#mapLegend [data-extra="${nome}"]`);
  const pintarLegenda = () => {
    const ativas = mapView.getVisibleLayers();
    document.querySelectorAll('#mapLegend [data-camada]').forEach((item) => {
      marcarItem(item, Boolean(ativas[item.dataset.camada]));
    });
    const ruasLigadas = motor && typeof camadaRuasLigada === 'function' && camadaRuasLigada();
    marcarItem(itemExtra('ruas'), Boolean(ruasLigadas));
    $('#mapStreets')?.classList.toggle('is-active', Boolean(ruasLigadas));
    // Sem arquivo carregado não há KML para mostrar, ainda que a camada esteja liberada.
    marcarItem(itemExtra('kml'), hasKmlData() && kmlVisivel());
    marcarItem(itemExtra('rotulos'), Boolean(settings.labels));
    // Rótulos de cada camada; com a chave geral desligada, nenhum aparece.
    document.querySelectorAll('#mapLegend [data-rot]').forEach((botao) => {
      const ligado = window.ngMapa ? window.ngMapa.rotuloLigado(botao.dataset.rot) : true;
      botao.setAttribute('aria-pressed', String(ligado));
      botao.disabled = !settings.labels;
    });
    if (typeof ngCamadasPintar === 'function') ngCamadasPintar();
    // Estilos → Camadas aberto acompanha a legenda, sem redesenhar enquanto alguém mexe nele.
    const painel = $('#sp');
    if (typeof SP !== 'undefined' && SP.aba === 'camadas' && painel && !painel.hidden && !painel.contains(document.activeElement)) renderSP();
  };
  document.querySelectorAll('#mapLegend [data-rot]').forEach((botao) => {
    botao.addEventListener('click', async () => {
      await carregarMotor();
      const grupo = botao.dataset.rot;
      window.ngMapa.definirRotulo(grupo, !window.ngMapa.rotuloLigado(grupo));
      pintarLegenda();
    });
  });
  document.querySelectorAll('#mapLegend [data-camada] input').forEach((caixa) => {
    caixa.addEventListener('change', () => mapView.setLayer(caixa.closest('[data-camada]').dataset.camada, caixa.checked));
  });
  itemExtra('ruas')?.querySelector('input')?.addEventListener('change', async (evento) => {
    const ligar = evento.target.checked;
    await carregarMotor();
    camadaRuas(ligar, true);
    pintarLegenda();
  });
  itemExtra('kml')?.querySelector('input')?.addEventListener('change', async (evento) => {
    if (!hasKmlData()) {
      pintarLegenda();
      openKmlDialogFromApp();
      return;
    }
    const ligar = evento.target.checked;
    await carregarMotor();
    await ngLigarCamada('kml', ligar);
    pintarLegenda();
  });
  itemExtra('rotulos')?.querySelector('input')?.addEventListener('change', (evento) => {
    updateSetting('labels', evento.target.checked);
  });
  // O motor guarda a visibilidade do KML para os desenhos dele: as duas pontas andam juntas.
  const sincronizarKml = () => {
    if (motor && typeof ativo !== 'undefined') ativo.kmlp = ativo.kmll = kmlVisivel();
    pintarLegenda();
  };
  bus.on('layers:changed', pintarLegenda);
  bus.on('kml:changed', sincronizarKml);
  bus.on('settings:changed', ({ key }) => {
    if (key === 'labels' || key === 'all') {
      pintarLegenda();
      window.ngRuasMapa?.redesenhar();
    }
  });
  bus.on('estilos:changed', pintarLegenda);
  window.NG.camadasPintar = pintarLegenda;
  pintarLegenda();
  ligarAlcaPainel();
  ligarPacoteRuas();
  // Rótulos e blocos do mapa usam a configuração do Projeto: o motor carrega logo após a abertura.
  setTimeout(() => {
    carregarMotor().then(() => {
      sincronizarKml();
      mapView.renderer?.schedule();
    }).catch((erro) => console.error('[projeto]', erro));
  }, 0);
  document.querySelectorAll('#limitesBox input').forEach((entrada) => {
    entrada.addEventListener('pointerdown', () => { carregarMotor(); }, { once: true });
  });
  $('#limMunBusca')?.addEventListener('input', async (evento) => {
    await carregarMotor();
    const termo = evento.target.value.trim();
    const achados = termo.length >= 2 ? limMunicipios(termo) : [];
    const lista = $('#limMunLista');
    lista.replaceChildren(...achados.map((achado) => {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'link-btn';
      botao.textContent = achado.t;
      botao.addEventListener('click', () => {
        irMunicipio(achado.mun);
        lista.replaceChildren();
        evento.target.value = '';
      });
      return botao;
    }));
  });
  $('#regionaisAplicar')?.addEventListener('click', aplicarRegionais);
  $('#regionaisTodas')?.addEventListener('click', () => {
    const marcas = [...document.querySelectorAll('#regionaisLista input')];
    const todas = marcas.every((m) => m.checked);
    marcas.forEach((m) => { m.checked = !todas; });
  });
  bus.on('data:changed', () => { iniciarRegionais().catch(console.error); });

  return { abrir: abrirProjeto, consulta: abrirConsultaPainel };
}
