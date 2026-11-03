import { poleLabelLines, networkConductorText, networkLength } from '../../data/labels.js';
import { parseNumber, stripAccents } from '../../core/format.js';

export const DXF_SETTINGS_KEY = 'neogrid.dxfSettings.v1';
const MAX_LIBRARY_BYTES = 2 * 1024 * 1024;
const MAX_BLOCK_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_LABEL_LINES = 40;

/** ACI colours offered in the settings dialog (index, Portuguese name). */
export const ACI_COLORS = [
  [1, 'Vermelho'],
  [2, 'Amarelo'],
  [3, 'Verde'],
  [4, 'Ciano'],
  [5, 'Azul'],
  [6, 'Magenta'],
  [7, 'Branco/preto'],
  [8, 'Cinza escuro'],
  [9, 'Cinza claro'],
  [30, 'Laranja'],
  [250, 'Cinza 250'],
  [251, 'Cinza 251'],
  [252, 'Cinza 252'],
  [253, 'Cinza 253'],
  [254, 'Cinza 254'],
  [255, 'Cinza 255'],
];

export const ACI_HEX = {
  1: '#ff5c5c',
  2: '#fbbf24',
  3: '#2dd4bf',
  4: '#22d3ee',
  5: '#60a5fa',
  6: '#f472b6',
  7: '#e2e8f0',
  8: '#94a3b8',
  9: '#cbd5e1',
  30: '#fb923c',
  250: '#475569',
  251: '#64748b',
  252: '#94a3b8',
  253: '#cbd5e1',
  254: '#e2e8f0',
  255: '#f8fafc',
};

export function aciHex(index, fallback = '#e2e8f0') {
  return ACI_HEX[Number(index)] || fallback;
}

/** Operators shared by block rules and label substitutions. */
export const RULE_OPERATORS = Object.freeze([
  { id: 'contains', label: 'contém', needsValue: true },
  { id: 'notContains', label: 'não contém', needsValue: true },
  { id: 'equals', label: 'é igual a', needsValue: true },
  { id: 'notEquals', label: 'é diferente de', needsValue: true },
  { id: 'startsWith', label: 'começa com', needsValue: true },
  { id: 'endsWith', label: 'termina com', needsValue: true },
  { id: 'in', label: 'está entre (separar com ;)', needsValue: true },
  { id: 'empty', label: 'está vazio', needsValue: false },
  { id: 'notEmpty', label: 'não está vazio', needsValue: false },
  { id: 'gt', label: 'é maior que', needsValue: true },
  { id: 'gte', label: 'é maior ou igual a', needsValue: true },
  { id: 'lt', label: 'é menor que', needsValue: true },
  { id: 'lte', label: 'é menor ou igual a', needsValue: true },
  { id: 'regex', label: 'corresponde à expressão', needsValue: true },
]);

export const RULE_OPERATOR_MAP = Object.freeze(
  Object.fromEntries(RULE_OPERATORS.map((operator) => [operator.id, operator])),
);

export const RULE_SCOPES = Object.freeze([
  { id: 'all', label: 'Todas as camadas' },
  { id: 'poste', label: 'Postes' },
  { id: 'inst', label: 'Instalações' },
  { id: 'bt', label: 'Rede BT' },
  { id: 'mt', label: 'Rede MT' },
]);

export const SUBSTITUTION_ACTIONS = Object.freeze([
  { id: 'value', label: 'Substituir todo o valor' },
  { id: 'text', label: 'Substituir apenas o trecho' },
]);

/**
 * Where a block is placed relative to its geometry. The CSV coordinate is the pole tip, so
 * `bottom` puts the centre of the block's lower edge on the coordinate (the CAD default used by
 * the field crews). `base` keeps the base point stored in the block library.
 */
export const BLOCK_ANCHORS = Object.freeze([
  { id: 'bottom', label: 'Ponta inferior (centro da base)' },
  { id: 'center', label: 'Centro do bloco' },
  { id: 'top', label: 'Centro do topo' },
  { id: 'left', label: 'Centro da esquerda' },
  { id: 'right', label: 'Centro da direita' },
  { id: 'base', label: 'Ponto base do próprio bloco' },
]);

