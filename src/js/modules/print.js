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
const TILE_TIMEOUT_MS = 60000;
const TILE_FADE_MS = 350;
const MIN_DATA_ZOOM = 15;   // abaixo disso o renderer não desenha a rede

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
  deps.markup?.concluir();
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

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statusMostrar({ titulo = 'Preparando a prancha', texto = '', progresso = null, barra = true, go = '', cancelar = 'Cancelar' }) {
  els.status.hidden = false;
  els.statusTitle.textContent = titulo;
  els.statusText.textContent = texto;
  els.statusBar.hidden = !barra;
  // Sem `value`, a barra fica em movimento: ainda não se sabe quanto falta.
  if (progresso == null) els.statusBar.removeAttribute('value');
  else els.statusBar.value = progresso;
  els.statusGo.hidden = !go;
  els.statusGo.textContent = go;
  els.statusCancel.textContent = cancelar;
}

/** Espera as imagens de fundo da folha, até o limite de tempo. */
async function aguardarFundo(cancelado) {
  const inicio = performance.now();
  let estavel = 0;
  const imagens = () => [...els.mapSlot.querySelectorAll('img.leaflet-tile')];
  while (performance.now() - inicio < TILE_TIMEOUT_MS && !cancelado()) {
    const todas = imagens();
    const prontas = todas.filter((img) => img.complete).length;
    if (todas.length) {
      statusMostrar({ texto: `Imagens de fundo: ${fmtInt(prontas)} de ${fmtInt(todas.length)}`, progresso: prontas / todas.length });
    }
    estavel = prontas === todas.length ? estavel + 1 : 0;
    if (estavel >= 2) break;
    await espera(200);
  }
  const todas = imagens();
  return { total: todas.length, faltam: todas.filter((img) => !img.complete || !img.naturalWidth).length };
}

/** O que falta na folha e deveria impedir a impressão sem o usuário saber. */
function problemasDaFolha(stats, fundo, lat) {
  const problemas = [];
  if (stats.lowZoom && stats.hasData) {
    const limite = Math.floor((156543.03392 * Math.cos(lat * RAD)) / (2 ** MIN_DATA_ZOOM * MM_PER_PX) / 100) * 100;
    problemas.push(`Nesta escala a rede não é desenhada. Use 1:${fmtInt(limite)} ou uma escala maior.`);
  }
  const nomes = (tipos) => tipos.map((tipo) => LAYER_META[tipo]?.name || tipo).join(', ');
  if (stats.cortadas?.length) problemas.push(`A folha passa do limite de ${fmtInt(20000)} elementos por camada e sairia cortada em: ${nomes(stats.cortadas)}. Use uma escala maior.`);
  if (stats.falhas?.length) problemas.push(`Não foi possível ler da base: ${nomes(stats.falhas)}.`);
  if (fundo.faltam) problemas.push(`${fmtInt(fundo.faltam)} de ${fmtInt(fundo.total)} imagens de fundo não carregaram.`);
  return problemas;
}

function avisoDeRotulos(stats) {
  const partes = [];
  if (stats.rotulosOmitidos) partes.push(`${fmtInt(stats.rotulosOmitidos)} omitidos por sobreposição`);
  if (stats.rotulosZoom) partes.push(`${fmtInt(stats.rotulosZoom)} ocultos pelo zoom mínimo dos estilos`);
  return partes.length ? `${partes.join(' e ')}. Para incluí-los, marque "Imprimir todos os rótulos".` : '';
}

async function print() {
  if (state.printing) return;
  deps.markup?.concluir();
  state.printing = true;
  const map = deps.mapView.map;
  const renderer = deps.mapView.renderer;
  const todosRotulos = Boolean(els.allLabels?.checked);
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

  let avisoFinal = '';
  let cancelou = false;
  let aoCancelar = () => {};
  let aoConfirmar = () => {};
  const foiCancelado = () => cancelou;
  // Resolve junto com o cancelamento, para o botão funcionar mesmo no meio de uma espera.
  const ouCancelar = (promessa) => Promise.race([promessa, new Promise((resolve) => { aoCancelar = resolve; })]);

  const restore = () => {
    if (!state.printing) return;
    state.printing = false;
    window.removeEventListener('afterprint', restore);
    els.statusCancel.onclick = null;
    els.statusGo.onclick = null;
    els.status.hidden = true;
    renderer?.setPrintMode(null);
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
    if (avisoFinal) toast.warning('Rótulos fora da prancha', avisoFinal, { duration: 12000 });
  };

  els.statusCancel.onclick = () => {
    cancelou = true;
    aoCancelar();
    aoConfirmar(false);
    restore();
  };

  try {
    statusMostrar({ texto: 'Desenhando a rede da folha…' });
    await espera(120);
    renderer?.setPrintMode({ todos: todosRotulos });
    map.setView(center, scaleZoom(center.lat, denominator), { animate: false });
    originalInvalidate({ animate: false, pan: false });
    await ouCancelar(document.fonts?.ready);
    if (foiCancelado()) return;

    let stats = await ouCancelar(renderer?.renderComplete());
    if (foiCancelado()) return;
    await ouCancelar(window.ngRuasMapa?.pronto());
    if (foiCancelado()) return;
    const fundo = await aguardarFundo(foiCancelado);
    if (foiCancelado()) return;
    await espera(TILE_FADE_MS);   // as imagens entram com transição de opacidade
    if (renderer?.pendente) stats = await ouCancelar(renderer.renderComplete());
    if (foiCancelado()) return;

    const problemas = problemasDaFolha(stats || {}, fundo, center.lat);
    if (problemas.length) {
      statusMostrar({ titulo: 'A prancha sairia incompleta', texto: problemas.join('\n'), barra: false, go: 'Imprimir assim' });
      const seguir = await new Promise((resolve) => {
        aoConfirmar = resolve;
        els.statusGo.onclick = () => resolve(true);
      });
      if (!seguir) return;
    }

    if (!todosRotulos) avisoFinal = avisoDeRotulos(stats || {});
    els.status.hidden = true;
    window.addEventListener('afterprint', restore, { once: true });
    window.print();
    // Sem restauração por tempo: a janela de impressão ainda pode estar lendo a folha.
    // Se o afterprint não vier, este botão é a saída.
    setTimeout(() => {
      if (state.printing) statusMostrar({ titulo: 'Impressão', texto: 'Quando terminar, volte ao mapa.', barra: false, cancelar: 'Voltar ao mapa' });
    }, 3000);
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
    allLabels: document.querySelector('#printAllLabels'),
    status: document.querySelector('#printStatus'),
    statusTitle: document.querySelector('#printStatusTitle'),
    statusText: document.querySelector('#printStatusText'),
    statusBar: document.querySelector('#printStatusBar'),
    statusCancel: document.querySelector('#printStatusCancel'),
    statusGo: document.querySelector('#printStatusGo'),
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
