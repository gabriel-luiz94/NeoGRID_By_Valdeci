import { bus } from '../core/bus.js';
import { library } from '../data/library.js';
import { LAYER_META } from '../data/schema.js';
import { fmtInt, fmtCoord, fmtDate } from '../core/format.js';
import { toast } from '../ui/toast.js';

const SHEETS = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
};
const MARGIN_MM = 10;
const MM_PER_PX = 0.0002645833;
const RAD = Math.PI / 180;

const state = {
  frame: null,
  printing: false,
  panelOpen: false,
};

let deps = {};
let els = {};

const sheetDimensions = () => {
  const dims = SHEETS[els.sheet?.value] || SHEETS.A3;
  const orientation = els.orientation?.value || 'l';
  return orientation === 'p' ? [dims[1], dims[0]] : [dims[0], dims[1]];
};

const scaleZoom = (lat, denominator) =>
  Math.log2((156543.03392 * Math.cos(lat * RAD)) / (denominator * MM_PER_PX));

function frameBoundsFor(denominator, widthMm, heightMm) {
  const center = deps.mapView.map.getCenter();
  const widthMeters = ((widthMm - MARGIN_MM * 2) / 1000) * denominator;
  const heightMeters = ((heightMm - MARGIN_MM * 2) / 1000) * denominator;
  const deltaLat = heightMeters / 2 / 111320;
  const deltaLon = widthMeters / 2 / (111320 * Math.cos(center.lat * RAD));
  return {
    center,
    widthMeters,
    heightMeters,
    bounds: L.latLngBounds(
      [center.lat - deltaLat, center.lng - deltaLon],
      [center.lat + deltaLat, center.lng + deltaLon],
    ),
  };
}

function updateFrame() {
  if (state.printing) return;
  if (!state.panelOpen || !deps.mapView?.map) {
    state.frame?.remove();
    state.frame = null;
    return;
  }
  const map = deps.mapView.map;
  const [widthMm, heightMm] = sheetDimensions();
  const denominator = Math.max(100, Number(els.scale?.value) || 1000);
  const { bounds, widthMeters, heightMeters } = frameBoundsFor(denominator, widthMm, heightMm);
  if (state.frame) state.frame.setBounds(bounds);
  else {
    state.frame = L.rectangle(bounds, {
      color: '#f5a524',
      weight: 2,
      dashArray: '7 5',
      fillColor: '#f5a524',
      fillOpacity: 0.055,
      interactive: false,
    }).addTo(map);
  }
  if (els.info) {
    const fullFrame = map.getBounds().contains(bounds);
    els.info.textContent = `Área útil ${widthMm - MARGIN_MM * 2} × ${heightMm - MARGIN_MM * 2} mm = ${Math.round(widthMeters)} × ${Math.round(heightMeters)} m no terreno. ${fullFrame ? 'Mova o mapa para enquadrar.' : 'Afaste o zoom para ver o quadro completo.'}`;
  }
}

function removeFrame() {
  state.frame?.remove();
  state.frame = null;
}

function closePanel() {
  state.panelOpen = false;
  els.panel.hidden = true;
  removeFrame();
}

function openPanel() {
  deps.navigate?.('map');
  if (!library.hasData()) {
    toast.info('Mapa sem dados', 'A prancha incluirá apenas o mapa de fundo. Importe os CSVs para incluir seus ativos.');
  }
  setTimeout(() => {
    state.panelOpen = true;
    els.panel.hidden = false;
    deps.mapView?.invalidate();
    updateFrame();
    const bounds = state.frame?.getBounds();
    if (bounds?.isValid()) {
      deps.mapView.map.fitBounds(bounds.pad(0.06), { animate: true, maxZoom: 18 });
    }
  }, 200);
}

function fillPrintMetadata(denominator) {
  const center = deps.mapView.map.getCenter();
  const summary = library.summary();
  const sheet = els.sheet?.value || 'A3';
  const orientation = els.orientation?.value === 'p' ? 'retrato' : 'paisagem';
  if (els.printTitle) els.printTitle.textContent = els.titleInput?.value?.trim() || 'Mapa de redes e ativos';
  if (els.printContext) {
    els.printContext.textContent = summary.totalRows
      ? `${fmtInt(summary.totalRows)} registros · ${summary.stores} camadas · centro ${fmtCoord(center.lat, 4)}, ${fmtCoord(center.lng, 4)}`
      : `Mapa base · centro ${fmtCoord(center.lat, 4)}, ${fmtCoord(center.lng, 4)}`;
  }
  if (els.sheetLabel) els.sheetLabel.textContent = sheet;
  if (els.meta) els.meta.textContent = `Escala 1:${fmtInt(denominator)} · ${sheet} ${orientation}`;
  if (els.date) els.date.textContent = fmtDate();
  if (els.legend) {
    if (els.includeLegend?.checked) {
      els.legend.innerHTML = ['poste', 'bt', 'mt', 'inst'].map((type) => (
        `<span><i style="--c:${LAYER_META[type].color}"></i>${LAYER_META[type].name}</span>`
      )).join('');
    } else {
      els.legend.innerHTML = '';
    }
  }
}

