import { library } from './library.js';
import { bus } from '../core/bus.js';
import { detectLayerByName, detectLayerByHeaders, LAYER_META, LAYER_TYPES } from './schema.js';
import { $, closeDialog, openDialog } from '../core/dom.js';
import { esc, fmtBytes, fmtInt } from '../core/format.js';
import { toast } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';
import { requirePermission } from '../core/auth.js';

const WARN_TOTAL_BYTES = 150 * 1024 * 1024;
const HARD_TOTAL_BYTES = 600 * 1024 * 1024;
const WARN_TOTAL_ROWS = 450000;
const HARD_TOTAL_ROWS = 950000;

/** Projetos `.neogrid` são leitura para qualquer perfil; CSV/base exige permissão. */
function allowedToLoad(files) {
  const list = [...(files || [])];
  const onlyProjects = list.length > 0 && list.every((file) => /\.neogrid$/i.test(file.name));
  if (onlyProjects) return true;
  return requirePermission('data:import', 'importar dados');
}

async function estimateFileRows(file) {
  try {
    const sampleBytes = Math.min(file.size, 65536);
    const sample = await file.slice(0, sampleBytes).text();
    const lines = sample.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length < 2 || !sampleBytes) return 0;
    const average = sample.length / lines.length;
    if (!Number.isFinite(average) || average <= 0) return 0;
    return Math.max(0, Math.round(file.size / average) - 1);
  } catch {
    return 0;
  }
}

const state = {
  entries: [],
  importing: false,
  cancelled: false,
  currentWorker: null,
  currentCancel: null,
  currentFinish: null,
  currentEntry: null,
  dragDepth: 0,
};

let deps = {};
let els = {};
let keyCounter = 0;

const typeOptions = (selected) => {
  const options = [`<option value=""${selected ? '' : ' selected'}>Detectar tipo…</option>`];
  for (const type of LAYER_TYPES) {
    options.push(`<option value="${type}"${selected === type ? ' selected' : ''}>${LAYER_META[type].name}</option>`);
  }
  return options.join('');
};

const statusLabel = (entry) => {
  if (entry.status === 'reading') {
    if (entry.rows) return `${fmtInt(entry.rows)} linhas · ${Math.round(entry.progress || 0)}%`;
    return 'Lendo…';
  }
  if (entry.status === 'done') return `${fmtInt(entry.rows)} linhas`;
  if (entry.status === 'error') return entry.error || 'Erro';
  if (entry.status === 'cancelled') return 'Cancelado';
  if (!entry.type) return 'Tipo automático';
  return 'Pronto';
};

const entryRow = (entry) => `
  <div class="import-file ${entry.status === 'done' ? 'is-done' : ''} ${entry.status === 'error' ? 'is-error' : ''}" data-id="${entry.id}">
    <span class="import-file-icon"><svg class="icon"><use href="#i-file-csv"></use></svg></span>
    <div class="import-file-copy">
      <strong title="${esc(entry.name)}">${esc(entry.name)}</strong>
      <span>${fmtBytes(entry.size)}${entry.delimiter ? ` · separador “${entry.delimiter === '\t' ? 'TAB' : entry.delimiter}”` : ''}${entry.encoding ? ` · ${entry.encoding.toUpperCase()}` : ''}</span>
    </div>
    <select class="select import-file-type" data-action="type" aria-label="Tipo do arquivo ${esc(entry.name)}" ${state.importing || entry.status === 'done' ? 'disabled' : ''}>
      ${typeOptions(entry.type)}
    </select>
    <span class="import-file-status">${esc(statusLabel(entry))}</span>
    <button class="icon-btn import-file-remove" data-action="remove" title="Remover arquivo" ${state.importing ? 'disabled' : ''}>
      <svg class="icon"><use href="#i-x"></use></svg>
    </button>
    <div class="import-file-progress"><span style="width:${Math.max(0, Math.min(100, entry.progress || 0))}%"></span></div>
  </div>`;

function renderList() {
  if (!els.list) return;
  els.list.innerHTML = state.entries.map(entryRow).join('');
}

