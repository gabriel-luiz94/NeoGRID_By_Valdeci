import { bus } from '../../core/bus.js';
import { library } from '../../data/library.js';
import { LAYER_META, LAYER_TYPES } from '../../data/schema.js';
import { icon, debounce } from '../../core/dom.js';
import { esc, fmtInt } from '../../core/format.js';
import { openRowDialog } from '../../ui/row-dialog.js';
import { openColumnsDialog } from '../../ui/field-dialogs.js';
import { exportLayerCsv } from '../../data/csv-export.js';
import { toast } from '../../ui/toast.js';
import { getTableColumns } from '../../core/settings.js';

const state = {
  type: null,
  query: '',
  sort: { column: null, dir: 1 },
  indices: [],
  columns: [],
  gridTemplate: '',
  filterToken: 0,
  filtering: false,
  selected: null,
  rowHeight: 38,
  dbPage: 0,
  dbPageSize: 200,
  dbTotal: 0,
  dbLoading: false,
};

const isDbMode = () => {
  const store = activeStore();
  return Boolean(store?.isDatabase);
};

let els = {};
let deps = {};
let renderFrame = 0;
let loadingElement = null;

const HEAD_HEIGHT = 34;
const OVERSCAN = 6;

const rowHeight = () => {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--table-row-h'));
  state.rowHeight = Number.isFinite(value) && value > 20 ? value : 38;
  return state.rowHeight;
};

const activeStore = () => (state.type ? library.get(state.type) : null);

function layerTabs() {
  const types = LAYER_TYPES.filter((type) => (library.get(type)?.stats.count || 0) > 0);
  if (!types.length) {
    els.tabs.innerHTML = '';
    return;
  }
  if (!state.type || !types.includes(state.type)) state.type = types.includes('poste') ? 'poste' : types[0];
  els.tabs.innerHTML = types.map((type) => {
    const meta = LAYER_META[type];
    const count = library.get(type)?.stats.count || 0;
    return `<button class="layer-tab ${state.type === type ? 'is-active' : ''}" data-data-layer="${type}" style="--lt-color:${meta.color}">
      <i></i>${meta.name}<span class="tab-count">${fmtInt(count)}</span>
    </button>`;
  }).join('');
}

function columnsFor(store) {
  const stored = getTableColumns(store.type);
  const existing = new Set(store.headers);
  const selected = (stored || store.importantColumns()).filter((column) => existing.has(column) && !/_DESC$/.test(column) && !/^GEOMETRIA_WKT$/.test(column));
  return selected.length ? selected : store.headers.filter((header) => !/_DESC$/.test(header) && !/^GEOMETRIA_WKT$/.test(header)).slice(0, 7);
}

function buildGridTemplate(columns) {
  const widths = columns.map((column) => {
    if (/^NU_PG_(ID|INI|FIN)$|^NU_INSTALA$|^NU_TRECHO$/.test(column)) return 132;
    if (column.length > 20) return 190;
    if (column.length > 13) return 158;
    return 128;
  });
  const total = 52 + widths.reduce((sum, width) => sum + width, 0);
  const last = widths.length ? `minmax(${widths[widths.length - 1]}px, 1fr)` : '1fr';
  const template = ['52px', ...widths.slice(0, -1).map((width) => `${width}px`), last].join(' ');
  return { template, total };
}

function renderHeader() {
  const store = activeStore();
  if (!store) return;
  const { template, total } = buildGridTemplate(state.columns);
  state.gridTemplate = template;
  els.inner.style.minWidth = `${total}px`;
  els.head.style.gridTemplateColumns = template;
  els.head.innerHTML = `
    <div class="vt-head-cell">#</div>
    ${state.columns.map((column) => {
      const sorted = state.sort.column === column;
      return `<div class="vt-head-cell ${sorted ? 'is-sorted' : ''}" data-column="${esc(column)}" title="Ordenar por ${esc(column)}">
        <span class="truncate">${esc(column)}</span>
        <span class="sort-icon">${sorted ? (state.sort.dir > 0 ? '↑' : '↓') : icon('sort')}</span>
      </div>`;
    }).join('')}`;
}

function valueClass(column) {
  return /^NU_PG_(ID|INI|FIN)$|^NU_INSTALA$|^NU_TRECHO$|^CD_FASE$|CONDUTOR|^ID$/.test(column) ? 'is-code' : '';
}

