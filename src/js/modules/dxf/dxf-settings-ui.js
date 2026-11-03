import { $, openDialog, closeDialog } from '../../core/dom.js';
import { esc, fmtInt, downloadText, safeFilename } from '../../core/format.js';
import { bus } from '../../core/bus.js';
import { library } from '../../data/library.js';
import { toast } from '../../ui/toast.js';
import {
  ACI_COLORS,
  BLOCK_ANCHORS,
  DEFAULT_DXF_SETTINGS,
  RULE_OPERATORS,
  blockRuleMatches,
  dxfBlockNames,
  getDxfLibraryText,
  loadDxfSettings,
  resetDxfSettings,
  ruleValue,
  saveDxfSettings,
  setDxfLibrary,
  typeKey,
} from './dxf-settings.js';

const KIND_TITLES = {
  poste: 'Postes',
  inst: 'Instalações',
};

const TYPE_LABELS = {
  DT: 'Duplo T',
  CIR: 'Circular',
  RET: 'Retangular',
  TA: 'Torre autoportante',
  'DUPLO T': 'Duplo T',
  CIRCULAR: 'Circular',
  RETANGULAR: 'Retangular',
};

function option(value, label, selected) {
  return `<option value="${esc(String(value))}"${selected ? ' selected' : ''}>${esc(String(label))}</option>`;
}

function colorOptions(selected) {
  return ACI_COLORS
    .map(([index, name]) => option(index, `${index} — ${name}`, Number(selected) === index))
    .join('');
}

function blockColorOptions(selected) {
  const keep = Number(selected) === 0;
  return option(0, '0 — Manter cores do bloco', keep)
    + ACI_COLORS
      .map(([index, name]) => option(index, `${index} — ${name}`, !keep && Number(selected) === index))
      .join('');
}

function blockOptions(names, selected) {
  const list = ['<option value="">Desenhar forma</option>'];
  for (const name of names) list.push(option(name, name, name === selected));
  if (selected && !names.includes(selected)) list.push(option(selected, selected, true));
  return list.join('');
}

function operatorOptions(selected) {
  return RULE_OPERATORS
    .map((operator) => option(operator.id, operator.label, operator.id === selected))
    .join('');
}

function operatorNeedsValue(operator) {
  return RULE_OPERATORS.find((item) => item.id === operator)?.needsValue !== false;
}

function uniqueId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeRules(value) {
  const normalize = (rule) => ({
    ...rule,
    id: rule?.id || uniqueId('rule'),
    enabled: rule?.enabled !== false,
    match: rule?.match === 'any' ? 'any' : 'all',
    conditions: Array.isArray(rule?.conditions) ? rule.conditions.map((condition) => ({ ...condition })) : [],
  });
  return {
    poste: Array.isArray(value?.poste) ? value.poste.map(normalize) : [],
    inst: Array.isArray(value?.inst) ? value.inst.map(normalize) : [],
  };
}

function newRule(kind) {
  return {
    id: uniqueId('rule'),
    name: kind === 'poste' ? 'Nova regra de poste' : 'Nova regra de instalação',
    enabled: true,
    match: 'all',
    block: '',
    conditions: [{ field: '', operator: 'contains', value: '' }],
  };
}

/** Portable payload with blocks, rules, colours, labels and the block library. */
export function buildSettingsPayload(settings) {
  const clean = settings || {};
  const libraryText = getDxfLibraryText(clean);
  return {
    app: 'NeoGrid',
    kind: 'dxf-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { ...clean, library: { name: clean.library?.name || '' } },
    library: { name: clean.library?.name || '', text: libraryText },
  };
}

