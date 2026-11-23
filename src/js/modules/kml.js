import { bus } from '../core/bus.js';
import { esc, fmtInt } from '../core/format.js';
import { icon, closeDialog, openDialog } from '../core/dom.js';
import { settings } from '../core/settings.js';
import { toast } from '../ui/toast.js';

const STORAGE_KEY = 'neogrid.kml.v1';

const DEFAULT_OPTIONS = Object.freeze({
  showPoints: true,
  showLines: true,
  showPolygons: true,
  showLabels: true,
  useKmlColors: true,
  pointColor: '#f472b6',
  lineColor: '#38bdf8',
  polygonColor: '#22c55e',
});

const state = {
  files: [],
  options: { ...DEFAULT_OPTIONS },
  fileStyles: {},
  fitOnImport: true,
  oculto: false,
};

let deps = {};
let els = {};
let layer = null;
let sequence = 0;

const childrenByLocal = (element, name) => [...(element?.children || [])]
  .filter((child) => child.localName === name);

const firstDescendant = (element, name) => {
  for (const node of element?.getElementsByTagName?.('*') || []) {
    if (node.localName === name) return node;
  }
  return null;
};

const directText = (element, name) => childrenByLocal(element, name)[0]?.textContent?.trim() || '';

function parseCoordinates(text) {
  if (!text) return [];
  const points = [];
  for (const tuple of String(text).trim().split(/\s+/)) {
    if (!tuple) continue;
    const parts = tuple.split(',').map((value) => Number(value));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    points.push([parts[1], parts[0]]);
  }
  return points;
}

/** KML colours are aabbggrr. Returns a CSS hex colour (ignoring alpha). */
function kmlColor(value) {
  const hex = String(value || '').trim();
  if (!/^[0-9a-f]{8}$/i.test(hex)) return '';
  return `#${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}`;
}

function kmlAlpha(value) {
  const hex = String(value || '').trim();
  if (!/^[0-9a-f]{8}$/i.test(hex)) return 1;
  return Math.max(0, Math.min(1, parseInt(hex.slice(0, 2), 16) / 255));
}

function readStyle(element) {
  if (!element) return {};
  const line = firstDescendant(element, 'LineStyle');
  const poly = firstDescendant(element, 'PolyStyle');
  const icon = firstDescendant(element, 'IconStyle');
  const label = firstDescendant(element, 'LabelStyle');
  const lineColor = kmlColor(firstDescendant(line, 'color')?.textContent);
  const polyColor = kmlColor(firstDescendant(poly, 'color')?.textContent);
  const iconColor = kmlColor(firstDescendant(icon, 'color')?.textContent);
  const labelColor = kmlColor(firstDescendant(label, 'color')?.textContent);
  const width = Number(firstDescendant(line, 'width')?.textContent);
  const fill = String(firstDescendant(poly, 'fill')?.textContent || '').trim() !== '0';
  const outline = String(firstDescendant(poly, 'outline')?.textContent || '').trim() !== '0';
  return {
    lineColor,
    polyColor,
    iconColor,
    labelColor,
    width: Number.isFinite(width) && width > 0 ? Math.min(8, width) : 0,
    fill,
    outline,
    lineAlpha: kmlAlpha(firstDescendant(line, 'color')?.textContent),
    polyAlpha: kmlAlpha(firstDescendant(poly, 'color')?.textContent),
  };
}

function collectStyles(doc) {
  const styles = new Map();
  const styleMaps = new Map();
  for (const node of doc.getElementsByTagName('*')) {
    const id = node.getAttribute?.('id');
    if (!id) continue;
    if (node.localName === 'Style') styles.set(id, readStyle(node));
    else if (node.localName === 'StyleMap') styleMaps.set(id, node);
  }
  const resolveStyleMap = (id) => {
    const map = styleMaps.get(id);
    if (!map) return null;
    const pairs = [...map.getElementsByTagName('*')].filter((node) => node.localName === 'Pair');
    let fallback = null;
    for (const pair of pairs) {
      const key = directText(pair, 'key');
      const url = directText(pair, 'styleUrl').replace(/^.*#/, '');
      const style = styles.get(url) || (styleMaps.has(url) ? resolveStyleMap(url) : null);
      if (!style) continue;
      if (key === 'normal') return style;
      fallback = fallback || style;
    }
    return fallback;
  };
  return {
    styles,
    resolve(id) {
      if (!id) return {};
      const clean = String(id).replace(/^.*#/, '');
      return styles.get(clean) || resolveStyleMap(clean) || {};
    },
  };
}

function styleForPlacemark(placemark, styles) {
  const inline = childrenByLocal(placemark, 'Style')[0];
  if (inline) return readStyle(inline);
  const url = directText(placemark, 'styleUrl');
  return styles.resolve(url);
}

function folderName(element) {
  const nomes = [];
  let node = element?.parentElement;
  while (node) {
    if (node.localName === 'Folder') {
      const nome = directText(node, 'name');
      if (nome) nomes.unshift(nome);
    }
    node = node.parentElement;
  }
  return nomes.join(' / ');
}

function geometryFromPlacemark(placemark) {
  const result = { points: [], lines: [], polygons: [], unsupported: [] };
  const visit = (node) => {
    for (const child of [...(node?.children || [])]) {
      const name = child.localName;
      if (name === 'Point') {
        const coords = parseCoordinates(firstDescendant(child, 'coordinates')?.textContent);
        if (coords.length) result.points.push(coords[0]);
      } else if (name === 'LineString') {
        const coords = parseCoordinates(firstDescendant(child, 'coordinates')?.textContent);
        if (coords.length >= 2) result.lines.push(coords);
      } else if (name === 'Polygon') {
        const rings = [];
        for (const boundary of [...child.children]) {
          if (boundary.localName !== 'outerBoundaryIs' && boundary.localName !== 'innerBoundaryIs') continue;
          const coords = parseCoordinates(firstDescendant(boundary, 'coordinates')?.textContent);
          if (coords.length >= 3) rings.push(coords);
        }
        if (rings.length) result.polygons.push(rings);
      } else if (name === 'MultiGeometry') {
        visit(child);
      } else if (name === 'Track' || name === 'MultiTrack') {
        const coords = [];
        for (const coord of child.getElementsByTagName('*')) {
          if (coord.localName !== 'coord') continue;
          const parts = coord.textContent.trim().split(/\s+/).map(Number);
          if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
            coords.push([parts[1], parts[0]]);
          }
        }
        if (coords.length >= 2) result.lines.push(coords);
      } else if (name === 'Model') {
        result.unsupported.push('Model');
      } else if (name === 'GroundOverlay' || name === 'ScreenOverlay' || name === 'PhotoOverlay') {
        result.unsupported.push(name);
      }
    }
  };
  visit(placemark);
  return result;
}

function featureBounds(features) {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  const add = ([lat, lon]) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
  };
  for (const feature of features) {
    if (feature.kind === 'point') add([feature.lat, feature.lon]);
    else if (feature.kind === 'line') feature.pts.forEach(add);
    else if (feature.kind === 'polygon') feature.rings.forEach((ring) => ring.forEach(add));
  }
  if (!Number.isFinite(south) || !Number.isFinite(west)) return null;
  return { south, west, north, east };
}

const XML_ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (todo, codigo) => {
    if (codigo[0] === '#') {
      const numero = codigo[1].toLowerCase() === 'x' ? parseInt(codigo.slice(2), 16) : parseInt(codigo.slice(1), 10);
      return Number.isFinite(numero) ? String.fromCodePoint(numero) : todo;
    }
    return XML_ENTIDADES[codigo.toLowerCase()] ?? todo;
  });
}

