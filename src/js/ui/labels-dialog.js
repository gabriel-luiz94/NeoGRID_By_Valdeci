import { $, closeDialog, icon, openDialog } from '../core/dom.js';
import { esc } from '../core/format.js';
import { settings, updateSetting } from '../core/settings.js';
import { bus } from '../core/bus.js';
import { library } from '../data/library.js';
import { installationInfo } from '../data/labels.js';
import {
  DEFAULT_DXF_SETTINGS,
  RULE_OPERATORS,
  RULE_SCOPES,
  SUBSTITUTION_ACTIONS,
  loadDxfSettings,
  renderLabel,
  saveDxfSettings,
  templateContext,
} from '../modules/dxf/dxf-settings.js';
import { toast } from './toast.js';

const LABEL_TYPES = ['poste', 'inst', 'bt', 'mt'];

const TYPE_META = {
  poste: { title: 'Postes', hint: 'Identificação, material e barramento.', color: '--layer-poste' },
  inst: { title: 'Instalações', hint: 'Tipo, placa e poste vinculado.', color: '--layer-inst' },
  bt: { title: 'Rede BT', hint: 'Condutores, comprimento e dados do trecho.', color: '--layer-bt' },
  mt: { title: 'Rede MT', hint: 'Condutores, comprimento, tensão e dados do trecho.', color: '--layer-mt' },
};

const COMPUTED_FIELDS = {
  poste: [
    { key: 'ASSINATURA', label: 'Assinatura do poste', detail: 'tipo + altura/esforço' },
  ],
  inst: [],
  bt: [
    { key: 'CONDUTORES', label: 'Condutores', detail: 'fases + neutro' },
    { key: 'COMPRIMENTO', label: 'Comprimento', detail: 'em metros' },
  ],
  mt: [
    { key: 'CONDUTORES', label: 'Condutores', detail: 'fases + neutro' },
    { key: 'COMPRIMENTO', label: 'Comprimento', detail: 'em metros' },
  ],
};

const FALLBACK_HEADERS = {
  poste: ['NU_PG_ID', 'TIPO_PG', 'MATERIAL', 'NU_ALTURA', 'NU_ESFORCO', 'DE_BARRAMEN', 'NU_ANGULO', 'NU_INSTALA'],
  inst: ['NU_INSTALA', 'TIPO_INSTA', 'DE_PLACA', 'NU_PG_ID', 'NU_ANGULO', 'TIPO_SIGLA'],
  bt: ['NU_TRECHO', 'NU_PG_INI', 'NU_PG_FIN', 'CONDUTOR_A', 'CONDUTOR_B', 'CONDUTOR_C', 'CONDUTOR_N', 'NU_COMPRIMENTO_REAL', 'CD_FASE', 'NU_INSTALA'],
  mt: ['NU_TRECHO', 'NU_PG_INI', 'NU_PG_FIN', 'CONDUTOR_A', 'CONDUTOR_B', 'CONDUTOR_C', 'CONDUTOR_N', 'NU_COMPRIMENTO_REAL', 'CD_FASE', 'NU_TENSAO', 'NU_INSTALA'],
};

const FIELD_LABELS = {
  NU_PG_ID: 'ID do poste',
  TIPO_PG: 'Tipo do poste',
  TIPO: 'Tipo',
  MATERIAL: 'Material',
  NU_ALTURA: 'Altura',
  NU_ESFORCO: 'Esforço',
  DE_BARRAMEN: 'Barramento',
  NU_ANGULO: 'Ângulo',
  NU_INSTALA: 'Instalação',
  TIPO_INSTA: 'Tipo da instalação',
  TIPO_SIGLA: 'Sigla da instalação',
  DE_PLACA: 'Placa',
  NU_TRECHO: 'Nº do trecho',
  NU_PG_INI: 'Poste inicial',
  NU_PG_FIN: 'Poste final',
  CONDUTOR_A: 'Condutor A',
  CONDUTOR_B: 'Condutor B',
  CONDUTOR_C: 'Condutor C',
  CONDUTOR_N: 'Neutro',
  NU_COMPRIMENTO_REAL: 'Comprimento real',
  SHP_LENGTH: 'Comprimento (shape)',
  CD_FASE: 'Fase',
  NU_TENSAO: 'Tensão',
  CD_TENSAO: 'Tensão',
  CD_INDD_MATERIAL_PG_DESC: 'Material (descrição)',
  CD_TIPO_PG_DESC: 'Tipo do poste (descrição)',
  NU_TIPO_INSTALACAO_MT_ID_DESC: 'Tipo da instalação MT',
};