function cellHtml(store, row, index, column) {
  const columnIndex = store.colIndex(column);
  let value = columnIndex >= 0 ? row[columnIndex] : '';
  value = value == null ? '' : String(value);
  if (!value) return `<div class="vt-cell is-empty">—</div>`;
  const className = valueClass(column);
  return `<div class="vt-cell ${className}" title="${esc(value)}">${esc(value)}</div>`;
}

function renderRows() {
  const store = activeStore();
  if (!store || !state.indices.length) return;
  if (!els.scroll.offsetHeight) return;
  const height = rowHeight();
  const scrollTop = els.scroll.scrollTop;
  const relativeTop = Math.max(0, scrollTop - HEAD_HEIGHT);
  const start = Math.max(0, Math.floor(relativeTop / height) - OVERSCAN);
  const end = Math.min(state.indices.length, Math.ceil((relativeTop + els.scroll.clientHeight) / height) + OVERSCAN);
  const rowTemplate = state.gridTemplate;

  let html = '';
  for (let position = start; position < end; position++) {
    const index = state.indices[position];
    const row = store.rows[index];
    const selected = state.selected?.type === store.type && state.selected.index === index;
    html += `<div class="vt-row ${selected ? 'is-selected' : ''}" data-index="${index}" style="top:${position * height}px;grid-template-columns:${rowTemplate}">
      <div class="vt-cell" style="color:var(--faint);font-family:var(--font-mono);font-size:8px">${fmtInt(index + 1)}</div>
      ${state.columns.map((column) => cellHtml(store, row, index, column)).join('')}
    </div>`;
  }
  els.body.innerHTML = html;
  updateRange(start, end);
}

function updateRange(start, end) {
  if (isDbMode()) {
    const total = state.dbTotal;
    const pages = Math.max(1, Math.ceil(total / state.dbPageSize));
    els.range.textContent = total
      ? `${fmtInt(total)} registros · página ${fmtInt(state.dbPage + 1)} de ${fmtInt(pages)} (modo banco)`
      : '0 registros';
    if (els.pageInfo) els.pageInfo.textContent = `Página ${fmtInt(state.dbPage + 1)} de ${fmtInt(pages)}`;
    if (els.pager) els.pager.hidden = false;
    if (els.prev) els.prev.disabled = state.dbPage <= 0 || state.dbLoading;
    if (els.next) els.next.disabled = state.dbPage + 1 >= pages || state.dbLoading;
    if (els.modeLabel) els.modeLabel.textContent = 'Paginação no banco';
    return;
  }
  if (els.pager) els.pager.hidden = true;
  if (els.modeLabel) els.modeLabel.textContent = 'Exibição virtualizada';
  if (!state.indices.length) {
    els.range.textContent = state.query ? 'Nenhum registro filtrado' : '0 registros';
    return;
  }
  const total = activeStore()?.stats.count || 0;
  if (state.query) {
    els.range.textContent = `${fmtInt(state.indices.length)} de ${fmtInt(total)} registros (filtro ativo)`;
  } else {
    els.range.textContent = `${fmtInt(state.indices.length)} registro${state.indices.length === 1 ? '' : 's'}`;
  }
}

function scheduleRows() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    renderRows();
  });
}

function applySort() {
  if (isDbMode()) return; // A ordenação no modo banco é feita pelo servidor (ver loadDbPage).
  if (!state.sort.column) return;
  const store = activeStore();
  if (!store) return;
  const columnIndex = store.colIndex(state.sort.column);
  if (columnIndex < 0) return;
  const dir = state.sort.dir;
  const keys = new Array(store.stats.count);
  for (const index of state.indices) {
    const raw = String(store.rows[index]?.[columnIndex] ?? '').trim();
    if (/^-?\d{1,15}([.,]\d+)?$/.test(raw)) {
      keys[index] = { number: Number(raw.replace(',', '.')) };
    } else {
      keys[index] = { text: raw.toLowerCase() };
    }
  }
  state.indices.sort((a, b) => {
    const ka = keys[a];
    const kb = keys[b];
    let result;
    if (ka.number != null && kb.number != null) result = ka.number - kb.number;
    else if (ka.number != null) result = -1;
    else if (kb.number != null) result = 1;
    else result = ka.text < kb.text ? -1 : ka.text > kb.text ? 1 : 0;
    return result * dir;
  });
}

