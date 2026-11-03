/* Adaptador Tauri da superfície `window.desktop` (módulo ESM).
 * Carregado após boot.js e antes de main.js (módulos executam em ordem).
 * Só instala dentro do WebView Tauri; o preload do Electron tem precedência
 * e, fora de ambos, o app segue em modo web.
 * Usa a API oficial vendorizada (`vendor/tauri/core.js` + `event.js`,
 * @tauri-apps/api 2.x, MIT) — sem depender de `window.__TAURI__*` internos.
 * Mesmos nomes de commands e formatos do preload.js. */
import { invoke } from '../../vendor/tauri/core.js';
import { listen } from '../../vendor/tauri/event.js';

(function installTauriDesktop() {
  try {
    if (window.desktop) return;
    // Detecção apenas (a API usada é a oficial vendorizada): sem o objeto
    // interno injetado pelo WebView, não instala — o app segue em modo web.
    if (!window.__TAURI_INTERNALS__) return;

    const B64_CHUNK = 0x8000;

    function bytesToBase64(bytes) {
      const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      let binary = '';
      for (let offset = 0; offset < input.length; offset += B64_CHUNK) {
        binary += String.fromCharCode.apply(null, input.subarray(offset, offset + B64_CHUNK));
      }
      return btoa(binary);
    }

    function base64ToArrayBuffer(value) {
      if (!value) return new ArrayBuffer(0);
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    function detectPlatform() {
      const ua = String(navigator.userAgent || '');
      if (/Windows/i.test(ua)) return 'win32';
      if (/Macintosh|Mac OS/i.test(ua)) return 'darwin';
      if (/Linux/i.test(ua)) return 'linux';
      return 'web';
    }

    window.desktop = {
      isDesktop: true,
      platform: detectPlatform(),
      saveFile: (options) => invoke('file_save', {
        title: (options && options.title) || null,
        defaultName: (options && (options.defaultName || options.suggestedName)) || null,
        filters: (options && options.filters
          ? options.filters.map((f) => [f.name || 'Arquivo', f.extensions || ['*']])
          : null),
        content: options ? options.content : null,
      }),
      fetchText: (payload) => invoke('net_fetch_text', {
        url: payload ? payload.url : '',
        headers: (payload && payload.headers) || null,
        body: (payload && payload.body != null) ? String(payload.body) : null,
        timeoutMs: (payload && payload.timeoutMs) || null,
      }),
      revealFile: (filePath) => invoke('file_reveal', { path: filePath || null }),
      appInfo: () => invoke('app_info'),
      setOverlayTheme: (theme) => invoke('window_overlay_theme', { theme: theme || null }),
      openExternal: (url) => invoke('app_open_external', { url: url || null }),
      projectStatus: () => invoke('project_status'),
      projectWriteAutosave: (buffer, meta) => invoke('project_write_autosave', {
        bufferB64: bytesToBase64(buffer),
        meta: meta || null,
      }),
      projectReadAutosave: async () => {
        const result = await invoke('project_read_autosave');
        return result && result.base64 ? { ...result, buffer: base64ToArrayBuffer(result.base64) } : result;
      },
      projectClearAutosave: () => invoke('project_clear_autosave'),
      projectSaveAs: (buffer, suggestedName) => invoke('project_save_as', {
        bufferB64: bytesToBase64(buffer),
        suggestedName: suggestedName || null,
      }),
      projectOpenFile: async () => {
        const result = await invoke('project_open_file');
        return result && result.base64 ? { ...result, buffer: base64ToArrayBuffer(result.base64) } : result;
      },
      dbOpenDialog: () => invoke('db_open_dialog'),
      dbOpen: (filePath) => invoke('db_open', { path: filePath }),
      dbInfo: () => invoke('db_info'),
      dbClose: () => invoke('db_close'),
      dbQuery: (channel, payload) => invoke('db_query', { channel, payload: payload || {} }),
      dbPickFolder: () => invoke('db_pick_folder'),
      dbPickOutput: (suggestedName) => invoke('db_pick_output', { suggestedName: suggestedName || null }),
      dbBuildStart: (payload) => invoke('db_build_start', { payload: payload || {} }),
      dbBuildCancel: () => invoke('db_build_cancel'),
      dbBuildBusy: () => invoke('db_build_busy'),
      onDbBuildProgress: (listener) => {
        const pending = listen('db:build-progress', (event) => {
          try {
            listener(event && event.payload !== undefined ? event.payload : event);
          } catch { /* listener do app */ }
        });
        return () => {
          Promise.resolve(pending).then((unlisten) => {
            try {
              if (typeof unlisten === 'function') unlisten();
            } catch { /* ignore */ }
          }).catch(() => {});
        };
      },
      getPathForFile: () => '',
    };
  } catch {
    /* sem Tauri: segue com preload do Electron ou modo web */
  }
})();