const PREFERRED = {
  poste: ['TIPO_PG', 'MATERIAL', 'NU_ALTURA', 'NU_ESFORCO', 'DE_BARRAMEN', 'NU_ANGULO', 'NU_PG_ID', 'NU_INSTALA'],
  inst: ['TIPO_INSTA', 'TIPO_SIGLA', 'DE_PLACA', 'NU_PG_ID', 'NU_INSTALA', 'NU_ANGULO'],
  bt: ['NU_TRECHO', 'CONDUTOR_A', 'CONDUTOR_B', 'CONDUTOR_C', 'CONDUTOR_N', 'NU_COMPRIMENTO_REAL', 'CD_FASE', 'NU_PG_INI', 'NU_PG_FIN', 'NU_INSTALA'],
  mt: ['NU_TRECHO', 'CONDUTOR_A', 'CONDUTOR_B', 'CONDUTOR_C', 'CONDUTOR_N', 'NU_COMPRIMENTO_REAL', 'CD_FASE', 'NU_TENSAO', 'CD_TENSAO', 'NU_PG_INI', 'NU_PG_FIN', 'NU_INSTALA'],
};

let dialog = null;
let els = {};
let draft = null;
let previewTimer = 0;
let fieldCache = new Map();

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

function fieldLabel(key) {
  return FIELD_LABELS[key] || key
    .replace(/^(NU|CD|DE|DT|SHP)_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (char) => char.toUpperCase());
}

function availableFields(type) {
  if (fieldCache.has(type) && fieldCache.get(type).revision === library.revision) {
    return fieldCache.get(type).items;
  }
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!item.key || seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };
  for (const item of COMPUTED_FIELDS[type] || []) push({ ...item, computed: true });
  const store = library.get(type);
  const headers = store?.headers?.length ? store.headers : FALLBACK_HEADERS[type] || [];
  const preferred = PREFERRED[type] || [];
  const ordered = [
    ...preferred.filter((header) => headers.includes(header)),
    ...headers.filter((header) => !preferred.includes(header)),
  ];
  for (const header of ordered) {
    if (/^GEOMETRIA_WKT$|^SHP_|^GEO_[XY]$/.test(header)) continue;
    push({ key: header, label: fieldLabel(header), detail: 'coluna do CSV', computed: false });
  }
  fieldCache.set(type, { revision: library.revision, items });
  return items;
}

function fieldFor(type, key) {
  return availableFields(type).find((item) => item.key === key) || {
    key,
    label: fieldLabel(key),
    detail: 'campo personalizado',
    computed: false,
  };
}

function parseTemplate(template) {
  const lines = String(template ?? '')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const fields = [];
  const free = [];
  for (const line of lines) {
    const match = line.match(/^\{([A-Za-z0-9_]+)\}(?:\s*m)?$/i);
    if (match) {
      const key = match[1].toUpperCase();
      if (!fields.includes(key)) fields.push(key);
    } else {
      free.push(line);
    }
  }
  return { fields, free: free.join('\n') };
}

