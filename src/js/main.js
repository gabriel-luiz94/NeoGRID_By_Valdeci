import { $, $$, openDialog } from './core/dom.js';
import { bus } from './core/bus.js';
import { fmtInt, fmtKm } from './core/format.js';
import { applyAppearance, settings } from './core/settings.js';
import { library } from './data/library.js';
import { LAYER_META } from './data/schema.js';
import { featureTitle } from './data/labels.js';
import { importController } from './data/import-controller.js';
import { persistence } from './data/persistence.js';
import { exportLayerCsv } from './data/csv-export.js';
import { MapView } from './modules/map/map-view.js';
import { search } from './modules/search.js';
import { initExports } from './modules/views/exports.js';
import { initDxf } from './modules/dxf/dxf-ui.js';
import { initStreets } from './modules/streets.js';
import { initKml } from './modules/kml.js';
import { initPrint } from './modules/print.js';
import { initSettings } from './modules/views/settings.js';
import { initFieldDialogs } from './ui/field-dialogs.js';
import { initLabelsDialog } from './ui/labels-dialog.js';
import { initDbBuildDialog } from './data/db-build-ui.js';
import { initRowDialog, openRowDialog } from './ui/row-dialog.js';
import { toast } from './ui/toast.js';

const VIEW_CONFIG = {
  map: {
    eyebrow: 'Operação',
    title: 'Mapa operacional',
    subtitle: 'Explore postes, instalações e redes elétricas em um só lugar.',
  },
  exports: {
    eyebrow: 'Entregáveis',
    title: 'Exportações',
    subtitle: 'Leve a operação para o CAD, para a planilha ou para o papel.',
  },
  settings: {
    eyebrow: 'Sistema',
    title: 'Configurações',
    subtitle: 'Aparência, preferências do mapa e desempenho do aplicativo.',
  },
};

let mapView = null;
let dxfApi = null;
let streetsApi = null;
let kmlApi = null;
let printApi = null;
let projectApi = null;
let currentView = 'map';
let statusTimer = 0;

function setPage(view) {
  const config = VIEW_CONFIG[view] || VIEW_CONFIG.map;
  $('#pageEyebrow').textContent = config.eyebrow;
  $('#pageTitle').textContent = config.title;
  $('#pageSubtitle').textContent = config.subtitle;
  $$('.sidebar-nav .nav-item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === view);
  });
  $$('.view').forEach((section) => {
    section.classList.toggle('is-active', section.dataset.view === view);
  });
  currentView = view;
  bus.emit('ui:view', view);
  if (view !== 'map' && $('#statusText')?.textContent.startsWith('Selecionado:')) {
    setStatus('Pronto');
  }
  if (view === 'map') {
    setTimeout(() => mapView?.invalidate(), 90);
  }
}

const router = { setView: setPage, get current() { return currentView; } };

function updateShell() {
  const summary = library.summary();
  const hasData = summary.totalRows > 0;
  const lastImport = library.importHistory[0];

  if ($('#sidebarDatasetName')) {
    $('#sidebarDatasetName').textContent = hasData
      ? summary.fileCount > 1
        ? `${summary.fileCount} arquivos`
        : lastImport?.fileName || 'Conjunto carregado'
      : 'Nenhum arquivo';
  }
  if ($('#sidebarRows')) $('#sidebarRows').textContent = `${fmtInt(summary.totalRows)} registros`;
  if ($('#sidebarLayers')) $('#sidebarLayers').textContent = `${summary.stores} camada${summary.stores === 1 ? '' : 's'}`;
  if ($('#sidebarProgressBar')) $('#sidebarProgressBar').style.width = hasData ? '100%' : '0%';

  const badge = $('#pageBadge');
  if (badge) {
    badge.hidden = !hasData;
    badge.textContent = hasData ? `${fmtInt(summary.totalRows)} registros` : '';
  }

  if ($('#statusData')) {
    $('#statusData').textContent = hasData
      ? `${fmtInt(summary.totalRows)} registros · ${summary.stores} camadas · ${fmtKm(summary.totalLength)} de rede`
      : 'Nenhum dado carregado';
  }
  if ($('#titlebarStatus')) {
    $('#titlebarStatus').textContent = hasData
      ? `${fmtInt(summary.totalRows)} registros · ${summary.stores} camadas`
      : 'Ambiente local pronto';
  }
}

