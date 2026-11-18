/* Atualizador automático (GitHub Releases).
 *
 * O backend (`rust/neogrid-app/src/updater.rs`) consulta a release mais
 * recente, baixa o `setup.exe` anexado e o aplica em modo silencioso. Aqui
 * ficam o agendamento (ao abrir + a cada 6 h), o estado para a tela de
 * Configurações e os avisos.
 *
 * Só funciona no aplicativo desktop (Tauri). No modo web o cartão de
 * atualizações fica desabilitado.
 */
import { bus } from './bus.js';
import { settings, updateSetting } from './settings.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_DELAY_MS = 2500;
const LAST_KEY = 'neogrid.update.lastCheck';
const FALLBACK_PAGE = 'https://github.com/gabriel-luiz94/NeoGRID_By_Valdeci/releases/latest';

const state = {
  supported: Boolean(globalThis.desktop?.updateCheck),
  checking: false,
  installing: false,
  progress: 0,
  downloaded: 0,
  total: 0,
  phase: '',
  current: '',
  latest: null,
  available: false,
  installed: true,
  error: '',
  message: '',
  checkedAt: 0,
};

let timer = 0;
let listening = false;
let noticeWired = false;
let dismissedVersion = '';

function emit() {
  bus.emit('update:state', { ...state });
  renderNotice();
}

const notice = () => document.querySelector('#updateNotice');