function setSort(column) {
  if (state.sort.column === column) state.sort.dir *= -1;
  else {
    state.sort.column = column;
    state.sort.dir = 1;
  }
  if (isDbMode()) {
    renderHeader();
    loadDbPage(0);
    els.sortInfo.textContent = state.sort.column
      ? `Ordenado por ${state.sort.column} ${state.sort.dir > 0 ? '↑' : '↓'}`
      : 'Sem ordenação';
    return;
  }
  applySort();
  renderHeader();
  renderRows();
  els.sortInfo.textContent = state.sort.column
    ? `Ordenado por ${state.sort.column} ${state.sort.dir > 0 ? '↑' : '↓'}`
    : 'Sem ordenação';
}

async function loadDbPage(page) {
  const store = activeStore();
  if (!store?.isDatabase) return;
  const { dbPage: dbPageQuery } = await import('../../data/database-client.js');
  state.dbLoading = true;
  state.dbPage = Math.max(0, page);
  showLoading(state.query ? 'Filtrando registros…' : 'Carregando página…');
  updateRange(0, 0);
  try {
    const result = await dbPageQuery({
      type: store.type,
      offset: state.dbPage * state.dbPageSize,
      limit: state.dbPageSize,
      search: state.query.trim(),
      sort: state.sort.column,
      dir: state.sort.dir,
    });
    state.dbTotal = result.total || 0;
    store.cachePackets(result.rows || []);
    state.indices = (result.rows || []).map((packet) => Number(packet.i));
    state.filtering = false;
    hideLoading();
    updateMeta();
    els.scroll.scrollTop = 0;
    if (!state.indices.length) showEmpty('no-results');
    else showTable();
  } catch (error) {
    hideLoading();
    toast.error('Falha ao consultar o banco', error.message);
  } finally {
    state.dbLoading = false;
    updateRange(0, state.indices.length);
  }
}

function showLoading(text) {
  if (!loadingElement) {
    loadingElement = document.createElement('div');
    loadingElement.className = 'table-loading';
    loadingElement.innerHTML = '<span><span class="search-spinner"></span><b></b></span>';
    els.wrap.appendChild(loadingElement);
  }
  loadingElement.hidden = false;
  loadingElement.querySelector('b').textContent = text;
}

function hideLoading() {
  if (loadingElement) loadingElement.hidden = true;
}

function showEmpty(kind = 'no-data') {
  els.table.hidden = true;
  els.empty.hidden = false;
  if (kind === 'no-results') {
    els.empty.innerHTML = `
      <div class="empty-orb">${icon('search')}</div>
      <h3>Nenhum registro encontrado</h3>
      <p>Não encontramos resultados para “${esc(state.query)}” nesta camada. Tente outro termo.</p>
      <button class="btn btn-ghost btn-sm" id="tableClearFilter" type="button">Limpar filtro</button>`;
  } else {
    els.empty.innerHTML = `
      <div class="empty-orb">${icon('database')}</div>
      <h3>Nenhum registro para exibir</h3>
      <p>Importe os arquivos CSV ou selecione outra camada para começar.</p>
      <button class="btn btn-primary btn-sm" data-import type="button">Importar CSVs</button>`;
  }
}

function showTable() {
  els.empty.hidden = true;
  els.table.hidden = false;
  els.body.style.height = `${state.indices.length * rowHeight()}px`;
  renderRows();
}

function updateMeta() {
  const store = activeStore();
  if (!store) {
    els.totalCount.textContent = '0';
    els.meta.textContent = 'Nenhum registro';
    els.range.textContent = '0 registros';
    els.sortInfo.textContent = 'Sem ordenação';
    return;
  }
  const total = store.isDatabase ? state.dbTotal || store.stats.count : store.stats.count;
  els.totalCount.textContent = fmtInt(total);
  els.meta.textContent = `${LAYER_META[store.type].name} · ${fmtInt(total)} registros · ${state.columns.length} colunas`;
  els.sortInfo.textContent = state.sort.column
    ? `Ordenado por ${state.sort.column} ${state.sort.dir > 0 ? '↑' : '↓'}`
    : 'Sem ordenação';
}