async function print() {
  if (state.printing) return;
  state.printing = true;
  const map = deps.mapView.map;
  const mapElement = map.getContainer();
  const parent = mapElement.parentElement;
  const nextSibling = mapElement.nextElementSibling;
  const originalInvalidate = map.invalidateSize.bind(map);
  const center = map.getCenter();
  const originalZoom = map.getZoom();
  const tileOpacity = map.getPane('tilePane').style.opacity;
  const denominator = Math.max(100, Number(els.scale?.value) || 1000);
  const [widthMm, heightMm] = sheetDimensions();
  const sheetName = els.sheet?.value || 'A3';
  const title = els.titleInput?.value?.trim() || 'Mapa de redes e ativos';
  const savedSelection = deps.mapView.inspector?.current;

  // A prancha não deve conter o quadro de pré-visualização nem a seleção atual.
  state.frame?.remove();
  state.frame = null;
  deps.mapView.renderer?.setSelected(null);
  deps.mapView.clearSearchMarker?.();

  fillPrintMetadata(denominator);
  document.querySelector('#printPageCss').textContent = `@page{size:${widthMm}mm ${heightMm}mm;margin:0}`;
  document.body.style.setProperty('--print-w', `${widthMm}mm`);
  document.body.style.setProperty('--print-h', `${heightMm}mm`);
  els.root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('is-printing');

  els.mapSlot.innerHTML = '';
  els.mapSlot.appendChild(mapElement);

  // Permite uma única sincronização de tamanho e evita que o redimensionamento
  // provocado pela janela de impressão destrua os tiles.
  map.invalidateSize = () => map;
  originalInvalidate({ animate: false, pan: false });

  const restore = () => {
    if (!state.printing) return;
    state.printing = false;
    document.querySelector('#printPageCss').textContent = '';
    document.body.classList.remove('is-printing');
    els.root.setAttribute('aria-hidden', 'true');
    map.invalidateSize = originalInvalidate;
    if (nextSibling && nextSibling.parentElement === parent) parent.insertBefore(mapElement, nextSibling);
    else parent.appendChild(mapElement);
    map.setView(center, originalZoom, { animate: false });
    originalInvalidate({ animate: false, pan: false });
    map.getPane('tilePane').style.opacity = tileOpacity;
    deps.mapView.renderer?.schedule();
    deps.mapView.updateScale?.();
    if (savedSelection) deps.mapView.selectFeature(savedSelection.type, savedSelection.index);
    if (state.panelOpen) updateFrame();
  };

  window.addEventListener('afterprint', restore, { once: true });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    map.setView(center, scaleZoom(center.lat, denominator), { animate: false });
    originalInvalidate({ animate: false, pan: false });
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      map.once('load', finish);
      setTimeout(finish, 1500);
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    deps.mapView.renderer?.render();
    await new Promise((resolve) => setTimeout(resolve, 250));
    window.print();
    // Alguns ambientes não disparam afterprint; restaura após a janela fechar.
    setTimeout(() => {
      if (!window.matchMedia('print').matches) restore();
    }, 1500);
  } catch (error) {
    restore();
    toast.error('Falha ao preparar impressão', error.message);
  }
}

export function initPrint(options = {}) {
  deps = options;
  els = {
    panel: document.querySelector('#printPanel'),
    close: document.querySelector('#printClose'),
    go: document.querySelector('#printGo'),
    sheet: document.querySelector('#printSheet'),
    orientation: document.querySelector('#printOrientation'),
    scale: document.querySelector('#printScale'),
    titleInput: document.querySelector('#printTitleInput'),
    includeLegend: document.querySelector('#printLegend'),
    info: document.querySelector('#printInfo'),
    root: document.querySelector('#printRoot'),
    mapSlot: document.querySelector('#printMapSlot'),
    printTitle: document.querySelector('#printTitle'),
    printContext: document.querySelector('#printContext'),
    sheetLabel: document.querySelector('#printSheetLabel'),
    meta: document.querySelector('#printMeta'),
    date: document.querySelector('#printDate'),
    legend: document.querySelector('#printLegendFooter'),
  };
  if (!els.panel) return { open: () => {} };

  els.sheet.innerHTML = Object.entries(SHEETS).map(([name, dims]) => (
    `<option value="${name}" ${name === 'A3' ? 'selected' : ''}>${name} · ${dims[0]} × ${dims[1]} mm</option>`
  )).join('');

  document.querySelector('#mapPrint')?.addEventListener('click', openPanel);
  document.querySelector('#exportPrintGo')?.addEventListener('click', openPanel);
  els.close?.addEventListener('click', closePanel);
  els.go?.addEventListener('click', print);
  els.panel.addEventListener('input', updateFrame);
  els.panel.addEventListener('change', updateFrame);
  bus.on('map:moving', () => {
    if (state.panelOpen) updateFrame();
  });
  bus.on('map:moved', () => {
    if (state.panelOpen) updateFrame();
  });
  bus.on('ui:view', (view) => {
    if (view !== 'map') closePanel();
  });

  return { open: openPanel, close: closePanel, print };
}
