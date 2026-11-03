import { bus } from '../core/bus.js';
import { fmtBytes, fmtDateTime, fmtInt } from '../core/format.js';
import { settings } from '../core/settings.js';
import { library } from './library.js';
import { LAYER_TYPES } from './schema.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';
import { $ } from '../core/dom.js';

export const PROJECT_FORMAT = 'neogrid-project';
export const PROJECT_VERSION = 3;
export const PROJECT_EXTENSION = '.neogrid';

const RESTORE_CHUNK = 20000;
const B64_CHUNK = 0x8000;
const MAX_SNAPSHOT_ROWS = 700000;
let sizeWarningShown = false;

let deps = {};
let status = { supported: false, file: { exists: false, size: 0, mtime: 0 }, meta: null };
let saving = false;
let loading = false;
let saveTimer = 0;
let suppressAutosave = false;
let lastSavedSignature = '';

const isDesktop = () => Boolean(window.desktop?.projectStatus);

function setStatusText(text, busy = false) {
  const label = $('#statusText');
  if (label) label.textContent = text;
  const dot = $('#statusDot');
  const titleDot = $('#titlebarDot');
  [dot, titleDot].forEach((element) => {
    if (!element) return;
    element.classList.toggle('is-busy', busy);
    if (!busy) element.classList.remove('is-error');
  });
}

/* ── gzip via CompressionStream ─────────────────────────────────── */
async function gzipEncode(bytes) {
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function gzipDecode(bytes) {
  const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(decompressed).arrayBuffer());
}

/* ── base64 em blocos (evita estouro de pilha) ──────────────────── */
function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + B64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function packCodes(codes, width) {
  if (width === 1) return Uint8Array.from(codes);
  const out = new Uint8Array(codes.length * width);
  const view = new DataView(out.buffer);
  if (width === 2) {
    for (let i = 0; i < codes.length; i++) view.setUint16(i * 2, codes[i], true);
  } else {
    for (let i = 0; i < codes.length; i++) view.setUint32(i * 4, codes[i], true);
  }
  return out;
}