function resetView({ scroll = true } = {}) {
  const store = activeStore();
  if (scroll) {
    els.scroll.scrollTop = 0;
    els.scroll.scrollLeft = 0;
  }
  if (!store) {
    state.filterToken += 1;
    state.indices = [];
    state.columns = [];
    updateMeta();
    showEmpty();
    hideLoading();
    return false;
  }
  state.columns = columnsFor(store);
  renderHeader();
  if (store.isDatabase) {
    state.dbPage = 0;
    loadDbPage(0);
    return true;
  }
  if (!state.query) {
    state.indices = Array.from({ length: store.stats.count }, (_, index) => index);
    if (state.sort.column) applySort();
    updateMeta();
    showTable();
    hideLoading();
  } else {
    startFilter();
  }
  return true;
}

function startFilter() {
  const store = activeStore();
  if (!store) {
    resetView();
    return;
  }
  if (store.isDatabase) {
    loadDbPage(0);
    return;
  }
  const token = ++state.filterToken;
  const query = state.query.trim().toLowerCase();
  if (!query) {
    state.filtering = false;
    state.indices = Array.from({ length: store.stats.count }, (_, index) => index);
    if (state.sort.column) applySort();
    hideLoading();
    updateMeta();
    showTable();
    return;
  }

  state.filtering = true;
  hideLoading();
  showLoading('Filtrando registros…');
  const total = store.stats.count;
  const searchable = store.headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => !/^GEOMETRIA_WKT$/.test(header))
    .map(({ index }) => index);
  const result = [];
  let offset = 0;
  const chunk = 25000;

  const step = () => {
    if (token !== state.filterToken) return;
    const end = Math.min(total, offset + chunk);
    for (let index = offset; index < end; index++) {
      const row = store.rows[index];
      for (const columnIndex of searchable) {
        const value = row[columnIndex];
        if (value == null) continue;
        if (String(value).toLowerCase().includes(query)) {
          result.push(index);
          break;
        }
      }
    }
    offset = end;
    if (offset < total) {
      showLoading(`Filtrando registros… ${fmtInt(offset)} de ${fmtInt(total)}`);
      setTimeout(step, 0);
    } else {
      state.filtering = false;
      state.indices = result;
      if (state.sort.column) applySort();
      hideLoading();
      updateMeta();
      els.scroll.scrollTop = 0;
      if (!result.length) showEmpty('no-results');
      else showTable();
    }
  };
  setTimeout(step, 20);
}

const debouncedFilter = debounce(() => {
  if (!activeStore()) return;
  startFilter();
}, 300);

function refreshAll({ scroll = true, resetFilter = false } = {}) {
  if (!library.hasData()) {
    state.query = '';
    state.sort = { column: null, dir: 1 };
    if (els.search) els.search.value = '';
    if (els.clear) els.clear.hidden = true;
  }
  if (resetFilter) {
    state.query = '';
    els.search.value = '';
    els.clear.hidden = true;
  }
  layerTabs();
  const ok = resetView({ scroll });
  if (!ok) {
    els.totalCount.textContent = '0';
  }
}

function exportCsv() {
  const store = activeStore();
  if (!store || !state.indices.length) {
    toast.info('Nada para exportar', 'Não há registros visíveis para exportar nesta camada.');
    return;
  }
  if (store.isDatabase) {
    const suffix = state.query ? 'filtrado' : `pagina-${state.dbPage + 1}`;
    exportLayerCsv({
      type: store.type,
      indices: state.indices,
      columns: state.columns,
      defaultName: `neogrid_${store.type}_${suffix}_${new Date().toISOString().slice(0, 10)}.csv`,
    });
    toast.info(
      'Exportação da página atual',
      `No modo banco, o CSV contém os ${fmtInt(state.indices.length)} registros da página exibida. Use a exportação DXF por área para extrair regiões maiores.`,
      { duration: 7000 },
    );
    return;
  }
  const suffix = state.query ? 'filtrado' : 'completo';
  exportLayerCsv({
    type: store.type,
    indices: state.indices,
    columns: state.columns,
    defaultName: `neogrid_${store.type}_${suffix}_${new Date().toISOString().slice(0, 10)}.csv`,
  });
}

