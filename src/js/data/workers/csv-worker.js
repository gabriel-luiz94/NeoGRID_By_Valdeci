/* Parser CSV executado em Web Worker. Streaming por chunks, sem travar a interface. */
'use strict';

try {
  importScripts('../../../vendor/papaparse/papaparse.min.js');
} catch (error) {
  self.postMessage({ kind: 'error', message: 'Falha ao carregar o analisador CSV: ' + error.message });
}

const BATCH_SIZE = 8000;
let cancelled = false;

function cleanHeader(name, index) {
  const cleaned = String(name ?? '').replace(/^\uFEFF/, '').trim().toUpperCase();
  return cleaned || `COLUNA_${index + 1}`;
}

function uniqueHeaders(raw) {
  const counts = new Map();
  return raw.map((name, index) => {
    const base = cleanHeader(name, index);
    const seen = counts.get(base) || 0;
    counts.set(base, seen + 1);
    return seen ? `${base}_${seen + 1}` : base;
  });
}

function sniffDelimiter(file) {
  return file.slice(0, 65536).text().then((text) => {
    const line = (text.split(/\r?\n/, 1)[0] || '').replace(/^\uFEFF/, '');
    let inQuotes = false;
    let semicolon = 0;
    let comma = 0;
    let tab = 0;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes) {
        if (char === ';') semicolon += 1;
        else if (char === ',') comma += 1;
        else if (char === '\t') tab += 1;
      }
    }
    if (semicolon >= comma && semicolon >= tab) return ';';
    if (tab > comma) return '\t';
    return ',';
  });
}

async function detectEncoding(file) {
  try {
    const buffer = await file.slice(0, 65536).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8';
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
    const cut = file.size > 65536 ? Math.max(0, bytes.length - 3) : bytes.length;
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, cut));
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

function postBatches(rows, headers) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    if (cancelled) return;
    self.postMessage({
      kind: 'batch',
      rows: rows.slice(offset, offset + BATCH_SIZE),
      count: Math.min(BATCH_SIZE, rows.length - offset),
    });
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.kind === 'cancel') {
    cancelled = true;
    self.close();
    return;
  }
  if (data.kind !== 'start') return;

  const { file, fileName, delimiter: requestedDelimiter, encoding } = data;
  if (!file) {
    self.postMessage({ kind: 'error', message: 'Arquivo inválido.' });
    return;
  }
  if (typeof Papa === 'undefined') {
    self.postMessage({ kind: 'error', message: 'Analisador CSV indisponível.' });
    return;
  }

  try {
    const delimiter = !requestedDelimiter || requestedDelimiter === 'auto'
      ? await sniffDelimiter(file)
      : requestedDelimiter;
    const resolvedEncoding = !encoding || encoding === 'auto'
      ? await detectEncoding(file)
      : encoding;

    self.postMessage({ kind: 'start', fileName, size: file.size, delimiter, encoding: resolvedEncoding });

    let headers = null;
    let rowCount = 0;
    let parseErrors = 0;
    let firstChunk = true;
    let lastCursor = 0;

    Papa.parse(file, {
      delimiter,
      encoding: resolvedEncoding,
      skipEmptyLines: 'greedy',
      chunkSize: 4 * 1024 * 1024,
      worker: false,
      chunk: (results) => {
        if (cancelled) return;
        parseErrors += results.errors?.length || 0;
        let rows = results.data || [];

        if (firstChunk) {
          firstChunk = false;
          if (!rows.length) {
            self.postMessage({ kind: 'error', message: 'O arquivo parece estar vazio.' });
            return;
          }
          headers = uniqueHeaders(rows[0]);
          rows = rows.slice(1);
          self.postMessage({ kind: 'headers', headers, fileName });
        }

        if (headers && rows.length) {
          rows = rows.filter((row) => {
            if (!Array.isArray(row) || !row.length) return false;
            if (row.length === headers.length && row.every((cell, index) => cleanHeader(cell, index) === headers[index])) {
              return false;
            }
            return row.some((cell) => String(cell ?? '').trim() !== '');
          });
          if (rows.length) {
            rowCount += rows.length;
            postBatches(rows, headers);
          }
        }

        lastCursor = results.meta?.cursor || lastCursor;
        self.postMessage({
          kind: 'progress',
          rows: rowCount,
          bytes: lastCursor,
          totalBytes: file.size,
          percent: file.size ? Math.min(100, (lastCursor / file.size) * 100) : 0,
          delimiter,
        });
      },
      complete: () => {
        if (cancelled) return;
        if (!headers) {
          self.postMessage({ kind: 'error', message: 'Não foi possível identificar o cabeçalho do arquivo.' });
          return;
        }
        self.postMessage({
          kind: 'done',
          fileName,
          headers,
          rows: rowCount,
          bytes: file.size,
          parseErrors,
          delimiter,
        });
      },
      error: (error) => {
        if (cancelled) return;
        self.postMessage({ kind: 'error', message: error?.message || 'Erro ao ler o arquivo.' });
      },
    });
  } catch (error) {
    self.postMessage({ kind: 'error', message: error?.message || 'Erro inesperado na leitura.' });
  }
};
