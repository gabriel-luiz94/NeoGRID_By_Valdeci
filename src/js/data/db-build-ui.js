/* Diálogo de conversão CSV → SQLite embutida no aplicativo. */
import { $, openDialog, closeDialog } from '../core/dom.js';
import { esc, fmtInt } from '../core/format.js';
import { toast } from '../ui/toast.js';
import { openDatabaseInfo } from './import-controller.js';

let els = {};
let running = false;
let unsubscribe = null;
let lastOutput = '';

function setRunning(value) {
  running = value;
  if (els.start) els.start.disabled = value;
  if (els.cancel) els.cancel.hidden = !value;
  if (els.progress) els.progress.hidden = !value && !els.log?.textContent;
  if (els.foot) {
    els.foot.textContent = value
      ? 'Conversão em andamento — você pode continuar usando o programa.'
      : 'A conversão leva alguns minutos e roda em segundo plano.';
  }
}

function appendLog(message) {
  if (!els.log) return;
  els.log.hidden = false;
  const line = document.createElement('div');
  line.textContent = message;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
  while (els.log.children.length > 400) els.log.firstChild.remove();
}

function setStatus(message, percent = null) {
  if (els.status) els.status.textContent = message;
  if (els.fill && percent != null) {
    els.fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

function handleProgress(event) {
  if (event.type === 'log') {
    appendLog(event.message);
    return;
  }
  if (event.type === 'phase' && (event.phase === 'scan' || event.phase === 'load')) {
    const action = event.phase === 'scan' ? 'Analisando' : 'Carregando';
    setStatus(`${action} ${event.layer} · ${event.file} (${event.fileNumber}/${event.fileCount})…`);
    return;
  }
  if ((event.type === 'scan-progress' || event.type === 'load-progress') && event.totalBytes > 0) {
    const percent = Math.floor((event.bytes / event.totalBytes) * 100);
    setStatus(`${event.layer} · ${event.file} · ${percent}%`, percent);
    return;
  }
  if (event.type === 'done') {
    finishBuild(null, event);
    return;
  }
  if (event.type === 'cancelled') {
    finishBuild(new Error('Conversão cancelada.'), null);
    return;
  }
  if (event.type === 'error') {
    finishBuild(new Error(event.error || 'Falha na conversão.'), null);
  }
}

async function finishBuild(error, result) {
  setRunning(false);
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (error) {
    setStatus(error.message);
    appendLog(`FALHA: ${error.message}`);
    toast.error('Conversão falhou', error.message);
    return;
  }
  const manifest = result?.manifest;
  const rows = manifest?.rows || 0;
  setStatus(`Banco criado: ${fmtInt(rows)} registros · rejeitos ${fmtInt(manifest?.rejectsTotal || 0)}.`, 100);
  appendLog(`OK: ${result.output} (${fmtInt(rows)} registros).`);
  toast.success('Banco SQLite gerado', `${fmtInt(rows)} registros · ${fmtInt(manifest?.rejectsTotal || 0)} rejeitos em quarentena.`, { duration: 7000 });
  lastOutput = result.output;
  // Oferece abrir imediatamente.
  const { confirmAction } = await import('../ui/confirm.js');
  const open = await confirmAction({
    title: 'Abrir o banco agora?',
    text: `O banco com ${fmtInt(rows)} registros foi gerado. Deseja abri-lo no mapa?`,
    confirmLabel: 'Abrir banco',
    cancelLabel: 'Depois',
    danger: false,
  });
  if (open) {
    try {
      const opened = await window.desktop.dbOpen(lastOutput);
      if (!opened?.opened) throw new Error(opened?.error || 'Falha ao abrir o banco.');
      closeDialog(els.dialog);
      await openDatabaseInfo(opened.info);
    } catch (openError) {
      toast.error('Não foi possível abrir o banco', openError.message);
    }
  }
}

async function start() {
  if (running) return;
  if (!window.desktop?.dbBuildStart) {
    toast.info('Somente no desktop', 'A conversão embutida funciona no aplicativo Electron.');
    return;
  }
  const source = els.source?.value?.trim();
  const output = els.output?.value?.trim();
  if (!source) {
    toast.warning('Selecione a pasta', 'Escolha a pasta com os CSVs da extração.');
    return;
  }
  if (!output) {
    toast.warning('Defina a saída', 'Escolha onde salvar o arquivo .sqlite.');
    return;
  }
  setRunning(true);
  if (els.log) {
    els.log.hidden = false;
    els.log.innerHTML = '';
  }
  setStatus('Iniciando…', 0);
  appendLog(`Origem: ${source}`);
  appendLog(`Destino: ${output}`);
  if (unsubscribe) unsubscribe();
  unsubscribe = window.desktop.onDbBuildProgress(handleProgress);
  try {
    const result = await window.desktop.dbBuildStart({ source, output, rejectLimit: 0.005 });
    // O resultado final também chega via evento; aqui é redundância de segurança.
    if (result?.finished && result?.manifest) {
      finishBuild(null, result);
    } else if (result && !result.started) {
      finishBuild(new Error(result.error || 'Não foi possível iniciar.'), null);
    }
  } catch (error) {
    finishBuild(error, null);
  }
}

export function openDbBuildDialog() {
  if (!els.dialog) return;
  openDialog(els.dialog);
}

export function initDbBuildDialog() {
  els = {
    dialog: $('#dbBuildDialog'),
    source: $('#dbBuildSource'),
    output: $('#dbBuildOutput'),
    start: $('#dbBuildStart'),
    cancel: $('#dbBuildCancel'),
    progress: $('#dbBuildProgress'),
    fill: $('#dbBuildBarFill'),
    status: $('#dbBuildStatus'),
    log: $('#dbBuildLog'),
    foot: $('#dbBuildFoot'),
  };
  if (!els.dialog) return;

  document.querySelector('#importBuildDb')?.addEventListener('click', () => {
    openDbBuildDialog();
  });

  document.querySelector('#dbBuildPickSource')?.addEventListener('click', async () => {
    const result = await window.desktop?.dbPickFolder?.();
    if (result?.cancelled) return;
    if (els.source) els.source.value = result.path || '';
    // Sugere a saída ao lado da origem.
    if (result?.path && !els.output?.value) {
      const month = new Date().toISOString().slice(0, 7).replace('-', '');
      els.output.value = `${result.path}\\neogrid_base_${month}.sqlite`;
    }
  });

  document.querySelector('#dbBuildPickZip')?.addEventListener('click', async () => {
    const result = await window.desktop?.dbPickZip?.();
    if (result?.cancelled) return;
    if (els.source) els.source.value = result.path || '';
    if (result?.path && !els.output?.value) {
      const month = new Date().toISOString().slice(0, 7).replace('-', '');
      els.output.value = `${result.path.replace(/\.zip$/i, '')}_${month}.sqlite`;
    }
  });

  document.querySelector('#dbBuildPickOutput')?.addEventListener('click', async () => {
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    const result = await window.desktop?.dbPickOutput?.(`neogrid_base_${month}.sqlite`);
    if (result?.cancelled) return;
    if (els.output) els.output.value = result.path || '';
  });

  els.start?.addEventListener('click', start);
  els.cancel?.addEventListener('click', async () => {
    await window.desktop?.dbBuildCancel?.();
    if (els.status) els.status.textContent = 'Cancelando (termina o arquivo atual)…';
  });

  return { open: openDbBuildDialog };
}
