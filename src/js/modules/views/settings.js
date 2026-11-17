import { bus } from '../../core/bus.js';
import { library } from '../../data/library.js';
import { settings, updateSetting, resetPreferences, applyAppearance } from '../../core/settings.js';
import {
  getUpdateState,
  checkForUpdates,
  installUpdate,
  openReleasePage,
  setAutoUpdate,
  formatBytes,
  formatCheckedAt,
} from '../../core/updater.js';
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
  syncUpdates();
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

function phaseLabel(update) {
  if (update.phase === 'check') return 'Consultando o GitHub…';
  if (update.phase === 'verify') return 'Conferindo o instalador…';
  if (update.phase === 'ready') return 'Instalador pronto, aplicando…';
  if (update.phase === 'download') {
    const size = update.total
      ? ` · ${formatBytes(update.downloaded)} de ${formatBytes(update.total)}`
      : '';
    return `Baixando instalador · ${update.progress || 0}%${size}`;
  }
  return '';
}

function syncUpdates(update = getUpdateState()) {
  if (!els.updateCurrent) return;

  if (update.current) {
    els.updateCurrent.textContent = update.installed === false
      ? `NeoGrid ${update.current} · cópia de desenvolvimento`
      : `NeoGrid ${update.current} · instalado neste computador`;
  } else {
    els.updateCurrent.textContent = update.supported
      ? 'NeoGrid · versão não informada'
      : 'Disponível apenas no aplicativo desktop';
  }

  let badge = '—';
  let variant = 'badge-soft';
  if (!update.supported) {
    badge = 'Somente desktop';
  } else if (update.installing) {
    badge = 'Instalando…';
    variant = 'badge-warning';
  } else if (update.checking) {
    badge = 'Verificando…';
  } else if (update.available) {
    badge = `v${update.latest?.version || '?'} disponível`;
    variant = 'badge-warning';
  } else if (update.error) {
    badge = 'Falha';
    variant = 'badge-danger';
  } else if (update.checkedAt) {
    badge = 'Em dia';
    variant = 'badge-success';
  }
  if (els.updateBadge) {
    els.updateBadge.textContent = badge;
    els.updateBadge.className = `badge ${variant}`;
  }

  if (els.autoUpdate) {
    els.autoUpdate.checked = settings.autoUpdate !== false;
    els.autoUpdate.disabled = !update.supported;
  }

  let status = 'Ainda não verificada.';
  if (!update.supported) {
    status = 'A verificação automática funciona na versão instalada do NeoGrid.';
  } else if (update.checking) {
    status = 'Consultando o GitHub…';
  } else if (update.error) {
    status = update.error;
  } else if (update.available) {
    const published = update.latest?.publishedAt
      ? ` · publicado em ${formatCheckedAt(Date.parse(update.latest.publishedAt))}`
      : '';
    status = `Versão ${update.latest?.version} disponível${published}.`;
  } else if (update.message) {
    status = update.message;
  } else if (update.checkedAt) {
    status = `Última verificação: ${formatCheckedAt(update.checkedAt)}.`;
  }
  if (els.updateStatus) els.updateStatus.textContent = status;

  if (els.updateAvailableRow) els.updateAvailableRow.hidden = !update.available;
  if (els.updateAvailableTitle && update.latest) {
    els.updateAvailableTitle.textContent = `NeoGrid ${update.latest.version}`;
  }
  if (els.updateAvailableNotes) {
    const notes = String(update.latest?.notes || '').replace(/[#*_`>]/g, '').trim();
    const fallback = update.latest?.asset?.size
      ? `Instalador de ${formatBytes(update.latest.asset.size)}.`
      : 'Instalador do Windows (NSIS).';
    els.updateAvailableNotes.textContent = notes ? notes.slice(0, 260) : fallback;
  }

  const busy = Boolean(update.installing);
  if (els.updateInstall) {
    els.updateInstall.disabled = busy;
    els.updateInstall.textContent = busy ? 'Instalando…' : 'Instalar e reiniciar';
  }
  if (els.updateCheck) {
    els.updateCheck.disabled = !update.supported || update.checking || busy;
  }

  if (els.updateProgressWrap) {
    els.updateProgressWrap.hidden = !busy;
    if (els.updateProgressBar) {
      const percent = Math.max(0, Math.min(100, Number(update.progress) || 0));
      els.updateProgressBar.style.width = `${percent}%`;
    }
    if (els.updateProgressText) els.updateProgressText.textContent = phaseLabel(update);
  }

  if (els.updateInstallHint) {
    const dev = update.supported && update.installed === false && update.available;
    els.updateInstallHint.hidden = !dev;
    if (dev) {
      els.updateInstallHint.textContent = `Esta cópia é uma build de desenvolvimento. A atualização será aplicada em ${update.installDir || '%LOCALAPPDATA%\\NeoGrid'}.`;
    }
  }
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
    updateCurrent: document.querySelector('#updateCurrent'),
    updateBadge: document.querySelector('#updateBadge'),
    updateStatus: document.querySelector('#updateStatusText'),
    updateAvailableRow: document.querySelector('#updateAvailableRow'),
    updateAvailableTitle: document.querySelector('#updateAvailableTitle'),
    updateAvailableNotes: document.querySelector('#updateAvailableNotes'),
    updateInstall: document.querySelector('#updateInstall'),
    updateReleasePage: document.querySelector('#updateReleasePage'),
    updateCheck: document.querySelector('#updateCheck'),
    updateProgressWrap: document.querySelector('#updateProgressWrap'),
    updateProgressBar: document.querySelector('#updateProgressBar'),
    updateProgressText: document.querySelector('#updateProgressText'),
    updateInstallHint: document.querySelector('#updateInstallHint'),
    autoUpdate: document.querySelector('#settingsAutoUpdate'),
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

  els.autoUpdate?.addEventListener('change', () => setAutoUpdate(els.autoUpdate.checked));
  els.updateCheck?.addEventListener('click', () => { checkForUpdates(); });
  els.updateInstall?.addEventListener('click', () => { installUpdate(); });
  els.updateReleasePage?.addEventListener('click', () => { openReleasePage(); });

  bus.on('settings:changed', sync);
  bus.on('data:changed', updateData);
  bus.on('update:state', syncUpdates);
  sync();

  window.desktop?.appInfo?.().then((info) => {
    const grid = document.querySelector('#aboutGrid');
    if (!grid || !info) return;
    grid.innerHTML = `
      <div><span>Aplicativo</span><strong>NeoGrid ${info.version}</strong></div>
      <div><span>Ambiente</span><strong>Tauri · WebView2</strong></div>
      <div><span>Plataforma</span><strong>${info.platform} · ${info.arch}</strong></div>
      <div><span>Dados</span><strong>Não saem do dispositivo</strong></div>`;
  }).catch(() => {});
}