export function initDataTable(options = {}) {
  deps = options;
  els = {
    tabs: document.querySelector('#dataLayerTabs'),
    search: document.querySelector('#dataSearch'),
    clear: document.querySelector('#dataSearchClear'),
    totalCount: document.querySelector('#dataTotalCount'),
    columns: document.querySelector('#dataColumns'),
    export: document.querySelector('#dataExport'),
    meta: document.querySelector('#tableMeta'),
    wrap: document.querySelector('#dataTableWrap'),
    table: document.querySelector('#virtualTable'),
    scroll: document.querySelector('#vtScroll'),
    inner: document.querySelector('#vtInner'),
    head: document.querySelector('#vtHead'),
    body: document.querySelector('#vtBody'),
    empty: document.querySelector('#tableEmpty'),
    range: document.querySelector('#tableRange'),
    sortInfo: document.querySelector('#tableSortInfo'),
    pager: document.querySelector('#tablePager'),
    pageInfo: document.querySelector('#tablePageInfo'),
    prev: document.querySelector('#tablePrev'),
    next: document.querySelector('#tableNext'),
    modeLabel: document.querySelector('#tableModeLabel'),
  };
  if (!els.table) return { refresh: () => {}, onShow: () => {} };

  els.prev?.addEventListener('click', () => {
    if (!isDbMode() || state.dbLoading || state.dbPage <= 0) return;
    loadDbPage(state.dbPage - 1);
  });
  els.next?.addEventListener('click', () => {
    if (!isDbMode() || state.dbLoading) return;
    const pages = Math.ceil((state.dbTotal || 0) / state.dbPageSize);
    if (state.dbPage + 1 >= pages) return;
    loadDbPage(state.dbPage + 1);
  });

  els.tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-data-layer]');
    if (!button) return;
    const type = button.dataset.dataLayer;
    if (type === state.type) return;
    state.type = type;
    state.query = '';
    state.sort = { column: null, dir: 1 };
    els.search.value = '';
    els.clear.hidden = true;
    layerTabs();
    resetView({ scroll: true });
  });

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    els.clear.hidden = !state.query;
    debouncedFilter();
  });
  els.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      debouncedFilter.cancel();
      startFilter();
    }
  });
  els.clear.addEventListener('click', () => {
    els.search.value = '';
    state.query = '';
    els.clear.hidden = true;
    startFilter();
    els.search.focus();
  });

  els.head.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-column]');
    if (!cell) return;
    setSort(cell.dataset.column);
  });

  els.scroll.addEventListener('scroll', scheduleRows, { passive: true });
  window.addEventListener('resize', scheduleRows);

  els.body.addEventListener('click', (event) => {
    const row = event.target.closest('.vt-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (!Number.isInteger(index)) return;
    state.selected = { type: state.type, index };
    row.closest('.vt-body').querySelectorAll('.vt-row.is-selected').forEach((item) => item.classList.remove('is-selected'));
    row.classList.add('is-selected');
    openRowDialog(state.type, index);
  });

  els.wrap.addEventListener('click', (event) => {
    if (event.target.closest('#tableClearFilter')) {
      els.clear.click();
      return;
    }
    if (event.target.closest('[data-import]')) {
      document.querySelector('#topImport')?.click();
    }
  });

  els.columns.addEventListener('click', () => {
    if (!activeStore()) {
      toast.info('Nenhuma camada carregada', 'Importe os CSVs para configurar as colunas.');
      return;
    }
    openColumnsDialog(state.type);
  });

  els.export.addEventListener('click', exportCsv);
  document.querySelector('#exportCsvGo')?.addEventListener('click', () => {
    if (!library.hasData()) {
      toast.info('Nenhum dado para exportar', 'Importe os CSVs primeiro.');
      return;
    }
    deps.navigate?.('data');
    setTimeout(exportCsv, 200);
  });

  bus.on('data:changed', () => {
    if (!library.hasData()) state.sort = { column: null, dir: 1 };
    refreshAll({ scroll: true });
  });
  bus.on('settings:changed', ({ key }) => {
    if (key === 'tableColumns' || key === 'all') {
      if (!activeStore()) return;
      state.columns = columnsFor(activeStore());
      renderHeader();
      updateMeta();
      els.body.style.height = `${state.indices.length * rowHeight()}px`;
      renderRows();
    }
    if (key === 'density' || key === 'all') {
      els.body.style.height = `${state.indices.length * rowHeight()}px`;
      renderRows();
    }
  });

  refreshAll({ scroll: true });
  return {
    refresh: () => refreshAll({ scroll: false }),
    onShow: () => {
      if (!activeStore()) return;
      layerTabs();
      requestAnimationFrame(() => {
        els.body.style.height = `${state.indices.length * rowHeight()}px`;
        renderRows();
      });
    },
    exportCsv,
    getState: () => state,
  };
}
