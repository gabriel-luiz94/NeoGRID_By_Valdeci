import { bus } from '../core/bus.js';
import { esc, fmtInt } from '../core/format.js';
import { icon } from '../core/dom.js';
import { toast } from '../ui/toast.js';
import { filterStreetsForBounds, fetchStreets, streetsBounds, MAX_AREA_KM2 } from './osm.js';
import { boundsSizeMeters } from './dxf/utm.js';

const STORAGE_KEY = 'neogrid.streets.v1';
const MAX_STORED_POINTS = 90000;

const state = {
  segments: [],
  visible: true,
  labels: false,
  updatedAt: 0,
  loadedAt: 0,
};

let deps = {};
let els = {};
let layer = null;
let selecting = false;
let selectionStart = null;
let rectangle = null;
let busy = false;
let sidebarVisible = false;

const countPoints = (segments) => segments.reduce((total, street) => total + (street.pts?.length || 0), 0);

function readStorage() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw || !Array.isArray(raw.segments)) return;
    state.segments = raw.segments
      .filter((street) => Array.isArray(street.pts) && street.pts.length >= 2)
      .map((street) => ({
        id: street.id || `street-${street.pts[0][0]},${street.pts[0][1]}`,
        pts: street.pts,
        nome: String(street.nome || ''),
        rodovia: String(street.rodovia || ''),
      }));
    state.visible = raw.visible !== false;
    state.labels = raw.labels === true;
    state.updatedAt = Number(raw.updatedAt) || 0;
    state.loadedAt = Number(raw.loadedAt) || 0;
  } catch {
    /* armazenamento indisponível */
  }
}

function persist() {
  const points = countPoints(state.segments);
  if (points > MAX_STORED_POINTS) {
    toast.warning(
      'Arruamento grande demais para salvar',
      `As ${fmtInt(state.segments.length)} vias continuam no mapa desta sessão, mas o volume (${fmtInt(points)} pontos) não cabe no armazenamento local.`,
      { duration: 6500 },
    );
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      segments: state.segments,
      visible: state.visible,
      labels: state.labels,
      updatedAt: state.updatedAt,
      loadedAt: state.loadedAt,
    }));
  } catch {
    /* quota cheia: mantém em memória */
  }
}

function pane() {
  if (!deps.mapView?.map) return null;
  if (!deps.mapView.map.getPane('streetsPane')) {
    deps.mapView.map.createPane('streetsPane');
    // Acima do canvas de dados (overlayPane 400), abaixo de marcadores/tooltips.
    deps.mapView.map.getPane('streetsPane').style.zIndex = '450';
    deps.mapView.map.getPane('streetsPane').style.pointerEvents = 'none';
  }
  return deps.mapView.map.getPane('streetsPane');
}

function clearLayer() {
  if (layer) {
    layer.remove();
    layer = null;
  }
}

/** Draws the loaded network with Leaflet polylines so it stays visible while the canvas redraws. */
function render() {
  clearLayer();
  if (!deps.mapView?.map) return;
  pane();
  if (!state.visible || !state.segments.length) return;
  layer = L.layerGroup();
  let labelled = 0;
  for (const street of state.segments) {
    if (!street.pts?.length) continue;
    const line = L.polyline(street.pts, {
      pane: 'streetsPane',
      color: '#cbd5e1',
      weight: 1.4,
      opacity: 0.62,
      interactive: false,
      smoothFactor: 1,
      className: 'street-line',
    });
    line.addTo(layer);
    if (state.labels && street.nome && labelled < 140 && state.segments.length <= 2500) {
      line.bindTooltip(esc(street.nome), {
        permanent: true,
        direction: 'center',
        className: 'street-label',
        opacity: 0.9,
      });
      labelled += 1;
    }
  }
  layer.addTo(deps.mapView.map);
}

