import { bus } from './bus.js';
import { cssVar } from './format.js';

export const SETTINGS_KEY = 'neogrid.settings.v2';

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',
  accent: 'orange',
  density: 'comfortable',
  basemap: 'satellite',
  scale: 1000,
  labels: true,
  labelZoom: 19,
  scalebar: true,
  north: true,
  maxElements: 12000,
  maxLabels: 2000,
  dpr: 0,
  adaptive: true,
  autosave: true,
  autoUpdate: true,
  fields: {},
  tableColumns: {},
});

function readSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_SETTINGS);
    const parsed = { ...structuredClone(DEFAULT_SETTINGS), ...raw };
    parsed.fields = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
    parsed.tableColumns = raw.tableColumns && typeof raw.tableColumns === 'object' ? raw.tableColumns : {};
    if (!['dark', 'light'].includes(parsed.theme)) parsed.theme = DEFAULT_SETTINGS.theme;
    if (!['orange', 'cyan', 'green', 'violet'].includes(parsed.accent)) parsed.accent = DEFAULT_SETTINGS.accent;
    if (!['comfortable', 'compact'].includes(parsed.density)) parsed.density = DEFAULT_SETTINGS.density;
    parsed.scale = Number(parsed.scale) || DEFAULT_SETTINGS.scale;
    parsed.labelZoom = Number(parsed.labelZoom) || DEFAULT_SETTINGS.labelZoom;
    parsed.maxElements = Number(parsed.maxElements) || DEFAULT_SETTINGS.maxElements;
    parsed.maxLabels = Number(parsed.maxLabels) || DEFAULT_SETTINGS.maxLabels;
    const dpr = Number(parsed.dpr);
    parsed.dpr = Number.isFinite(dpr) && dpr >= 0 && dpr <= 3 ? dpr : DEFAULT_SETTINGS.dpr;
    parsed.adaptive = parsed.adaptive !== false;
    parsed.labels = parsed.labels !== false;
    parsed.scalebar = parsed.scalebar !== false;
    parsed.north = parsed.north !== false;
    parsed.autosave = parsed.autosave !== false;
    parsed.autoUpdate = parsed.autoUpdate !== false;
    return parsed;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export const settings = readSettings();

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* armazenamento indisponível */
  }
}

export function applyAppearance({ notify = true } = {}) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.accent = settings.accent;
  root.dataset.density = settings.density;
  root.dataset.platform = window.desktop?.platform || 'web';

  if (window.desktop?.setOverlayTheme) {
    window.desktop.setOverlayTheme({
      color: cssVar('--bg-subtle', '#080d12'),
      symbolColor: cssVar('--text-2', '#dbe4ee'),
    });
  }

  if (notify) bus.emit('settings:changed', { key: 'appearance', value: settings });
}

export function updateSetting(key, value, { notify = true } = {}) {
  if (!(key in settings)) return;
  settings[key] = value;
  saveSettings();
  if (key === 'theme' || key === 'accent' || key === 'density') {
    applyAppearance({ notify: false });
  }
  if (notify) bus.emit('settings:changed', { key, value });
}

export function getFieldSelection(type) {
  const selection = settings.fields?.[type];
  return Array.isArray(selection) && selection.length ? selection : null;
}

export function setFieldSelection(type, names) {
  if (!names || !names.length) delete settings.fields[type];
  else settings.fields[type] = [...new Set(names)];
  saveSettings();
  bus.emit('settings:changed', { key: 'fields', value: settings.fields });
}

export function getTableColumns(type) {
  const selection = settings.tableColumns?.[type];
  return Array.isArray(selection) && selection.length ? selection : null;
}

export function setTableColumns(type, names) {
  if (!names || !names.length) delete settings.tableColumns[type];
  else settings.tableColumns[type] = [...new Set(names)];
  saveSettings();
  bus.emit('settings:changed', { key: 'tableColumns', value: settings.tableColumns });
}

export function resetPreferences() {
  const next = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings, next);
  saveSettings();
  applyAppearance({ notify: false });
  bus.emit('settings:changed', { key: 'all', value: settings });
}

applyAppearance({ notify: false });
