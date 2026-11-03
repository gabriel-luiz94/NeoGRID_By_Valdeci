import { bus } from '../../core/bus.js';
import { library } from '../../data/library.js';
import { LAYER_META } from '../../data/schema.js';
import { fmtInt, safeFilename, downloadText, esc } from '../../core/format.js';
import { icon } from '../../core/dom.js';
import { toast } from '../../ui/toast.js';
import { collectForExport, collectForExportAsync, countCollected, generateDxf } from './dxf-export.js';
import { getLoadedStreets, getStreetsForBounds } from '../streets.js';
import { getKmlExportData, hasKmlData, kmlSummary } from '../kml.js';
import { initDxfSettings } from './dxf-settings-ui.js';
import { loadDxfSettings } from './dxf-settings.js';
import { boundsSizeMeters } from './utm.js';

const state = {
  selecting: false,
  start: null,
  bounds: null,
  rectangle: null,
  collected: null,
  exporting: false,
};

let deps = {};
let els = {};
let dxfSettingsUi = null;

const btnHtml = (label, iconName = 'download') => `${icon(iconName)} ${label}`;

function hideDock() {
  if (els.dock) els.dock.hidden = true;
  if (els.instruction) els.instruction.hidden = true;
}

function updateLoadedLayers() {
  const streets = getLoadedStreets().length;
  const streetsLabel = document.querySelector('#dxfStreetsCount');
  if (streetsLabel) {
    streetsLabel.textContent = streets
      ? `${fmtInt(streets)} vias carregadas`
      : 'nenhuma via — use Arruamento no mapa';
  }
  if (els.streets) {
    els.streets.disabled = !streets;
    if (!streets) els.streets.checked = false;
    else if (els.streets.dataset.empty === '1') els.streets.checked = true;
    els.streets.dataset.empty = streets ? '0' : '1';
  }
  const kml = kmlSummary();
  const kmlTotal = kml.points + kml.lines + kml.polygons;
  const kmlLabel = document.querySelector('#dxfKmlCount');
  if (kmlLabel) {
    kmlLabel.textContent = kmlTotal
      ? `${fmtInt(kmlTotal)} elementos · ${fmtInt(kml.points)} pontos · ${fmtInt(kml.lines)} linhas · ${fmtInt(kml.polygons)} áreas`
      : 'nenhum KML carregado';
  }
  if (els.kml) {
    els.kml.disabled = !hasKmlData();
    if (!hasKmlData()) els.kml.checked = false;
    else if (els.kml.dataset.empty === '1') els.kml.checked = true;
    els.kml.dataset.empty = hasKmlData() ? '0' : '1';
  }
}

function removeRectangle() {
  if (state.rectangle) {
    state.rectangle.remove();
    state.rectangle = null;
  }
}

function reset({ keepMapMode = false } = {}) {
  state.selecting = false;
  state.start = null;
  state.bounds = null;
  state.collected = null;
  removeRectangle();
  hideDock();
  deps.mapView?.setDxfMode(false);
  deps.mapView?.map?.dragging?.enable();
  if (!keepMapMode) deps.mapView?.stageElement?.classList.remove('is-dxf-selecting');
}

function beginDrag() {
  reset({ keepMapMode: true });
  state.selecting = true;
  deps.navigate?.('map');
  bus.emit('dxf:selecting');
  bus.emit('map:kml-close');
  requestAnimationFrame(() => {
    deps.mapView?.invalidate();
    deps.mapView?.setDxfMode(true);
    deps.mapView?.map?.dragging?.disable();
    if (els.instruction) els.instruction.hidden = false;
    if (els.dock) els.dock.hidden = true;
  });
}

function drawRectangle(latlngBounds) {
  removeRectangle();
  state.rectangle = L.rectangle(latlngBounds, {
    color: '#f5a524',
    weight: 2,
    dashArray: '6 4',
    fillColor: '#f5a524',
    fillOpacity: 0.07,
    interactive: false,
    className: 'dxf-area-selection',
  }).addTo(deps.mapView.map);
}