function buildTemplate(state) {
  const lines = (state?.fields || []).map((key) => (
    key === 'COMPRIMENTO' ? '{COMPRIMENTO} m' : `{${key}}`
  ));
  const free = String(state?.free || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return [...lines, ...free].join('\n');
}

function defaultLabelState(type) {
  return parseTemplate(DEFAULT_DXF_SETTINGS.labels?.[type] || '');
}

function stateSettings() {
  return {
    ...(draft?.settings || loadDxfSettings()),
    substitutions: { rules: draft?.substitutions || [] },
  };
}

function previewLines(type, store, index) {
  const template = buildTemplate(draft.labels[type]);
  const context = templateContext(store, store.rows[index], type, stateSettings());
  if (type === 'inst') {
    const info = installationInfo(store, index);
    context.TIPO_INSTA = context.TIPO_INSTA || info.name;
    context.DE_PLACA = context.DE_PLACA || info.plate;
  }
  const lines = renderLabel(template, context, { settings: stateSettings(), type });
  if (!lines.length) return '<span class="labels-preview-empty">O rótulo está vazio com os campos atuais.</span>';
  return `<div class="label-preview-lines">${lines.map((line) => `<span class="label-preview-line">${esc(line)}</span>`).join('')}</div>`;
}

function previewFor(type) {
  const store = library.get(type);
  if (!store?.stats?.count) {
    return '<span class="labels-preview-empty">Importe dados para visualizar um exemplo.</span>';
  }
  if (store.isDatabase) {
    return '<span class="labels-preview-empty">Buscando exemplo no banco…</span>';
  }
  let index = 0;
  for (let i = 0; i < store.stats.count; i++) {
    if (Number.isFinite(store.X[i]) && Number.isFinite(store.Y[i])) {
      index = i;
      break;
    }
  }
  return previewLines(type, store, index);
}

async function refreshDbPreview(type) {
  const store = library.get(type);
  const pane = dialog?.querySelector(`[data-label-pane="${type}"] [data-label-preview]`);
  if (!store?.isDatabase || !pane) return;
  try {
    const sample = await store.sampleRow();
    if (!pane.isConnected) return;
    pane.innerHTML = sample ? previewLines(type, store, sample.index) : '<span class="labels-preview-empty">Nenhum registro localizado.</span>';
  } catch {
    if (pane.isConnected) pane.innerHTML = '<span class="labels-preview-empty">Não foi possível buscar o exemplo.</span>';
  }
}

function renderTypePane(type) {
  if (!draft) return;
  draft.rendered?.add(type);
  const pane = dialog.querySelector(`[data-label-pane="${type}"]`);
  if (!pane) return;
  const state = draft.labels[type];
  const selected = pane.querySelector('[data-label-selected]');
  const fieldsHost = pane.querySelector('[data-label-fields]');
  const free = pane.querySelector('[data-label-free]');
  const preview = pane.querySelector('[data-label-preview]');
  const count = pane.querySelector('[data-label-count]');
  const search = pane.querySelector('[data-label-search]');

  if (selected) {
    selected.innerHTML = state.fields.length
      ? state.fields.map((key) => {
        const item = fieldFor(type, key);
        return `<button type="button" class="label-chip" data-label-remove="${esc(key)}" title="Remover ${esc(item.label)}">
          <span>${esc(item.label)}</span>
          <span class="label-chip-x">${icon('x')}</span>
        </button>`;
      }).join('')
      : '<span class="labels-empty-selected">Nenhum campo selecionado. Clique nos campos abaixo para montar o rótulo.</span>';
  }
  if (free && free.value !== state.free) free.value = state.free;
  if (count) count.textContent = `${state.fields.length} campo${state.fields.length === 1 ? '' : 's'}`;
  if (search) search.value = draft.search?.[type] || '';
  renderPalette(type);
  if (preview) {
    preview.innerHTML = previewFor(type);
    if (library.get(type)?.isDatabase) refreshDbPreview(type);
  }
}

function renderPalette(type) {
  const pane = dialog.querySelector(`[data-label-pane="${type}"]`);
  const host = pane?.querySelector('[data-label-fields]');
  if (!host) return;
  const state = draft.labels[type];
  const selected = new Set(state.fields);
  const term = String(draft.search?.[type] || '').trim().toLowerCase();
  const matches = availableFields(type).filter((item) => {
    if (!term) return true;
    return `${item.label} ${item.key} ${item.detail || ''}`.toLowerCase().includes(term);
  });
  if (!matches.length) {
    host.innerHTML = '<span class="labels-preview-empty">Nenhum campo corresponde à busca.</span>';
    return;
  }
  const scrollTop = host.scrollTop;
  const computed = matches.filter((item) => item.computed);
  const columns = matches.filter((item) => !item.computed);
  const group = (title, items) => (items.length
    ? `<div class="label-field-group-title">${title}</div>${items.map((item) => `
        <button type="button" class="label-field-option ${selected.has(item.key) ? 'is-selected' : ''}" data-label-field="${esc(item.key)}">
          <span class="label-field-mark">${selected.has(item.key) ? icon('check') : icon('plus')}</span>
          <span class="label-field-copy"><strong>${esc(item.label)}</strong><small>${esc(item.key)}${item.detail ? ` · ${esc(item.detail)}` : ''}</small></span>
        </button>`).join('')}`
    : '');
  host.innerHTML = group('Campos calculados', computed) + group('Campos do CSV', columns);
  host.scrollTop = scrollTop;
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    for (const type of LABEL_TYPES) {
      const preview = dialog.querySelector(`[data-label-pane="${type}"] [data-label-preview]`);
      if (preview) preview.innerHTML = previewFor(type);
    }
  }, 110);
}

