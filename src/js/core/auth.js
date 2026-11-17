/* Login com Supabase Auth.
 *
 * - A senha nunca passa pelo app: o WebView chama a API oficial de Auth
 *   (`/auth/v1/token`) e recebe um JWT + refresh token.
 * - A sessão fica salva no computador. Sem internet, ela continua valendo por
 *   até 7 dias depois da última validação (uso em campo).
 * - Perfis vêm de `app_metadata.role` (ou `user_metadata.role`, por
 *   compatibilidade) e controlam as ações destrutivas do app.
 *
 * Importante: isto protege a interface, não é uma barreira de segurança
 * forte — qualquer regra de dados precisa estar no RLS do Supabase.
 */
import { bus } from './bus.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './auth-config.js';

const CONFIG_KEY = 'neogrid.auth.config';
const SESSION_KEY = 'neogrid.auth.session';
const OFFLINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_S = 120;

const ROLE_LABELS = { admin: 'Administrador', operador: 'Operador', leitor: 'Leitor' };

/** O que cada perfil pode fazer. `*` libera tudo. */
const ROLE_PERMISSIONS = {
  admin: ['*'],
  operador: [
    'data:import', 'data:build', 'data:export',
    'project', 'project:export',
    'settings', 'settings:fields',
    'update:check', 'update:install',
  ],
  leitor: ['data:export', 'project:view', 'settings:view', 'update:check'],
};

/** Ações bloqueadas na captura de clique (além das checagens nos módulos). */
const CLICK_GUARDS = [
  {
    permission: 'data:import',
    selector: '[data-import], #topImport, #mapEmptyImport, #dataImport, #dashImport, #importsNew',
    label: 'importar dados',
  },
  { permission: 'data:clear', selector: '#settingsClearData', label: 'limpar a base' },
  { permission: 'settings:reset', selector: '#settingsResetPrefs', label: 'restaurar preferências' },
];

let session = null;
let pending = null;
let refreshTimer = 0;
let wired = false;

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function readConfig() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
  } catch {
    stored = null;
  }
  const url = normalizeUrl(stored?.url || SUPABASE_URL);
  const key = String(stored?.key || SUPABASE_ANON_KEY || '').trim();
  return { url, key, ready: Boolean(url.startsWith('http') && key) };
}

function saveConfig(url, key) {
  const clean = { url: normalizeUrl(url), key: String(key || '').trim() };
  try {
    if (!clean.url && !clean.key) localStorage.removeItem(CONFIG_KEY);
    else localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
  } catch {
    /* sem armazenamento */
  }
}

function normalizeRole(raw) {
  const value = String(raw || '').toLowerCase().trim();
  if (['admin', 'administrador', 'gestor', 'manager', 'master'].includes(value)) return 'admin';
  if (['leitor', 'reader', 'viewer', 'consulta', 'visualizador'].includes(value)) return 'leitor';
  if (['operador', 'operator', 'user', 'usuario', 'usuário', 'editor'].includes(value)) return 'operador';
  return 'operador';
}

function roleOf(user) {
  const meta = user?.app_metadata || {};
  const publicMeta = user?.user_metadata || {};
  return normalizeRole(meta.role || meta.perfil || publicMeta.role || publicMeta.perfil);
}

function displayName(user) {
  const meta = user?.user_metadata || {};
  const name = meta.nome || meta.name || meta.full_name || meta.display_name;
  if (name && String(name).trim()) return String(name).trim();
  const email = String(user?.email || '');
  return email ? email.split('@')[0] : 'Operador';
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function persistSession() {
  try {
    if (!session) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* sem armazenamento */
  }
}

function readSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!raw || !raw.accessToken || !raw.user) return null;
    return raw;
  } catch {
    return null;
  }
}