async function showDock(bounds) {
  state.bounds = {
    west: bounds.getWest(),
    east: bounds.getEast(),
    south: bounds.getSouth(),
    north: bounds.getNorth(),
  };
  const size = boundsSizeMeters(state.bounds);
  if (els.areaInfo) {
    els.areaInfo.textContent = `${Math.round(size.width)} × ${Math.round(size.height)} m · área selecionada`;
  }
  drawRectangle(bounds);

  if (els.summary) {
    els.summary.innerHTML = '<span><span class="search-spinner"></span> Contando ativos na área…</span>';
  }
  let collected;
  try {
    collected = library.isDatabase()
      ? await collectForExportAsync(state.bounds, deps.mapView.getVisibleLayers())
      : collectForExport(state.bounds, deps.mapView.getVisibleLayers());
  } catch (error) {
    if (els.summary) els.summary.innerHTML = `<span>Falha ao consultar a área: ${esc(error.message)}</span>`;
    return;
  }
  state.collected = collected;
  const { counts, total } = countCollected(collected);

  if (els.summary) {
    els.summary.innerHTML = ['poste', 'inst', 'bt', 'mt'].map((type) => {
      return `<span><i style="--c:${LAYER_META[type].color}"></i>${LAYER_META[type].name}: ${fmtInt(counts[type])}</span>`;
    }).join('') + (total ? '' : '<span>Nenhum ativo nas camadas visíveis</span>');
  }
  if (els.exportButton) {
    els.exportButton.disabled = !total;
    els.exportButton.innerHTML = btnHtml('Gerar e salvar DXF');
  }
  if (els.dock) els.dock.hidden = false;
  if (els.instruction) els.instruction.hidden = true;
  updateLoadedLayers();
  deps.mapView?.setDxfMode(false);
  deps.mapView?.map?.dragging?.enable();
  deps.mapView?.suppressClicks(400);
  requestAnimationFrame(() => deps.mapView?.invalidate());
}

function finishSelection(bounds) {
  const dimensions = boundsSizeMeters({
    west: bounds.getWest(),
    east: bounds.getEast(),
    south: bounds.getSouth(),
    north: bounds.getNorth(),
  });
  if (dimensions.width < 2 || dimensions.height < 2) {
    reset();
    toast.info('Área muito pequena', 'Arraste uma área com pelo menos 2 × 2 metros.');
    return;
  }
  showDock(bounds);
}

function bindMapSelection() {
  const map = deps.mapView.map;
  map.on('mousedown', (event) => {
    if (!state.selecting) return;
    if (event.originalEvent?.button) return;
    state.start = event.latlng;
    drawRectangle(L.latLngBounds(event.latlng, event.latlng));
    deps.mapView.suppressClicks(500);
  });
  map.on('mousemove', (event) => {
    if (!state.selecting || !state.start || !state.rectangle) return;
    state.rectangle.setBounds(L.latLngBounds(state.start, event.latlng));
  });
  map.on('mouseup', (event) => {
    if (!state.selecting || !state.start) return;
    const bounds = L.latLngBounds(state.start, event.latlng);
    state.selecting = false;
    state.start = null;
    deps.mapView.setDxfMode(false);
    deps.mapView.map.dragging.enable();
    if (els.instruction) els.instruction.hidden = true;
    finishSelection(bounds);
  });
}

function setExportBusy(busy, label = 'Gerando DXF…') {
  state.exporting = busy;
  if (!els.exportButton) return;
  els.exportButton.disabled = busy;
  els.exportButton.innerHTML = busy ? `<span class="search-spinner"></span> ${label}` : btnHtml('Gerar e salvar DXF');
}