function setStatus(text, type = 'ready') {
  const label = $('#statusText');
  const dot = $('#statusDot');
  const titleDot = $('#titlebarDot');
  if (label) label.textContent = text;
  [dot, titleDot].forEach((element) => {
    if (!element) return;
    element.classList.remove('is-busy', 'is-error');
    if (type === 'busy') element.classList.add('is-busy');
    if (type === 'error') element.classList.add('is-error');
  });
  clearTimeout(statusTimer);
  if (type !== 'busy') {
    statusTimer = setTimeout(() => {
      dot?.classList.remove('is-busy', 'is-error');
      titleDot?.classList.remove('is-busy', 'is-error');
    }, 4000);
  }
}

function bindShell() {
  $$('.sidebar-nav .nav-item').forEach((button) => {
    button.addEventListener('click', () => setPage(button.dataset.view));
  });

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-goto]');
    if (target) {
      event.preventDefault();
      setPage(target.dataset.goto);
    }
  });

  const shell = $('#appShell');
  const collapsedKey = 'neogrid.ui.sidebar-collapsed';
  const setCollapsed = (collapsed) => {
    shell.classList.toggle('is-collapsed', collapsed);
    try {
      localStorage.setItem(collapsedKey, collapsed ? '1' : '0');
    } catch {
      /* sem armazenamento */
    }
    setTimeout(() => mapView?.invalidate(), 320);
  };
  try {
    if (localStorage.getItem(collapsedKey) === '1') shell.classList.add('is-collapsed');
  } catch {
    /* sem armazenamento */
  }
  $('#sidebarCollapse')?.addEventListener('click', () => setCollapsed(true));
  $('#sidebarExpand')?.addEventListener('click', () => setCollapsed(false));

  const help = () => openDialog($('#helpDialog'));
  $('#sidebarHelp')?.addEventListener('click', help);
  $('#dashHelp')?.addEventListener('click', help);

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      || document.activeElement?.isContentEditable;
    const dialogOpen = Boolean(document.querySelector('dialog[open]'));

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      importController.open();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      printApi?.open();
      return;
    }
    if (event.key === 'Escape') {
      if (dialogOpen) return;
      printApi?.close();
      dxfApi?.cancel();
      streetsApi?.cancel();
      kmlApi?.cancel();
      mapView?.clearSelection();
      search.hide();
      return;
    }
    if (typing || dialogOpen) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (['1', '2', '3'].includes(event.key)) {
      const view = ['map', 'exports', 'settings'][Number(event.key) - 1];
      setPage(view);
      return;
    }
    if (event.key === '+') {
      if (currentView === 'map') mapView.map.zoomIn(1);
      return;
    }
    if (event.key === '-') {
      if (currentView === 'map') mapView.map.zoomOut(1);
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'f') {
      setPage('map');
      mapView.fitData();
    } else if (key === 's') {
      setPage('map');
      setTimeout(() => mapView.goToScale(settings.scale), 120);
    } else if (key === 'd') {
      dxfApi?.start();
    }
  });

  bus.on('data:changed', () => {
    updateShell();
    if (!library.hasData()) {
      setStatus('Pronto');
      $('#statusDot')?.classList.remove('is-error');
      $('#titlebarDot')?.classList.remove('is-error');
    }
  });

  bus.on('import:start', ({ files }) => {
    setStatus(`Importando ${files} arquivo${files === 1 ? '' : 's'}…`, 'busy');
    if ($('#sidebarProgressBar')) $('#sidebarProgressBar').style.width = '0%';
  });
  bus.on('import:progress', ({ file, percent, rows }) => {
    const safePercent = Math.max(0, Math.min(100, percent || 0));
    if ($('#sidebarProgressBar')) $('#sidebarProgressBar').style.width = `${safePercent}%`;
    setStatus(`Lendo ${file} · ${fmtInt(rows || 0)} linhas · ${Math.round(safePercent)}%`, 'busy');
  });
  bus.on('import:finish', ({ cancelled, added, summary, errors }) => {
    if (cancelled) {
      setStatus('Importação cancelada');
    } else if (added) {
      setStatus(`${fmtInt(added)} registros importados${errors ? ` · ${errors} arquivo(s) com erro` : ''}`);
    } else {
      setStatus('Importação sem novos registros', errors ? 'error' : 'ready');
    }
    updateShell();
    if (summary?.totalRows && $('#sidebarProgressBar')) $('#sidebarProgressBar').style.width = '100%';
  });

  bus.on('feature:selected', (feature) => {
    if (!feature) {
      if (currentView === 'map') setStatus('Pronto');
      return;
    }
    const store = library.get(feature.type);
    if (!store) return;
    setStatus(`Selecionado: ${LAYER_META[feature.type].singular} ${featureTitle(store, feature.index)}`);
  });

  bus.on('map:utm-warning', () => {
    setStatus('Coordenadas em UTM detectadas — o mapa espera WGS 84', 'error');
  });
}