function summaryHtml() {
  if (!state.segments.length) return '';
  const points = countPoints(state.segments);
  const named = state.segments.filter((street) => street.nome).length;
  return `
    <span><i style="--c:#cbd5e1"></i>${fmtInt(state.segments.length)} vias</span>
    <span><i style="--c:#94a3b8"></i>${fmtInt(points)} pontos</span>
    <span><i style="--c:#64748b"></i>${fmtInt(named)} com nome</span>`;
}

function updateDock() {
  if (!els.dock) return;
  if (els.info) {
    els.info.textContent = state.segments.length
      ? `${fmtInt(state.segments.length)} vias do OpenStreetMap carregadas`
      : 'Nenhuma via carregada';
  }
  if (els.summary) els.summary.innerHTML = summaryHtml();
  if (els.show) els.show.checked = state.visible;
  if (els.labels) els.labels.checked = state.labels;
  if (els.fit) els.fit.disabled = !state.segments.length;
  if (els.clear) els.clear.disabled = !state.segments.length;
  document.querySelector('#mapStreets')?.classList.toggle('is-active', state.segments.length > 0 && state.visible);
  updateDxfLabel();
}

function updateDxfLabel() {
  const target = document.querySelector('#dxfStreetsCount');
  if (!target) return;
  target.textContent = state.segments.length
    ? `${fmtInt(state.segments.length)} vias carregadas`
    : 'nenhuma via carregada — use Arruamento no mapa';
}

function setBusy(value, text = 'Consultando o OpenStreetMap…') {
  busy = value;
  if (els.progress) {
    els.progress.hidden = !value;
    if (value) els.progressText.textContent = text;
  }
  if (els.select) els.select.disabled = value;
  if (els.visible) els.visible.disabled = value;
  if (els.fit) els.fit.disabled = value || !state.segments.length;
  if (els.clear) els.clear.disabled = value || !state.segments.length;
}

function openDock({ show = true } = {}) {
  if (!els.dock) return;
  if (show) els.dock.hidden = false;
  updateDock();
  bus.emit('map:dock', 'streets');
}

function hideDock() {
  if (els.dock) els.dock.hidden = true;
}

function closeOtherDock() {
  bus.emit('map:dock', 'streets');
}

/* ---------- ÁREA ---------- */

function drawRectangle(bounds) {
  removeRectangle();
  rectangle = L.rectangle(bounds, {
    color: '#38bdf8',
    weight: 2,
    dashArray: '6 4',
    fillColor: '#38bdf8',
    fillOpacity: 0.07,
    interactive: false,
    className: 'streets-area-selection',
  }).addTo(deps.mapView.map);
}

function removeRectangle() {
  if (rectangle) {
    rectangle.remove();
    rectangle = null;
  }
}

function setSelectingVisual(active) {
  deps.mapView?.setDxfMode(active);
  deps.mapView?.stageElement?.classList.toggle('is-streets-selecting', active);
  if (active) deps.mapView?.map?.dragging?.disable();
  else deps.mapView?.map?.dragging?.enable();
  if (els.instruction) els.instruction.hidden = !active;
}

function cancelSelection() {
  if (!selecting && !rectangle) return;
  selecting = false;
  selectionStart = null;
  removeRectangle();
  setSelectingVisual(false);
  if (deps.mapView) deps.mapView.suppressClicks(350);
  if (!state.segments.length) hideDock();
  else openDock();
}

function beginSelection() {
  if (busy) return;
  deps.navigate?.('map');
  bus.emit('dxf:cancel');
  bus.emit('map:kml-close');
  closeOtherDock();
  cancelSelection();
  selecting = true;
  hideDock();
  requestAnimationFrame(() => {
    deps.mapView?.invalidate();
    setSelectingVisual(true);
  });
}