function unpackCodes(bytes, width, count) {
  const codes = new Array(count);
  if (width === 1) {
    for (let i = 0; i < count; i++) codes[i] = bytes[i];
    return codes;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (width === 2) {
    for (let i = 0; i < count; i++) codes[i] = view.getUint16(i * 2, true);
  } else {
    for (let i = 0; i < count; i++) codes[i] = view.getUint32(i * 4, true);
  }
  return codes;
}

/* ── Codificação por coluna ───────────────────────────────────────
   Colunas repetitivas (material, tipo, condutor, fase…) viram
   dicionário + índices empacotados. Colunas únicas (WKT, IDs) ficam
   em texto corrido. O gzip final comprime ambos os casos. */
function encodeColumn(name, values) {
  const n = values.length;
  if (!n) return { e: 'raw', v: [] };

  const looksUnique = /WKT|GEOMETR|COORD|LAT|LON|GEO_X|GEO_Y/.test(name);
  if (n > 5000 && looksUnique) {
    const sample = Math.min(n, 1500);
    const seen = new Set();
    let totalLen = 0;
    for (let i = 0; i < sample; i++) {
      const value = values[(i * n / sample) | 0] ?? '';
      seen.add(value);
      totalLen += value.length;
    }
    if (seen.size / sample > 0.85 && totalLen / sample > 80) {
      return { e: 'raw', v: values };
    }
  }

  const indexByValue = new Map();
  const dict = [];
  const codes = new Array(n);
  for (let i = 0; i < n; i++) {
    const value = values[i] ?? '';
    let code = indexByValue.get(value);
    if (code === undefined) {
      if (indexByValue.size >= 20000) return { e: 'raw', v: values };
      code = dict.length;
      dict.push(value);
      indexByValue.set(value, code);
    }
    codes[i] = code;
  }

  const unique = dict.length;
  const repeat = n / Math.max(1, unique);
  const worthIt = n >= 50 && (repeat >= 2.5 || (unique <= 256 && n >= 200));
  if (!worthIt) return { e: 'raw', v: values };

  const width = unique <= 256 ? 1 : unique <= 65536 ? 2 : 4;
  return { e: 'dict', d: dict, w: width, b: bytesToBase64(packCodes(codes, width)) };
}

function decodeColumn(payload, count) {
  if (!payload || payload.e === 'raw') {
    const raw = Array.isArray(payload?.v) ? payload.v : [];
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = raw[i] ?? '';
    return out;
  }
  if (payload.e === 'dict') {
    const dict = Array.isArray(payload.d) ? payload.d : [];
    const bytes = base64ToBytes(payload.b || '');
    const codes = unpackCodes(bytes, payload.w || 1, count);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = dict[codes[i]] ?? '';
    return out;
  }
  throw new Error('Codificação de coluna desconhecida.');
}

/* ── Snapshot ───────────────────────────────────────────────────── */
function snapshotLayers() {
  const layers = {};
  let rows = 0;
  for (const type of LAYER_TYPES) {
    const store = library.get(type);
    if (!store || store.isDatabase || !store.stats.count) continue;
    const headers = [...store.headers];
    const count = store.stats.count;
    rows += count;
    const columns = headers.map((header, columnIndex) => {
      const values = new Array(count);
      for (let i = 0; i < count; i++) {
        const cell = store.rows[i]?.[columnIndex];
        values[i] = cell == null ? '' : String(cell);
      }
      return encodeColumn(header, values);
    });
    layers[type] = { headers, rowCount: count, columns };
  }
  return { layers, rows };
}

function snapshotImports() {
  return library.importHistory.slice(0, 30).map((item) => ({
    fileName: item.fileName,
    type: item.type,
    rows: item.rows,
    size: item.size,
    delimiter: item.delimiter,
    parseErrors: item.parseErrors,
    at: item.at,
  }));
}

function parseDocument(buffer) {
  if (!buffer?.length) throw new Error('Arquivo de projeto vazio.');
  const head = buffer.subarray(0, 2);
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;
  if (!isGzip) throw new Error('Formato inválido: esperado um projeto .neogrid (gzip).');
  return gzipDecode(buffer).then((raw) => {
    const text = new TextDecoder().decode(raw);
    const doc = JSON.parse(text);
    if (!doc || doc.format !== PROJECT_FORMAT || typeof doc.version !== 'number') {
      throw new Error('Arquivo de projeto inválido ou corrompido.');
    }
    if (doc.version > PROJECT_VERSION) {
      throw new Error(`Projeto salvo em versão mais nova (v${doc.version}). Atualize o NeoGrid.`);
    }
    return { doc, jsonBytes: raw.length };
  });
}

async function buildSnapshotBuffer() {
  const t0 = performance.now();
  const rowTotal = library.summary().totalRows;
  if (rowTotal > MAX_SNAPSHOT_ROWS) {
    throw new Error(`A base tem ${fmtInt(rowTotal)} registros. O snapshot local é limitado a ${fmtInt(MAX_SNAPSHOT_ROWS)} registros para não esgotar a memória. Importe e salve uma regional por vez.`);
  }
  const { layers, rows } = snapshotLayers();
  if (!rows) throw new Error('Nada para salvar: a base está vazia.');
  const doc = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    appVersion: '2.0.0',
    compression: 'dict+gzip',
    rows,
    layers,
    importHistory: snapshotImports(),
  };
  const json = JSON.stringify(doc);
  const jsonBytes = new TextEncoder().encode(json);
  const compressed = await gzipEncode(jsonBytes);
  return {
    buffer: compressed,
    jsonBytes: jsonBytes.length,
    compressedBytes: compressed.length,
    rows,
    ms: performance.now() - t0,
    doc,
  };
}