export const DEFAULT_DXF_SETTINGS = Object.freeze({
  colors: {
    poste: 2,
    inst: 7,
    bt: 3,
    mt: 1,
    txtPoste: 2,
    txtInst: 7,
    txtBt: 3,
    txtMt: 1,
    arruamento: 9,
    txtRuas: 9,
    kmlPoint: 6,
    kmlLine: 5,
    kmlArea: 4,
    kmlText: 6,
  },
  /** Colour of the INSERT entities. 0 keeps the colours stored inside the block. */
  blockColors: {
    poste: 7,
    inst: 7,
  },
  /** Anchor of each block. `bottom` makes the pole tip land on the CSV coordinate. */
  blockAnchor: {
    poste: 'bottom',
    inst: 'base',
  },
  /** Rewrite explicit colours inside the block to BYBLOCK so `blockColors` is respected. */
  uniformBlockColors: true,
  shapes: {
    poste: 'rectangle',
    inst: 'auto',
  },
  blocks: {
    poste: '',
    inst: '',
  },
  typeBlocks: {
    poste: {},
    inst: {},
  },
  /** Ordered rules: the first matching rule wins. See `blockFor`. */
  blockRules: {
    poste: [],
    inst: [],
  },
  /** Text substitutions applied to label values and to the final label text. */
  substitutions: {
    rules: [],
  },
  blockSize: 20,
  labels: {
    poste: '{ASSINATURA}\n{DE_BARRAMEN}\n{MATERIAL}',
    inst: '{TIPO_INSTA}\n{DE_PLACA}',
    bt: '{CONDUTORES}\n{COMPRIMENTO} m',
    mt: '{CONDUTORES}\n{COMPRIMENTO} m',
    rua: '{NOME}',
  },
  library: {
    name: '',
    text: '',
  },
});

let runtimeLibraryText = '';
let settingsVersion = 0;

export function dxfSettingsVersion() {
  return settingsVersion;
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function merge(base, patch) {
  const out = cloneValue(base);
  if (!isObject(out)) return patch === undefined ? out : cloneValue(patch);
  if (!isObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(out[key]) && isObject(value) ? merge(out[key], value) : cloneValue(value);
  }
  return out;
}

export function loadDxfSettings() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(DXF_SETTINGS_KEY) || 'null');
  } catch {
    stored = null;
  }
  const settings = merge(DEFAULT_DXF_SETTINGS, stored || {});
  if (!runtimeLibraryText && settings.library?.text) runtimeLibraryText = settings.library.text;
  return settings;
}

export function saveDxfSettings(settings) {
  const clean = merge(DEFAULT_DXF_SETTINGS, settings || {});
  if (runtimeLibraryText && runtimeLibraryText.length <= MAX_LIBRARY_BYTES) {
    clean.library = { name: clean.library?.name || '', text: runtimeLibraryText };
  } else {
    clean.library = { name: clean.library?.name || '', text: '' };
  }
  try {
    localStorage.setItem(DXF_SETTINGS_KEY, JSON.stringify(clean));
  } catch {
    // A large DXF library can exceed the storage quota; keep it in memory for this session.
  }
  settingsVersion += 1;
  return clean;
}

export function resetDxfSettings() {
  runtimeLibraryText = '';
  settingsVersion += 1;
  try {
    localStorage.removeItem(DXF_SETTINGS_KEY);
  } catch {
    // Storage may be unavailable (tests, private mode).
  }
  return merge(DEFAULT_DXF_SETTINGS, {});
}

export function setDxfLibrary(text, name = '') {
  runtimeLibraryText = typeof text === 'string' ? text : '';
  settingsVersion += 1;
  return { name, bytes: runtimeLibraryText.length };
}

export function getDxfLibraryText(settings = loadDxfSettings()) {
  return runtimeLibraryText || settings.library?.text || '';
}

/** A CSV type cell as a stable mapping key (`DUPLO T`, `CHAVE FUSÍVEL RELIGADORA`...). */
export function typeKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

const normalizeMatch = (value) => stripAccents(String(value ?? '')).trim().toUpperCase();