function finishSelection(bounds) {
  selecting = false;
  selectionStart = null;
  removeRectangle();
  setSelectingVisual(false);
  deps.mapView?.suppressClicks(500);
  const size = boundsSizeMeters(bounds);
  if (size.width < 10 || size.height < 10) {
    toast.info('Área muito pequena', 'Arraste uma área maior para baixar o arruamento.');
    if (state.segments.length) openDock();
    return;
  }
  downloadArea(bounds);
}

async function downloadArea(latLngBounds) {
  const bounds = {
    west: latLngBounds.getWest(),
    east: latLngBounds.getEast(),
    south: latLngBounds.getSouth(),
    north: latLngBounds.getNorth(),
  };
  // A API principal do OSM recusa caixas acima de ~0,25°; o Overpass trava em áreas grandes.
  // Barra antes de baixar para não deixar o usuário esperando à toa.
  const approxKm2 = (() => {
    const h = Math.abs(bounds.north - bounds.south) * 111.32;
    const w = Math.abs(bounds.east - bounds.west) * 111.32 * Math.cos((((bounds.north + bounds.south) / 2) * Math.PI) / 180);
    return Math.abs(w * h);
  })();
  if (approxKm2 > MAX_AREA_KM2) {
    openDock();
    toast.warning(
      'Área grande demais para o arruamento',
      `A área tem ~${approxKm2.toFixed(0)} km² (limite ${MAX_AREA_KM2} km²). Aproxime o zoom (17+) ou selecione um quarteirão menor.`,
      { duration: 7000 },
    );
    return;
  }
  openDock();
  setBusy(true, 'Consultando o OpenStreetMap…');
  deps.navigate?.('map');
  try {
    const incoming = await fetchStreets(bounds, ({ host, phase, attempt, total }) => {
      const step = attempt && total ? ` (${attempt}/${total})` : '';
      setBusy(true, phase === 'fallback'
        ? `Overpass indisponível · tentando a API principal do OSM…${step}`
        : `Baixando arruamento · ${host}${step}`);
    });
    mergeStreets(incoming);
    state.updatedAt = Date.now();
    state.loadedAt = Date.now();
    state.visible = true;
    persist();
    render();
    updateDock();
    bus.emit('streets:changed');
    const named = state.segments.filter((street) => street.nome).length;
    toast.success(
      'Arruamento carregado',
      `${fmtInt(state.segments.length)} vias no mapa · ${fmtInt(named)} com nome. Inclua no DXF quando quiser.`,
      { duration: 6500 },
    );
  } catch (error) {
    toast.error('Arruamento indisponível', error.message || 'Tente uma área menor ou verifique a internet.');
  } finally {
    setBusy(false);
    updateDock();
  }
}

function mergeStreets(incoming) {
  const byId = new Map(state.segments.map((street) => [street.id, street]));
  for (const street of incoming) {
    ensureStreetId(street);
    byId.set(street.id, street);
  }
  state.segments = [...byId.values()];
}

function ensureStreetId(street) {
  if (!street.id) {
    street.id = `street-${street.pts[0][0].toFixed(6)},${street.pts[0][1].toFixed(6)}`;
  }
}

function bindMapEvents() {
  const map = deps.mapView?.map;
  if (!map) return;
  map.on('mousedown', (event) => {
    if (!selecting) return;
    if (event.originalEvent?.button) return;
    selectionStart = event.latlng;
    drawRectangle(L.latLngBounds(event.latlng, event.latlng));
    deps.mapView.suppressClicks(500);
  });
  map.on('mousemove', (event) => {
    if (!selecting || !selectionStart || !rectangle) return;
    rectangle.setBounds(L.latLngBounds(selectionStart, event.latlng));
  });
  map.on('mouseup', (event) => {
    if (!selecting || !selectionStart) return;
    const bounds = L.latLngBounds(selectionStart, event.latlng);
    finishSelection(bounds);
  });
}

