'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function base64ToArrayBuffer(value) {
  if (!value) return new ArrayBuffer(0);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  saveFile: (options) => ipcRenderer.invoke('file:save', options),
  fetchText: (payload) => ipcRenderer.invoke('net:fetch-text', payload),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  appInfo: () => ipcRenderer.invoke('app:info'),
  setOverlayTheme: (theme) => ipcRenderer.invoke('window:overlay-theme', theme),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  projectStatus: () => ipcRenderer.invoke('project:status'),
  projectWriteAutosave: (buffer, meta) => ipcRenderer.invoke('project:write-autosave', { buffer, meta }),
  projectReadAutosave: async () => {
    const result = await ipcRenderer.invoke('project:read-autosave');
    return result?.base64 ? { ...result, buffer: base64ToArrayBuffer(result.base64) } : result;
  },
  projectClearAutosave: () => ipcRenderer.invoke('project:clear-autosave'),
  projectSaveAs: (buffer, suggestedName) => ipcRenderer.invoke('project:save-as', { buffer, suggestedName }),
  projectOpenFile: async () => {
    const result = await ipcRenderer.invoke('project:open-file');
    return result?.base64 ? { ...result, buffer: base64ToArrayBuffer(result.base64) } : result;
  },
  dbOpenDialog: () => ipcRenderer.invoke('db:open-dialog'),
  dbOpen: (filePath) => ipcRenderer.invoke('db:open', filePath),
  dbInfo: () => ipcRenderer.invoke('db:info'),
  dbClose: () => ipcRenderer.invoke('db:close'),
  dbQuery: (channel, payload) => ipcRenderer.invoke(channel, payload),
  dbPickFolder: () => ipcRenderer.invoke('db:pick-folder'),
  dbPickOutput: (suggestedName) => ipcRenderer.invoke('db:pick-output', suggestedName),
  dbBuildStart: (payload) => ipcRenderer.invoke('db:build-start', payload),
  dbBuildCancel: () => ipcRenderer.invoke('db:build-cancel'),
  dbBuildBusy: () => ipcRenderer.invoke('db:build-busy'),
  onDbBuildProgress: (listener) => {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on('db:build-progress', wrapped);
    return () => ipcRenderer.removeListener('db:build-progress', wrapped);
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
