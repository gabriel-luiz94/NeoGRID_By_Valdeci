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
const FIRST_DELAY_MS = 7000;
const LAST_KEY = 'neogrid.update.lastCheck';
const NOTIFIED_KEY = 'neogrid.update.notified';
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

function emit() {
  bus.emit('update:state', { ...state });
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

function announce() {
  const version = state.latest?.version;
  if (!version) return;
  if (readString(NOTIFIED_KEY) === version) return;
  writeString(NOTIFIED_KEY, version);
  toast.info(
    `Atualização ${version} disponível`,
    'Abra Configurações → Atualizações para instalar.',
    {
      duration: 10000,
      actionLabel: 'Instalar',
      action: () => { install(); },
    },
  );
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
        toast.info(`Atualização disponível: ${state.latest?.version}`, 'Use “Instalar e reiniciar” nesta tela.');
      } else {
        toast.success('Você está na versão mais recente', `NeoGrid ${state.current}`);
      }
    } else if (state.available) {
      announce();
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

/** Inicia o agendador; chamado uma vez no boot do app. */
export function startUpdater() {
  state.supported = Boolean(globalThis.desktop?.updateCheck);
  state.checkedAt = readNumber(LAST_KEY);
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
  if (new URLSearchParams(location.search).get('test') === '1') {
    emit();
    return;
  }
  reschedule();
  emit();
}
