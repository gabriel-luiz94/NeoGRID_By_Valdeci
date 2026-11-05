import { bus } from '../core/bus.js';
import { esc, fmtInt } from '../core/format.js';
import { icon, openDialog } from '../core/dom.js';
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
  let node = element?.parentElement;
  while (node) {
    if (node.localName === 'Folder' || node.localName === 'Document') {
      const name = directText(node, 'name');
      if (name) return name;
    }
    node = node.parentElement;
  }
  return '';
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

/** Parse a KML document into points, lines and polygons. */
export function parseKml(text, fileName = 'arquivo.kml') {
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
    name: fileName.replace(/\.kml$/i, ''),
    fileName,
    features,
    counts,
    unsupported,
    bounds: featureBounds(features),
  };
}

// O KML vale só enquanto o programa está aberto: os arquivos nunca são gravados.
// Ficam guardadas apenas as preferências de exibição.
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      options: state.options,
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
  const estilo = window.ngMapa?.kml();
  if (!settings.labels || !(estilo ? estilo.rotulos : state.options.showLabels) || !name) return;
  leafletLayer.bindTooltip(esc(name), {
    permanent: true,
    direction: 'center',
    className,
    opacity: 0.92,
  });
}

function render() {
  clearLayer();
  const map = deps.mapView?.map;
  if (!map) return;
  kmlPane();
  layer = L.layerGroup();
  const visibleFiles = state.files.filter((file) => file.visible !== false);
  let labels = 0;

  // Areas below lines so the lines remain visible on top.
  if (state.options.showPolygons) {
    for (const file of visibleFiles) {
      for (const feature of file.features) {
        if (feature.kind !== 'polygon') continue;
        const color = featureColor(feature, 'polygon', state.options.polygonColor);
        const polygon = L.polygon(feature.rings, {
          pane: 'kmlPane',
          color,
          weight: 1.8,
          opacity: 0.9,
          fillColor: color,
          fillOpacity: feature.style?.fill === false ? 0 : 0.14,
          interactive: false,
        });
        polygon.addTo(layer);
        if (labels < 200 && feature.name) {
          addLabel(polygon, feature.name);
          labels += 1;
        }
      }
    }
  }

  if (state.options.showLines) {
    for (const file of visibleFiles) {
      for (const feature of file.features) {
        if (feature.kind !== 'line') continue;
        const color = featureColor(feature, 'line', state.options.lineColor);
        const line = L.polyline(feature.pts, {
          pane: 'kmlPane',
          color,
          weight: feature.style?.width || (window.ngMapa?.kml().larg ?? 2),
          opacity: feature.style?.lineAlpha ?? 0.9,
          interactive: false,
        });
        line.addTo(layer);
        if (labels < 200 && feature.name) {
          addLabel(line, feature.name);
          labels += 1;
        }
      }
    }
  }

  if (state.options.showPoints) {
    for (const file of visibleFiles) {
      for (const feature of file.features) {
        if (feature.kind !== 'point') continue;
        const color = featureColor(feature, 'point', state.options.pointColor);
        const marker = L.circleMarker([feature.lat, feature.lon], {
          pane: 'kmlPane',
          radius: window.ngMapa?.kml().raio ?? 5,
          color: '#0b1220',
          weight: 1.4,
          fillColor: color,
          fillOpacity: 0.95,
          interactive: false,
        });
        marker.addTo(layer);
        if (labels < 200 && feature.name) {
          addLabel(marker, feature.name, 'kml-label kml-label-point');
          labels += 1;
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

function hideKmlDock() {}

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

async function importFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => /\.kml$/i.test(file.name));
  if (!files.length) {
    toast.warning('Nenhum KML selecionado', 'Escolha arquivos com extensão .kml.');
    return;
  }
  let added = 0;
  let firstBounds = null;
  for (const file of files) {
    try {
      const text = await file.text();
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
    const ignored = Object.entries(file.unsupported || {});
    const ignoredText = ignored.length
      ? `<span class="kml-warning">${ignored.map(([name, count]) => `${count} ${esc(name)}`).join(' · ')} ignorado(s)</span>`
      : '';
    return `<article class="kml-file" data-kml-file="${esc(file.id)}">
      <label class="inline-switch kml-file-toggle">
        <input type="checkbox" data-kml-visible ${file.visible === false ? '' : 'checked'}>
        <span class="kml-file-copy">
          <strong>${esc(file.name)}</strong>
          <small>${esc(file.fileName)} · ${fmtInt(file.counts?.points || 0)} pontos · ${fmtInt(file.counts?.lines || 0)} linhas · ${fmtInt(file.counts?.polygons || 0)} áreas</small>
          ${ignoredText}
        </span>
      </label>
      <div class="kml-file-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-kml-fit>Ir para</button>
        <button class="icon-btn" type="button" data-kml-remove title="Remover KML" aria-label="Remover KML">${icon('trash')}</button>
      </div>
    </article>`;
  }).join('');
}

function persistOptions() {
  save();
  render();
  renderFiles();
  updateImportStatus();
}

function openKmlDialog() {
  if (!els.dialog) return;
  syncOptionsUi();
  renderFiles();
  updateImportStatus();
  openDialog(els.dialog);
}

export function initKml(options = {}) {
  deps = options;
  els = {
    dialog: document.querySelector('#kmlDialog'),
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
  bus.on('ui:view', (view) => {
    if (view !== 'map') hideKmlDock();
  });
  bus.on('kml:open', () => openKmlDialog());
  bus.on('estilos:changed', () => { if (state.files.length) render(); });
  bus.on('settings:changed', ({ key }) => {
    if ((key === 'labels' || key === 'all') && state.files.length) render();
  });
  document.querySelector('#kmlEstilos')?.addEventListener('click', () => {
    els.dialog?.close?.();
    bus.emit('labels:open', 'camadas');
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
