import { bus } from '../../core/bus.js';
import { library } from '../../data/library.js';
import { settings, updateSetting, resetPreferences, applyAppearance } from '../../core/settings.js';
import { BASEMAPS } from '../map/basemaps.js';
import { fmtInt, fmtKm } from '../../core/format.js';
import { toast } from '../../ui/toast.js';
import { confirmAction } from '../../ui/confirm.js';

let els = {};

function sync() {
  document.querySelectorAll('#themeSegmented [data-theme-value]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.themeValue === settings.theme);
  });
  document.querySelectorAll('#accentSwatches [data-accent-value]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.accentValue === settings.accent);
  });
  if (els.compact) els.compact.checked = settings.density === 'compact';
  if (els.basemap) els.basemap.value = settings.basemap;
  if (els.scale) els.scale.value = String(settings.scale);
  if (els.labels) els.labels.checked = settings.labels;
  if (els.maxElements) els.maxElements.value = String(settings.maxElements);
  if (els.maxLabels) els.maxLabels.value = String(settings.maxLabels);
  if (els.dpr) els.dpr.value = String(settings.dpr);
  if (els.adaptive) els.adaptive.checked = settings.adaptive !== false;
  const autosave = document.querySelector('#settingsAutosave');
  if (autosave) autosave.checked = settings.autosave !== false;
  updateData();
}

function updateData() {
  if (!els.dataSummary) return;
  const summary = library.summary();
  if (!summary.totalRows) {
    els.dataSummary.textContent = 'Nenhum conjunto carregado.';
    if (els.dataBadge) els.dataBadge.textContent = 'Vazio';
    if (els.clear) els.clear.disabled = true;
    return;
  }
  els.dataSummary.textContent = `${fmtInt(summary.totalRows)} registros em ${summary.stores} camadas · ${fmtKm(summary.totalLength)} de rede.`;
  if (els.dataBadge) els.dataBadge.textContent = `${fmtInt(summary.totalRows)} registros`;
  if (els.clear) els.clear.disabled = false;
}

async function clearData() {
  if (!library.hasData()) {
    toast.info('Base já está vazia', 'Não há registros para remover.');
    return;
  }
  const ok = await confirmAction({
    title: 'Limpar base de dados?',
    text: 'Todos os registros carregados serão removidos da memória e o snapshot guardado em disco será apagado. Os arquivos CSV originais não serão alterados.',
    confirmLabel: 'Limpar base',
  });
  if (!ok) return;
  if (library.isDatabase()) await library.closeDatabase();
  library.clear();
  try {
    const { persistence } = await import('../../data/persistence.js');
    await persistence.clearSaved({ silent: true });
  } catch (error) {
    console.error('[projeto] clear', error);
  }
  toast.success('Base limpa', 'Os registros da sessão e o snapshot em disco foram removidos.');
}

async function resetAll() {
  const ok = await confirmAction({
    title: 'Restaurar preferências?',
    text: 'Tema, mapa, rótulos, desempenho e campos personalizados voltarão ao padrão. A base de dados não será alterada.',
    confirmLabel: 'Restaurar padrão',
    danger: false,
  });
  if (!ok) return;
  resetPreferences();
  applyAppearance();
  sync();
  window.dispatchEvent(new Event('resize'));
  toast.success('Preferências restauradas', 'O ambiente voltou à configuração padrão.');
}

export function initSettings() {
  els = {
    compact: document.querySelector('#compactDensity'),
    basemap: document.querySelector('#settingsBasemap'),
    scale: document.querySelector('#settingsScale'),
    labels: document.querySelector('#settingsLabels'),
    maxElements: document.querySelector('#settingsMaxElements'),
    maxLabels: document.querySelector('#settingsMaxLabels'),
    dpr: document.querySelector('#settingsDpr'),
    adaptive: document.querySelector('#settingsAdaptive'),
    dataSummary: document.querySelector('#settingsDataSummary'),
    dataBadge: document.querySelector('#settingsDataBadge'),
    clear: document.querySelector('#settingsClearData'),
  };
  if (!document.querySelector('#themeSegmented')) return;

  if (els.basemap) {
    els.basemap.innerHTML = BASEMAPS.map((definition) => `<option value="${definition.id}">${definition.name} · ${definition.provider}</option>`).join('');
  }

  document.querySelector('#themeToggle')?.addEventListener('click', () => {
    updateSetting('theme', settings.theme === 'dark' ? 'light' : 'dark');
  });

  document.querySelectorAll('#themeSegmented [data-theme-value]').forEach((button) => {
    button.addEventListener('click', () => updateSetting('theme', button.dataset.themeValue));
  });
  document.querySelectorAll('#accentSwatches [data-accent-value]').forEach((button) => {
    button.addEventListener('click', () => updateSetting('accent', button.dataset.accentValue));
  });

  els.compact?.addEventListener('change', () => {
    updateSetting('density', els.compact.checked ? 'compact' : 'comfortable');
    window.dispatchEvent(new Event('resize'));
  });
  els.basemap?.addEventListener('change', () => updateSetting('basemap', els.basemap.value));
  els.scale?.addEventListener('change', () => updateSetting('scale', Number(els.scale.value)));
  els.labels?.addEventListener('change', () => updateSetting('labels', els.labels.checked));
  els.maxElements?.addEventListener('change', () => updateSetting('maxElements', Number(els.maxElements.value)));
  els.maxLabels?.addEventListener('change', () => updateSetting('maxLabels', Number(els.maxLabels.value)));
  els.dpr?.addEventListener('change', () => updateSetting('dpr', Number(els.dpr.value)));
  els.adaptive?.addEventListener('change', () => updateSetting('adaptive', els.adaptive.checked));

  els.clear?.addEventListener('click', clearData);
  document.querySelector('#settingsResetPrefs')?.addEventListener('click', resetAll);

  bus.on('settings:changed', sync);
  bus.on('data:changed', updateData);
  sync();

  window.desktop?.appInfo?.().then((info) => {
    const grid = document.querySelector('#aboutGrid');
    if (!grid || !info) return;
    grid.innerHTML = `
      <div><span>Aplicativo</span><strong>NeoGrid ${info.version}</strong></div>
      <div><span>Ambiente</span><strong>Electron ${info.electron}</strong></div>
      <div><span>Plataforma</span><strong>${info.platform} · ${info.arch}</strong></div>
      <div><span>Dados</span><strong>Não saem do dispositivo</strong></div>`;
  }).catch(() => {});
}