function renderTabs() {
  els.tabs.innerHTML = [
    ...LABEL_TYPES.map((type) => `<button type="button" data-label-tab="${type}">${TYPE_META[type].title}</button>`),
    '<button type="button" data-label-tab="rules">Substituições</button>',
  ].join('');
}

function renderPaneShells() {
  els.panes.innerHTML = [
    ...LABEL_TYPES.map((type) => `<section class="labels-pane" data-label-pane="${type}" hidden>
      <div class="labels-pane-head">
        <div>
          <h3>${TYPE_META[type].title}</h3>
          <p>${TYPE_META[type].hint}</p>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" data-label-reset="${type}">Restaurar padrão</button>
      </div>
      <div class="labels-subtitle"><span>Campos exibidos</span><small data-label-count></small></div>
      <div class="labels-selected" data-label-selected></div>
      <div class="labels-fieldbar">
        <div class="labels-search">
          ${icon('search')}
          <input type="search" data-label-search placeholder="Buscar campo nesta camada…" autocomplete="off">
        </div>
      </div>
      <div class="labels-fields" data-label-fields></div>
      <label class="field labels-free">
        <span>Linhas livres (opcional)</span>
        <textarea class="input" data-label-free rows="2" placeholder="Ex.: Vão 04 — rede protegida"></textarea>
      </label>
      <div class="labels-preview">
        <span class="labels-preview-title">Prévia com um registro da base</span>
        <div class="labels-preview-card" data-label-preview></div>
      </div>
    </section>`),
    `<section class="labels-pane" data-label-pane="rules" hidden>
      <div class="labels-pane-head">
        <div>
          <h3>Substituições de anotação</h3>
          <p>Troque um valor ou trecho do rótulo por outro. Ex.: em Rede MT, um trecho cujo nome contém "LIG" pode ser exibido como "Ligação".</p>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" id="labelsAddSubstitution">+ Nova substituição</button>
      </div>
      <div class="substitution-rules" id="substitutionRules"></div>
      <p class="field-hint">As regras valem para o mapa e para o DXF. A primeira regra que combinar é aplicada.</p>
    </section>`,
  ].join('');
}

function scopeOptions(selected) {
  return RULE_SCOPES
    .map((scope) => `<option value="${scope.id}"${scope.id === selected ? ' selected' : ''}>${scope.label}</option>`)
    .join('');
}

function operatorOptions(selected) {
  return RULE_OPERATORS
    .map((operator) => `<option value="${operator.id}"${operator.id === selected ? ' selected' : ''}>${operator.label}</option>`)
    .join('');
}

function actionOptions(selected) {
  return SUBSTITUTION_ACTIONS
    .map((action) => `<option value="${action.id}"${action.id === selected ? ' selected' : ''}>${action.label}</option>`)
    .join('');
}

function substitutionFieldOptions(selected) {
  const groups = [];
  const generic = [
    { key: '__label__', label: 'Texto final do rótulo' },
    { key: '*', label: 'Qualquer campo do registro' },
  ];
  groups.push(`<optgroup label="Geral">${generic.map((item) => `<option value="${esc(item.key)}"${item.key === selected ? ' selected' : ''}>${esc(item.label)}</option>`).join('')}</optgroup>`);
  for (const type of LABEL_TYPES) {
    const items = availableFields(type);
    if (!items.length) continue;
    groups.push(`<optgroup label="${TYPE_META[type].title}">${items.map((item) => `<option value="${esc(item.key)}"${item.key === selected ? ' selected' : ''}>${esc(item.label)} (${esc(item.key)})</option>`).join('')}</optgroup>`);
  }
  if (selected && !groups.join('').includes(`value="${esc(selected)}"`)) {
    groups.unshift(`<optgroup label="Regra atual"><option value="${esc(selected)}" selected>${esc(selected)}</option></optgroup>`);
  }
  return groups.join('');
}