function fitStreets() {
  const bounds = streetsBounds(state.segments);
  if (!bounds) {
    toast.info('Sem arruamento', 'Baixe uma área primeiro usando “Selecionar área”.');
    return;
  }
  deps.navigate?.('map');
  state.visible = true;
  render();
  updateDock();
  deps.mapView?.map?.fitBounds(
    L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]).pad(0.08),
    { animate: true, maxZoom: 18, padding: [30, 30] },
  );
}

function clearStreets() {
  state.segments = [];
  state.updatedAt = 0;
  state.loadedAt = 0;
  clearLayer();
  persist();
  updateDock();
  bus.emit('streets:changed');
  toast.info('Arruamento removido', 'As vias carregadas foram retiradas do mapa e do DXF.');
}

export function initStreets(options = {}) {
  deps = options;
  els = {
    dock: document.querySelector('#streetsDock'),
    info: document.querySelector('#streetsInfo'),
    summary: document.querySelector('#streetsSummary'),
    progress: document.querySelector('#streetsProgress'),
    progressText: document.querySelector('#streetsProgressText'),
    instruction: document.querySelector('#streetsInstruction'),
    show: document.querySelector('#streetsShow'),
    labels: document.querySelector('#streetsLabels'),
    select: document.querySelector('#streetsSelect'),
    visible: document.querySelector('#streetsVisible'),
    fit: document.querySelector('#streetsFit'),
    clear: document.querySelector('#streetsClear'),
    close: document.querySelector('#streetsDockClose'),
    cancel: document.querySelector('#streetsCancelTop'),
  };
  if (!els.dock || !deps.mapView) return { open: () => {}, cancel: () => {}, get: () => [] };

  readStorage();
  bindMapEvents();

  document.querySelector('#mapStreets')?.addEventListener('click', () => {
    if (els.dock.hidden) {
      openDock();
      return;
    }
    if (!state.segments.length) beginSelection();
  });
  els.select?.addEventListener('click', () => beginSelection());
  els.visible?.addEventListener('click', () => {
    downloadArea(deps.mapView.map.getBounds());
  });
  els.cancel?.addEventListener('click', () => cancelSelection());
  els.close?.addEventListener('click', () => {
    cancelSelection();
    hideDock();
  });
  els.fit?.addEventListener('click', fitStreets);
  els.clear?.addEventListener('click', clearStreets);
  els.show?.addEventListener('change', () => {
    state.visible = Boolean(els.show.checked);
    render();
    persist();
    updateDock();
  });
  els.labels?.addEventListener('change', () => {
    state.labels = Boolean(els.labels.checked);
    render();
    persist();
  });

  document.querySelector('#exportStreetsSelect')?.addEventListener('click', () => beginSelection());
  document.querySelector('#exportStreetsView')?.addEventListener('click', () => {
    deps.navigate?.('map');
    downloadArea(deps.mapView.map.getBounds());
  });

  bus.on('dxf:cancel', () => cancelSelection());
  bus.on('dxf:selecting', () => {
    if (selecting) cancelSelection();
  });
  bus.on('map:dock', (id) => {
    if (id !== 'streets' && !els.dock.hidden) hideDock();
  });
  bus.on('ui:view', (view) => {
    if (view !== 'map') cancelSelection();
  });
  bus.on('streets:open', () => openDock());
  bus.on('streets:manage', () => openDock());

  render();
  updateDock();
  updateDxfLabel();
  bus.emit('streets:changed');

  return {
    open: () => openDock(),
    start: () => beginSelection(),
    startVisible: () => downloadArea(deps.mapView.map.getBounds()),
    cancel: () => cancelSelection(),
    clear: () => clearStreets(),
    fit: () => fitStreets(),
    get: () => state.segments,
    getForBounds: (bounds) => filterStreetsForBounds(state.segments, bounds),
    hasData: () => state.segments.length > 0,
  };
}

export function getLoadedStreets() {
  return state.segments;
}

export function getStreetsForBounds(bounds) {
  return filterStreetsForBounds(state.segments, bounds);
}