function updateEntry(entry) {
  const row = els.list?.querySelector(`[data-id="${entry.id}"]`);
  if (!row) return;
  row.classList.toggle('is-done', entry.status === 'done');
  row.classList.toggle('is-error', entry.status === 'error');
  const status = row.querySelector('.import-file-status');
  if (status) status.textContent = statusLabel(entry);
  const bar = row.querySelector('.import-file-progress span');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, entry.progress || 0))}%`;
  const select = row.querySelector('.import-file-type');
  if (select) {
    select.value = entry.type || '';
    select.disabled = state.importing || entry.status === 'done';
  }
}

function refreshFooter() {
  const usable = state.entries.filter((entry) => entry.status !== 'done' && entry.status !== 'error');
  const totalBytes = state.entries.reduce((total, entry) => total + entry.size, 0);
  if (els.foot) {
    if (!state.entries.length) {
      els.foot.textContent = 'Nenhum arquivo selecionado';
    } else if (state.importing) {
      const reading = state.entries.find((entry) => entry.status === 'reading');
      els.foot.textContent = reading
        ? `Importando ${reading.name} · ${Math.round(reading.progress || 0)}%`
        : 'Preparando importação…';
    } else {
      els.foot.textContent = `${state.entries.length} arquivo${state.entries.length > 1 ? 's' : ''} · ${fmtBytes(totalBytes)}${state.entries.some((entry) => !entry.type) ? ' · tipos detectados automaticamente' : ''}${totalBytes > WARN_TOTAL_BYTES ? ' · base extensa: prefira uma regional por vez' : ''}`;
    }
  }
  if (els.start) {
    els.start.disabled = state.importing || !state.entries.length || !usable.length;
    els.start.innerHTML = state.importing
      ? '<span class="search-spinner"></span> Importando…'
      : '<svg class="icon"><use href="#i-upload"></use></svg> Importar dados';
  }
  if (els.cancel) {
    els.cancel.textContent = state.importing ? 'Cancelar importação' : 'Cancelar';
  }
}

function setImporting(value) {
  state.importing = value;
  els.dialog.querySelectorAll('[data-close]').forEach((button) => {
    button.disabled = value;
  });
  if (els.drop) els.drop.classList.toggle('is-busy', value);
  refreshFooter();
  renderList();
}

async function detectTypeFromFile(file) {
  try {
    const text = await file.slice(0, 65536).text();
    const firstLine = (text.split(/\r?\n/, 1)[0] || '').replace(/^\uFEFF/, '');
    const delimiter = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
    return detectLayerByHeaders(firstLine.split(delimiter));
  } catch {
    return null;
  }
}

async function openProjectFiles(files) {
  const { persistence } = await import('./persistence.js');
  for (const file of files) {
    const result = await persistence.openFileObject(file);
    if (result?.opened) return true;
    if (result?.cancelled) return false;
  }
  return false;
}

async function addFiles(files) {
  if (state.importing) {
    toast.warning('Importação em andamento', 'Aguarde ou cancele a importação atual antes de adicionar arquivos.');
    return;
  }
  const all = [...files];
  if (!allowedToLoad(all)) return;
  const projects = all.filter((file) => /\.neogrid$/i.test(file.name));
  if (projects.length) {
    closeImport();
    await openProjectFiles(projects);
    const rest = all.filter((file) => !/\.neogrid$/i.test(file.name));
    if (rest.length) await addFiles(rest);
    return;
  }
  const incoming = all.filter((file) => /\.(csv|txt)$/i.test(file.name));
  if (!incoming.length) {
    toast.warning('Nenhum arquivo válido', 'Selecione CSVs (.csv/.txt) ou um projeto (.neogrid).');
    return;
  }

  for (const file of incoming) {
    const duplicate = state.entries.some(
      (entry) => entry.name === file.name && entry.size === file.size && entry.file.lastModified === file.lastModified,
    );
    if (duplicate) continue;
    const id = `file-${++keyCounter}`;
    const entry = {
      id,
      file,
      name: file.name,
      size: file.size,
      type: detectLayerByName(file.name),
      status: 'ready',
      progress: 0,
      rows: 0,
      headers: null,
      error: '',
      delimiter: '',
    };
    state.entries.push(entry);
    if (!entry.type) {
      detectTypeFromFile(file).then((type) => {
        if (!entry.type && type) {
          entry.type = type;
          updateEntry(entry);
          refreshFooter();
        }
      });
    }
  }

  renderList();
  refreshFooter();
  if (state.entries.length && !els.dialog.open) openImport();
}

function clearEntries() {
  state.entries = [];
  renderList();
  refreshFooter();
}

function openImport(files = null) {
  if (!allowedToLoad(files)) return;
  if (files?.length) {
    if ([...files].some((file) => /\.neogrid$/i.test(file.name))) {
      addFiles(files);
      return;
    }
    clearEntries();
    addFiles(files);
  } else {
    renderList();
    refreshFooter();
  }
  openDialog(els.dialog);
}

function closeImport() {
  closeDialog(els.dialog);
}

function cancelCurrent({ request = false } = {}) {
  if (state.importing) {
    state.cancelled = true;
    state.currentCancel?.();
    state.currentWorker?.terminate();
    state.currentWorker = null;
    return;
  }
  closeImport();
}

async function openDatabaseDialog() {
  if (!window.desktop?.dbOpenDialog) {
    toast.info('Somente no desktop', 'A base SQLite funciona no aplicativo Electron.');
    return;
  }
  if (state.importing) {
    toast.warning('Importação em andamento', 'Aguarde ou cancele a importação atual.');
    return;
  }
  let result;
  try {
    result = await window.desktop.dbOpenDialog();
  } catch (error) {
    toast.error('Não foi possível abrir', error.message);
    return;
  }
  if (!result?.opened) {
    if (result?.error) toast.error('Não foi possível abrir o banco', result.error);
    return;
  }
  await openDatabaseInfo(result.info);
}

export async function openDatabaseInfo(info) {
  if (!info) return false;
  try {
    if (library.hasData() && !library.isDatabase()) {
      const { confirmAction } = await import('../ui/confirm.js');
      const ok = await confirmAction({
        title: 'Substituir a base atual?',
        text: `A base SQLite com ${fmtInt(info.rows || 0)} registros vai substituir os ${fmtInt(library.summary().totalRows)} registros em memória.`,
        confirmLabel: 'Abrir banco',
        danger: false,
      });
      if (!ok) return false;
    }
    if (library.isDatabase()) await library.closeDatabase();
    library.clear();
    library.openDatabase(info);
    closeImport();
    clearEntries();
    toast.success(
      'Base SQLite aberta',
      `${fmtInt(info.rows || 0)} registros · o mapa consulta por área, sem carregar tudo na memória.`,
      { duration: 6000 },
    );
    if (info.rejects > 0) {
      setTimeout(() => toast.warning(
        'Quarentena na conversão',
        `${fmtInt(info.rejects)} linha(s) malformadas foram separadas na conversão e não entraram no banco. Veja o manifesto do build.`,
        { duration: 8000 },
      ), 600);
    }
    deps.navigate?.('map');
    setTimeout(() => deps.mapView?.fitData({ animate: false }), 250);
    return true;
  } catch (error) {
    toast.error('Não foi possível abrir o banco', error.message);
    return false;
  }
}

function importEntry(entry, delimiter, encoding) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL('./workers/csv-worker.js', import.meta.url));
    } catch (error) {
      entry.status = 'error';
      entry.error = error.message;
      updateEntry(entry);
      resolve({ ok: false });
      return;
    }
    state.currentWorker = worker;
    entry.status = 'reading';
    entry.progress = 0;
    entry.rows = 0;
    entry.added = 0;
    entry.error = '';
    updateEntry(entry);
    refreshFooter();

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      state.currentFinish = null;
      state.currentEntry = null;
      state.currentCancel = null;
      worker.terminate();
      if (state.currentWorker === worker) state.currentWorker = null;
      resolve(result);
    };
    state.currentFinish = finish;
    state.currentEntry = entry;
    state.currentCancel = () => {
      entry.status = 'cancelled';
      entry.error = 'Cancelado pelo operador';
      updateEntry(entry);
      finish({ ok: false, cancelled: true });
    };

    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.kind === 'start') {
        entry.delimiter = message.delimiter;
        entry.encoding = message.encoding;
        updateEntry(entry);
        return;
      }

      if (message.kind === 'headers') {
        entry.headers = message.headers;
        if (!entry.type) {
          entry.type = detectLayerByHeaders(message.headers) || detectLayerByName(entry.name);
          if (!entry.type) {
            entry.status = 'error';
            entry.error = 'Tipo não identificado';
            updateEntry(entry);
            bus.emit('import:progress', { file: entry.name, percent: 0, rows: 0, note: 'Tipo não identificado' });
            finish({ ok: false });
            return;
          }
          updateEntry(entry);
        }
        return;
      }

      if (message.kind === 'batch') {
        if (!entry.headers || !entry.type) return;
        try {
          entry.added += library.addBatch(entry.type, entry.headers, message.rows);
          entry.rows += message.rows.length;
          updateEntry(entry);
        } catch (error) {
          entry.status = 'error';
          entry.error = error.message;
          updateEntry(entry);
          finish({ ok: false, error });
        }
        return;
      }

      if (message.kind === 'progress') {
        entry.progress = message.percent || 0;
        entry.rows = message.rows || entry.rows;
        updateEntry(entry);
        refreshFooter();
        bus.emit('import:progress', {
          file: entry.name,
          percent: entry.progress,
          rows: entry.rows,
          totalFiles: state.entries.length,
        });
        return;
      }

      if (message.kind === 'done') {
        entry.status = 'done';
        entry.progress = 100;
        entry.rows = message.rows || entry.rows;
        if (message.parseErrors) entry.error = `${message.parseErrors} aviso(s) de leitura`;
        library.addImport({
          fileName: entry.name,
          type: entry.type,
          size: entry.size,
          rows: entry.rows,
          parseErrors: message.parseErrors || 0,
          delimiter: message.delimiter || entry.delimiter,
          at: Date.now(),
        });
        updateEntry(entry);
        finish({
          ok: true,
          added: entry.added,
          rows: entry.rows,
          parseErrors: message.parseErrors || 0,
        });
        return;
      }

      if (message.kind === 'error') {
        entry.status = 'error';
        entry.error = message.message || 'Erro de leitura';
        updateEntry(entry);
        finish({ ok: false });
      }
    };

    worker.onerror = (event) => {
      entry.status = 'error';
      entry.error = event.message || 'Falha no processamento';
      updateEntry(entry);
      finish({ ok: false });
    };

    worker.postMessage({
      kind: 'start',
      file: entry.file,
      fileName: entry.name,
      delimiter,
      encoding,
    });
  });
}

async function startImport() {
  if (state.importing) return;
  const entries = state.entries.filter((entry) => entry.status === 'ready' || entry.status === 'cancelled' || entry.status === 'error');
  if (!entries.length) return;

  const totalBytes = entries.reduce((total, entry) => total + (entry.size || 0), 0);
  const clearFirst = els.clear?.checked && library.hasData();
  const existingRows = clearFirst ? 0 : library.summary().totalRows;
  let estimatedRows = 0;
  const estimates = await Promise.all(entries.map((entry) => estimateFileRows(entry.file)));
  estimatedRows = estimates.reduce((total, rows) => total + rows, 0);
  const projectedRows = existingRows + estimatedRows;
  const sizeLabel = `${fmtBytes(totalBytes)}${estimatedRows ? ` (~${fmtInt(estimatedRows)} registros estimados)` : ''}`;
  if (totalBytes > HARD_TOTAL_BYTES || projectedRows > HARD_TOTAL_ROWS) {
    await confirmAction({
      title: 'Base grande demais para a memória',
      text: `A seleção tem ${sizeLabel}${existingRows ? ` e a base atual já tem ${fmtInt(existingRows)} registros` : ''}. O NeoGrid mantém todos os registros em memória e ainda gera um snapshot local; essa quantidade pode esgotar a memória e travar o aplicativo. Importe uma regional por vez (Poste + Rede BT + Rede MT + Instalação) ou divida os arquivos em partes menores.`,
      confirmLabel: 'Entendi',
      cancelLabel: 'Voltar',
      danger: true,
    });
    return;
  }
  if (totalBytes > WARN_TOTAL_BYTES || projectedRows > WARN_TOTAL_ROWS) {
    const proceed = await confirmAction({
      title: 'Base extensa',
      text: `A seleção tem ${sizeLabel}${existingRows ? ` e a base atual já tem ${fmtInt(existingRows)} registros` : ''}. Para manter o aplicativo responsivo, recomendamos importar uma regional por vez. Deseja continuar mesmo assim?`,
      confirmLabel: 'Continuar',
      cancelLabel: 'Voltar',
      danger: false,
    });
    if (!proceed) return;
  }


  state.cancelled = false;
  setImporting(true);
  if (clearFirst) {
    library.clear();
    toast.info('Base limpa', 'Os registros anteriores foram removidos antes da importação.');
  }
  bus.emit('import:start', { files: entries.length });
  const delimiter = els.delimiter?.value || 'auto';
  const encoding = els.encoding?.value || 'auto';
  let filesDone = 0;
  let added = 0;
  let errors = 0;
  let parseWarnings = 0;

  for (const entry of entries) {
    if (state.cancelled) break;
    const result = await importEntry(entry, delimiter, encoding);
    if (result?.ok) {
      filesDone += 1;
      added += result.added || 0;
      parseWarnings += result.parseErrors || 0;
    } else {
      errors += 1;
    }
  }

  const cancelled = state.cancelled;
  state.cancelled = false;
  state.currentCancel = null;
  state.currentFinish = null;
  state.currentEntry = null;
  setImporting(false);

  if (!cancelled || added > 0) {
    // Publica as linhas já incorporadas mesmo em importação parcial.
    library.notifyDataChanged();
  }

  const summary = library.summary();

  if (cancelled) {
    bus.emit('import:finish', { cancelled: true, added, errors, summary });
    toast.warning(
      'Importação cancelada',
      added
        ? `${fmtInt(added)} registros já incorporados à base foram mantidos.`
        : 'Nenhum registro foi incorporado.',
    );
    closeImport();
    return;
  }

  if (!filesDone) {
    bus.emit('import:finish', { cancelled: false, added, errors, summary });
    toast.error('Não foi possível importar', 'Verifique o formato e o cabeçalho dos arquivos selecionados.');
    refreshFooter();
    return;
  }

  closeImport();
  clearEntries();
  els.clear.checked = false;

  toast.success(
    'Importação concluída',
    `${fmtInt(added)} registros incorporados em ${filesDone} arquivo${filesDone > 1 ? 's' : ''}.`,
    { duration: 5200 },
  );
  if (parseWarnings) {
    setTimeout(() => toast.warning('Avisos de leitura', `${parseWarnings} linha(s) apresentaram inconsistências e foram importadas como estão.`), 350);
  }
  if (summary.utmSuspect) {
    setTimeout(() => toast.warning(
      'Coordenadas em UTM detectadas',
      'O mapa espera latitude/longitude (WGS 84). Gere os CSVs com OUT_SR = 4326 para o posicionamento correto.',
    ), 700);
    bus.emit('map:utm-warning', summary);
  }
  if (errors) {
    setTimeout(() => toast.warning('Alguns arquivos falharam', `${errors} arquivo(s) não puderam ser importados.`), 300);
  }

  bus.emit('import:finish', { cancelled: false, added, errors, summary });
  deps.navigate?.('map');
  setTimeout(() => deps.mapView?.fitData({ animate: true }), 180);
}

function init(options) {
  deps = options || {};
  els = {
    dialog: $('#importDialog'),
    form: $('#importForm'),
    drop: $('#importDrop'),
    input: $('#importInput'),
    browse: $('#importBrowse'),
    list: $('#importFiles'),
    delimiter: $('#importDelimiter'),
    encoding: $('#importEncoding'),
    clear: $('#importClear'),
    start: $('#importStart'),
    cancel: $('#importCancel'),
    foot: $('#importFootInfo'),
  };
  if (!els.dialog) return;

  $('#topImport')?.addEventListener('click', () => openImport());
  $('#dataImport')?.addEventListener('click', () => openImport());
  $('#dashImport')?.addEventListener('click', () => openImport());
  $('#mapEmptyImport')?.addEventListener('click', () => openImport());
  $('#importsNew')?.addEventListener('click', () => openImport());
  document.querySelectorAll('[data-import]').forEach((button) => button.addEventListener('click', () => openImport()));

  els.browse?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!state.importing) els.input.click();
  });
  els.drop?.addEventListener('click', (event) => {
    if (!event.target.closest('button') && !state.importing) els.input.click();
  });
  els.input?.addEventListener('change', (event) => {
    addFiles(event.target.files || []);
    event.target.value = '';
  });

  els.list?.addEventListener('change', (event) => {
    const select = event.target.closest('[data-action="type"]');
    if (!select) return;
    const entry = state.entries.find((item) => item.id === select.closest('[data-id]')?.dataset.id);
    if (!entry || state.importing) return;
    entry.type = select.value;
    updateEntry(entry);
    refreshFooter();
  });

  els.list?.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-action="remove"]');
    if (!remove || state.importing) return;
    const id = remove.closest('[data-id]')?.dataset.id;
    state.entries = state.entries.filter((entry) => entry.id !== id);
    renderList();
    refreshFooter();
  });

  els.start?.addEventListener('click', () => {
    window.__importStartedAt = performance.now();
    startImport();
  });
  els.cancel?.addEventListener('click', () => cancelCurrent());
  document.querySelector('#importOpenDb')?.addEventListener('click', () => openDatabaseDialog());
  els.dialog.addEventListener('cancel', (event) => {
    if (state.importing) {
      event.preventDefault();
      cancelCurrent();
    } else {
      clearEntries();
    }
  });
  els.dialog.addEventListener('close', () => {
    if (!state.importing) clearEntries();
  });

  // DnD em toda a aplicação
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    state.dragDepth += 1;
    if (!state.importing && !els.dialog.open) $('#dropOverlay').hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth && !state.importing) $('#dropOverlay').hidden = true;
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    $('#dropOverlay').hidden = true;
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    if (els.dialog.open) {
      if (!state.importing) addFiles(files);
    } else {
      openImport(files);
    }
  });

  bus.on('data:changed', () => {
    if (!library.hasData() && !state.importing) {
      state.entries = [];
    }
  });
}

export const importController = {
  init,
  open: openImport,
  addFiles,
  start: startImport,
  async importDirect(files) {
    openImport(files);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await startImport();
  },
};