function substitutionHtml(rule, index) {
  const field = rule.field || '__label__';
  return `<article class="substitution-rule" data-subst-id="${esc(rule.id)}">
    <header class="substitution-head">
      <input class="input" data-subst-name value="${esc(rule.name || '')}" placeholder="Nome da substituição" aria-label="Nome da substituição">
      <label class="inline-switch"><input type="checkbox" data-subst-enabled${rule.enabled === false ? '' : ' checked'}><span>Ativa</span></label>
      <button class="icon-btn danger" type="button" data-subst-remove title="Remover substituição" aria-label="Remover substituição">×</button>
    </header>
    <div class="substitution-grid">
      <label class="field"><span>Onde</span><select class="select" data-subst-scope>${scopeOptions(rule.scope || 'all')}</select></label>
      <label class="field"><span>Campo ou texto</span><select class="select" data-subst-field>${substitutionFieldOptions(field)}</select></label>
      <label class="field"><span>Condição</span><select class="select" data-subst-operator>${operatorOptions(rule.operator || 'contains')}</select></label>
      <label class="field"><span>Padrão</span><input class="input" data-subst-pattern value="${esc(rule.pattern ?? '')}" placeholder="Ex.: LIG"></label>
      <label class="field"><span>Vira</span><input class="input" data-subst-replacement value="${esc(rule.replacement ?? '')}" placeholder="Ex.: Ligação"></label>
      <label class="field"><span>Ação</span><select class="select" data-subst-action>${actionOptions(rule.action || 'value')}</select></label>
    </div>
    <span class="substitution-order">Regra ${index + 1}</span>
  </article>`;
}

function renderSubstitutions() {
  const host = dialog.querySelector('#substitutionRules');
  if (!host) return;
  host.innerHTML = draft.substitutions.length
    ? draft.substitutions.map((rule, index) => substitutionHtml(rule, index)).join('')
    : '<div class="labels-empty-selected">Nenhuma substituição configurada. O rótulo mostra os valores originais da base.</div>';
}

function captureSubstitutions() {
  const host = dialog.querySelector('#substitutionRules');
  if (!host) return draft.substitutions;
  draft.substitutions = [...host.querySelectorAll('[data-subst-id]')].map((card) => ({
    id: card.dataset.substId,
    name: card.querySelector('[data-subst-name]')?.value?.trim() || '',
    enabled: Boolean(card.querySelector('[data-subst-enabled]')?.checked),
    scope: card.querySelector('[data-subst-scope]')?.value || 'all',
    field: card.querySelector('[data-subst-field]')?.value || '',
    operator: card.querySelector('[data-subst-operator]')?.value || 'contains',
    pattern: card.querySelector('[data-subst-pattern]')?.value ?? '',
    replacement: card.querySelector('[data-subst-replacement]')?.value ?? '',
    action: card.querySelector('[data-subst-action]')?.value || 'value',
  }));
  return draft.substitutions;
}

function newSubstitution() {
  return {
    id: uniqueId('subst'),
    name: 'Nova substituição',
    enabled: true,
    scope: 'all',
    field: '__label__',
    operator: 'contains',
    pattern: '',
    replacement: '',
    action: 'text',
  };
}

function uniqueId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function setActiveTab(tab) {
  draft.tab = tab;
  if (LABEL_TYPES.includes(tab) && !draft.rendered?.has(tab)) {
    renderTypePane(tab);
    draft.rendered?.add(tab);
  }
  dialog.querySelectorAll('[data-label-tab]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.labelTab === tab);
  });
  dialog.querySelectorAll('[data-label-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.labelPane !== tab;
  });
}

function resetType(type) {
  draft.labels[type] = defaultLabelState(type);
  renderTypePane(type);
}

function validateSubstitutions(rules) {
  for (const rule of rules) {
    if (rule.operator !== 'regex' || !rule.pattern) continue;
    try {
      new RegExp(rule.pattern, 'i');
    } catch (error) {
      return `A expressão regular de "${rule.name || 'uma substituição'}" é inválida: ${error.message}`;
    }
  }
  return '';
}

function refreshAllPreviews() {
  schedulePreview();
}