/** CSV export from the Exports view: one complete file per loaded layer. */
function wireCsvExport() {
  document.querySelector('#exportCsvGo')?.addEventListener('click', async () => {
    if (!library.hasData()) {
      toast.info('Nenhum dado para exportar', 'Importe o banco de dados primeiro.');
      return;
    }
    const stores = library.storesWithData();
    if (library.isDatabase()) {
      toast.info(
        'Use o DXF por área',
        'No modo banco, o CSV exporta apenas a página exibida. Para áreas maiores, use a exportação DXF por área.',
        { duration: 7000 },
      );
      return;
    }
    for (const store of stores) {
      const date = new Date().toISOString().slice(0, 10);
      await exportLayerCsv({
        type: store.type,
        defaultName: `neogrid_${store.type}_completo_${date}.csv`,
      });
    }
  });
}

function bindGlobalErrors() {
  let count = 0;
  const report = (message) => {
    if (count >= 3) return;
    count += 1;
    toast.error('Ocorreu um erro inesperado', message || 'Consulte o console para mais detalhes.');
  };
  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
    report(event.reason?.message);
  });
  window.addEventListener('error', (event) => {
    if (!event.message || event.message === 'Script error.') return;
    console.error(event.error || event.message);
    report(event.message);
  });
}

function init() {
  applyAppearance({ notify: false });
  document.documentElement.dataset.platform = window.desktop?.platform || 'web';

  mapView = new MapView({
    navigate: (view) => setPage(view),
    openRow: (type, index) => openRowDialog(type, index),
  }).init();

  initRowDialog({
    onLocate: (type, index) => {
      setPage('map');
      setTimeout(() => mapView.focusFeature(type, index), 120);
    },
  });

  importController.init({ navigate: (view) => setPage(view), mapView });
  projectApi = persistence.init({
    navigate: (view) => setPage(view),
    fitData: (options) => mapView.fitData(options),
  });
  dxfApi = initDxf({ mapView, navigate: (view) => setPage(view) });
  streetsApi = initStreets({ mapView, navigate: (view) => setPage(view) });
  kmlApi = initKml({ mapView, navigate: (view) => setPage(view) });
  printApi = initPrint({ mapView, navigate: (view) => setPage(view) });
  initExports();
  wireCsvExport();
  initSettings();
  initFieldDialogs();
  initLabelsDialog();
  initDbBuildDialog();
  search.init({ mapView });

  bindShell();
  bindGlobalErrors();
  $$('dialog.modal form').forEach((form) => {
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.target.closest('button')) event.preventDefault();
    });
  });
  setPage('map');
  updateShell();

  const splash = $('#splash');
  requestAnimationFrame(() => {
    setTimeout(() => splash?.classList.add('is-hidden'), 500);
  });

  const isTest = new URLSearchParams(location.search).get('test') === '1';
  if (!isTest) {
    persistence.refreshStatus().then(() => persistence.autoload()).then((result) => {
      if (result?.loaded) setTimeout(() => mapView.fitData({ animate: false }), 350);
    }).catch((error) => console.error('[projeto] autoload', error));
  }
  if (isTest) {
    window.__neo = {
      library,
      settings,
      mapView,
      bus,
      persistence,
      streets: streetsApi,
      kml: kmlApi,
      setView: setPage,
      openRowDialog,
      getSummary: () => library.summary(),
      async importCsv(name, content) {
        const file = new File([content], name, { type: 'text/csv' });
        await importController.importDirect([file]);
      },
      async importFiles(files) {
        await importController.importDirect(files);
      },
      async openDatabase(filePath) {
        const { openDatabaseInfo } = await import('./data/import-controller.js');
        let info;
        if (typeof filePath === 'string') {
          const opened = await window.desktop.dbOpen(filePath);
          if (!opened?.opened) throw new Error(opened?.error || 'Falha ao abrir o banco.');
          info = opened.info;
        } else {
          info = filePath;
        }
        return openDatabaseInfo(info);
      },
    };
    window.__neo.ready = true;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