class AuthError extends Error {
  constructor(message, { network = false, status = 0 } = {}) {
    super(message);
    this.network = network;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body = null, token = '' } = {}) {
  const { url, key } = readConfig();
  if (!url.startsWith('http') || !key) {
    throw new AuthError('Conexão com o Supabase não configurada.', { status: 0 });
  }

  // No aplicativo a chamada passa pelo Rust: usa o proxy do Windows (o mesmo
  // das outras consultas) e não depende de CORS do WebView.
  if (globalThis.desktop?.authRequest) {
    try {
      const resposta = await globalThis.desktop.authRequest({
        method,
        url,
        path: `auth/v1/${path.replace(/^\/+/, '')}`,
        body: body || null,
        apikey: key,
        token: token || null,
      });
      if (!resposta || !resposta.status) {
        throw new AuthError(resposta?.error || 'Sem conexão com o Supabase.', { network: true });
      }
      return { ok: Boolean(resposta.ok), status: resposta.status, data: resposta.data || {} };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(error?.message || 'Sem conexão com o Supabase.', { network: true });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${url}/auth/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${token || key}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { msg: text };
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    throw new AuthError(
      error?.name === 'AbortError' ? 'O Supabase demorou para responder.' : 'Sem conexão com o Supabase.',
      { network: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

function apiMessage(data) {
  const raw = String(data?.msg || data?.error_description || data?.error || data?.message || '').toLowerCase();
  if (raw.includes('invalid login credentials') || raw.includes('invalid_grant')) return 'E-mail ou senha incorretos.';
  if (raw.includes('email not confirmed')) return 'Confirme o e-mail antes de entrar.';
  if (raw.includes('user not found')) return 'Conta não encontrada.';
  if (raw.includes('rate limit') || raw.includes('too many')) return 'Muitas tentativas. Aguarde alguns minutos.';
  if (raw.includes('signups not allowed')) return 'Cadastro desativado neste projeto.';
  return data?.msg || data?.error_description || data?.error || 'Não foi possível entrar.';
}

function adopt(data) {
  const user = data?.user || {};
  if (!data?.access_token) throw new AuthError('Resposta de login inválida.');
  session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt: Number(data.expires_at) || Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600),
    user: {
      id: user.id || '',
      email: user.email || '',
      name: displayName(user),
      role: roleOf(user),
    },
    lastValidatedAt: Date.now(),
    offline: false,
  };
  persistSession();
  return session;
}

async function refreshSession(current) {
  if (!current?.refreshToken) throw new AuthError('Sessão sem refresh token.', { status: 401 });
  const { ok, status, data } = await request('token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: current.refreshToken },
  });
  if (!ok) throw new AuthError(apiMessage(data), { status });
  return adopt(data);
}

function expired(current, margin = REFRESH_MARGIN_S) {
  return !current?.expiresAt || current.expiresAt - Date.now() / 1000 < margin;
}

function withinOfflineWindow(current) {
  return Boolean(current?.lastValidatedAt) && Date.now() - current.lastValidatedAt <= OFFLINE_WINDOW_MS;
}

function offlineUntil(current) {
  const until = new Date((current.lastValidatedAt || Date.now()) + OFFLINE_WINDOW_MS);
  return until.toLocaleDateString('pt-BR');
}

// ---- Estado público ---------------------------------------------------------

export function getSession() {
  return session;
}

export function currentUser() {
  if (!session) return null;
  return { ...session.user, roleLabel: ROLE_LABELS[session.user.role] || session.user.role, offline: Boolean(session.offline) };
}

/** Sessão restaurada sem internet (chip mostra "offline"). */
export function isOffline() {
  return Boolean(session?.offline);
}

export function can(permission) {
  if (!session) return false;
  const list = ROLE_PERMISSIONS[session.user.role] || ROLE_PERMISSIONS.leitor;
  return list.includes('*') || list.includes(permission);
}

/** Usado por módulos para bloquear uma ação com aviso. */
export function requirePermission(permission, label = 'esta ação') {
  if (can(permission)) return true;
  const role = ROLE_LABELS[session?.user?.role] || 'atual';
  toast.warning('Acesso restrito', `O perfil ${role} não pode ${label}.`);
  return false;
}

// ---- Logout -----------------------------------------------------------------

export async function signOut() {
  const ok = await confirmAction({
    title: 'Sair da conta?',
    text: 'A sessão será encerrada neste computador. Os dados locais continuam salvos.',
    confirmLabel: 'Sair',
    danger: false,
  });
  if (!ok) return false;
  const token = session?.accessToken;
  session = null;
  persistSession();
  try {
    await request('logout', { method: 'POST', token });
  } catch {
    /* sem rede: a sessão local já foi apagada */
  }
  clearInterval(refreshTimer);
  // Recarrega para descartar o que está em memória e voltar ao login.
  location.reload();
  return true;
}

// ---- Interface --------------------------------------------------------------

function showGate(show) {
  const gate = document.querySelector('#authGate');
  if (!gate) return;
  gate.hidden = !show;
  if (show) {
    setTimeout(() => document.querySelector('#authEmail')?.focus(), 50);
  }
}

function setError(message) {
  const element = document.querySelector('#authError');
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

function setBusy(busy) {
  const button = document.querySelector('#authSubmit');
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? 'Entrando…' : 'Entrar';
}

function renderUser() {
  const user = currentUser();
  const chip = document.querySelector('#userChip');
  const menu = document.querySelector('#userMenu');
  if (chip) {
    chip.hidden = !user;
    chip.classList.toggle('is-offline', Boolean(user?.offline));
    if (user) {
      chip.title = `${user.name} · ${user.email} · ${user.roleLabel}${user.offline ? ' · sessão offline' : ''}`;
      const avatar = document.querySelector('#userAvatar');
      const name = document.querySelector('#userName');
      if (avatar) avatar.textContent = initials(user.name);
      if (name) name.textContent = user.name;
    }
  }
  if (menu && menu.hidden === false && !user) menu.hidden = true;

  const menuName = document.querySelector('#userMenuName');
  const menuRole = document.querySelector('#userMenuRole');
  if (menuName && user) menuName.textContent = user.name;
  if (menuRole && user) {
    menuRole.textContent = user.offline ? `${user.roleLabel} · offline` : user.roleLabel;
  }

  const account = document.querySelector('#settingsAccount');
  if (account) {
    account.textContent = user
      ? `${user.name} · ${user.email} · ${user.roleLabel}${user.offline ? ' · sessão offline' : ''}`
      : 'Não autenticado';
  }
  document.documentElement.dataset.role = user?.role || 'anon';
  bus.emit('auth:changed', user);
}

function updateConfigUi() {
  const config = readConfig();
  const urlInput = document.querySelector('#authUrl');
  const keyInput = document.querySelector('#authKey');
  const foot = document.querySelector('#authFoot');
  if (urlInput) urlInput.value = config.url;
  if (keyInput) keyInput.value = config.key;
  if (foot) {
    foot.textContent = config.ready
      ? `Conectado a ${config.url.replace(/^https?:\/\//, '')}`
      : 'Conexão não configurada';
  }
}

function wireUi() {
  if (wired) return;
  wired = true;

  document.querySelector('#authForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = String(document.querySelector('#authEmail')?.value || '').trim();
    const password = String(document.querySelector('#authPassword')?.value || '');
    if (!email || !password) {
      setError('Informe e-mail e senha.');
      return;
    }
    if (!readConfig().ready) {
      setError('Conexão não configurada. Abra “Conexão” e informe a URL e a chave pública.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const result = await request('token?grant_type=password', {
        method: 'POST',
        body: { email, password },
      });
      if (!result.ok) throw new AuthError(apiMessage(result.data), { status: result.status });
      adopt(result.data);
      document.querySelector('#authPassword').value = '';
      afterAuth();
      showGate(false);
      toast.success(`Bem-vindo, ${session.user.name}`, `Perfil: ${ROLE_LABELS[session.user.role]}`);
      pending?.(session);
      pending = null;
    } catch (error) {
      setError(error?.message || 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  });

  document.querySelector('#authShow')?.addEventListener('click', () => {
    const input = document.querySelector('#authPassword');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.querySelector('#authConfigToggle')?.addEventListener('click', () => {
    const form = document.querySelector('#authConfigForm');
    if (form) form.hidden = !form.hidden;
    updateConfigUi();
  });

  document.querySelector('#authConfigForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = normalizeUrl(document.querySelector('#authUrl')?.value || '');
    const key = String(document.querySelector('#authKey')?.value || '').trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      setError('URL inválida. Use algo como https://xxxx.supabase.co');
      return;
    }
    saveConfig(url, key);
    updateConfigUi();
    setError('');
    const form = document.querySelector('#authConfigForm');
    if (form) form.hidden = true;
    toast.success('Conexão salva', 'Agora entre com seu e-mail e senha do Supabase.');
  });

  document.querySelector('#authForgot')?.addEventListener('click', async () => {
    const email = String(document.querySelector('#authEmail')?.value || '').trim();
    if (!email) {
      setError('Informe o e-mail para receber o link de recuperação.');
      return;
    }
    try {
      await request('recover', { method: 'POST', body: { email } });
      toast.info('Link enviado', 'Se existir uma conta com esse e-mail, o Supabase enviará as instruções.');
    } catch (error) {
      toast.error('Não foi possível enviar', error?.message || String(error));
    }
  });

  document.querySelector('#userChip')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = document.querySelector('#userMenu');
    if (menu) menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (event) => {
    const menu = document.querySelector('#userMenu');
    if (menu && !menu.hidden && !event.target.closest('#userMenu') && !event.target.closest('#userChip')) {
      menu.hidden = true;
    }
  });
  document.querySelector('#userMenuSignOut')?.addEventListener('click', () => { signOut(); });
  document.querySelector('#settingsSignOut')?.addEventListener('click', () => { signOut(); });

  // Bloqueia ações restritas antes do handler do botão (capture phase).
  document.addEventListener('click', (event) => {
    for (const guard of CLICK_GUARDS) {
      const element = event.target.closest?.(guard.selector);
      if (!element) continue;
      if (can(guard.permission)) continue;
      event.preventDefault();
      event.stopPropagation();
      requirePermission(guard.permission, guard.label);
      return;
    }
  }, true);
}

function startRefreshLoop() {
  clearInterval(refreshTimer);
  if (!session) return;
  refreshTimer = setInterval(async () => {
    if (!session || session.offline || !expired(session, 600)) return;
    try {
      await refreshSession(session);
      renderUser();
    } catch (error) {
      if (error?.network && withinOfflineWindow(session)) {
        session.offline = true;
        persistSession();
        renderUser();
      }
    }
  }, 5 * 60 * 1000);
}

function afterAuth() {
  renderUser();
  startRefreshLoop();
}

async function restore() {
  const cached = readSession();
  if (!cached) return null;
  session = cached;
  session.offline = false;

  if (!expired(cached, REFRESH_MARGIN_S)) return session;

  try {
    return await refreshSession(cached);
  } catch (error) {
    if (error?.network && withinOfflineWindow(cached)) {
      session = cached;
      session.offline = true;
      persistSession();
      toast.info('Sessão offline', `Sem conexão. Esta sessão vale até ${offlineUntil(cached)}.`);
      return session;
    }
    session = null;
    persistSession();
    return null;
  }
}

/**
 * Prepara o login. Resolve com a sessão ativa — só depois disso o app é
 * inicializado. Em modo de teste (`?test=1`) libera um usuário fictício.
 */
export async function initAuth() {
  const testMode = new URLSearchParams(location.search).get('test') === '1';
  if (testMode) {
    session = {
      accessToken: 'test',
      refreshToken: '',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'test', email: 'e2e@neogrid.local', name: 'Teste', role: 'admin' },
      lastValidatedAt: Date.now(),
      offline: false,
    };
    showGate(false);
    renderUser();
    return session;
  }

  const gate = document.querySelector('#authGate');
  if (!gate) return null;

  wireUi();
  updateConfigUi();
  showGate(true);

  const restored = await restore();
  if (restored) {
    afterAuth();
    showGate(false);
    return restored;
  }

  return new Promise((resolve) => {
    pending = resolve;
  });
}