function bindEvents() {
  els.enabled?.addEventListener('change', () => {
    // Applied on save together with the label fields.
  });

  dialog.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-label-tab]');
    if (tab) {
      setActiveTab(tab.dataset.labelTab);
      return;
    }
    const pane = event.target.closest('[data-label-pane]');
    if (!pane) return;
    const type = pane.dataset.labelPane;
    if (!type || type === 'rules') {
      if (event.target.closest('#labelsAddSubstitution')) {
        captureSubstitutions();
        draft.substitutions.push(newSubstitution());
        renderSubstitutions();
      }
      const remove = event.target.closest('[data-subst-remove]');
      if (remove) {
        captureSubstitutions();
        const id = remove.closest('[data-subst-id]')?.dataset.substId;
        draft.substitutions = draft.substitutions.filter((rule) => rule.id !== id);
        renderSubstitutions();
      }
      return;
    }
    const remove = event.target.closest('[data-label-remove]');
    if (remove) {
      draft.labels[type].fields = draft.labels[type].fields.filter((key) => key !== remove.dataset.labelRemove);
      renderTypePane(type);
      return;
    }
    const reset = event.target.closest('[data-label-reset]');
    if (reset) {
      resetType(type);
      return;
    }
    const field = event.target.closest('[data-label-field]');
    if (field) {
      const key = field.dataset.labelField;
      const list = draft.labels[type].fields;
      const index = list.indexOf(key);
      if (index >= 0) list.splice(index, 1);
      else list.push(key);
      renderTypePane(type);
    }
  });

  dialog.addEventListener('input', (event) => {
    const pane = event.target.closest('[data-label-pane]');
    const type = pane?.dataset.labelPane;
    if (!type) return;
    if (type === 'rules') {
      captureSubstitutions();
      refreshAllPreviews();
      return;
    }
    if (event.target.matches('[data-label-search]')) {
      draft.search[type] = event.target.value;
      renderPalette(type);
      return;
    }
    if (event.target.matches('[data-label-free]')) {
      draft.labels[type].free = event.target.value;
      schedulePreview();
    }
  });

  dialog.addEventListener('change', (event) => {
    if (!event.target.closest('[data-label-pane="rules"]')) return;
    captureSubstitutions();
    refreshAllPreviews();
  });

  els.save?.addEventListener('click', save);
  els.reset?.addEventListener('click', () => {
    for (const type of LABEL_TYPES) draft.labels[type] = defaultLabelState(type);
    for (const type of LABEL_TYPES) renderTypePane(type);
    toast.info('Rótulos restaurados', 'Os campos padrão foram recolocados. Clique em Salvar para aplicar.');
  });
}

function save() {
  captureSubstitutions();
  const error = validateSubstitutions(draft.substitutions);
  if (error) {
    toast.error('Substituição inválida', error);
    return;
  }
  const base = loadDxfSettings();
  base.labels = {
    ...(base.labels || {}),
    poste: buildTemplate(draft.labels.poste),
    inst: buildTemplate(draft.labels.inst),
    bt: buildTemplate(draft.labels.bt),
    mt: buildTemplate(draft.labels.mt),
  };
  base.substitutions = { rules: draft.substitutions };
  saveDxfSettings(base);
  updateSetting('labels', Boolean(els.enabled?.checked));
  updateSetting('labelZoom', Number(els.zoom?.value) || 19);
  bus.emit('dxf:settings-changed');
  closeDialog(dialog);
  toast.success('Rótulos atualizados', 'Os campos escolhidos aparecem no mapa e na exportação DXF.');
}

function open() {
  if (!dialog) return;
  const current = loadDxfSettings();
  draft = {
    settings: current,
    labels: Object.fromEntries(LABEL_TYPES.map((type) => [type, parseTemplate(current.labels?.[type])])),
    substitutions: clone(current.substitutions?.rules || []),
    search: {},
    tab: 'poste',
    rendered: new Set(),
  };
  els.enabled.checked = settings.labels !== false;
  els.zoom.value = String(settings.labelZoom || 19);
  renderTabs();
  renderPaneShells();
  renderSubstitutions();
  setActiveTab(draft.tab);
  openDialog(dialog);
}

export function initLabelsDialog() {
  dialog = $('#labelsDialog');
  if (!dialog) return { open: () => {} };
  els = {
    tabs: $('#labelTabs'),
    panes: $('#labelPanes'),
    enabled: $('#labelsEnabled'),
    zoom: $('#labelsZoom'),
    save: $('#labelsSave'),
    reset: $('#labelsReset'),
  };
  bindEvents();
  document.querySelectorAll('[data-labels-open]').forEach((button) => {
    button.addEventListener('click', open);
  });
  bus.on('labels:open', open);
  return { open };
}