export function initDxfSettings({ onSaved = () => {} } = {}) {
  const dialog = $('#dxfSettingsDialog');
  if (!dialog) return { open: () => {} };

  const form = $('#dxfSettingsForm');
  const fileInput = $('#dxfBlockFile');
  const status = $('#dxfBlockStatus');
  const blockPoste = $('#dxfBlockPoste');
  const blockInst = $('#dxfBlockInst');
  const rulesHost = $('#dxfBlockRules');
  let rulesDraft = { poste: [], inst: [] };
  let valueCache = new Map();
  let valueCacheRevision = -1;
  let namesCache = { text: '', names: [] };
  let ruleCountGeneration = 0;
  let ruleBlockNames = [];

  const libraryNames = (text) => {
    if (text !== namesCache.text) {
      namesCache = { text, names: text ? dxfBlockNames(text) : [] };
    }
    return namesCache.names;
  };

  const colorFields = [...dialog.querySelectorAll('[data-dxf-color]')];
  for (const field of colorFields) field.innerHTML = colorOptions(field.dataset.dxfColor);

  const blockColorFields = [...dialog.querySelectorAll('[data-dxf-block-color]')];
  for (const field of blockColorFields) field.innerHTML = blockColorOptions(field.dataset.dxfBlockColor);

  const anchorSelects = [...dialog.querySelectorAll('[data-dxf-anchor]')];
  for (const field of anchorSelects) {
    field.innerHTML = BLOCK_ANCHORS
      .map((anchor) => option(anchor.id, anchor.label, anchor.id === field.dataset.dxfAnchor))
      .join('');
  }

  const setStatus = (text) => {
    if (status) status.textContent = text;
  };

  const readNames = (settings) => {
    const text = getDxfLibraryText(settings);
    const names = [...libraryNames(text)];
    const mapped = [settings.blocks?.poste, settings.blocks?.inst];
    for (const kind of ['poste', 'inst']) {
      mapped.push(...Object.values(settings.typeBlocks?.[kind] || {}));
      for (const rule of settings.blockRules?.[kind] || []) mapped.push(rule.block);
    }
    for (const name of mapped.filter(Boolean)) if (!names.includes(name)) names.push(name);
    return names;
  };

  const typesFor = (kind, settings) => {
    const store = library.get(kind);
    const counts = new Map();
    if (store?.isDatabase) {
      // No modo banco, as distribuições já vêm agregadas nos metadados.
      const field = kind === 'poste' ? 'poleType' : 'installationType';
      for (const { name, count } of library.distribution(kind, field)) {
        const key = typeKey(name);
        if (key && key !== 'NÃO INFORMADO') counts.set(key, (counts.get(key) || 0) + count);
      }
    } else {
      const index = kind === 'poste' ? store?.poleTypeIndex : store?.installationTypeIndex;
      if (store && Number.isInteger(index) && index >= 0) {
        for (const row of store.rows) {
          const key = typeKey(row[index]);
          if (key) counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    }
    for (const key of Object.keys(settings.typeBlocks?.[kind] || {})) {
      if (!counts.has(key)) counts.set(key, 0);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'))
      .slice(0, 200);
  };

  const typeLabel = (key) => {
    const friendly = TYPE_LABELS[key];
    return friendly && friendly !== key ? `${key} — ${friendly}` : key;
  };

  const ruleFields = (kind) => {
    const preferred = kind === 'poste'
      ? ['TIPO', 'TIPO_PG', 'MATERIAL', 'NU_ALTURA', 'NU_ESFORCO', 'DE_BARRAMEN', 'NU_ANGULO', 'ASSINATURA']
      : ['TIPO', 'TIPO_INSTA', 'TIPO_SIGLA', 'DE_PLACA', 'NU_PG_ID', 'NU_ANGULO'];
    const fields = new Set(preferred);
    const store = library.get(kind);
    for (const header of store?.headers || []) {
      if (/^GEOMETRIA_WKT$|^SHP_/.test(header)) continue;
      fields.add(header);
    }
    return [...fields];
  };

  const valuesFor = (kind, field) => {
    if (valueCacheRevision !== library.revision) {
      valueCache = new Map();
      valueCacheRevision = library.revision;
    }
    const name = String(field || '').trim().toUpperCase();
    if (!name) return [];
    const cacheKey = `${kind}:${name}`;
    if (valueCache.has(cacheKey)) return valueCache.get(cacheKey);
    const store = library.get(kind);
    const values = new Set();
    if (store) {
      for (const row of store.rows) {
        const value = String(ruleValue(store, row, name) ?? '').trim();
        if (value) values.add(value);
        if (values.size >= 250) break;
      }
    }
    const result = [...values].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })).slice(0, 200);
    valueCache.set(cacheKey, result);
    return result;
  };

  const refreshConditionValues = (condition) => {
    if (!condition) return;
    const card = condition.closest('[data-rule-id]');
    const kind = card?.dataset.ruleKind || 'poste';
    const field = condition.querySelector('[data-cond-field]')?.value || '';
    const datalist = condition.querySelector('[data-cond-values]');
    if (!datalist) return;
    const store = library.get(kind);
    if (store?.isDatabase) {
      const name = String(field || '').trim().toUpperCase();
      if (!name || !store.headers.includes(name)) {
        datalist.innerHTML = '';
        return;
      }
      datalist.innerHTML = '<option value="carregando…"></option>';
      store.distinctValues(name, 200).then((values) => {
        if (!condition.isConnected) return;
        datalist.innerHTML = values
          .map((value) => `<option value="${esc(value)}"></option>`)
          .join('');
      }).catch(() => {
        if (condition.isConnected) datalist.innerHTML = '';
      });
      return;
    }
    datalist.innerHTML = valuesFor(kind, field)
      .map((value) => `<option value="${esc(value)}"></option>`)
      .join('');
  };

  const conditionHtml = (kind, rule, condition, index, fields) => {
    const conditionId = `${rule.id}_${index}`;
    const fieldsId = `fields_${conditionId}`;
    const valuesId = `values_${conditionId}`;
    const field = String(condition.field || '');
    const operator = condition.operator || 'contains';
    const needsValue = operatorNeedsValue(operator);
    return `<div class="dxf-rule-condition" data-condition-id="${esc(conditionId)}">
      <input class="input" data-cond-field list="${esc(fieldsId)}" value="${esc(field)}" placeholder="Campo (ex.: MATERIAL)" aria-label="Campo da condição">
      <datalist id="${esc(fieldsId)}">${fields.map((name) => `<option value="${esc(name)}"></option>`).join('')}</datalist>
      <select class="select" data-cond-op aria-label="Operador da condição">${operatorOptions(operator)}</select>
      <input class="input" data-cond-value list="${esc(valuesId)}" value="${esc(condition.value ?? '')}" placeholder="Valor (ex.: CONCRETO)" aria-label="Valor da condição"${needsValue ? '' : ' disabled'}>
      <datalist id="${esc(valuesId)}" data-cond-values></datalist>
      <button class="icon-btn" type="button" data-condition-remove title="Remover condição" aria-label="Remover condição">×</button>
    </div>`;
  };

  const ruleHtml = (kind, rule, index, total, names, fields) => {
    const conditions = (Array.isArray(rule.conditions) && rule.conditions.length
      ? rule.conditions
      : [{ field: '', operator: 'contains', value: '' }]);
    return `<article class="dxf-rule" data-rule-id="${esc(rule.id)}" data-rule-kind="${kind}">
      <header class="dxf-rule-head">
        <input class="input dxf-rule-name" data-rule-name value="${esc(rule.name || '')}" placeholder="Nome da regra" aria-label="Nome da regra">
        <label class="inline-switch dxf-rule-enabled">
          <input type="checkbox" data-rule-enabled${rule.enabled === false ? '' : ' checked'}>
          <span>Ativa</span>
        </label>
        <div class="dxf-rule-tools">
          <button class="icon-btn" type="button" data-rule-move="-1" title="Subir regra" aria-label="Subir regra"${index === 0 ? ' disabled' : ''}>↑</button>
          <button class="icon-btn" type="button" data-rule-move="1" title="Descer regra" aria-label="Descer regra"${index === total - 1 ? ' disabled' : ''}>↓</button>
          <button class="icon-btn danger" type="button" data-rule-remove title="Remover regra" aria-label="Remover regra">×</button>
        </div>
      </header>
      <div class="dxf-rule-body">
        <div class="dxf-rule-match">
          <span>Quando</span>
          <select class="select select-sm" data-rule-match aria-label="Combinação das condições">
            ${option('all', 'todas', rule.match !== 'any')}
            ${option('any', 'qualquer uma', rule.match === 'any')}
          </select>
          <span>das condições abaixo:</span>
        </div>
        <div class="dxf-rule-conditions">
          ${conditions.map((condition, conditionIndex) => conditionHtml(kind, rule, condition, conditionIndex, fields)).join('')}
          <button class="ghost-btn dxf-rule-add-condition" type="button" data-rule-add-condition>+ condição</button>
        </div>
      </div>
      <footer class="dxf-rule-foot">
        <label class="field dxf-rule-block">
          <span>Usar bloco</span>
          <select class="select" data-rule-block>${blockOptions(names, rule.block || '')}</select>
        </label>
        <span class="dxf-rule-count" data-rule-count>Calculando correspondências…</span>
      </footer>
    </article>`;
  };

  const renderRules = () => {
    if (!rulesHost) return;
    const names = ruleBlockNames;
    const groups = [];
    for (const kind of ['poste', 'inst']) {
      const list = rulesDraft[kind] || [];
      const fields = ruleFields(kind);
      groups.push(`<section class="dxf-rule-group" data-rule-group="${kind}">
        <div class="dxf-rule-group-head">
          <div><strong>${KIND_TITLES[kind]}</strong><small>${list.length ? `${list.length} regra${list.length === 1 ? '' : 's'}` : 'Nenhuma regra configurada'}</small></div>
          <button class="btn btn-ghost btn-sm" type="button" data-add-rule="${kind}">+ Nova regra</button>
        </div>
        ${list.length
          ? list.map((rule, index) => ruleHtml(kind, rule, index, list.length, names, fields)).join('')
          : '<div class="dxf-type-empty">Sem regras. Os tipos continuam usando o mapeamento rápido de blocos abaixo.</div>'}
      </section>`);
    }
    rulesHost.innerHTML = groups.join('');
    ruleCountGeneration += 1;
    for (const condition of rulesHost.querySelectorAll('[data-condition-id]')) refreshConditionValues(condition);
    setTimeout(updateRuleCounts, 0);
  };

  const captureRules = () => {
    const grouped = { poste: [], inst: [] };
    if (!rulesHost) return grouped;
    for (const card of rulesHost.querySelectorAll('[data-rule-id]')) {
      const kind = card.dataset.ruleKind;
      if (!grouped[kind]) continue;
      const conditions = [...card.querySelectorAll('[data-condition-id]')].map((condition) => ({
        field: condition.querySelector('[data-cond-field]')?.value?.trim().toUpperCase() || '',
        operator: condition.querySelector('[data-cond-op]')?.value || 'contains',
        value: condition.querySelector('[data-cond-value]')?.value ?? '',
      }));
      grouped[kind].push({
        id: card.dataset.ruleId,
        name: card.querySelector('[data-rule-name]')?.value?.trim() || '',
        enabled: Boolean(card.querySelector('[data-rule-enabled]')?.checked),
        match: card.querySelector('[data-rule-match]')?.value === 'any' ? 'any' : 'all',
        block: card.querySelector('[data-rule-block]')?.value || '',
        conditions,
      });
    }
    rulesDraft = grouped;
    return grouped;
  };

  const updateRuleCounts = () => {
    if (!rulesHost) return;
    const generation = ruleCountGeneration;
    for (const card of rulesHost.querySelectorAll('[data-rule-id]')) {
      const kind = card.dataset.ruleKind;
      const target = card.querySelector('[data-rule-count]');
      if (!target) continue;
      const store = library.get(kind);
      if (!store?.stats.count) {
        target.textContent = 'Importe os dados para testar a regra.';
        continue;
      }
      const rule = {
        id: card.dataset.ruleId,
        enabled: Boolean(card.querySelector('[data-rule-enabled]')?.checked),
        match: card.querySelector('[data-rule-match]')?.value === 'any' ? 'any' : 'all',
        block: card.querySelector('[data-rule-block]')?.value || '',
        conditions: [...card.querySelectorAll('[data-condition-id]')].map((condition) => ({
          field: condition.querySelector('[data-cond-field]')?.value?.trim().toUpperCase() || '',
          operator: condition.querySelector('[data-cond-op]')?.value || 'contains',
          value: condition.querySelector('[data-cond-value]')?.value ?? '',
        })),
      };
      if (!rule.block) {
        target.textContent = 'Escolha um bloco para ativar esta regra.';
        continue;
      }
      if (!rule.conditions.some((condition) => condition.field)) {
        target.textContent = 'Informe ao menos um campo.';
        continue;
      }
      if (store.isDatabase) {
        target.textContent = 'A regra será aplicada no mapa e no DXF (contagem indisponível no modo banco).';
        continue;
      }
      const token = String((Number(card.dataset.countToken) || 0) + 1);
      card.dataset.countToken = token;
      target.textContent = 'Contando correspondências…';
      let index = 0;
      let count = 0;
      const step = () => {
        if (generation !== ruleCountGeneration || card.dataset.countToken !== token) return;
        const end = Math.min(store.rows.length, index + 8000);
        for (; index < end; index++) {
          if (blockRuleMatches(rule, store, store.rows[index])) count += 1;
        }
        if (index < store.rows.length) {
          target.textContent = `Contando… ${fmtInt(count)} já correspondem`;
          setTimeout(step, 0);
          return;
        }
        target.textContent = `${fmtInt(count)} registro${count === 1 ? '' : 's'} usam este bloco`;
      };
      setTimeout(step, 0);
    }
  };

  if (rulesHost) {
    rulesHost.addEventListener('click', (event) => {
      const add = event.target.closest('[data-add-rule]');
      if (add) {
        captureRules();
        const kind = add.dataset.addRule;
        if (!rulesDraft[kind]) rulesDraft[kind] = [];
        rulesDraft[kind].push(newRule(kind));
        renderRules();
        return;
      }
      const card = event.target.closest('[data-rule-id]');
      if (!card) return;
      const kind = card.dataset.ruleKind;
      const ruleId = card.dataset.ruleId;
      const list = rulesDraft[kind] || [];
      const ruleIndex = list.findIndex((rule) => rule.id === ruleId);
      if (ruleIndex < 0) return;
      if (event.target.closest('[data-rule-remove]')) {
        captureRules();
        rulesDraft[kind].splice(ruleIndex, 1);
        renderRules();
        return;
      }
      const moveButton = event.target.closest('[data-rule-move]');
      if (moveButton) {
        captureRules();
        const direction = Number(moveButton.dataset.ruleMove) || 0;
        const target = ruleIndex + direction;
        if (target >= 0 && target < list.length) {
          [rulesDraft[kind][ruleIndex], rulesDraft[kind][target]] = [rulesDraft[kind][target], rulesDraft[kind][ruleIndex]];
          renderRules();
        }
        return;
      }
      if (event.target.closest('[data-rule-add-condition]')) {
        captureRules();
        const rule = rulesDraft[kind].find((item) => item.id === ruleId);
        rule?.conditions.push({ field: '', operator: 'contains', value: '' });
        renderRules();
        return;
      }
      if (event.target.closest('[data-condition-remove]')) {
        captureRules();
        const condition = event.target.closest('[data-condition-id]');
        const index = Number(condition?.dataset.conditionId?.split('_').pop());
        const rule = rulesDraft[kind].find((item) => item.id === ruleId);
        if (rule && Number.isInteger(index)) {
          rule.conditions.splice(index, 1);
          if (!rule.conditions.length) rule.conditions.push({ field: '', operator: 'contains', value: '' });
        }
        renderRules();
      }
    });

    rulesHost.addEventListener('change', (event) => {
      const operator = event.target.closest('[data-cond-op]');
      if (operator) {
        const condition = operator.closest('[data-condition-id]');
        const valueInput = condition?.querySelector('[data-cond-value]');
        if (valueInput) valueInput.disabled = !operatorNeedsValue(operator.value);
        return;
      }
      if (event.target.closest('[data-cond-field]')) {
        refreshConditionValues(event.target.closest('[data-condition-id]'));
        return;
      }
      if (event.target.closest('[data-rule-block], [data-rule-enabled], [data-rule-match]')) {
        setTimeout(updateRuleCounts, 0);
        return;
      }
      if (event.target.closest('[data-cond-value]')) {
        setTimeout(updateRuleCounts, 0);
      }
    });
  }

  const renderTypeBlocks = (settings, names) => {
    const container = $('#dxfTypeBlocks');
    if (!container) return;
    const groups = [];
    for (const [kind, title] of [['poste', 'Postes'], ['inst', 'Instalações']]) {
      const types = typesFor(kind, settings);
      if (!types.length) continue;
      groups.push(`<div class="dxf-type-title">${title}</div>`);
      for (const [key, count] of types) {
        const selected = settings.typeBlocks?.[kind]?.[key] || '';
        groups.push(
          `<div class="dxf-type-row" title="${esc(key)}">`
          + `<div><strong>${esc(typeLabel(key))}</strong><small>${count ? `${count} registro(s)` : 'mapeado'}</small></div>`
          + `<select class="select" data-type-kind="${kind}" data-type-key="${esc(key)}">${blockOptions(names, selected)}</select>`
          + '</div>',
        );
      }
    }
    container.innerHTML = groups.length
      ? groups.join('')
      : '<div class="dxf-type-empty">Importe os CSVs para listar os tipos de poste e de instalação.</div>';
  };

  const populate = (settings, { keepRules = false } = {}) => {
    if (!keepRules) rulesDraft = normalizeRules(settings.blockRules);
    const names = readNames(settings);
    ruleBlockNames = names;
    blockPoste.innerHTML = blockOptions(names, settings.blocks?.poste || '');
    blockInst.innerHTML = blockOptions(names, settings.blocks?.inst || '');
    $('#dxfShapePoste').value = settings.shapes?.poste || 'rectangle';
    $('#dxfShapeInst').value = settings.shapes?.inst || 'auto';
    for (const field of colorFields) field.value = String(settings.colors?.[field.dataset.dxfColor] ?? 7);
    for (const field of blockColorFields) {
      const value = Number(settings.blockColors?.[field.dataset.dxfBlockColor]);
      field.value = String(Number.isFinite(value) ? value : 7);
    }
    for (const field of anchorSelects) {
      field.value = settings.blockAnchor?.[field.dataset.dxfAnchor] || 'base';
    }
    const uniform = $('#dxfUniformBlockColors');
    if (uniform) uniform.checked = settings.uniformBlockColors !== false;
    $('#dxfLabelPoste').value = settings.labels?.poste || '';
    $('#dxfLabelInst').value = settings.labels?.inst || '';
    $('#dxfLabelBt').value = settings.labels?.bt || '';
    $('#dxfLabelMt').value = settings.labels?.mt || '';
    $('#dxfLabelRua').value = settings.labels?.rua || '';
    $('#dxfBlockSize').value = String(settings.blockSize || 20);
    renderRules();
    renderTypeBlocks(settings, names);
    const lib = settings.library || {};
    setStatus(names.length
      ? `${names.length} bloco(s) disponíveis${lib.name ? ` em ${lib.name}` : ''}.`
      : 'Nenhum DXF de blocos carregado — as formas abaixo serão desenhadas.');
  };

  const collect = () => {
    const settings = loadDxfSettings();
    settings.blocks = {
      poste: blockPoste.value,
      inst: blockInst.value,
    };
    settings.shapes = {
      poste: $('#dxfShapePoste').value,
      inst: $('#dxfShapeInst').value,
    };
    settings.colors = {
      ...DEFAULT_DXF_SETTINGS.colors,
      ...Object.fromEntries(colorFields.map((field) => [field.dataset.dxfColor, Number(field.value) || 7])),
    };
    settings.blockColors = {
      poste: 7,
      inst: 7,
      ...Object.fromEntries(blockColorFields.map((field) => [field.dataset.dxfBlockColor, Number(field.value) || 0])),
    };
    settings.blockAnchor = {
      poste: 'bottom',
      inst: 'base',
      ...Object.fromEntries(anchorSelects.map((field) => [field.dataset.dxfAnchor, field.value || 'base'])),
    };
    settings.uniformBlockColors = $('#dxfUniformBlockColors') ? Boolean($('#dxfUniformBlockColors').checked) : true;
    settings.labels = {
      poste: $('#dxfLabelPoste').value,
      inst: $('#dxfLabelInst').value,
      bt: $('#dxfLabelBt').value,
      mt: $('#dxfLabelMt').value,
      rua: $('#dxfLabelRua').value,
    };
    const typeBlocks = { poste: {}, inst: {} };
    for (const select of dialog.querySelectorAll('[data-type-kind]')) {
      const kind = select.dataset.typeKind;
      const key = select.dataset.typeKey;
      if (!typeBlocks[kind] || !key || !select.value) continue;
      typeBlocks[kind][key] = select.value;
    }
    settings.typeBlocks = typeBlocks;
    settings.blockRules = captureRules();
    settings.blockSize = Math.max(8, Math.min(120, Number($('#dxfBlockSize').value) || 20));
    return settings;
  };

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      setStatus(`Lendo ${file.name}...`);
      const text = await file.text();
      setDxfLibrary(text, file.name);
      const settings = loadDxfSettings();
      settings.library = { ...(settings.library || {}), name: file.name };
      if (rulesHost && rulesDraft) settings.blockRules = captureRules();
      saveDxfSettings(settings);
      const names = libraryNames(text);
      populate({ ...settings, library: { name: file.name } }, { keepRules: true });
      setStatus(names.length
        ? `${names.length} bloco(s) encontrados em ${file.name}. Escolha quais usar como poste, instalação e nas regras.`
        : `Nenhum bloco encontrado em ${file.name}.`);
      bus.emit('dxf:settings-changed');
    } catch (error) {
      setStatus(`Falha ao ler o DXF: ${error.message}`);
      toast.error('Falha ao ler o DXF', error.message);
    } finally {
      fileInput.value = '';
    }
  });

  const open = () => {
    populate(loadDxfSettings());
    openDialog(dialog);
  };

  document.querySelectorAll('[data-dxf-settings-open]').forEach((button) => {
    button.addEventListener('click', open);
  });

  $('#dxfSettingsSave')?.addEventListener('click', () => {
    saveDxfSettings(collect());
    closeDialog(dialog);
    toast.success('Desenho salvo', 'Regras de blocos, cores e rótulos serão usados no mapa e na exportação DXF.');
    bus.emit('dxf:settings-changed');
    onSaved();
  });

  $('#dxfSettingsExport')?.addEventListener('click', () => {
    const payload = buildSettingsPayload(collect());
    const date = new Date().toISOString().slice(0, 10);
    const filename = safeFilename(`neogrid_blocos_${date}.json`);
    const content = JSON.stringify(payload);
    if (window.desktop?.saveFile) {
      window.desktop.saveFile({
        defaultName: filename,
        title: 'Exportar configuração de blocos',
        content,
        filters: [{ name: 'Configuração NeoGrid', extensions: ['json'] }],
      }).then((saved) => {
        if (saved?.saved) toast.success('Configuração exportada', `Blocos, regras, cores e rótulos salvos em ${saved.path || filename}. Envie o arquivo para quem for usar.`);
        else if (saved?.error) toast.error('Falha ao salvar', saved.error);
      });
    } else {
      downloadText(content, filename, 'application/json;charset=utf-8');
      toast.success('Configuração exportada', 'Blocos, regras, cores e rótulos salvos. Envie o arquivo para quem for usar.');
    }
  });

  const importInput = $('#dxfSettingsImportFile');
  $('#dxfSettingsImport')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || (payload.kind !== 'dxf-settings' && !payload.settings)) {
        throw new Error('O arquivo não é uma configuração de blocos do NeoGrid.');
      }
      const incoming = payload.settings || {};
      const library = payload.library || {};
      if (typeof library.text === 'string' && library.text) {
        setDxfLibrary(library.text, library.name || file.name);
        incoming.library = { ...(incoming.library || {}), name: library.name || file.name };
      }
      const saved = saveDxfSettings({ ...loadDxfSettings(), ...incoming });
      populate(saved);
      toast.success('Configuração importada', `Blocos e regras de ${file.name} aplicados ao mapa e ao DXF.`);
      bus.emit('dxf:settings-changed');
    } catch (error) {
      toast.error('Falha ao importar', error.message);
    }
  });

  $('#dxfSettingsReset')?.addEventListener('click', () => {
    const settings = resetDxfSettings();
    rulesDraft = normalizeRules(settings.blockRules);
    populate(settings);
    toast.info('Desenho restaurado', 'Os padrões de blocos, regras, cores e rótulos foram restaurados.');
    bus.emit('dxf:settings-changed');
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    $('#dxfSettingsSave')?.click();
  });

  return { open };
}