async function restoreDocument(doc, onProgress = () => {}) {
  const types = LAYER_TYPES.filter((type) => doc.layers?.[type]?.rowCount > 0);
  const total = types.reduce((sum, type) => sum + (doc.layers[type].rowCount || 0), 0);
  if (!total) throw new Error('O projeto não contém registros.');
  let done = 0;

  suppressAutosave = true;
  library.clear();
  try {
    for (const type of types) {
      const payload = doc.layers[type];
      const headers = Array.isArray(payload.headers) ? payload.headers : [];
      const count = payload.rowCount | 0;
      if (!headers.length || !count) continue;
      onProgress({ phase: 'decode', type, done, total });
      const columns = payload.columns || [];
      const decoded = new Array(headers.length);
      for (let c = 0; c < headers.length; c++) {
        decoded[c] = decodeColumn(columns[c], count);
        if (c % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      for (let offset = 0; offset < count; offset += RESTORE_CHUNK) {
        const end = Math.min(count, offset + RESTORE_CHUNK);
        const batch = new Array(end - offset);
        for (let i = offset; i < end; i++) {
          const row = new Array(headers.length);
          for (let c = 0; c < headers.length; c++) row[c] = decoded[c][i];
          batch[i - offset] = row;
        }
        library.addBatch(type, headers, batch);
        done += end - offset;
        onProgress({ phase: 'restore', type, done, total });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    library.importHistory = Array.isArray(doc.importHistory) ? doc.importHistory.slice(0, 30) : [];
    library.lastImportAt = doc.savedAt || Date.now();
    library.notifyDataChanged();
    bus.emit('imports:changed', library.importHistory);
  } finally {
    suppressAutosave = false;
  }
  return { rows: total, savedAt: doc.savedAt };
}

/* ── Operações de disco (via main process) ──────────────────────── */
function signature() {
  const summary = library.summary();
  return `${summary.totalRows}:${summary.stores}:${library.revision}`;
}

async function refreshStatus() {
  if (!isDesktop()) {
    status = { supported: false, file: { exists: false, size: 0, mtime: 0 }, meta: null };
    renderStorage();
    return status;
  }
  try {
    status = await window.desktop.projectStatus();
  } catch (error) {
    console.error('[projeto]', error);
  }
  renderStorage();
  return status;
}

function renderStorage() {
  const summaryEl = $('#projectStorageSummary');
  const badgeEl = $('#projectStorageBadge');
  if (!summaryEl && !badgeEl) return;
  const summary = library.summary();
  if (!isDesktop()) {
    if (summaryEl) summaryEl.textContent = 'Persistência disponível apenas no aplicativo desktop.';
    if (badgeEl) badgeEl.textContent = 'Indisponível';
    return;
  }
  const meta = status.meta;
  const file = status.file || {};
  if (!summary.totalRows) {
    if (summaryEl) summaryEl.textContent = file.exists
      ? `Nenhum dado em memória · snapshot de ${fmtBytes(file.size)} guardado em disco.`
      : 'Nenhum conjunto carregado. Importe CSVs ou abra um projeto.';
    if (badgeEl) badgeEl.textContent = file.exists ? 'Snapshot em disco' : 'Vazio';
    return;
  }
  if (meta?.compressedBytes && meta?.rawBytes) {
    const ratio = Math.max(0, 1 - meta.compressedBytes / meta.rawBytes);
    if (summaryEl) {
      summaryEl.textContent = `${fmtInt(summary.totalRows)} registros em memória · ${fmtBytes(meta.compressedBytes)} em disco (${(ratio * 100).toFixed(0)}% menor) · ${meta.savedAt ? fmtDateTime(meta.savedAt) : '—'}`;
    }
    if (badgeEl) badgeEl.textContent = `-${(ratio * 100).toFixed(0)}% em disco`;
  } else if (file.exists) {
    if (summaryEl) summaryEl.textContent = `${fmtInt(summary.totalRows)} registros em memória · ${fmtBytes(file.size)} guardados em disco.`;
    if (badgeEl) badgeEl.textContent = 'Salvo localmente';
  } else {
    if (summaryEl) summaryEl.textContent = `${fmtInt(summary.totalRows)} registros em memória · ainda não salvos em disco.`;
    if (badgeEl) badgeEl.textContent = 'Não salvo';
  }
}

async function saveNow({ silent = false, reason = 'manual' } = {}) {
  if (!isDesktop()) {
    if (!silent) toast.info('Somente no desktop', 'A persistência em disco funciona no aplicativo Electron.');
    return { saved: false };
  }
  if (saving || loading) return { saved: false, busy: true };
  if (!library.hasData()) return { saved: false, empty: true };
  if (library.isDatabase?.()) {
    if (!silent) {
      toast.info(
        'Base no banco SQLite',
        'No modo banco, os dados já estão no arquivo .sqlite — não há snapshot a gerar. O arquivo do banco é a própria persistência.',
        { duration: 7000 },
      );
      setStatusText('Base SQLite: dados no arquivo do banco');
    }
    return { saved: false, database: true };
  }
  const rowTotal = library.summary().totalRows;
  if (rowTotal > MAX_SNAPSHOT_ROWS) {
    if (!silent) {
      toast.warning(
        'Base grande demais para salvar',
        `${fmtInt(rowTotal)} registros excedem o limite de ${fmtInt(MAX_SNAPSHOT_ROWS)} do snapshot local. Importe e salve uma regional por vez.`,
        { duration: 9000 },
      );
      setStatusText('Salvamento pausado: base muito grande');
    }
    return { saved: false, tooLarge: true };
  }
  saving = true;
  bus.emit('project:saving', { reason });
  if (!silent) setStatusText('Compactando base para disco…', true);
  try {
    const snapshot = await buildSnapshotBuffer();
    const meta = {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      savedAt: Date.now(),
      rows: snapshot.rows,
      rawBytes: snapshot.jsonBytes,
      layers: Object.fromEntries(
        Object.entries(snapshot.doc.layers).map(([type, payload]) => [type, payload.rowCount]),
      ),
      imports: snapshot.doc.importHistory?.length || 0,
    };
    const result = await window.desktop.projectWriteAutosave(snapshot.buffer, meta);
    if (!result?.saved) throw new Error(result?.error || 'Falha ao gravar o snapshot.');
    lastSavedSignature = signature();
    status = await window.desktop.projectStatus().catch(() => status);
    renderStorage();
    bus.emit('project:saved', { bytes: result.bytes, rows: snapshot.rows, reason });
    if (!silent) {
      const ratio = 1 - snapshot.compressedBytes / snapshot.jsonBytes;
      toast.success(
        'Base salva localmente',
        `${fmtInt(snapshot.rows)} registros · ${fmtBytes(snapshot.compressedBytes)} em disco (${(ratio * 100).toFixed(0)}% menor que o JSON).`,
        { duration: 5000 },
      );
      setStatusText('Base salva localmente');
    }
    return { saved: true, bytes: result.bytes, rows: snapshot.rows };
  } catch (error) {
    console.error('[projeto] save', error);
    bus.emit('project:save-error', { error: error.message });
    if (!silent) {
      toast.error('Não foi possível salvar', error.message);
      setStatusText('Falha ao salvar a base');
    }
    return { saved: false, error: error.message };
  } finally {
    saving = false;
  }
}

function scheduleAutosave() {
  if (!settings.autosave || suppressAutosave || !isDesktop()) return;
  if (library.isDatabase?.()) return;
  if (library.summary().totalRows > MAX_SNAPSHOT_ROWS) {
    if (!sizeWarningShown) {
      sizeWarningShown = true;
      toast.warning(
        'Salvamento automático pausado',
        `A base passa de ${fmtInt(MAX_SNAPSHOT_ROWS)} registros. O snapshot local não é gerado para evitar travamentos; importe uma regional por vez para manter o salvamento.`,
        { duration: 9000 },
      );
      setStatusText('Salvamento automático pausado: base muito grande');
    }
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (signature() === lastSavedSignature) return;
    saveNow({ silent: true, reason: 'auto' });
  }, 1500);
}

async function clearSaved({ silent = false } = {}) {
  if (!isDesktop()) return { cleared: false };
  try {
    await window.desktop.projectClearAutosave();
  } catch (error) {
    if (!silent) toast.error('Falha ao limpar disco', error.message);
    return { cleared: false };
  }
  lastSavedSignature = '';
  await refreshStatus();
  return { cleared: true };
}

async function openBuffer(buffer, { name = 'projeto.neogrid', replace = true } = {}) {
  if (loading) return { opened: false };
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (library.hasData() && replace) {
    const ok = await confirmAction({
      title: 'Substituir a base atual?',
      text: `O projeto “${name}” vai substituir os ${fmtInt(library.summary().totalRows)} registros em memória.`,
      confirmLabel: 'Substituir base',
    });
    if (!ok) return { opened: false, cancelled: true };
  }
  loading = true;
  bus.emit('project:loading', { name });
  setStatusText(`Abrindo ${name}…`, true);
  try {
    const { doc, jsonBytes } = await parseDocument(bytes);
    const result = await restoreDocument(doc, ({ done, total }) => {
      setStatusText(`Restaurando base… ${fmtInt(done)} de ${fmtInt(total)}`, true);
    });
    lastSavedSignature = '';
    bus.emit('project:loaded', { name, rows: result.rows, savedAt: result.savedAt });
    toast.success('Projeto aberto', `${fmtInt(result.rows)} registros restaurados de ${fmtBytes(bytes.length)} (JSON ${fmtBytes(jsonBytes)}).`, { duration: 5200 });
    setStatusText(`${fmtInt(result.rows)} registros restaurados`);
    if (settings.autosave) scheduleAutosave();
    else await refreshStatus();
    deps.navigate?.('map');
    setTimeout(() => deps.fitData?.({ animate: false }), 250);
    return { opened: true, rows: result.rows };
  } catch (error) {
    console.error('[projeto] open', error);
    toast.error('Não foi possível abrir o projeto', error.message);
    setStatusText('Falha ao abrir o projeto');
    return { opened: false, error: error.message };
  } finally {
    loading = false;
  }
}

async function openFileObject(file) {
  if (!file) return { opened: false };
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    return openBuffer(buffer, { name: file.name });
  } catch (error) {
    toast.error('Não foi possível ler o arquivo', error.message);
    return { opened: false, error: error.message };
  }
}

async function openFileDialog() {
  if (!isDesktop()) {
    toast.info('Somente no desktop', 'Abrir projetos .neogrid funciona no aplicativo Electron.');
    return { opened: false };
  }
  const result = await window.desktop.projectOpenFile();
  if (!result || result.canceled) return { opened: false, cancelled: true };
  if (result.error) {
    toast.error('Não foi possível abrir', result.error);
    return { opened: false, error: result.error };
  }
  return openBuffer(new Uint8Array(result.buffer), { name: result.name || 'projeto.neogrid' });
}

async function saveAsDialog() {
  if (!isDesktop()) {
    toast.info('Somente no desktop', 'Exportar o projeto funciona no aplicativo Electron.');
    return { saved: false };
  }
  if (!library.hasData()) {
    toast.info('Nada para salvar', 'Importe CSVs ou abra um projeto antes de exportar.');
    return { saved: false };
  }
  setStatusText('Compactando projeto…', true);
  try {
    const snapshot = await buildSnapshotBuffer();
    const date = new Date().toISOString().slice(0, 10);
    const result = await window.desktop.projectSaveAs(
      snapshot.buffer,
      `neogrid_projeto_${date}${PROJECT_EXTENSION}`,
    );
    if (!result?.saved) {
      setStatusText('Pronto');
      return { saved: false, cancelled: !result?.error };
    }
    library.addExport({
      format: 'NEOGRID',
      name: (result.path || '').split(/[\\/]/).pop() || 'projeto.neogrid',
      type: 'project',
      rows: snapshot.rows,
      bytes: result.bytes,
      path: result.path || '',
    });
    const ratio = 1 - snapshot.compressedBytes / snapshot.jsonBytes;
    toast.success(
      'Projeto exportado',
      `${fmtInt(snapshot.rows)} registros · ${fmtBytes(result.bytes)} (${(ratio * 100).toFixed(0)}% menor).`,
      result.path ? {
        duration: 6500,
        actionLabel: 'Mostrar na pasta',
        action: () => window.desktop?.revealFile(result.path),
      } : { duration: 5000 },
    );
    setStatusText('Projeto exportado');
    return { saved: true, path: result.path };
  } catch (error) {
    toast.error('Falha ao exportar projeto', error.message);
    setStatusText('Falha ao exportar projeto');
    return { saved: false, error: error.message };
  }
}

async function autoload() {
  if (!isDesktop()) return { loaded: false };
  const statusNow = await refreshStatus();
  if (!statusNow?.file?.exists) return { loaded: false, empty: true };
  loading = true;
  setStatusText('Restaurando base salva…', true);
  try {
    const result = await window.desktop.projectReadAutosave();
    if (!result?.found) return { loaded: false, empty: true };
    const bytes = new Uint8Array(result.buffer);
    const { doc } = await parseDocument(bytes);
    const restored = await restoreDocument(doc, ({ done, total }) => {
      setStatusText(`Restaurando base… ${fmtInt(done)} de ${fmtInt(total)}`, true);
    });
    lastSavedSignature = signature();
    await refreshStatus();
    bus.emit('project:loaded', { name: 'autosave', rows: restored.rows, savedAt: restored.savedAt, silent: true });
    setStatusText(`${fmtInt(restored.rows)} registros restaurados do disco`);
    return { loaded: true, rows: restored.rows };
  } catch (error) {
    console.error('[projeto] autoload', error);
    toast.warning(
      'Snapshot local ignorado',
      'O salvamento automático estava ilegível e foi ignorado. Importe os CSVs novamente.',
    );
    setStatusText('Pronto');
    return { loaded: false, error: error.message };
  } finally {
    loading = false;
  }
}

function bindInterface() {
  $('#settingsAutosave')?.addEventListener('change', async (event) => {
    const { updateSetting } = await import('../core/settings.js');
    updateSetting('autosave', event.target.checked);
    if (event.target.checked) {
      toast.info('Salvamento automático ativado', 'A base será compactada e guardada em disco após cada importação.');
      scheduleAutosave();
    } else {
      clearTimeout(saveTimer);
      toast.info('Salvamento automático pausado', 'Use “Salvar agora” para guardar a base manualmente.');
    }
  });

  $('#projectSaveNow')?.addEventListener('click', () => saveNow({ silent: false }));
  $('#projectSaveAs')?.addEventListener('click', saveAsDialog);
  $('#projectOpen')?.addEventListener('click', openFileDialog);

  bus.on('data:changed', () => {
    renderStorage();
    if (suppressAutosave) return;
    if (!library.hasData()) {
      clearTimeout(saveTimer);
      lastSavedSignature = '';
      sizeWarningShown = false;
      return;
    }
    if (library.summary().totalRows <= MAX_SNAPSHOT_ROWS) sizeWarningShown = false;
    if (settings.autosave) scheduleAutosave();
  });
  bus.on('import:finish', ({ cancelled, added }) => {
    if (!cancelled && added > 0 && settings.autosave) scheduleAutosave();
  });
  bus.on('settings:changed', ({ key }) => {
    if (key === 'autosave' || key === 'all') {
      const checkbox = $('#settingsAutosave');
      if (checkbox) checkbox.checked = settings.autosave !== false;
    }
  });
  bus.on('project:saved', markSidebarSaved);
  bus.on('project:loaded', markSidebarSaved);
}

function markSidebarSaved() {
  const el = $('#sidebarLayers');
  if (el && !/salvo/.test(el.textContent || '')) el.textContent = `${el.textContent} · salvo`;
}

export function initPersistence(options = {}) {
  deps = options;
  const checkbox = $('#settingsAutosave');
  if (checkbox) checkbox.checked = settings.autosave !== false;
  bindInterface();
  return {
    autoload,
    saveNow,
    scheduleAutosave,
    openFileDialog,
    saveAsDialog,
    openFileObject,
    openBuffer,
    clearSaved,
    refreshStatus,
    getStatus: () => status,
    get saving() { return saving; },
    get loading() { return loading; },
  };
}

export const persistence = {
  init: initPersistence,
  saveNow,
  scheduleAutosave,
  openFileDialog,
  saveAsDialog,
  openFileObject,
  openBuffer,
  clearSaved,
  refreshStatus,
  autoload,
};
