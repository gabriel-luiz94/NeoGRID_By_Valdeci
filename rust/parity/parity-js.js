'use strict';
// Paridade JS: replica a Fase 0 de electron/db-build.js (sniffDelimiter,
// uniqueHeaders, classify, scanWkt) sobre os mesmos arquivos, para comparar
// com o binario Rust `neogrid-parity`. Uso:
//   node parity-js.js <arquivo.csv> [--sample N]
const fs = require('node:fs');
const path = require('node:path');

function sniffDelimiter(line) {
  let inQuotes = false, semicolon = 0, comma = 0, tab = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (char === ';') semicolon += 1;
      else if (char === ',') comma += 1;
      else if (char === '\t') tab += 1;
    }
  }
  if (semicolon >= comma && semicolon >= tab && semicolon > 0) return ';';
  if (tab >= comma && tab > 0) return '\t';
  if (comma > 0) return ',';
  return ';';
}

function normalizeHeader(v) {
  return String(v ?? '').replace(/^\uFEFF/, '').trim().toUpperCase();
}
function uniqueHeaders(values) {
  const counts = new Map();
  return values.map((value, index) => {
    const base = normalizeHeader(value) || `COLUNA_${index + 1}`;
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    return count ? `${base}_${count + 1}` : base;
  });
}

function scanWkt(raw) {
  if (!raw) return null;
  const text = String(raw);
  let source = text;
  if (/^SRID=/i.test(text)) {
    const sc = text.indexOf(';');
    if (sc >= 0) source = text.slice(sc + 1);
  }
  let index = 0, firstLon = null, firstLat = null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  let pairIndex = 0;
  while (index < source.length) {
    const char = source[index];
    if ((char >= '0' && char <= '9') || char === '-' || char === '+' || char === '.') {
      const start = index;
      index += 1;
      while (index < source.length) {
        const nx = source[index];
        if ((nx >= '0' && nx <= '9') || nx === '.' || nx === '-' || nx === '+' || nx === 'e' || nx === 'E') index += 1;
        else break;
      }
      const value = Number(source.slice(start, index));
      if (!Number.isFinite(value)) continue;
      if (pairIndex % 2 === 0) {
        if (firstLon === null) firstLon = value;
        if (value < minLon) minLon = value;
        if (value > maxLon) maxLon = value;
      } else {
        if (firstLat === null) firstLat = value;
        if (value < minLat) minLat = value;
        if (value > maxLat) maxLat = value;
      }
      pairIndex += 1;
    } else index += 1;
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) return null;
  return { firstLon, firstLat, minLon, minLat, maxLon, maxLat };
}

async function main() {
  const file = process.argv[2];
  const si = process.argv.indexOf('--sample');
  const sampleN = si >= 0 ? Number(process.argv[si + 1]) || 20000 : 20000;
  if (!file) { console.error('uso: node parity-js.js <arquivo.csv> [--sample N]'); process.exit(2); }
  const t0 = Date.now();
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const firstLine = (text.split(/\r?\n/, 1)[0] || '').replace(/^\uFEFF/, '');
  const delim = sniffDelimiter(firstLine);
  const headers = uniqueHeaders(firstLine.split(delim));
  const t1 = Date.now();
  const lines = text.split('\n');
  let rows = 0, wktOk = 0;
  const wktIdx = headers.indexOf('GEOMETRIA_WKT');
  for (let i = 1; i < lines.length && rows < sampleN; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    rows++;
    // split ingenuo por delim para a paridade (arquivos reais nao usam aspas com ; interno no WKT)
    const cells = line.split(delim);
    const cand = wktIdx >= 0 ? cells[wktIdx] : cells[cells.length - 1];
    if (scanWkt(cand)) wktOk++;
  }
  const t2 = Date.now();
  console.log(JSON.stringify({
    file, delimiter: delim, headers: headers.length,
    sampleRows: rows, wktOk, detectMs: t1 - t0, totalMs: t2 - t0,
  }));
}
main();