/** The value used by a rule condition, including computed label tokens. */
export function ruleValue(store, row, field) {
  const name = String(field || '').trim().toUpperCase();
  if (!store || !row || !name) return '';
  if (name === 'TIPO') {
    return typeKey(store.type === 'poste'
      ? store.col(row, 'TIPO_PG') || store.col(row, 'CD_TIPO_PG_DESC')
      : store.col(row, 'TIPO_INSTA') || store.col(row, 'TIPO_SIGLA'));
  }
  if (name === 'ASSINATURA' && store.type === 'poste') return poleLabelLines(store, row)[0] || '';
  if (name === 'CONDUTORES') return networkConductorText(store, row);
  if (name === 'COMPRIMENTO') {
    const length = networkLength(store, row);
    return length ? String(length) : '';
  }
  return store.col(row, name);
}

/** True when `actual` satisfies `operator` for the expected value. */
export function matchRuleValue(actual, operator, expected) {
  const text = String(actual ?? '').trim();
  const normalized = normalizeMatch(text);
  const target = normalizeMatch(expected);
  switch (operator) {
    case 'equals':
      return normalized === target;
    case 'notEquals':
      return normalized !== target;
    case 'contains':
      return Boolean(target) && normalized.includes(target);
    case 'notContains':
      return Boolean(target) && !normalized.includes(target);
    case 'startsWith':
      return Boolean(target) && normalized.startsWith(target);
    case 'endsWith':
      return Boolean(target) && normalized.endsWith(target);
    case 'in': {
      const values = String(expected ?? '')
        .split(/[;,]/)
        .map(normalizeMatch)
        .filter(Boolean);
      return values.includes(normalized);
    }
    case 'empty':
      return !text || normalized === 'NULO';
    case 'notEmpty':
      return Boolean(text) && normalized !== 'NULO';
    case 'gt':
      return parseNumber(text) > parseNumber(expected);
    case 'gte':
      return parseNumber(text) >= parseNumber(expected);
    case 'lt':
      return parseNumber(text) < parseNumber(expected);
    case 'lte':
      return parseNumber(text) <= parseNumber(expected);
    case 'regex':
      try {
        return new RegExp(String(expected ?? ''), 'i').test(text);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** A block rule is active when it has a block and all/any conditions match. */
export function blockRuleMatches(rule, store, row) {
  if (!rule || rule.enabled === false || !String(rule.block || '').trim()) return false;
  const conditions = (Array.isArray(rule.conditions) ? rule.conditions : [])
    .filter((condition) => condition && String(condition.field || '').trim());
  if (!conditions.length) return false;
  const results = conditions.map((condition) => matchRuleValue(
    ruleValue(store, row, condition.field),
    condition.operator || 'contains',
    condition.value,
  ));
  return rule.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

/** The first enabled rule that matches the row, or null. */
export function matchBlockRule(settings, store, row, kind) {
  const rules = settings?.blockRules?.[kind];
  if (!Array.isArray(rules) || !rules.length) return null;
  for (const rule of rules) {
    if (blockRuleMatches(rule, store, row)) return rule;
  }
  return null;
}

/** The block configured for a row: attribute rules, then type mapping, then the category default. */
export function blockFor(settings, store, row, kind) {
  const rule = matchBlockRule(settings, store, row, kind);
  if (rule?.block) return String(rule.block).trim();
  const index = kind === 'poste' ? store?.poleTypeIndex : store?.installationTypeIndex;
  const key = Number.isInteger(index) && index >= 0 && row ? typeKey(row[index]) : '';
  const mapped = key ? settings.typeBlocks?.[kind]?.[key] : '';
  return String(mapped || settings.blocks?.[kind] || '').trim();
}

/** ACI colour used by the INSERT of a block. 0 means "keep the colours inside the block". */
export function blockColorIndex(settings, kind, fallback = 7) {
  const value = Number(settings?.blockColors?.[kind]);
  if (Number.isFinite(value) && value >= 0 && value <= 255) return value;
  return fallback;
}

/** The point of the block (local coordinates) that should land on the CSV coordinate. */
export function blockAnchorPoint(block, anchorId = 'base') {
  const base = [block?.base?.[0] || 0, block?.base?.[1] || 0];
  const bounds = block?.bounds;
  if (!bounds) return base;
  switch (String(anchorId || 'base')) {
    case 'bottom':
      return [bounds.cx, bounds.minY];
    case 'top':
      return [bounds.cx, bounds.maxY];
    case 'center':
      return [bounds.cx, bounds.cy];
    case 'left':
      return [bounds.minX, bounds.cy];
    case 'right':
      return [bounds.maxX, bounds.cy];
    default:
      return base;
  }
}

/** Insertion point (same space as `target`) that puts the chosen anchor on the target. */
export function blockInsertionPoint(block, anchorId, target, rotationDegrees = 0) {
  const [ax, ay] = blockAnchorPoint(block, anchorId);
  const bx = block?.base?.[0] || 0;
  const by = block?.base?.[1] || 0;
  const dx = ax - bx;
  const dy = ay - by;
  if (!dx && !dy) return [target[0], target[1]];
  const theta = (Number(rotationDegrees) || 0) * Math.PI / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [
    target[0] - (dx * cos - dy * sin),
    target[1] - (dx * sin + dy * cos),
  ];
}

/* ---------- LABEL SUBSTITUTIONS ---------- */

const escapeRegExp = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function substitutionMatches(rule, text) {
  return matchRuleValue(text, rule.operator || 'contains', rule.pattern);
}

function applySubstitutionRule(text, rule) {
  const source = String(text ?? '');
  if (!rule || rule.enabled === false || !substitutionMatches(rule, source)) return source;
  const replacement = String(rule.replacement ?? '');
  if ((rule.action || 'value') === 'value') return replacement;
  if (rule.operator === 'regex') {
    try {
      return source.replace(new RegExp(String(rule.pattern ?? ''), 'gi'), replacement);
    } catch {
      return source;
    }
  }
  if (!String(rule.pattern ?? '')) return replacement;
  try {
    return source.replace(new RegExp(escapeRegExp(rule.pattern), 'gi'), () => replacement);
  } catch {
    return replacement;
  }
}

function rulesFor(settings, type) {
  const rules = settings?.substitutions?.rules;
  if (!Array.isArray(rules) || !rules.length) return [];
  return rules.filter((rule) => rule
    && rule.enabled !== false
    && String(rule.field || '').trim()
    && (rule.scope === 'all' || !rule.scope || rule.scope === type));
}

/** Apply value-level substitutions to a label context (mutates and returns it). */
export function applySubstitutions(context, type, settings) {
  const rules = rulesFor(settings, type).filter((rule) => rule.field !== '__label__');
  if (!rules.length) return context;
  for (const rule of rules) {
    const field = String(rule.field || '').toUpperCase();
    if (field === '*') {
      for (const key of Object.keys(context)) {
        context[key] = applySubstitutionRule(context[key], rule);
      }
      continue;
    }
    const key = Object.keys(context).find((name) => name.toUpperCase() === field);
    if (key) context[key] = applySubstitutionRule(context[key], rule);
  }
  return context;
}

function applyLabelTextSubstitutions(lines, type, settings) {
  const rules = rulesFor(settings, type).filter((rule) => rule.field === '__label__');
  if (!rules.length) return lines;
  return lines.map((line) => rules.reduce((text, rule) => applySubstitutionRule(text, rule), line));
}


/* ---------- DXF BLOCKS ---------- */

function dxfPairs(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}

function blockName(value) {
  return String(value || '').trim().replace(/[\r\n]/g, '').slice(0, 255);
}

function toNumber(value) {
  const n = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function shapeBounds(shapes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const shape of shapes) {
    if (shape.type === 'line') {
      add(shape.a[0], shape.a[1]);
      add(shape.b[0], shape.b[1]);
    } else if (shape.type === 'circle' || shape.type === 'arc') {
      add(shape.c[0] - shape.r, shape.c[1] - shape.r);
      add(shape.c[0] + shape.r, shape.c[1] + shape.r);
    } else if (shape.points) {
      for (const p of shape.points) add(p[0], p[1]);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 && height <= 0) return null;
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** Bounds of a block including the nested blocks it inserts. */
function resolveBounds(block, map, seen = new Set()) {
  if (block.resolvedBounds !== undefined) return block.resolvedBounds;
  const own = shapeBounds(block.shapes.filter((shape) => shape.type !== 'insert'));
  let minX = own?.minX ?? Infinity;
  let minY = own?.minY ?? Infinity;
  let maxX = own?.maxX ?? -Infinity;
  let maxY = own?.maxY ?? -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  if (seen.has(block.name.toUpperCase())) {
    block.resolvedBounds = own;
    return own;
  }
  const next = new Set(seen);
  next.add(block.name.toUpperCase());
  for (const shape of block.shapes) {
    if (shape.type !== 'insert') continue;
    const nested = map.get(shape.name.toUpperCase());
    if (!nested) continue;
    const bounds = resolveBounds(nested, map, next);
    if (!bounds) continue;
    const cos = Math.cos(shape.rotation);
    const sin = Math.sin(shape.rotation);
    for (const [x, y] of [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY]]) {
      add(shape.p[0] + (x * cos - y * sin) * shape.sx, shape.p[1] + (x * sin + y * cos) * shape.sy);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    block.resolvedBounds = null;
    return null;
  }
  const result = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  block.resolvedBounds = result;
  return result;
}

/** The drawable primitives of a block (LINE, CIRCLE, ARC, ellipses and polylines). */
function blockShapes(pairs, start, end) {
  const shapes = [];
  let currentPolyline = null;
  let i = start;
  while (i < end) {
    const [code, value] = pairs[i];
    if (code !== 0) {
      i += 1;
      continue;
    }
    const kind = value.trim().toUpperCase();
    let j = i + 1;
    const groups = [];
    while (j < end && pairs[j][0] !== 0) {
      groups.push(pairs[j]);
      j += 1;
    }
    const get = (wanted) => groups.find(([c]) => c === wanted)?.[1];
    const point = (xc = 10, yc = 20) => [toNumber(get(xc)), toNumber(get(yc))];
    if (kind === 'LINE') {
      shapes.push({ type: 'line', a: point(10, 20), b: point(11, 21) });
    } else if (kind === 'CIRCLE') {
      const r = Math.abs(toNumber(get(40)));
      if (r > 1e-9) shapes.push({ type: 'circle', c: point(), r });
    } else if (kind === 'ARC') {
      const r = Math.abs(toNumber(get(40)));
      if (r > 1e-9) {
        shapes.push({
          type: 'arc',
          c: point(),
          r,
          start: toNumber(get(50)) * Math.PI / 180,
          end: toNumber(get(51)) * Math.PI / 180,
        });
      }
    } else if (kind === 'LWPOLYLINE') {
      const points = [];
      let x = null;
      for (const [c, v] of groups) {
        if (c === 10) {
          if (x != null) points.push([x, 0]);
          x = toNumber(v);
        } else if (c === 20 && x != null) {
          points.push([x, toNumber(v)]);
          x = null;
        }
      }
      if (x != null) points.push([x, 0]);
      if (points.length >= 2) shapes.push({ type: 'polyline', points, closed: (toNumber(get(70)) & 1) === 1 });
    } else if (kind === 'POLYLINE') {
      currentPolyline = { type: 'polyline', points: [], closed: (toNumber(get(70)) & 1) === 1 };
      shapes.push(currentPolyline);
    } else if (kind === 'VERTEX' && currentPolyline) {
      currentPolyline.points.push(point());
    } else if (kind === 'SEQEND') {
      currentPolyline = null;
    } else if (kind === 'ELLIPSE') {
      const c = point();
      const major = point(11, 21);
      const ratio = Math.max(0.001, Math.min(1, Math.abs(toNumber(get(40))) || 1));
      const startAngle = toNumber(get(41));
      const endAngle = toNumber(get(42)) || Math.PI * 2;
      const a = Math.hypot(major[0], major[1]) || 1;
      const b = a * ratio;
      const rotation = Math.atan2(major[1], major[0]);
      const points = [];
      const sweep = Math.abs(endAngle - startAngle) > 1e-9 ? endAngle - startAngle : Math.PI * 2;
      const steps = 32;
      for (let k = 0; k <= steps; k++) {
        const t = startAngle + (sweep * k) / steps;
        const x = Math.cos(t) * a;
        const y = Math.sin(t) * b;
        points.push([c[0] + x * Math.cos(rotation) - y * Math.sin(rotation), c[1] + x * Math.sin(rotation) + y * Math.cos(rotation)]);
      }
      shapes.push({ type: 'polyline', points, closed: sweep >= Math.PI * 2 - 1e-9 });
    } else if (kind === 'SOLID' || kind === 'TRACE') {
      const points = [point(10, 20), point(11, 21), point(12, 22), point(13, 23)];
      shapes.push({ type: 'polygon', points, closed: true });
    } else if (kind === 'INSERT') {
      const name = blockName(get(2));
      if (name) {
        shapes.push({
          type: 'insert',
          name,
          p: point(),
          rotation: toNumber(get(50)) * Math.PI / 180,
          sx: toNumber(get(41)) || 1,
          sy: toNumber(get(42)) || 1,
        });
      }
    }
    i = j;
  }
  return shapes;
}

/** Read the BLOCKS section of a DXF and return its block definitions. */
export function parseDxfBlocks(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 40 * 1024 * 1024) return [];
  const pairs = dxfPairs(text);
  let start = -1;
  for (let i = 0; i + 2 < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'SECTION'
        && pairs[i + 1][0] === 2 && pairs[i + 1][1].trim().toUpperCase() === 'BLOCKS') {
      start = i + 2;
      break;
    }
  }
  if (start < 0) return [];

  const blocks = [];
  const seen = new Set();
  let i = start;
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code === 0 && value.trim().toUpperCase() === 'ENDSEC') break;
    if (code !== 0 || value.trim().toUpperCase() !== 'BLOCK') {
      i += 1;
      continue;
    }
    const blockStart = i;
    let name = '';
    const base = [0, 0, 0];
    i += 1;
    // The BLOCK record holds the base point (10/20/30). Stop at the first entity: otherwise
    // coordinates from LINE/POINT/INSERT would overwrite the base and the map would anchor the
    // symbol on the wrong point (the CAD file keeps the real base).
    while (i < pairs.length && pairs[i][0] !== 0) {
      const [c, v] = pairs[i];
      if (c === 2 && !name) name = blockName(v);
      else if (c === 10) base[0] = Number(v) || 0;
      else if (c === 20) base[1] = Number(v) || 0;
      else if (c === 30) base[2] = Number(v) || 0;
      i += 1;
    }
    let end = -1;
    while (i < pairs.length) {
      const [c, v] = pairs[i];
      if (c === 0 && v.trim().toUpperCase() === 'ENDBLK') {
        end = i;
        break;
      }
      i += 1;
    }
    if (end < 0) break;
    i = end + 1;
    if (!name || name.startsWith('*') || seen.has(name.toUpperCase())) continue;
    seen.add(name.toUpperCase());
    const definition = pairs
      .slice(blockStart, end + 1)
      .map(([c, v]) => `${c}\n${v}`)
      .join('\n') + '\n';
    if (definition.length > MAX_BLOCK_TEXT_BYTES) continue;
    const shapes = blockShapes(pairs, blockStart + 1, end);
    blocks.push({ name, base, definition, shapes, start: blockStart, end });
  }
  const byName = new Map(blocks.map((block) => [block.name.toUpperCase(), block]));
  for (const block of blocks) block.bounds = resolveBounds(block, byName);
  return blocks;
}

export function dxfBlockNames(text) {
  return parseDxfBlocks(text).map((block) => block.name);
}

/** The raw BLOCK/ENDBLK records for `names`, ready to paste into a BLOCKS section. */
export function extractBlockDefinitions(text, names = [], options = {}) {
  const wanted = new Set((names || []).map((name) => String(name || '').trim().toUpperCase()).filter(Boolean));
  if (!wanted.size) return '';
  const byBlock = options.byBlock === true;
  const blocks = parseDxfBlocks(text);
  const byName = new Map(blocks.map((block) => [block.name.toUpperCase(), block]));
  const out = [];
  const seen = new Set();
  // The generated file already has its own handles: drop the original owner/handle groups so
  // copied blocks can't collide with them. R12 readers assign handles when they are absent.
  // Text and attributes inside the block would duplicate the labels configured from the CSV, so
  // they are left out: the map and the DXF label them the same way.
  const COLORED = new Set([
    'LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'ELLIPSE', 'SOLID', 'TRACE',
    '3DFACE', 'POINT', 'INSERT', 'DIMENSION', 'LEADER', 'MLINE', 'RAY', 'XLINE',
  ]);
  const clean = (definition) => {
    const pairs = dxfPairs(definition);
    const skip = new Set(['TEXT', 'MTEXT', 'ATTDEF', 'ATTRIB', 'HATCH', 'WIPEOUT', 'SPLINE']);
    const out = [];
    let i = 0;
    let entity = '';
    while (i < pairs.length) {
      const [code, value] = pairs[i];
      if (code === 0) {
        const kind = value.trim().toUpperCase();
        if (skip.has(kind)) {
          i += 1;
          while (i < pairs.length && pairs[i][0] !== 0) i += 1;
          continue;
        }
        out.push(`${code}\n${value}`);
        entity = kind;
        // BYBLOCK makes every internal primitive inherit the INSERT colour. That is what lets
        // the black/white (ACI 7) CAD standard override the colours saved in the block library.
        if (byBlock && COLORED.has(kind)) out.push(`${62}\n0`);
        i += 1;
        continue;
      }
      if (byBlock && code === 62 && COLORED.has(entity)) {
        i += 1;
        continue;
      }
      if (code !== 5 && code !== 330 && code !== 360) out.push(`${code}\n${value}`);
      i += 1;
    }
    return out.join('\n') + '\n';
  };
  const visit = (name) => {
    const key = String(name || '').toUpperCase();
    if (!key || seen.has(key)) return;
    const block = byName.get(key);
    if (!block) return;
    seen.add(key);
    out.push(clean(block.definition));
    for (const shape of block.shapes) {
      if (shape.type === 'insert') visit(shape.name);
    }
  };
  for (const name of wanted) visit(name);
  return out.join('');
}

/* ---------- LABELS ---------- */

function fmtNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

/** Values a label template can use: every CSV column plus the computed tokens. */
export function templateContext(store, row, type = '', settings = null) {
  const ctx = {};
  if (!store || !row) return ctx;
  for (const [index, header] of (store.headers || []).entries()) {
    ctx[String(header).toUpperCase()] = row[index] ?? '';
  }
  if (type === 'poste') {
    ctx.ASSINATURA = poleLabelLines(store, row)[0] || '';
  } else if (type === 'bt' || type === 'mt') {
    ctx.CONDUTORES = networkConductorText(store, row);
    ctx.COMPRIMENTO = fmtNumber(networkLength(store, row));
  } else if (type === 'inst') {
    ctx.TIPO_INSTA = ctx.TIPO_INSTA || ctx.TIPO_SIGLA || ctx.NU_TIPO_INSTALACAO_MT_ID_DESC || '';
  }
  if (settings) applySubstitutions(ctx, type, settings);
  return ctx;
}

/** Replace `{COLUMN}` tokens; `\n` (typed or literal) starts a new line. */
export function renderLabel(template, context = {}, options = {}) {
  const source = String(template ?? '').replace(/\\n/g, '\n');
  if (!source.trim()) return [];
  const values = Object.fromEntries(
    Object.entries(context || {}).map(([key, value]) => [String(key).toUpperCase(), value == null ? '' : String(value)]),
  );
  let lines = source
    .split('\n')
    .map((line) => line.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => values[key.toUpperCase()] ?? '').trim())
    .filter(Boolean);
  if (options.settings) lines = applyLabelTextSubstitutions(lines, options.type || '', options.settings).filter(Boolean);
  return lines.slice(0, MAX_LABEL_LINES);
}