function renderNotice() {
  const el = notice();
  if (!el) return;
  const version = state.latest?.version || '';
  const show = Boolean(state.supported && state.available && version && dismissedVersion !== version);
  el.hidden = !show;
  if (!show) return;

  const title = document.querySelector('#updateNoticeTitle');
  const text = document.querySelector('#updateNoticeText');
  const button = document.querySelector('#updateNoticeInstall');
  const bar = document.querySelector('#updateNoticeBar');
  const fill = document.querySelector('#updateNoticeFill');

  if (title) title.textContent = `NeoGrid ${version} disponível`;
  if (text) {
    if (state.installing) {
      const total = state.total ? ` · ${formatBytes(state.downloaded)} de ${formatBytes(state.total)}` : '';
      text.textContent = `${phaseText()} ${state.progress || 0}%${total}`;
    } else if (state.error) {
      text.textContent = state.error;
    } else {
      const notes = String(state.latest.notes || '').replace(/[#*_`>]/g, '').trim().split('\n')[0];
      text.textContent = notes
        ? notes.slice(0, 140)
        : `Você está na ${state.current || 'versão atual'}. Instale para receber as novidades.`;
    }
  }
  if (button) {
    button.disabled = Boolean(state.installing);
    button.textContent = state.installing ? 'Instalando…' : 'Instalar agora';
  }
  if (bar) bar.hidden = !state.installing;
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, state.progress || 0))}%`;
}

function phaseText() {
  if (state.phase === 'check') return 'Consultando…';
  if (state.phase === 'verify') return 'Conferindo o instalador ·';
  if (state.phase === 'ready') return 'Aplicando ·';
  return 'Baixando';
}

function wireNotice() {
  if (noticeWired) return;
  noticeWired = true;
  document.querySelector('#updateNoticeInstall')?.addEventListener('click', () => { installUpdate(); });
  document.querySelector('#updateNoticeLater')?.addEventListener('click', () => {
    dismissedVersion = state.latest?.version || '';
    renderNotice();
  });
  document.querySelector('#updateNoticeDetails')?.addEventListener('click', () => { openReleasePage(); });
}

function readNumber(key) {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function readString(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sem armazenamento */
  }
}

export function getUpdateState() {
  return { ...state };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function formatCheckedAt(timestamp) {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function applyResult(result) {
  if (!result || typeof result !== 'object') {
    state.error = 'Resposta inválida do verificador de atualizações.';
    return;
  }
  if (result.current) state.current = String(result.current);
  state.latest = result.latest || null;
  state.available = Boolean(result.available);
  state.installed = result.installed !== false;
  state.message = result.message || '';
  state.error = result.ok === false ? result.error || 'Falha ao consultar o GitHub.' : '';
}

async function runCheck({ manual = false } = {}) {
  if (!state.supported) {
    if (manual) {
      toast.info('Atualizações no aplicativo', 'A verificação automática funciona na versão instalada do NeoGrid.');
    }
    return state;
  }
  if (state.checking || state.installing) return state;
  state.checking = true;
  state.error = '';
  emit();
  try {
    applyResult(await globalThis.desktop.updateCheck());
    state.checkedAt = Date.now();
    writeString(LAST_KEY, String(state.checkedAt));
    if (manual) {
      if (state.error) toast.error('Não foi possível verificar', state.error);
      else if (state.available) {
        toast.info(`Atualização disponível: ${state.latest?.version}`, 'Use “Instalar agora” no aviso abaixo.');
      } else {
        toast.success('Você está na versão mais recente', `NeoGrid ${state.current}`);
      }
    }
  } catch (error) {
    state.error = error?.message || String(error);
    state.checkedAt = Date.now();
    writeString(LAST_KEY, String(state.checkedAt));
    if (manual) toast.error('Não foi possível verificar', state.error);
  } finally {
    state.checking = false;
    emit();
  }
  return state;
}

/** Verifica agora (botão das Configurações). */
export function checkForUpdates() {
  return runCheck({ manual: true });
}

function bindProgress() {
  if (listening || !globalThis.desktop?.onUpdateProgress) return;
  listening = true;
  globalThis.desktop.onUpdateProgress((payload) => {
    if (!payload) return;
    state.phase = payload.phase || state.phase;
    state.downloaded = Number(payload.downloaded) || 0;
    state.total = Number(payload.total) || 0;
    state.progress = state.total > 0
      ? Math.min(100, Math.round((state.downloaded / state.total) * 100))
      : Number(payload.percent) || 0;
    emit();
  });
}

/** Baixa e aplica a atualização disponível. O app fecha ao final. */
export async function installUpdate() {
  if (!state.supported || state.installing) return false;
  if (!state.available || !state.latest) {
    toast.info('Nenhuma atualização disponível', 'Verifique novamente em instantes.');
    return false;
  }
  const version = state.latest.version;
  const size = formatBytes(state.latest.asset?.size);
  const ok = await confirmAction({
    title: `Instalar NeoGrid ${version}?`,
    text: `O instalador (${size}) será baixado do GitHub, o NeoGrid vai fechar e reinstalar automaticamente. Suas bases, projetos e preferências locais são mantidos.`,
    confirmLabel: 'Instalar e reiniciar',
    danger: false,
  });
  if (!ok) return false;

  state.installing = true;
  state.phase = 'download';
  state.progress = 0;
  state.error = '';
  emit();
  bindProgress();
  try {
    const result = await globalThis.desktop.updateInstall();
    if (!result?.ok) throw new Error(result?.error || 'falha ao instalar a atualização.');
    toast.success('Instalando atualização', 'O NeoGrid vai fechar e reabrir com a nova versão.');
    return true;
  } catch (error) {
    state.installing = false;
    state.error = error?.message || String(error);
    emit();
    toast.error('Atualização não aplicada', state.error);
    return false;
  }
}

/** Abre a página da release no navegador padrão. */
export async function openReleasePage() {
  const url = state.latest?.pageUrl || FALLBACK_PAGE;
  if (globalThis.desktop?.openExternal) {
    await globalThis.desktop.openExternal(url);
    return;
  }
  globalThis.open?.(url, '_blank', 'noopener');
}

function reschedule() {
  clearTimeout(timer);
  timer = 0;
  if (!state.supported || settings.autoUpdate === false) return;
  const elapsed = state.checkedAt ? Date.now() - state.checkedAt : Number.POSITIVE_INFINITY;
  const wait = elapsed >= INTERVAL_MS ? FIRST_DELAY_MS : Math.max(60000, INTERVAL_MS - elapsed);
  const tick = () => {
    runCheck();
    timer = setTimeout(tick, INTERVAL_MS);
  };
  timer = setTimeout(tick, wait);
}

/** Liga/desliga a verificação automática (setting `autoUpdate`). */
export function setAutoUpdate(enabled) {
  updateSetting('autoUpdate', Boolean(enabled));
  reschedule();
}

/** Inicia o agendador; chamado uma vez no boot do app (depois do login). */
export function startUpdater() {
  state.supported = Boolean(globalThis.desktop?.updateCheck);
  state.checkedAt = readNumber(LAST_KEY);
  wireNotice();
  const testMode = new URLSearchParams(location.search).get('test') === '1';
  if (testMode) {
    // Gancho dos testes automatizados: simula uma versão publicada.
    globalThis.__updateTest = {
      state(next) { Object.assign(state, { supported: true }, next); emit(); },
    };
  }
  if (!state.supported) {
    emit();
    return;
  }
  globalThis.desktop.appInfo?.().then((info) => {
    if (!info) return;
    state.current = info.version || state.current;
    emit();
  }).catch(() => {});
  // Nos testes automatizados (e2e com ?test=1) nada de rede em segundo plano.
  if (testMode) {
    emit();
    return;
  }
  reschedule();
  emit();
}