async function exportDxf() {
  if (state.exporting || !state.bounds) return;
  const collectedCount = countCollected(state.collected || { poste: [], inst: [], bt: [], mt: [] });
  if (!collectedCount.total) {
    toast.info('Nada para exportar', 'Ative uma camada com ativos dentro da área selecionada.');
    return;
  }
  setExportBusy(true);
  const denominator = Number(els.scale?.value) || 1000;
  const streets = els.streets?.checked ? getStreetsForBounds(state.bounds) : [];
  const loadedStreets = getLoadedStreets().length;
  const kml = els.kml?.checked ? getKmlExportData() : { features: [], labels: false };

  setExportBusy(true, 'Gerando arquivo…');
  let result;
  try {
    result = generateDxf(state.bounds, denominator, streets, deps.mapView.getVisibleLayers(), {
      settings: loadDxfSettings(),
      collected: state.collected,
      kml,
    });
  } catch (error) {
    setExportBusy(false);
    toast.error('Falha ao gerar DXF', error.message);
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = safeFilename(`neogrid_dxf_1-${denominator}_${date}.dxf`);
  const bytes = new Blob([result.content]).size;

  let saved;
  if (window.desktop?.saveFile) {
    saved = await window.desktop.saveFile({
      defaultName: filename,
      title: 'Salvar desenho DXF',
      content: result.content,
      filters: [{ name: 'Desenho DXF', extensions: ['dxf'] }],
    });
  } else {
    downloadText(result.content, filename, 'application/dxf');
    saved = { saved: true };
  }

  setExportBusy(false);
  if (!saved?.saved) {
    if (saved?.error) toast.error('Falha ao salvar', saved.error);
    return;
  }

  library.addExport({
    format: 'DXF',
    name: filename,
    type: 'dxf',
    rows: result.total,
    bytes,
    path: saved.path || '',
  });

  const countsText = [
    `Postes ${fmtInt(result.counts.poste)}`,
    `Instalações ${fmtInt(result.counts.inst)}`,
    `BT ${fmtInt(result.counts.bt)}`,
    `MT ${fmtInt(result.counts.mt)}`,
    result.counts.ruas ? `Ruas ${fmtInt(result.counts.ruas)}` : '',
    result.counts.kml ? `KML ${fmtInt(result.counts.kml)}` : '',
  ].filter(Boolean).join(' · ');
  const streetsOutside = Boolean(els.streets?.checked && loadedStreets && !streets.length);

  toast.success(
    'DXF gerado',
    `${countsText} · UTM ${result.zone}${result.hemisphere}${streetsOutside ? ' · arruamento fora da área' : ''}`,
    saved.path ? {
      duration: 7500,
      actionLabel: 'Mostrar na pasta',
      action: () => window.desktop.revealFile(saved.path),
    } : { duration: 7000 },
  );
  if (result.warnings?.length) {
    setTimeout(() => toast.warning('Blocos não encontrados', result.warnings.join(' ')), 700);
  }

  reset();
}

export function initDxf(options = {}) {
  deps = options;
  els = {
    dock: document.querySelector('#dxfDock'),
    instruction: document.querySelector('#dxfInstruction'),
    areaInfo: document.querySelector('#dxfAreaInfo'),
    summary: document.querySelector('#dxfSummary'),
    scale: document.querySelector('#dxfScale'),
    streets: document.querySelector('#dxfStreets'),
    kml: document.querySelector('#dxfKml'),
    exportButton: document.querySelector('#dxfExport'),
    settingsButton: document.querySelector('#dxfSettings'),
    cancelTop: document.querySelector('#dxfCancelTop'),
    close: document.querySelector('#dxfDockClose'),
    newArea: document.querySelector('#dxfNewArea'),
  };
  if (!els.dock || !deps.mapView) return { start: () => {}, cancel: () => {} };
  dxfSettingsUi = initDxfSettings();
  updateLoadedLayers();

  const start = ({ useView = false } = {}) => {
    if (!library.hasData()) {
      toast.info('Nenhum dado carregado', 'Importe os CSVs antes de exportar um DXF.');
      return;
    }
    reset();
    deps.navigate?.('map');
    setTimeout(() => {
      deps.mapView.invalidate();
      if (useView) {
        showDock(deps.mapView.map.getBounds());
      } else {
        beginDrag();
      }
    }, 180);
  };

  document.querySelector('#mapDxf')?.addEventListener('click', () => start());
  document.querySelector('#exportDxfSelect')?.addEventListener('click', () => start());
  document.querySelector('#exportDxfView')?.addEventListener('click', () => start({ useView: true }));

  els.cancelTop?.addEventListener('click', () => reset());
  els.close?.addEventListener('click', () => reset());
  els.newArea?.addEventListener('click', () => {
    reset();
    beginDrag();
  });
  els.exportButton?.addEventListener('click', exportDxf);
  els.settingsButton?.addEventListener('click', () => dxfSettingsUi?.open());
  document.querySelector('#dxfStreetsManage')?.addEventListener('click', () => bus.emit('streets:open'));
  document.querySelector('#dxfKmlManage')?.addEventListener('click', () => bus.emit('kml:manage'));

  bindMapSelection();

  bus.on('streets:changed', updateLoadedLayers);
  bus.on('kml:changed', updateLoadedLayers);

  bus.on('ui:view', (view) => {
    if (view !== 'map') reset({ keepMapMode: true });
  });

  return {
    start,
    cancel: () => reset(),
    get active() {
      return state.selecting || !els.dock.hidden;
    },
  };
}
