import { $, openDialog } from '../core/dom.js';
import { esc } from '../core/format.js';
import { library } from '../data/library.js';
import { LAYER_TYPES, LAYER_META, hiddenHeader } from '../data/schema.js';
import { bus } from '../core/bus.js';
import {
  getFieldSelection,
  setFieldSelection,
  getTableColumns,
  setTableColumns,
} from '../core/settings.js';
import { toast } from './toast.js';

let fieldsState = { activeType: null };
let columnsState = { activeType: null };

const existingTypes = () => LAYER_TYPES.filter((type) => (library.get(type)?.stats.count || 0) > 0);

function ensureSearch(dialog, list, placeholder, onInput) {
  if (!dialog || !list) return null;
  let input = dialog.querySelector('.field-search-input');
  if (!input) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field-search';
    wrapper.style.marginBottom = '10px';
    wrapper.innerHTML = `<div class="data-search" style="width:100%"><svg class="icon"><use href="#i-search"></use></svg><input class="field-search-input" type="search" placeholder="${placeholder}" aria-label="${placeholder}"></div>`;
    list.parentElement.insertBefore(wrapper, list);
    input = wrapper.querySelector('input');
  }
  input.value = '';
  input.oninput = () => onInput(input.value.trim().toLowerCase());
  return input;
}

function renderFieldsTabs() {
  const types = existingTypes();
  const tabs = $('#fieldsTabs');
  if (!tabs) return;
  if (!types.length) {
    tabs.innerHTML = '';
    fieldsState.activeType = null;
    return;
  }
  if (!fieldsState.activeType || !types.includes(fieldsState.activeType)) fieldsState.activeType = types[0];
  tabs.innerHTML = types.map((type) => `<button type="button" class="field-tab ${type === fieldsState.activeType ? 'is-active' : ''}" data-field-tab="${type}">${LAYER_META[type].name}</button>`).join('');
}

function renderFieldsList(filter = '') {
  const list = $('#fieldsList');
  const info = $('#fieldsInfo');
  if (!list) return;
  const type = fieldsState.activeType;
  const store = type ? library.get(type) : null;
  if (!store) {
    list.innerHTML = '<div class="field-list-empty">Importe os CSVs para configurar os campos.</div>';
    if (info) info.textContent = 'Nenhum conjunto carregado.';
    return;
  }
  const selected = getFieldSelection(type) || store.effectiveFieldHeaders();
  const headers = store.headers.filter((header) => !hiddenHeader(header));
  const visible = headers.filter((header) => !filter || header.toLowerCase().includes(filter));
  list.innerHTML = visible.length
    ? visible.map((header) => `<label class="field-check" data-header="${esc(header).toLowerCase()}"><input type="checkbox" value="${esc(header)}" ${selected.includes(header) ? 'checked' : ''}>${esc(header)}</label>`).join('')
    : '<div class="field-list-empty">Nenhum campo corresponde ao filtro.</div>';
  const checked = headers.filter((header) => selected.includes(header)).length;
  if (info) info.textContent = `${checked} de ${headers.length} campos exibidos · salvo automaticamente`;
}

function renderColumnsList(filter = '') {
  const list = $('#columnsList');
  if (!list) return;
  const type = columnsState.activeType;
  const store = type ? library.get(type) : null;
  if (!store) {
    list.innerHTML = '<div class="field-list-empty">Importe os CSVs para configurar as colunas.</div>';
    return;
  }
  const selected = getTableColumns(type) || store.importantColumns();
  const headers = store.headers.filter((header) => !/_DESC$/.test(header) && !/^GEOMETRIA_WKT$/.test(header));
  const visible = headers.filter((header) => !filter || header.toLowerCase().includes(filter));
  list.innerHTML = visible.length
    ? visible.map((header) => `<label class="field-check" data-header="${esc(header).toLowerCase()}"><input type="checkbox" value="${esc(header)}" ${selected.includes(header) ? 'checked' : ''}>${esc(header)}</label>`).join('')
    : '<div class="field-list-empty">Nenhum campo corresponde ao filtro.</div>';
}

export function openFieldsDialog(type = null) {
  const types = existingTypes();
  if (!types.length) {
    toast.info('Nenhum campo disponível', 'Importe os CSVs primeiro para personalizar os detalhes.');
    return;
  }
  fieldsState.activeType = type && types.includes(type) ? type : types[0];
  renderFieldsTabs();
  renderFieldsList();
  ensureSearch($('#fieldsDialog'), $('#fieldsList'), 'Filtrar campos…', (filter) => renderFieldsList(filter));
  openDialog($('#fieldsDialog'));
}

export function openColumnsDialog(type = null) {
  const types = existingTypes();
  if (!types.length) {
    toast.info('Nenhuma coluna disponível', 'Importe os CSVs primeiro para configurar a tabela.');
    return;
  }
  columnsState.activeType = type && types.includes(type) ? type : types[0];
  renderColumnsList();
  ensureSearch($('#columnsDialog'), $('#columnsList'), 'Filtrar colunas…', (filter) => renderColumnsList(filter));
  openDialog($('#columnsDialog'));
}

function handleCheckboxChange(event, list, state, setter) {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  const checked = [...list.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  if (!checked.length) {
    checkbox.checked = true;
    toast.warning('Selecione ao menos um campo', 'É necessário manter pelo menos um campo visível.');
    return;
  }
  setter(state.activeType, checked);
  if (list === $('#fieldsList')) {
    const store = library.get(state.activeType);
    const total = store.headers.filter((header) => !hiddenHeader(header)).length;
    const info = $('#fieldsInfo');
    if (info) info.textContent = `${checked.length} de ${total} campos exibidos · salvo automaticamente`;
  }
}

export function initFieldDialogs() {
  $('#settingsFields')?.addEventListener('click', () => openFieldsDialog());

  $('#fieldsTabs')?.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-field-tab]');
    if (!tab) return;
    fieldsState.activeType = tab.dataset.fieldTab;
    renderFieldsTabs();
    renderFieldsList();
  });

  $('#fieldsList')?.addEventListener('change', (event) => {
    handleCheckboxChange(event, $('#fieldsList'), fieldsState, setFieldSelection);
  });

  $('#fieldsReset')?.addEventListener('click', () => {
    if (!fieldsState.activeType) return;
    setFieldSelection(fieldsState.activeType, null);
    renderFieldsList();
    toast.info('Campos restaurados', `A exibição de ${LAYER_META[fieldsState.activeType].name} voltou ao padrão.`, { duration: 2600 });
  });

  $('#columnsList')?.addEventListener('change', (event) => {
    handleCheckboxChange(event, $('#columnsList'), columnsState, setTableColumns);
  });

  $('#columnsReset')?.addEventListener('click', () => {
    if (!columnsState.activeType) return;
    setTableColumns(columnsState.activeType, null);
    renderColumnsList();
    toast.info('Colunas restauradas', 'A tabela voltou às colunas recomendadas.', { duration: 2600 });
  });

  // Atualiza os diálogos se os dados mudarem enquanto estão abertos.
  bus.on('data:changed', () => {
    if ($('#fieldsDialog')?.open) {
      renderFieldsTabs();
      renderFieldsList();
    }
    if ($('#columnsDialog')?.open) renderColumnsList();
  });
}