/** Lê um bloco de <Style> direto do texto (usado no caminho rápido). */
function readStyleText(bloco) {
  const trecho = (nome) => {
    const achado = new RegExp(`<${nome}[^>]*>([\\s\\S]*?)</${nome}>`, 'i').exec(bloco);
    return achado ? achado[1] : '';
  };
  const valor = (texto, nome) => {
    const achado = new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`, 'i').exec(texto);
    return achado ? achado[1].trim() : '';
  };
  const linha = trecho('LineStyle');
  const area = trecho('PolyStyle');
  const icone = trecho('IconStyle');
  const rotulo = trecho('LabelStyle');
  const corLinha = valor(linha, 'color');
  const corArea = valor(area, 'color');
  const largura = Number(valor(linha, 'width'));
  return {
    lineColor: kmlColor(corLinha),
    polyColor: kmlColor(corArea),
    iconColor: kmlColor(valor(icone, 'color')),
    labelColor: kmlColor(valor(rotulo, 'color')),
    width: Number.isFinite(largura) && largura > 0 ? Math.min(8, largura) : 0,
    fill: valor(area, 'fill') !== '0',
    outline: valor(area, 'outline') !== '0',
    lineAlpha: kmlAlpha(corLinha),
    polyAlpha: kmlAlpha(corArea),
  };
}

/**
 * Caminho rápido para KML grandes (dezenas de MB): percorre o texto com
 * expressões regulares em vez de montar um DOM com milhões de nós.
 */
export function parseKmlFast(text, fileName = 'arquivo.kml') {
  const src = String(text || '');
  const estilos = new Map();
  const estiloRe = /<Style\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/Style>/g;
  let achado;
  while ((achado = estiloRe.exec(src))) estilos.set(achado[1], readStyleText(achado[2]));
  const resolver = (url) => {
    const id = String(url || '').replace(/^.*#/, '');
    return id ? estilos.get(id) || null : null;
  };

  const coordsDe = (bloco) => {
    const m = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(bloco);
    return parseCoordinates(m ? m[1] : '');
  };

  const features = [];
  const pastas = [];
  const tokenRe = /<Folder\b[^>]*>|<\/Folder>|<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g;
  while ((achado = tokenRe.exec(src))) {
    const token = achado[0];
    if (token.startsWith('</Folder')) {
      pastas.pop();
      continue;
    }
    if (token.startsWith('<Folder')) {
      const inicio = tokenRe.lastIndex;
      const nomePasta = /^\s*<name>([\s\S]*?)<\/name>/.exec(src.slice(inicio, inicio + 500));
      pastas.push(nomePasta ? decodeXml(nomePasta[1]).trim() : `Pasta ${pastas.length + 1}`);
      continue;
    }
    const corpo = achado[1];
    const pasta = pastas.filter(Boolean).join(' / ');
    const nome = decodeXml((/<name>([\s\S]*?)<\/name>/.exec(corpo) || [])[1] || '').trim();
    const styleUrl = (/<styleUrl>([\s\S]*?)<\/styleUrl>/.exec(corpo) || [])[1]?.trim() || '';
    let estilo = resolver(styleUrl);
    if (!estilo) {
      const inline = /<Style>([\s\S]*?)<\/Style>/.exec(corpo);
      if (inline) estilo = readStyleText(inline[1]);
    }
    const base = { name: nome, folder: pasta, styleUrl, style: estilo || {}, placemark: features.length };

    const linhaRe = /<LineString\b[^>]*>([\s\S]*?)<\/LineString>/g;
    let linha;
    while ((linha = linhaRe.exec(corpo))) {
      const pts = coordsDe(linha[1]);
      if (pts.length >= 2) features.push({ ...base, kind: 'line', pts });
    }
    const pontoRe = /<Point\b[^>]*>([\s\S]*?)<\/Point>/g;
    let ponto;
    while ((ponto = pontoRe.exec(corpo))) {
      const pts = coordsDe(ponto[1]);
      if (pts.length) features.push({ ...base, kind: 'point', lat: pts[0][0], lon: pts[0][1] });
    }
    const areaRe = /<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/g;
    let area;
    while ((area = areaRe.exec(corpo))) {
      const aneis = [];
      for (const tipo of ['outerBoundaryIs', 'innerBoundaryIs']) {
        const anelRe = new RegExp(`<${tipo}[^>]*>([\\s\\S]*?)</${tipo}>`, 'g');
        let anel;
        while ((anel = anelRe.exec(area[1]))) {
          const pts = coordsDe(anel[1]);
          if (pts.length >= 3) aneis.push(pts);
        }
      }
      if (aneis.length) features.push({ ...base, kind: 'polygon', rings: aneis });
    }
  }

  if (!features.length) throw new Error('Nenhum ponto, linha ou polígono encontrado.');
  return {
    name: fileName.replace(/\.km[zl]$/i, ''),
    fileName,
    features,
    counts: {
      points: features.filter((feature) => feature.kind === 'point').length,
      lines: features.filter((feature) => feature.kind === 'line').length,
      polygons: features.filter((feature) => feature.kind === 'polygon').length,
    },
    unsupported: {},
    bounds: featureBounds(features),
  };
}

/** Parse a KML document into points, lines and polygons. */
export function parseKml(text, fileName = 'arquivo.kml') {
  // Acima de ~4 MB o DOM fica grande demais: o caminho por regex é muito mais rápido.
  if (String(text || '').length > 4_000_000) return parseKmlFast(text, fileName);
  if (typeof DOMParser === 'undefined') throw new Error('Leitor XML indisponível.');
  const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('O arquivo não é um KML válido.');
  const styles = collectStyles(doc);
  const features = [];
  const unsupported = {};
  const countUnsupported = (name) => {
    unsupported[name] = (unsupported[name] || 0) + 1;
  };
  const placemarks = [...doc.getElementsByTagName('*')].filter((node) => node.localName === 'Placemark');
  placemarks.forEach((placemark, index) => {
    const name = directText(placemark, 'name');
    const style = styleForPlacemark(placemark, styles);
    const folder = folderName(placemark);
    const geometry = geometryFromPlacemark(placemark);
    for (const kind of geometry.unsupported) countUnsupported(kind);
    const base = {
      name,
      folder,
      styleUrl: directText(placemark, 'styleUrl'),
      style,
      placemark: index,
    };
    geometry.points.forEach(([lat, lon]) => {
      features.push({ ...base, kind: 'point', lat, lon });
    });
    geometry.lines.forEach((pts) => {
      features.push({ ...base, kind: 'line', pts });
    });
    geometry.polygons.forEach((rings) => {
      features.push({ ...base, kind: 'polygon', rings });
    });
  });
  if (!features.length) {
    const ignored = Object.keys(unsupported);
    throw new Error(ignored.length
      ? `O KML só possui elementos não suportados (${ignored.join(', ')}).`
      : 'Nenhum ponto, linha ou polígono encontrado.');
  }
  const counts = {
    points: features.filter((feature) => feature.kind === 'point').length,
    lines: features.filter((feature) => feature.kind === 'line').length,
    polygons: features.filter((feature) => feature.kind === 'polygon').length,
  };
  return {
    name: fileName.replace(/\.km[zl]$/i, ''),
    fileName,
    features,
    counts,
    unsupported,
    bounds: featureBounds(features),
  };
}

// O KML vale só enquanto o programa está aberto: os arquivos nunca são gravados.
// Ficam guardadas as preferências de exibição e a aparência de cada arquivo.
function save() {
  for (const file of state.files) {
    if (file.settings) state.fileStyles[fileKey(file)] = file.settings;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      options: state.options,
      styles: state.fileStyles,
      fitOnImport: state.fitOnImport,
    }));
  } catch {
    /* sem armazenamento: as preferências valem nesta sessão */
  }
  bus.emit('kml:changed');
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw) return;
    state.options = { ...DEFAULT_OPTIONS, ...(raw.options || {}) };
    state.fileStyles = raw.styles && typeof raw.styles === 'object' ? raw.styles : {};
    state.fitOnImport = raw.fitOnImport !== false;
    // Versões anteriores guardavam os arquivos: apaga para não ocupar espaço nem reaparecer.
    if ('files' in raw || 'oculto' in raw) save();
  } catch {
    /* sem armazenamento */
  }
}

function kmlPane() {
  const map = deps.mapView?.map;
  if (!map) return;
  if (!map.getPane('kmlPane')) {
    map.createPane('kmlPane');
    map.getPane('kmlPane').style.zIndex = '460';
    map.getPane('kmlPane').style.pointerEvents = 'none';
  }
}

function clearLayer() {
  if (layer) {
    layer.remove();
    layer = null;
  }
}

function featureColor(feature, kind, fallback) {
  const estilo = window.ngMapa?.kml();
  const base = estilo ? (kind === 'point' ? estilo.ponto : estilo.linha) : fallback;
  if (!(estilo ? estilo.corKml : state.options.useKmlColors)) return base;
  fallback = base;
  const style = feature.style || {};
  if (kind === 'point') return style.iconColor || style.labelColor || fallback;
  if (kind === 'line') return style.lineColor || fallback;
  return style.polyColor || style.lineColor || fallback;
}

function addLabel(leafletLayer, name, className = 'kml-label') {
  if (!name) return;
  leafletLayer.bindTooltip(esc(name), {
    permanent: true,
    direction: 'center',
    className,
    opacity: 0.92,
  });
}

const CFG_ARQUIVO = () => ({
  hiddenFolders: [],
  hiddenStyles: [],
  lineWidth: null,
  lineColor: '',
  lineOpacity: null,
  labels: null,
  labelSource: 'name',
  pointSize: null,
  pointColor: '',
  polygonOpacity: null,
  polygonColor: '',
});

function chaveEstilo(feature) {
  const url = String(feature.styleUrl || '').replace(/^.*#/, '');
  if (url) return url;
  const style = feature.style || {};
  return `s-${style.width || 0}-${style.lineColor || ''}-${style.polyColor || ''}`;
}

/** Chave estável da aparência: o KMZ embutido mantém id; arquivos usam nome + arquivo. */
function fileKey(file) {
  return file.id === EMBUTIDO_ID ? EMBUTIDO_ID : `${file.name || ''}::${file.fileName || ''}`;
}

function cfgDoArquivo(file) {
  if (!file.settings) {
    const salvo = state.fileStyles?.[fileKey(file)];
    file.settings = { ...CFG_ARQUIVO(), ...(salvo && typeof salvo === 'object' ? salvo : {}) };
  }
  const cfg = file.settings;
  if (!Array.isArray(cfg.hiddenFolders)) cfg.hiddenFolders = [];
  if (!Array.isArray(cfg.hiddenStyles)) cfg.hiddenStyles = [];
  return cfg;
}

/** A pasta (ou uma pasta acima dela) está desmarcada? */
function pastaOculta(cfg, pasta) {
  if (!pasta) return false;
  return cfg.hiddenFolders.some((oculta) => pasta === oculta || pasta.startsWith(`${oculta} / `));
}

function meioLinha(pts) {
  return pts?.length ? pts[Math.floor(pts.length / 2)] : null;
}

function render() {
  clearLayer();
  const map = deps.mapView?.map;
  if (!map) return;
  kmlPane();
  layer = L.layerGroup();
  const visibleFiles = state.files.filter((file) => file.visible !== false);
  const k = window.ngMapa?.kml() || {};
  const raioBase = k.raio ?? 5;
  let rotulos = 0;
  const MAX_ROTULOS = 200;

  // Texto do rótulo: opção do arquivo (liga/desliga e origem) sobre a opção geral.
  const textoRotulo = (cfg, feature) => {
    if (settings.labels === false) return '';
    if (cfg.labels === false) return '';
    if (!(cfg.labels === true || state.options.showLabels)) return '';
    return (cfg.labelSource === 'folder' ? feature.folder : feature.name) || '';
  };

  // Areas below lines so the lines remain visible on top.
  if (state.options.showPolygons) {
    for (const file of visibleFiles) {
      const cfg = cfgDoArquivo(file);
      for (const feature of file.features) {
        if (feature.kind !== 'polygon') continue;
        if (pastaOculta(cfg, feature.folder || '')) continue;
        if (cfg.hiddenStyles.includes(chaveEstilo(feature))) continue;
        const color = cfg.polygonColor || featureColor(feature, 'polygon', state.options.polygonColor);
        const polygon = L.polygon(feature.rings, {
          pane: 'kmlPane',
          color,
          weight: 1.8,
          opacity: 0.9,
          fillColor: color,
          fillOpacity: cfg.polygonOpacity ?? (feature.style?.fill === false ? 0 : 0.14),
          interactive: false,
        });
        polygon.addTo(layer);
        const texto = textoRotulo(cfg, feature);
        if (texto && rotulos < MAX_ROTULOS) {
          addLabel(polygon, texto);
          rotulos += 1;
        }
      }
    }
  }

  if (state.options.showLines) {
    for (const file of visibleFiles) {
      const cfg = cfgDoArquivo(file);
      const linhas = file.features.filter(
        (feature) => feature.kind === 'line'
          && !pastaOculta(cfg, feature.folder || '')
          && !cfg.hiddenStyles.includes(chaveEstilo(feature)),
      );
      if (!linhas.length) continue;

      const cor = (feature) => cfg.lineColor || featureColor(feature, 'line', state.options.lineColor);
      const peso = (feature) => cfg.lineWidth ?? ((k.largKml ? feature.style?.width : 0) || k.larg || 2);
      const opac = (feature) => cfg.lineOpacity
        ?? (k.opacKml ? (feature.style?.lineAlpha ?? 0.9) : (k.opac ?? 0.9));

      if (linhas.length > 800) {
        // Arquivos grandes (ex.: rede de gás): agrupa por estilo e desenha em
        // um canvas só; os rótulos (até 200) vão ancorados no meio das linhas.
        const renderer = L.canvas({ pane: 'kmlPane', padding: 0.3 });
        const grupos = new Map();
        for (const feature of linhas) {
          const chave = `${cor(feature)}|${peso(feature)}|${opac(feature)}`;
          let grupo = grupos.get(chave);
          if (!grupo) {
            grupo = { color: cor(feature), weight: peso(feature), opacity: opac(feature), segmentos: [] };
            grupos.set(chave, grupo);
          }
          grupo.segmentos.push(feature.pts);
        }
        for (const grupo of grupos.values()) {
          L.polyline(grupo.segmentos, {
            pane: 'kmlPane',
            renderer,
            color: grupo.color,
            weight: grupo.weight,
            opacity: grupo.opacity,
            interactive: false,
            smoothFactor: 1,
          }).addTo(layer);
        }
        for (const feature of linhas) {
          if (rotulos >= MAX_ROTULOS) break;
          const texto = textoRotulo(cfg, feature);
          if (!texto) continue;
          const meio = meioLinha(feature.pts);
          if (!meio) continue;
          L.tooltip({ permanent: true, direction: 'center', className: 'kml-label', opacity: 0.92 })
            .setLatLng(meio)
            .setContent(esc(texto))
            .addTo(layer);
          rotulos += 1;
        }
      } else {
        for (const feature of linhas) {
          const line = L.polyline(feature.pts, {
            pane: 'kmlPane',
            color: cor(feature),
            weight: peso(feature),
            opacity: opac(feature),
            interactive: false,
          });
          line.addTo(layer);
          const texto = textoRotulo(cfg, feature);
          if (texto && rotulos < MAX_ROTULOS) {
            addLabel(line, texto);
            rotulos += 1;
          }
        }
      }
    }
  }

  if (state.options.showPoints) {
    for (const file of visibleFiles) {
      const cfg = cfgDoArquivo(file);
      for (const feature of file.features) {
        if (feature.kind !== 'point') continue;
        if (pastaOculta(cfg, feature.folder || '')) continue;
        if (cfg.hiddenStyles.includes(chaveEstilo(feature))) continue;
        const color = cfg.pointColor || featureColor(feature, 'point', state.options.pointColor);
        const marker = L.circleMarker([feature.lat, feature.lon], {
          pane: 'kmlPane',
          radius: (cfg.pointSize ?? raioBase * 2) / 2,
          color: '#0b1220',
          weight: 1.4,
          fillColor: color,
          fillOpacity: 0.95,
          interactive: false,
        });
        marker.addTo(layer);
        const texto = textoRotulo(cfg, feature);
        if (texto && rotulos < MAX_ROTULOS) {
          addLabel(marker, texto, 'kml-label kml-label-point');
          rotulos += 1;
        }
      }
    }
  }

  if (!state.oculto) layer.addTo(map);
  updateDock();
}

function summary() {
  const points = state.files.reduce((total, file) => total + (file.counts?.points || 0), 0);
  const lines = state.files.reduce((total, file) => total + (file.counts?.lines || 0), 0);
  const polygons = state.files.reduce((total, file) => total + (file.counts?.polygons || 0), 0);
  return { points, lines, polygons };
}

function updateDock() {
  if (els.fit) els.fit.disabled = !state.files.length;
  document.querySelector('#mapKml')?.classList.toggle('is-active', state.files.length > 0);
}

function hideKmlDock() {
  const painel = document.querySelector('#kmlPanel');
  if (painel) painel.hidden = true;
  const outro = ['#prj', '#sp', '#cons'].some((sel) => {
    const el = document.querySelector(sel);
    return el && !el.hidden;
  });
  if (!outro) document.querySelector('.map-layout')?.classList.remove('is-prj');
  deps.mapView?.invalidate?.();
}

function fitBounds(bounds, { maxZoom = 18 } = {}) {
  if (!bounds) return;
  deps.navigate?.('map');
  deps.mapView?.map?.fitBounds(
    L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]).pad(0.08),
    { animate: true, maxZoom, padding: [30, 30] },
  );
}

function fitAll() {
  const bounds = featureBounds(state.files.flatMap((file) => file.features));
  fitBounds(bounds);
}

function fitFile(file) {
  fitBounds(file.bounds || featureBounds(file.features));
}

/** Extrai o primeiro `.kml` de um KMZ (zip), sem depender de biblioteca externa. */
export async function unzipKml(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 22) throw new Error('KMZ vazio ou inválido.');
  const view = new DataView(buffer);
  // Localiza o "end of central directory" (assinatura 0x06054b50).
  let eocd = -1;
  const limite = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= limite; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('KMZ inválido: diretório do zip não encontrado.');
  const total = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let alvo = null;
  for (let n = 0; n < total && offset + 46 <= bytes.length; n += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const metodo = view.getUint16(offset + 10, true);
    const comprimido = view.getUint32(offset + 20, true);
    const tamNome = view.getUint16(offset + 28, true);
    const extra = view.getUint16(offset + 30, true);
    const comentario = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const nome = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + tamNome));
    if (/\.kml$/i.test(nome) && (!alvo || /(^|\/)doc\.kml$/i.test(nome))) {
      alvo = { nome, metodo, comprimido, local };
    }
    offset += 46 + tamNome + extra + comentario;
  }
  if (!alvo) throw new Error('O KMZ não contém um arquivo .kml.');
  if (alvo.local + 30 > bytes.length || view.getUint32(alvo.local, true) !== 0x04034b50) {
    throw new Error('KMZ inválido: cabeçalho do arquivo não encontrado.');
  }
  const tamNome = view.getUint16(alvo.local + 26, true);
  const extra = view.getUint16(alvo.local + 28, true);
  const inicio = alvo.local + 30 + tamNome + extra;
  const dados = bytes.subarray(inicio, inicio + alvo.comprimido);
  if (alvo.metodo === 0) return new TextDecoder().decode(dados);
  if (alvo.metodo !== 8) throw new Error(`KMZ com compressão não suportada (método ${alvo.metodo}).`);
  if (typeof DecompressionStream === 'undefined') throw new Error('Este sistema não consegue descompactar KMZ.');
  const fluxo = new Blob([dados]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(fluxo).text();
}

async function importFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => /\.(kml|kmz)$/i.test(file.name));
  if (!files.length) {
    toast.warning('Nenhum KML/KMZ selecionado', 'Escolha arquivos com extensão .kml ou .kmz.');
    return;
  }
  let added = 0;
  let firstBounds = null;
  for (const file of files) {
    try {
      const text = /\.kmz$/i.test(file.name)
        ? await unzipKml(await file.arrayBuffer())
        : await file.text();
      const parsed = parseKml(text, file.name);
      sequence += 1;
      const record = {
        id: `kml-${sequence}-${Date.now().toString(36)}`,
        name: parsed.name,
        fileName: file.name,
        addedAt: Date.now(),
        visible: true,
        counts: parsed.counts,
        unsupported: parsed.unsupported,
        bounds: parsed.bounds,
        features: parsed.features,
      };
      state.files.push(record);
      if (!firstBounds && parsed.bounds) firstBounds = parsed.bounds;
      added += 1;
      const ignored = Object.entries(parsed.unsupported || {});
      const ignoredText = ignored.length
        ? ` · ${ignored.map(([name, count]) => `${count} ${name}`).join(', ')} ignorado(s)`
        : '';
      toast.success(
        'KML carregado',
        `${file.name} · ${fmtInt(parsed.counts.points)} pontos · ${fmtInt(parsed.counts.lines)} linhas · ${fmtInt(parsed.counts.polygons)} áreas${ignoredText}`,
        { duration: 6500 },
      );
    } catch (error) {
      toast.error(`Falha ao ler ${file.name}`, error.message);
    }
  }
  if (!added) {
    updateImportStatus();
    return;
  }
  state.oculto = false; // quem acabou de importar quer ver o arquivo
  save();
  render();
  renderFiles();
  updateImportStatus();
  if (state.fitOnImport && firstBounds) fitBounds(firstBounds);
}

// ---- KMZ embutido (Rede Copergás) -----------------------------------------
// O arquivo fica em src/data/copergas.kmz (vai junto do programa). Um KMZ
// substituído pelo usuário fica no IndexedDB e tem prioridade; "Restaurar
// original" apaga o substituto e volta ao embutido.
const EMBUTIDO_URL = 'data/copergas.kmz';
const EMBUTIDO_ID = 'kml-embutido';
const EMBUTIDO_DB = 'neogrid-kml';
const EMBUTIDO_CHAVE = 'kml:copergas';

function bytesParaBase64(bytes) {
  const view = new Uint8Array(bytes);
  let binario = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binario += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return btoa(binario);
}

function base64ParaBytes(texto) {
  const binario = atob(String(texto));
  const out = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) out[i] = binario.charCodeAt(i);
  return out.buffer;
}

function abrirBancoEmbutido() {
  return new Promise((resolve, reject) => {
    const pedido = indexedDB.open(EMBUTIDO_DB, 1);
    pedido.onupgradeneeded = () => {
      const db = pedido.result;
      if (!db.objectStoreNames.contains('arquivos')) db.createObjectStore('arquivos');
    };
    pedido.onsuccess = () => resolve(pedido.result);
    pedido.onerror = () => reject(pedido.error);
  });
}

async function comBancoEmbutido(modo, acao) {
  const db = await abrirBancoEmbutido();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('arquivos', modo);
    const pedido = acao(tx.objectStore('arquivos'));
    tx.oncomplete = () => resolve(pedido?.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

// O substituto fica no workspace (SQLite), que é estável entre execuções — o
// IndexedDB não serve no app porque a porta do servidor local muda a cada
// abertura. No modo web (sem desktop), o IndexedDB assume.
async function lerEmbutidoSubstituido() {
  if (globalThis.desktop?.wsGet) {
    try {
      const salvo = await globalThis.desktop.wsGet(EMBUTIDO_CHAVE);
      if (salvo) return base64ParaBytes(salvo);
    } catch {
      /* tenta o IndexedDB */
    }
  }
  return comBancoEmbutido('readonly', (store) => store.get('copergas')).catch(() => null);
}

async function gravarEmbutido(bytes) {
  if (globalThis.desktop?.wsPut) {
    await globalThis.desktop.wsPut(EMBUTIDO_CHAVE, bytesParaBase64(bytes));
    return;
  }
  await comBancoEmbutido('readwrite', (store) => store.put(bytes, 'copergas'));
}

async function limparEmbutido() {
  if (globalThis.desktop?.wsPut) {
    try { await globalThis.desktop.wsPut(EMBUTIDO_CHAVE, ''); } catch { /* segue */ }
  }
  await comBancoEmbutido('readwrite', (store) => store.delete('copergas')).catch(() => null);
}

function atualizarStatusEmbutido(erro) {
  const el = document.querySelector('#kmlEmbedStatus');
  if (!el) return;
  if (erro) {
    el.textContent = `Não foi possível carregar o KMZ embutido: ${erro}`;
    return;
  }
  const registro = state.files.find((file) => file.id === EMBUTIDO_ID);
  if (!registro) {
    el.textContent = 'KMZ embutido não carregado.';
    return;
  }
  const { points = 0, lines = 0, polygons = 0 } = registro.counts || {};
  const origem = registro.origem === 'local'
    ? 'KMZ substituído neste computador'
    : 'KMZ original embutido no programa';
  el.textContent = `${origem} · ${fmtInt(lines)} linhas${points ? ` · ${fmtInt(points)} pontos` : ''}${polygons ? ` · ${fmtInt(polygons)} áreas` : ''}.`;
}

async function carregarEmbutido({ avisar = false } = {}) {
  state.files = state.files.filter((file) => file.id !== EMBUTIDO_ID);
  try {
    let bytes = await lerEmbutidoSubstituido();
    const local = Boolean(bytes);
    if (!bytes) {
      const resposta = await fetch(EMBUTIDO_URL, { cache: 'no-cache' });
      if (!resposta.ok) throw new Error(`arquivo embutido indisponível (HTTP ${resposta.status})`);
      bytes = await resposta.arrayBuffer();
    }
    const cabeca = new Uint8Array(bytes.slice(0, 2));
    const texto = cabeca[0] === 0x50 && cabeca[1] === 0x4b
      ? await unzipKml(bytes)
      : new TextDecoder().decode(bytes);
    const parsed = parseKml(texto, 'Rede Copergás.kmz');
    state.files.unshift({
      id: EMBUTIDO_ID,
      embutido: true,
      origem: local ? 'local' : 'original',
      name: 'Rede Copergás',
      fileName: local ? 'KMZ substituído neste computador' : 'KMZ embutido no programa',
      addedAt: Date.now(),
      visible: true,
      counts: parsed.counts,
      unsupported: parsed.unsupported,
      bounds: parsed.bounds,
      features: parsed.features,
    });
    render();
    renderFiles();
    updateImportStatus();
    atualizarStatusEmbutido();
    if (avisar) {
      toast.success('Rede Copergás carregada', local ? 'Usando o KMZ substituído.' : 'Usando o KMZ embutido no programa.');
    }
  } catch (erro) {
    atualizarStatusEmbutido(erro?.message || String(erro));
    if (avisar) toast.error('KMZ embutido', erro?.message || String(erro));
  }
}

function updateImportStatus(text) {
  if (!els.importStatus) return;
  const { points, lines, polygons } = summary();
  els.importStatus.textContent = text || (state.files.length
    ? `${state.files.length} arquivo(s) · ${fmtInt(points)} pontos · ${fmtInt(lines)} linhas · ${fmtInt(polygons)} áreas`
    : 'Nenhum arquivo KML carregado.');
}

function syncOptionsUi() {
  const o = state.options;
  if (els.showPoints) els.showPoints.checked = o.showPoints !== false;
  if (els.showLines) els.showLines.checked = o.showLines !== false;
  if (els.showPolygons) els.showPolygons.checked = o.showPolygons !== false;
  if (els.showLabels) els.showLabels.checked = o.showLabels !== false;
  if (els.useKmlColors) els.useKmlColors.checked = o.useKmlColors !== false;
  if (els.pointColor) els.pointColor.value = o.pointColor;
  if (els.lineColor) els.lineColor.value = o.lineColor;
  if (els.polygonColor) els.polygonColor.value = o.polygonColor;
  if (els.fitOnImport) els.fitOnImport.checked = state.fitOnImport !== false;
}

function renderFiles() {
  if (!els.files) return;
  const unsupported = {};
  for (const file of state.files) {
    for (const [name, count] of Object.entries(file.unsupported || {})) {
      unsupported[name] = (unsupported[name] || 0) + count;
    }
  }
  if (els.unsupported) {
    els.unsupported.textContent = Object.keys(unsupported).length
      ? `Ignorados: ${Object.entries(unsupported).map(([name, count]) => `${count} ${name}`).join(', ')}. Converta esses elementos para pontos, linhas ou áreas para usá-los no mapa e no DXF.`
      : '';
  }
  if (!state.files.length) {
    els.files.innerHTML = '<div class="kml-empty">Importe um KML para ver pontos, linhas e áreas no mapa e escolher o que vai para o DXF.</div>';
    return;
  }
  els.files.innerHTML = state.files.map((file) => {
    const cfg = cfgDoArquivo(file);
    const k = window.ngMapa?.kml() || {};
    const amostras = {};
    for (const feature of file.features || []) {
      if (!amostras[feature.kind]) amostras[feature.kind] = feature;
    }
    const styleOf = (kind) => amostras[kind]?.style || {};
    const hex = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback);
    const cor = (kind) => {
      const style = styleOf(kind);
      if (kind === 'line') return hex(cfg.lineColor || style.lineColor || k.linha || state.options.lineColor, '#38bdf8');
      if (kind === 'point') return hex(cfg.pointColor || style.iconColor || style.labelColor || k.ponto || state.options.pointColor, '#f472b6');
      return hex(cfg.polygonColor || style.polyColor || style.lineColor || k.linha || state.options.polygonColor, '#22c55e');
    };
    const pontos = file.counts?.points || 0;
    const linhas = file.counts?.lines || 0;
    const areas = file.counts?.polygons || 0;
    const cores = [
      linhas ? `<input type="color" class="kml-cor-input" data-kml-color="line" value="${cor('line')}" title="Cor das linhas deste arquivo" aria-label="Cor das linhas">` : '',
      pontos ? `<input type="color" class="kml-cor-input" data-kml-color="point" value="${cor('point')}" title="Cor dos pontos deste arquivo" aria-label="Cor dos pontos">` : '',
      areas ? `<input type="color" class="kml-cor-input" data-kml-color="polygon" value="${cor('polygon')}" title="Cor das áreas deste arquivo" aria-label="Cor das áreas">` : '',
    ].filter(Boolean).join('');
    const ignored = Object.entries(file.unsupported || {});
    const ignoredText = ignored.length
      ? `<span class="kml-warning">${ignored.map(([name, count]) => `${count} ${esc(name)}`).join(' · ')} ignorado(s)</span>`
      : '';
    return `<article class="kml-file" data-kml-file="${esc(file.id)}">
      <label class="inline-switch kml-file-toggle">
        <input type="checkbox" data-kml-visible ${file.visible === false ? '' : 'checked'}>
        <span class="kml-file-copy">
          <strong>${esc(file.name)}</strong>
          <small>${esc(file.fileName)} · ${fmtInt(pontos)} pontos · ${fmtInt(linhas)} linhas · ${fmtInt(areas)} áreas</small>
          ${ignoredText}
        </span>
      </label>
      <div class="kml-file-actions">
        <span class="kml-file-colors" aria-label="Cores deste arquivo">${cores}</span>
        <button class="btn btn-ghost btn-sm" type="button" data-kml-edit title="Mudar a aparência só deste arquivo">${icon('palette')} Aparência</button>
        <button class="btn btn-ghost btn-sm" type="button" data-kml-fit>Ir para</button>
        <button class="icon-btn" type="button" data-kml-remove title="Remover KML" aria-label="Remover KML">${icon('trash')}</button>
      </div>
    </article>`;
  }).join('');
}

// ---- Editor do arquivo (pastas, linhas, rótulos) ---------------------------
function elNovo(tag, props = {}, ...filhos) {
  const node = document.createElement(tag);
  for (const [chave, valor] of Object.entries(props || {})) {
    if (chave === 'class') node.className = valor;
    else if (chave === 'text') node.textContent = valor;
    else if (chave.startsWith('on')) node[chave] = valor;
    else if (valor === true) node.setAttribute(chave, '');
    else if (valor !== false && valor != null) node.setAttribute(chave, valor);
  }
  for (const filho of filhos.flat()) {
    if (filho == null) continue;
    node.append(filho.nodeType ? filho : document.createTextNode(String(filho)));
  }
  return node;
}

function pastasDoArquivo(file) {
  const mapa = new Map();
  for (const feature of file.features) {
    const nome = feature.folder || '(sem pasta)';
    let info = mapa.get(nome);
    if (!info) {
      info = { nome, linhas: 0, pontos: 0, areas: 0 };
      mapa.set(nome, info);
    }
    if (feature.kind === 'line') info.linhas += 1;
    else if (feature.kind === 'point') info.pontos += 1;
    else info.areas += 1;
  }
  return [...mapa.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

let editorTimer = 0;
const atualizarMapaEditor = () => {
  clearTimeout(editorTimer);
  editorTimer = setTimeout(() => { save(); render(); }, 110);
};

function abrirEditorKml(file) {
  const dlg = document.querySelector('#kmlEditDialog');
  const body = document.querySelector('#kmlEditBody');
  if (!dlg || !body) return;
  const cfg = cfgDoArquivo(file);
  const k = window.ngMapa?.kml() || {};
  const titulo = document.querySelector('#kmlEditTitle');
  const subtitulo = document.querySelector('#kmlEditSubtitle');
  if (titulo) titulo.textContent = `Aparência · ${file.name}`;
  if (subtitulo) {
    subtitulo.textContent = `${fmtInt(file.counts?.lines || 0)} linhas · ${fmtInt(file.counts?.points || 0)} pontos · ${fmtInt(file.counts?.polygons || 0)} áreas`;
  }
  body.replaceChildren();

  const irPara = (features) => {
    const bounds = featureBounds(features);
    if (!bounds) return;
    closeDialog(dlg);
    fitBounds(bounds);
  };

  // ---- Camadas (pastas) ----
  const pastas = pastasDoArquivo(file);
  const listaPastas = elNovo('div', { class: 'kml-edit-pastas' });
  for (const info of pastas) {
    const ocultaAcima = cfg.hiddenFolders.some((nome) => info.nome.startsWith(`${nome} / `));
    const marcada = !cfg.hiddenFolders.includes(info.nome);
    const caixa = elNovo('input', { type: 'checkbox' });
    caixa.checked = marcada;
    caixa.addEventListener('change', () => {
      cfg.hiddenFolders = cfg.hiddenFolders.filter((nome) => nome !== info.nome);
      if (!caixa.checked) cfg.hiddenFolders.push(info.nome);
      atualizarMapaEditor();
    });
    const ver = elNovo('button', { type: 'button', class: 'ghost-btn', text: 'Ir' });
    ver.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      irPara(file.features.filter((f) => (f.folder || '(sem pasta)') === info.nome || (f.folder || '').startsWith(`${info.nome} / `)));
    });
    const contagem = [
      info.linhas ? `${fmtInt(info.linhas)} linhas` : '',
      info.pontos ? `${fmtInt(info.pontos)} pontos` : '',
      info.areas ? `${fmtInt(info.areas)} áreas` : '',
    ].filter(Boolean).join(' · ');
    listaPastas.append(elNovo('label', { class: 'kml-edit-pasta', title: ocultaAcima ? 'Oculta por uma pasta acima' : '' },
      caixa,
      elNovo('span', { text: info.nome + (ocultaAcima ? ' (oculta pela pasta acima)' : '') }),
      elNovo('small', { text: contagem }),
      ver));
  }
  body.append(elNovo('section', { class: 'kml-edit-sec' },
    elNovo('h4', { text: `Camadas do arquivo (${pastas.length})` }),
    elNovo('p', { class: 'field-hint', text: 'Desmarque uma pasta para esconder as linhas dela no mapa e no DXF.' }),
    listaPastas));

  // ---- Camadas por estilo (o que diferencia as linhas dentro da pasta) ----
  const estilos = new Map();
  for (const feature of file.features) {
    if (feature.kind !== 'line') continue;
    const chave = chaveEstilo(feature);
    let info = estilos.get(chave);
    if (!info) {
      const estilo = feature.style || {};
      info = {
        chave,
        nome: feature.styleUrl ? String(feature.styleUrl).replace(/^.*#/, '') : 'sem estilo',
        largura: estilo.width || 0,
        cor: estilo.lineColor || '',
        linhas: 0,
      };
      estilos.set(chave, info);
    }
    info.linhas += 1;
  }
  const listaEstilos = elNovo('div', { class: 'kml-edit-pastas' });
  for (const info of [...estilos.values()].sort((a, b) => b.linhas - a.linhas)) {
    const caixa = elNovo('input', { type: 'checkbox' });
    caixa.checked = !cfg.hiddenStyles.includes(info.chave);
    caixa.addEventListener('change', () => {
      cfg.hiddenStyles = cfg.hiddenStyles.filter((chave) => chave !== info.chave);
      if (!caixa.checked) cfg.hiddenStyles.push(info.chave);
      atualizarMapaEditor();
    });
    const amostra = elNovo('i', { class: 'kml-edit-cor' });
    if (/^#[0-9a-f]{6}$/i.test(info.cor)) amostra.style.background = info.cor;
    else amostra.style.visibility = 'hidden';
    const detalhe = `${fmtInt(info.linhas)} linhas${info.largura ? ` · ${info.largura} px` : ''}`;
    listaEstilos.append(elNovo('label', { class: 'kml-edit-pasta' },
      caixa, amostra, elNovo('span', { text: info.nome }), elNovo('small', { text: detalhe })));
  }
  body.append(elNovo('section', { class: 'kml-edit-sec' },
    elNovo('h4', { text: `Camadas por estilo (${estilos.size})` }),
    elNovo('p', { class: 'field-hint', text: 'Cada estilo do arquivo (espessura e cor) vira uma camada; desmarque para esconder.' }),
    listaEstilos));

  // ---- Linhas ----
  const larguraBase = k.larg || 2;
  const linhaLargura = elNovo('input', { type: 'range', min: '0.5', max: '10', step: '0.5' });
  linhaLargura.value = String(cfg.lineWidth ?? larguraBase);
  const larguraValor = elNovo('span', { class: 'kml-edit-val', text: Number(linhaLargura.value).toFixed(1) });
  linhaLargura.addEventListener('input', () => {
    cfg.lineWidth = Number(linhaLargura.value);
    larguraValor.textContent = Number(linhaLargura.value).toFixed(1);
    atualizarMapaEditor();
  });
  const corLinha = elNovo('input', { type: 'color' });
  corLinha.value = /^#[0-9a-f]{6}$/i.test(cfg.lineColor) ? cfg.lineColor : (k.linha || '#38bdf8');
  corLinha.addEventListener('input', () => { cfg.lineColor = corLinha.value; atualizarMapaEditor(); });
  const opacidade = elNovo('input', { type: 'range', min: '0.1', max: '1', step: '0.05' });
  opacidade.value = String(cfg.lineOpacity ?? (k.opac ?? 0.9));
  const opacidadeValor = elNovo('span', { class: 'kml-edit-val', text: `${Math.round(Number(opacidade.value) * 100)}%` });
  opacidade.addEventListener('input', () => {
    cfg.lineOpacity = Number(opacidade.value);
    opacidadeValor.textContent = `${Math.round(Number(opacidade.value) * 100)}%`;
    atualizarMapaEditor();
  });
  const padraoLinhas = elNovo('button', { type: 'button', class: 'ghost-btn', text: 'Restaurar padrão' });
  padraoLinhas.addEventListener('click', () => {
    cfg.lineWidth = null;
    cfg.lineColor = '';
    cfg.lineOpacity = null;
    render();
    abrirEditorKml(file);
  });
  body.append(elNovo('section', { class: 'kml-edit-sec' },
    elNovo('h4', { text: 'Linhas' }),
    elNovo('div', { class: 'kml-edit-row' }, elNovo('label', { text: 'Espessura (px)' }), linhaLargura, larguraValor),
    elNovo('div', { class: 'kml-edit-row' }, elNovo('label', { text: 'Cor' }), corLinha, elNovo('span', { class: 'kml-edit-val', text: cfg.lineColor ? '' : 'do estilo' })),
    elNovo('div', { class: 'kml-edit-row' }, elNovo('label', { text: 'Opacidade' }), opacidade, opacidadeValor),
    elNovo('div', { class: 'kml-edit-row' }, elNovo('span', { class: 'field-hint', text: 'Vale só para este arquivo; o Estilo continua valendo para os demais.' }), padraoLinhas)));

  // ---- Rótulos ----
  const rotuloLigado = cfg.labels === true || (cfg.labels == null && state.options.showLabels);
  const caixaRotulo = elNovo('input', { type: 'checkbox' });
  caixaRotulo.checked = rotuloLigado;
  const fonteRotulo = elNovo('select', { class: 'select select-sm' });
  fonteRotulo.append(
    elNovo('option', { value: 'name', text: 'Nome do elemento' }),
    elNovo('option', { value: 'folder', text: 'Nome da pasta' }),
  );
  fonteRotulo.value = cfg.labelSource || 'name';
  caixaRotulo.addEventListener('change', () => { cfg.labels = caixaRotulo.checked; atualizarMapaEditor(); });
  fonteRotulo.addEventListener('change', () => { cfg.labelSource = fonteRotulo.value; atualizarMapaEditor(); });
  body.append(elNovo('section', { class: 'kml-edit-sec' },
    elNovo('h4', { text: 'Rótulos' }),
    elNovo('div', { class: 'kml-edit-row' },
      elNovo('label', null, caixaRotulo, elNovo('span', { text: 'Mostrar rótulos nas linhas' })),
      fonteRotulo),
    elNovo('p', { class: 'field-hint', text: 'Até 200 rótulos por arquivo. Em arquivos grandes eles são ancorados no meio de cada linha.' })));

  // ---- Pontos e áreas ----
  const tamanhoPonto = elNovo('input', { type: 'range', min: '2', max: '20', step: '1' });
  tamanhoPonto.value = String(cfg.pointSize ?? (k.raio ?? 5) * 2);
  const tamanhoValor = elNovo('span', { class: 'kml-edit-val', text: `${tamanhoPonto.value}px` });
  tamanhoPonto.addEventListener('input', () => {
    cfg.pointSize = Number(tamanhoPonto.value);
    tamanhoValor.textContent = `${tamanhoPonto.value}px`;
    atualizarMapaEditor();
  });
  const corPonto = elNovo('input', { type: 'color' });
  corPonto.value = /^#[0-9a-f]{6}$/i.test(cfg.pointColor) ? cfg.pointColor : (k.ponto || '#f472b6');
  corPonto.addEventListener('input', () => { cfg.pointColor = corPonto.value; atualizarMapaEditor(); });
  const opacidadeArea = elNovo('input', { type: 'range', min: '0', max: '0.6', step: '0.02' });
  opacidadeArea.value = String(cfg.polygonOpacity ?? 0.14);
  const areaValor = elNovo('span', { class: 'kml-edit-val', text: `${Math.round(Number(opacidadeArea.value) * 100)}%` });
  opacidadeArea.addEventListener('input', () => {
    cfg.polygonOpacity = Number(opacidadeArea.value);
    areaValor.textContent = `${Math.round(Number(opacidadeArea.value) * 100)}%`;
    atualizarMapaEditor();
  });
  body.append(elNovo('section', { class: 'kml-edit-sec' },
    elNovo('h4', { text: 'Pontos e áreas' }),
    elNovo('div', { class: 'kml-edit-row' }, elNovo('label', { text: 'Tamanho do ponto' }), tamanhoPonto, tamanhoValor),
    elNovo('div', { class: 'kml-edit-row' }, elNovo('label', { text: 'Cor do ponto' }), corPonto),
    elNovo('div', { class: 'kml-edit-row' }, elNovo('label', { text: 'Preenchimento da área' }), opacidadeArea, areaValor)));

  // ---- Lista das linhas ----
  const linhasComIndice = file.features
    .map((feature, indice) => ({ feature, indice }))
    .filter(({ feature }) => feature.kind === 'line');
  const busca = elNovo('input', { type: 'search', class: 'input', placeholder: 'Filtrar por nome ou pasta…' });
  const listaLinhas = elNovo('div', { class: 'kml-edit-linhas' });
  const desenharLinhas = () => {
    const termo = busca.value.trim().toLowerCase();
    const filtradas = linhasComIndice
      .filter(({ feature }) => !termo
        || String(feature.name || '').toLowerCase().includes(termo)
        || String(feature.folder || '').toLowerCase().includes(termo))
      .slice(0, 300);
    listaLinhas.replaceChildren(...filtradas.map(({ feature, indice }) => {
      const ver = elNovo('button', { type: 'button', class: 'ghost-btn', text: 'Ir' });
      ver.addEventListener('click', () => irPara([feature]));
      return elNovo('div', { class: 'kml-edit-linha' },
        elNovo('span', { text: feature.name || `Linha ${indice + 1}` }),
        elNovo('small', { text: feature.folder || '' }),
        ver);
    }));
    if (!filtradas.length) listaLinhas.append(elNovo('p', { class: 'field-hint', text: 'Nenhuma linha encontrada.' }));
  };
  busca.addEventListener('input', desenharLinhas);
  desenharLinhas();
  body.append(elNovo('section', { class: 'kml-edit-sec' },
    elNovo('h4', { text: `Linhas do arquivo (${fmtInt(linhasComIndice.length)})` }),
    busca, listaLinhas));

  openDialog(dlg);
}

function persistOptions() {
  save();
  render();
  renderFiles();
  updateImportStatus();
}

function openKmlDialog() {
  const painel = els.view || document.querySelector('#kmlPanel');
  if (!painel) return;
  deps.navigate?.('map');
  painel.hidden = false;
  document.querySelector('.map-layout')?.classList.add('is-prj');
  deps.mapView?.invalidate?.();
  syncOptionsUi();
  renderFiles();
  updateImportStatus();
  atualizarStatusEmbutido();
}

export function initKml(options = {}) {
  deps = options;
  els = {
    view: document.querySelector('#kmlPanel'),
    dialog: document.querySelector('#kmlPanel'),
    fit: document.querySelector('#kmlFit'),
    clear: document.querySelector('#kmlClear'),
    fileInput: document.querySelector('#kmlFileInput'),
    pick: document.querySelector('#kmlPick'),
    importStatus: document.querySelector('#kmlImportStatus'),
    fitOnImport: document.querySelector('#kmlFitOnImport'),
    showPoints: document.querySelector('#kmlShowPoints'),
    showLines: document.querySelector('#kmlShowLines'),
    showPolygons: document.querySelector('#kmlShowPolygons'),
    showLabels: document.querySelector('#kmlShowLabels'),
    useKmlColors: document.querySelector('#kmlUseKmlColors'),
    pointColor: document.querySelector('#kmlPointColor'),
    lineColor: document.querySelector('#kmlLineColor'),
    polygonColor: document.querySelector('#kmlPolygonColor'),
    files: document.querySelector('#kmlFiles'),
    unsupported: document.querySelector('#kmlUnsupported'),
    clearAll: document.querySelector('#kmlClearAll'),
  };
  if (!els.dialog || !deps.mapView) return { open: () => {}, getExportData: () => ({ features: [], labels: false }) };

  load();
  syncOptionsUi();
  render();

  document.querySelector('#kmlPanelClose')?.addEventListener('click', hideKmlDock);
  document.querySelector('#mapKml')?.addEventListener('click', () => {
    openKmlDialog();
  });
  document.querySelector('#exportKmlImport')?.addEventListener('click', () => {
    openKmlDialog();
    setTimeout(() => els.fileInput?.click(), 220);
  });
  document.querySelector('#exportKmlManage')?.addEventListener('click', openKmlDialog);
  document.querySelector('#dxfKmlManage')?.addEventListener('click', openKmlDialog);
  els.pick?.addEventListener('click', () => els.fileInput?.click());
  els.fileInput?.addEventListener('change', async () => {
    const files = [...(els.fileInput.files || [])];
    els.fileInput.value = '';
    await importFiles(files);
  });
  document.querySelector('#kmlEmbedReplace')?.addEventListener('click', () => {
    document.querySelector('#kmlEmbedInput')?.click();
  });
  document.querySelector('#kmlEmbedInput')?.addEventListener('change', async () => {
    const input = document.querySelector('#kmlEmbedInput');
    const file = input?.files?.[0];
    if (input) input.value = '';
    if (!file) return;
    try {
      await gravarEmbutido(await file.arrayBuffer());
      await carregarEmbutido({ avisar: true });
    } catch (erro) {
      toast.error('Substituir KMZ', erro?.message || String(erro));
    }
  });
  document.querySelector('#kmlEmbedRestore')?.addEventListener('click', async () => {
    try {
      await limparEmbutido();
      await carregarEmbutido({ avisar: true });
    } catch (erro) {
      toast.error('Restaurar KMZ', erro?.message || String(erro));
    }
  });
  // Carrega o KMZ da Copergás embutido depois que a janela assentou.
  setTimeout(() => { carregarEmbutido(); }, 1200);

  els.fit?.addEventListener('click', fitAll);
  els.clear?.addEventListener('click', () => {
    if (!state.files.length) return;
    state.files = [];
    save();
    render();
    renderFiles();
    updateImportStatus();
    toast.info('KML removido', 'Os arquivos KML foram retirados do mapa e do DXF.');
  });
  els.clearAll?.addEventListener('click', () => {
    state.files = [];
    save();
    render();
    renderFiles();
    updateImportStatus();
  });

  const bindOption = (element, key, transform = (value) => value) => {
    element?.addEventListener('change', () => {
      state.options[key] = transform(element.type === 'checkbox' ? element.checked : element.value);
      if (key === 'fitOnImport') state.fitOnImport = Boolean(element.checked);
      persistOptions();
    });
  };
  bindOption(els.showPoints, 'showPoints');
  bindOption(els.showLines, 'showLines');
  bindOption(els.showPolygons, 'showPolygons');
  bindOption(els.showLabels, 'showLabels');
  bindOption(els.useKmlColors, 'useKmlColors');
  els.pointColor?.addEventListener('input', () => {
    state.options.pointColor = els.pointColor.value;
    persistOptions();
  });
  els.lineColor?.addEventListener('input', () => {
    state.options.lineColor = els.lineColor.value;
    persistOptions();
  });
  els.polygonColor?.addEventListener('input', () => {
    state.options.polygonColor = els.polygonColor.value;
    persistOptions();
  });
  els.fitOnImport?.addEventListener('change', () => {
    state.fitOnImport = Boolean(els.fitOnImport.checked);
    save();
  });

  els.files?.addEventListener('change', (event) => {
    const cor = event.target.closest('[data-kml-color]');
    if (cor) {
      const cardCor = cor.closest('[data-kml-file]');
      const fileCor = state.files.find((item) => item.id === cardCor?.dataset.kmlFile);
      if (!fileCor) return;
      const cfgCor = cfgDoArquivo(fileCor);
      if (cor.dataset.kmlColor === 'line') cfgCor.lineColor = cor.value;
      else if (cor.dataset.kmlColor === 'point') cfgCor.pointColor = cor.value;
      else cfgCor.polygonColor = cor.value;
      save();
      render();
      return;
    }
    const checkbox = event.target.closest('[data-kml-visible]');
    const card = event.target.closest('[data-kml-file]');
    if (!checkbox || !card) return;
    const file = state.files.find((item) => item.id === card.dataset.kmlFile);
    if (!file) return;
    file.visible = Boolean(checkbox.checked);
    save();
    render();
    renderFiles();
  });
  els.files?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-kml-file]');
    if (!card) return;
    const file = state.files.find((item) => item.id === card.dataset.kmlFile);
    if (!file) return;
    if (event.target.closest('[data-kml-edit]')) {
      abrirEditorKml(file);
      return;
    }
    if (event.target.closest('[data-kml-fit]')) {
      fitFile(file);
      return;
    }
    if (event.target.closest('[data-kml-remove]')) {
      state.files = state.files.filter((item) => item.id !== file.id);
      save();
      render();
      renderFiles();
      updateImportStatus();
    }
  });

  bus.on('map:dock', (id) => {
  });
  bus.on('map:kml-close', hideKmlDock);
  bus.on('kml:open', () => openKmlDialog());
  bus.on('estilos:changed', () => { if (state.files.length) render(); });
  bus.on('settings:changed', ({ key }) => {
    if ((key === 'labels' || key === 'all') && state.files.length) render();
  });
  document.querySelector('#kmlEstilos')?.addEventListener('click', () => {
    bus.emit('labels:open', 'kmll');
  });
  bus.on('kml:manage', () => openKmlDialog());

  return {
    open: openKmlDialog,
    dialog: openKmlDialog,
    close: hideKmlDock,
    cancel: hideKmlDock,
    importFiles,
    fitAll,
    getExportData() {
      const features = [];
      if (state.options.showPoints || state.options.showLines || state.options.showPolygons) {
        for (const file of state.files) {
          if (file.visible === false) continue;
          for (const feature of file.features) {
            if (feature.kind === 'point' && !state.options.showPoints) continue;
            if (feature.kind === 'line' && !state.options.showLines) continue;
            if (feature.kind === 'polygon' && !state.options.showPolygons) continue;
            if (feature.kind === 'line') {
              features.push({ kind: 'line', name: feature.name, pts: feature.pts });
            } else if (feature.kind === 'polygon') {
              features.push({ kind: 'polygon', name: feature.name, rings: feature.rings });
            } else {
              features.push({ kind: 'point', name: feature.name, lat: feature.lat, lon: feature.lon });
            }
          }
        }
      }
      return { features, labels: state.options.showLabels !== false };
    },
    hasData: () => state.files.length > 0,
  };
}

export function kmlSummary() {
  return summary();
}

export function getKmlExportData() {
  const features = [];
  if (state.options.showPoints || state.options.showLines || state.options.showPolygons) {
    for (const file of state.files) {
      if (file.visible === false) continue;
      for (const feature of file.features) {
        if (feature.kind === 'point' && !state.options.showPoints) continue;
        if (feature.kind === 'line' && !state.options.showLines) continue;
        if (feature.kind === 'polygon' && !state.options.showPolygons) continue;
        if (feature.kind === 'line') {
          features.push({ kind: 'line', name: feature.name, pts: feature.pts });
        } else if (feature.kind === 'polygon') {
          features.push({ kind: 'polygon', name: feature.name, rings: feature.rings });
        } else {
          features.push({ kind: 'point', name: feature.name, lat: feature.lat, lon: feature.lon });
        }
      }
    }
  }
  return { features, labels: state.options.showLabels !== false };
}

/** Liga ou desliga o KML inteiro no mapa, a partir das camadas do Projeto. */
export function setKmlVisible(visivel) {
  state.oculto = !visivel;
  render();
  bus.emit('kml:changed');
}

export function kmlVisivel() {
  return !state.oculto;
}

/** O que o KML mostra (pontos, linhas, áreas), para a tela de Estilos. */
export function kmlOpcoes() {
  return {
    showPoints: state.options.showPoints !== false,
    showLines: state.options.showLines !== false,
    showPolygons: state.options.showPolygons !== false,
  };
}

export function setKmlOpcao(chave, valor) {
  if (!['showPoints', 'showLines', 'showPolygons'].includes(chave)) return;
  state.options[chave] = Boolean(valor);
  persistOptions();
}

/** Redesenha o KML (rótulos ligados ou desligados em Estilos). */
export function redesenharKml() {
  if (state.files.length) render();
}

export function hasKmlData() {
  return state.files.length > 0;
}

export function openKmlDialogFromApp() {
  openKmlDialog();
}

export function fitKmlAll() {
  fitAll();
}

export { parseKml as parseKmlText };
