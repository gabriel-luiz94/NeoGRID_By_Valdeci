import { library } from './library.js';
import { LAYER_META } from './schema.js';
import { csvEscape, downloadText, fmtInt, safeFilename } from '../core/format.js';
import { toast } from '../ui/toast.js';

export function buildCsv(store, indices, columns) {
  const lines = [columns.map((column) => csvEscape(column)).join(';')];
  for (const index of indices) {
    const row = store.rows[index];
    lines.push(columns.map((column) => {
      const columnIndex = store.colIndex(column);
      return csvEscape(columnIndex >= 0 ? row[columnIndex] : '');
    }).join(';'));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function exportLayerCsv({ type, indices = null, columns = null, defaultName = '' }) {
  const store = library.get(type);
  if (!store || !store.stats.count) {
    toast.info('Nada para exportar', `A camada ${LAYER_META[type]?.name || type} não possui registros.`);
    return { saved: false };
  }
  const rows = Array.isArray(indices) ? indices : Array.from({ length: store.stats.count }, (_, index) => index);
  const selectedColumns = columns?.length ? columns : store.headers.filter((header) => !/_DESC$/.test(header));
  const content = buildCsv(store, rows, selectedColumns);
  const date = new Date().toISOString().slice(0, 10);
  const filename = safeFilename(defaultName || `neogrid_${type}_${date}.csv`);
  const bytes = new Blob([content]).size;

  let result;
  if (window.desktop?.saveFile) {
    result = await window.desktop.saveFile({
      defaultName: filename,
      title: 'Salvar CSV',
      content,
      filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
    });
  } else {
    downloadText(content, filename, 'text/csv;charset=utf-8');
    result = { saved: true };
  }

  if (!result?.saved) {
    if (result?.error) toast.error('Falha ao salvar', result.error);
    return result || { saved: false };
  }

  library.addExport({
    format: 'CSV',
    name: filename,
    type,
    rows: rows.length,
    bytes,
    path: result.path || '',
  });

  toast.success(
    'CSV exportado',
    `${fmtInt(rows.length)} registros · ${(bytes / 1024).toFixed(0)} KB`,
    result.path ? {
      duration: 6000,
      actionLabel: 'Mostrar na pasta',
      action: () => window.desktop?.revealFile(result.path),
    } : { duration: 4500 },
  );
  return { ...result, filename, rows: rows.length, bytes };
}
