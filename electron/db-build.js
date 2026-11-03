'use strict';

/*
 * Núcleo do conversor CSV → SQLite, compartilhado entre o CLI
 * (scripts/build-sqlite.js) e o aplicativo (IPC no main process).
 * Não usa process.argv nem process.exit; reporta via onProgress e obedece
 * a um token de cancelamento (efeito entre arquivos e fases).
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

function papaparsePath() {
  // Funciona no repositório (scripts/) e no app empacotado (electron/).
  const candidates = [
    path.join(__dirname, '..', 'src', 'vendor', 'papaparse', 'papaparse.min.js'),
    path.join(__dirname, '..', '..', 'src', 'vendor', 'papaparse', 'papaparse.min.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('papaparse.min.js não encontrado.');
}

const Papa = require(papaparsePath());

const LAYER_ORDER = ['poste', 'bt', 'mt', 'inst'];
const LAYER_TITLES = { poste: 'Postes', bt: 'Rede BT', mt: 'Rede MT', inst: 'Instalações' };

const ID_HEADERS = {
  poste: ['NU_PG_ID'],
  inst: ['NU_INSTALACAO_MT_ID', 'NU_INSTALA'],
  bt: ['NU_TRECHO_BT_ID', 'NU_TRECHO'],
  mt: ['NU_TRECHO_MT_ID', 'NU_TRECHO'],
};

const LON_HEADERS = ['NU_LONGITUDE', 'GEO_X', 'LONGITUDE', 'LON'];
const LAT_HEADERS = ['NU_LATITUDE', 'GEO_Y', 'LATITUDE', 'LAT'];
const WKT_HEADERS = ['GEOMETRIA_WKT'];
const LENGTH_HEADERS = ['NU_COMPRIMENTO_REAL', 'SHP_LENGTH'];

// Marcadores esperados por camada (confirmação pelo cabeçalho).
// Ordem importa: instalações primeiro, pois os CSVs de instalação também
// carregam colunas NU_TRECHO_MT_ID/NU_INSTALACAO_MT_ID herdadas do modelo.
const LAYER_MARKERS = {
  inst: [/^TIPO_SIGLA$/, /^TIPO_INSTA$/],
  mt: [/NU_TRECHO_MT/, /NU_CONDUTOR_MT/],
  bt: [/NU_TRECHO_BT/, /NU_CONDUTOR_BT/],
  poste: [/NU_ALTURA/, /NU_ESFORCO/, /DE_BARRAMEN/, /^TIPO_PG$/],
};

const DICT_MAX_DISTINCT = 2000;
const DICT_TRACK_CAP = 5000;
const WKT_DEFLATE_OVER = 200;
const CHUNK_BYTES = 8 * 1024 * 1024;

function emit() {}

function formatInt(value) {
  return Number(value || 0).toLocaleString('pt-BR');
}

function normalizeHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toUpperCase();
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

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function classifyFileByName(file) {
  const name = path.basename(file).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/instalac/.test(name)) return 'inst';
  if (/rede[\s_-]*mt|(^|[\s_-])mt([\s_-]|$)/.test(name)) return 'mt';
  if (/rede[\s_-]*bt|(^|[\s_-])bt([\s_-]|$)/.test(name)) return 'bt';
  if (/poste/.test(name)) return 'poste';
  return null;
}

function classifyByHeaders(headers) {
  const list = headers.map((header) => header.toUpperCase());
  const has = (pattern) => list.some((header) => pattern.test(header));
  // Instalações primeiro: os CSVs de instalação também carregam colunas
  // NU_TRECHO_MT_ID/NU_INSTALACAO_MT_ID do modelo, que confundem com rede MT.
  if (LAYER_MARKERS.inst.some(has)) return 'inst';
  if (LAYER_MARKERS.mt.some(has) && !LAYER_MARKERS.bt.some(has)) return 'mt';
  if (LAYER_MARKERS.bt.some(has)) return 'bt';
  if (LAYER_MARKERS.poste.some(has)) return 'poste';
  return null;
}

function toNumber(value) {
  if (value == null || value === '') return NaN;
  const number = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) ? number : NaN;
}

/* ---------- encoding ---------- */

function detectEncoding(buffer) {
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return 'utf-8';
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) return 'utf-16le';
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) return 'utf-16be';
  // UTF-16 sem BOM: muitos bytes nulos intercalados.
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      if (i % 2 === 0) evenZero += 1;
      else oddZero += 1;
    }
  }
  if (oddZero > sample.length * 0.25) return 'utf-16le';
  if (evenZero > sample.length * 0.25) return 'utf-16be';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, Math.min(buffer.length, 1 << 20)));
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

function readSampleBuffer(file, maxBytes = 1 << 20) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function sniffDelimiter(line) {
  let inQuotes = false;
  let semicolon = 0;
  let comma = 0;
  let tab = 0;
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

/** Transcodifica para UTF-8 temporário (streaming, pouca memória). Retorna o caminho. */
async function transcodeToUtf8(file, encoding) {
  const temp = `${file}.${process.pid}.utf8.tmp`;
  const decoder = new TextDecoder(encoding);
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    const output = fs.createWriteStream(temp, { encoding: 'utf8' });
    input.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    input.on('data', (chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      if (text && !output.write(text)) input.pause();
    });
    output.on('drain', () => input.resume());
    input.on('end', () => {
      const tail = decoder.decode();
      if (tail) output.write(tail);
      output.end();
    });
  });
  return temp;
}

/* ---------- WKT ---------- */

function scanWkt(raw) {
  if (!raw) return null;
  const text = String(raw);
  let source = text;
  if (/^SRID=/i.test(text)) {
    const semicolon = text.indexOf(';');
    if (semicolon >= 0) source = text.slice(semicolon + 1);
  }
  let index = 0;
  let firstLon = null;
  let firstLat = null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let pairIndex = 0;

  while (index < source.length) {
    const char = source[index];
    if ((char >= '0' && char <= '9') || char === '-' || char === '+' || char === '.') {
      const start = index;
      index += 1;
      while (index < source.length) {
        const next = source[index];
        if ((next >= '0' && next <= '9') || next === '.' || next === '-' || next === '+' || next === 'e' || next === 'E') index += 1;
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
    } else {
      index += 1;
    }
  }

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return null;
  }
  return { firstLon, firstLat, minLon, minLat, maxLon, maxLat };
}

function encodeGeometry(raw) {
  const text = raw == null ? '' : String(raw);
  if (!text) return null;
  if (text.length > WKT_DEFLATE_OVER) {
    // Prefixo binário seria ambíguo com TEXT; BLOB + inflate no leitor.
    return zlib.deflateSync(Buffer.from(text, 'utf8'), { level: 6 });
  }
  return text;
}

class BuildCancelled extends Error {
  constructor() {
    super('Conversão cancelada.');
    this.code = 'BUILD_CANCELLED';
  }
}

function bump(map, value) {
  const label = String(value ?? '').trim() || 'Não informado';
  map.set(label, (map.get(label) || 0) + 1);
}

function throwIfCancelled(token) {
  if (token?.cancelled) throw new BuildCancelled();
}

/* ---------- streaming de linhas ---------- */

function streamRows(file, delimiter, onRow, hooks = {}) {
  const { token = null, onChunk = null, fileSize = 0 } = hooks;
  return new Promise((resolve, reject) => {
    let firstChunk = true;
    let headers = null;
    let lineNumber = 1; // 1 = cabeçalho
    let sinceCheck = 0;
    Papa.parse(fs.createReadStream(file, { encoding: 'utf8' }), {
      delimiter,
      skipEmptyLines: 'greedy',
      chunkSize: CHUNK_BYTES,
      chunk: (results, parser) => {
        try {
          if (token?.cancelled) {
            try { parser?.abort?.(); } catch { /* ignore */ }
            throw new BuildCancelled();
          }
          let data = results.data || [];
          if (firstChunk) {
            firstChunk = false;
            if (!data.length) return;
            headers = uniqueHeaders(data[0]);
            data = data.slice(1);
          }
          for (const sourceRow of data) {
            lineNumber += 1;
            if (!Array.isArray(sourceRow) || !sourceRow.length) continue;
            if (!sourceRow.some((cell) => String(cell ?? '').trim() !== '')) continue;
            onRow(sourceRow, headers, lineNumber);
            sinceCheck += 1;
            if (sinceCheck >= 2048) {
              sinceCheck = 0;
              throwIfCancelled(token);
            }
          }
          if (onChunk && fileSize > 0) {
            onChunk({ bytes: results.meta?.cursor || 0, totalBytes: fileSize });
          }
        } catch (error) {
          reject(error);
        }
      },
      complete: () => resolve({ headers }),
      error: (error) => reject(error),
    });
  });
}

/* ---------- programa ---------- */

async function buildDatabase(options = {}) {
  const {
    source: sourceArg,
    output: outputArg,
    manifestoBase = null,
    manifestoOut = null,
    rejectLimit = 0.005,
    token = null,
    onProgress = null,
  } = options;
  if (!sourceArg || !outputArg) throw new Error('Origem e destino são obrigatórios.');
  const emit = (message, extra = {}) => {
    try {
      onProgress?.({ type: 'log', message, ...extra });
    } catch { /* ouvinte indisponível */ }
  };
  const phase = (name, extra = {}) => {
    try {
      onProgress?.({ type: 'phase', phase: name, ...extra });
    } catch { /* ignore */ }
  };
  const SOURCE = path.resolve(sourceArg);
  const OUTPUT = path.resolve(outputArg);
  if (!fs.existsSync(SOURCE)) throw new Error(`Pasta não encontrada: ${SOURCE}`);

  const files = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.csv$/i.test(entry.name)) files.push(full);
    }
  };
  walk(SOURCE);
  if (!files.length) throw new Error('Nenhum CSV encontrado.');

  // Fase 0: detecção por arquivo (encoding, delimitador, cabeçalho, camada).
  const fileInfos = [];
  for (const file of files) {
    const sample = readSampleBuffer(file);
    const encoding = detectEncoding(sample);
    const decoded = new TextDecoder(encoding).decode(sample);
    const firstLine = (decoded.split(/\r?\n/, 1)[0] || '').replace(/^\uFEFF/, '');
    const delimiter = sniffDelimiter(firstLine);
    const parsed = Papa.parse(firstLine, { delimiter });
    const headers = uniqueHeaders(parsed.data?.[0] || []);
    const byName = classifyFileByName(file);
    const byHeaders = classifyByHeaders(headers);
    const type = byHeaders || byName;
    const conflict = Boolean(byName && byHeaders && byName !== byHeaders);
    fileInfos.push({
      file, encoding, delimiter, headers, type, byName, byHeaders, conflict,
      size: fs.statSync(file).size,
    });
    if (!type) emit(`AVISO: camada não identificada para ${path.basename(file)} — arquivo ignorado.`);
    if (conflict) emit(`AVISO: ${path.basename(file)} parece ${byName} pelo nome, mas ${byHeaders} pelo cabeçalho — usando ${type}.`);
  }

  const byLayer = { poste: [], bt: [], mt: [], inst: [] };
  for (const info of fileInfos) {
    if (info.type) byLayer[info.type].push(info);
  }

  const headersByLayer = {};
  for (const type of LAYER_ORDER) {
    const headers = [];
    const seen = new Set();
    for (const info of byLayer[type]) {
      for (const header of info.headers) {
        if (seen.has(header)) continue;
        seen.add(header);
        headers.push(header);
      }
    }
    headersByLayer[type] = headers;
    emit(`${type}: ${byLayer[type].length} arquivo(s), ${headers.length} coluna(s)`);
  }

  if (fs.existsSync(OUTPUT)) {
    emit(`Removendo banco anterior: ${OUTPUT}`);
    fs.rmSync(OUTPUT, { force: true });
    fs.rmSync(`${OUTPUT}-wal`, { force: true });
    fs.rmSync(`${OUTPUT}-shm`, { force: true });
  }

  const db = new DatabaseSync(OUTPUT);
  try {
    return await buildIntoDatabase(db);
  } catch (error) {
    try { db.close(); } catch { /* ignore */ }
    if (error?.code === 'BUILD_CANCELLED') {
      fs.rmSync(OUTPUT, { force: true });
      fs.rmSync(`${OUTPUT}-wal`, { force: true });
      fs.rmSync(`${OUTPUT}-shm`, { force: true });
    }
    throw error;
  }

  async function buildIntoDatabase(db) {
  db.exec('PRAGMA journal_mode = OFF');
  db.exec('PRAGMA synchronous = OFF');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -131072');
  db.exec('CREATE TABLE IF NOT EXISTS meta ("key" TEXT PRIMARY KEY, "value" TEXT)');
  db.exec(`CREATE TABLE IF NOT EXISTS "_rejects" (
    "layer" TEXT, "file" TEXT, "line" INTEGER, "reason" TEXT, "content" TEXT
  )`);

  const manifest = {
    format: 'neogrid-build-manifest',
    version: 1,
    builtAt: Date.now(),
    source: SOURCE,
    output: OUTPUT,
    rejectLimit: rejectLimit,
    layers: {},
    files: [],
    rejectsTotal: 0,
    rejectsSample: [],
  };
  const insertReject = db.prepare('INSERT INTO "_rejects" ("layer", "file", "line", "reason", "content") VALUES (?, ?, ?, ?, ?)');
  const recordReject = (layer, file, line, reason, row) => {
    manifest.rejectsTotal += 1;
    insertReject.run(layer, path.basename(file), line, reason, String(row?.join(';') ?? '').slice(0, 2000));
    if (manifest.rejectsSample.length < 50) {
      manifest.rejectsSample.push({ layer, file: path.basename(file), line, reason });
    }
  };

  const layersMeta = [];
  const startedAt = Date.now();

  for (const type of LAYER_ORDER) {
    if (!byLayer[type].length) continue;
    const headers = headersByLayer[type];
    const headerIndex = new Map(headers.map((header, i) => [header, i]));
    const idIndex = ID_HEADERS[type].map((name) => headerIndex.get(name) ?? -1).find((i) => i >= 0) ?? -1;
    const lonIndex = LON_HEADERS.map((name) => headerIndex.get(name) ?? -1).find((i) => i >= 0) ?? -1;
    const latIndex = LAT_HEADERS.map((name) => headerIndex.get(name) ?? -1).find((i) => i >= 0) ?? -1;
    const wktIndex = WKT_HEADERS.map((name) => headerIndex.get(name) ?? -1).find((i) => i >= 0) ?? -1;
    const lengthIndex = LENGTH_HEADERS.map((name) => headerIndex.get(name) ?? -1).find((i) => i >= 0) ?? -1;

    // Fase A: varredura de cardinalidade (dicionário) + contagem, sem inserir.
    emit(`${type}: fase A (cardinalidade)…`);
    const distinct = headers.map(() => new Set());
    const ineligible = new Set();
    if (wktIndex >= 0) ineligible.add(wktIndex);
    if (lonIndex >= 0) ineligible.add(lonIndex);
    if (latIndex >= 0) ineligible.add(latIndex);
    let scannedRows = 0;
    const layerFiles = byLayer[type];
    for (let fileNumber = 0; fileNumber < layerFiles.length; fileNumber++) {
      const info = layerFiles[fileNumber];
      throwIfCancelled(token);
      phase('scan', { layer: type, file: path.basename(info.file), fileNumber: fileNumber + 1, fileCount: layerFiles.length });
      const parseFile = info.encoding === 'utf-8' ? info.file : await transcodeToUtf8(info.file, info.encoding);
      try {
        const sourceIdx = info.headers.map((header) => headerIndex.get(header));
        await streamRows(parseFile, info.delimiter, (sourceRow) => {
          if (sourceRow.length !== info.headers.length) return; // rejeito conta na fase B
          scannedRows += 1;
          for (let c = 0; c < headers.length; c++) {
            if (ineligible.has(c)) continue;
            const set = distinct[c];
            if (!set) continue;
            const src = sourceIdx.indexOf(c);
            const value = src >= 0 ? String(sourceRow[src] ?? '') : '';
            if (value === '') continue;
            set.add(value);
            if (set.size > DICT_TRACK_CAP) {
              distinct[c] = null;
              ineligible.add(c);
            }
          }
        }, {
          token,
          fileSize: info.size,
          onChunk: ({ bytes, totalBytes }) => phase('scan-progress', {
            layer: type, file: path.basename(info.file), bytes, totalBytes,
          }),
        });
      } finally {
        if (parseFile !== info.file) fs.rmSync(parseFile, { force: true });
      }
    }
    const dictColumns = new Map(); // headerIndex -> [valores ordenados]
    for (let c = 0; c < headers.length; c++) {
      const set = distinct[c];
      if (set && set.size > 0 && set.size <= DICT_MAX_DISTINCT) {
        dictColumns.set(c, [...set].sort());
      }
    }
    emit(`${type}: ${dictColumns.size} coluna(s) em dicionário de ${headers.length}`);

    // Fase B: carga com codificação.
    const dictIndex = new Map();
    for (const [c, values] of dictColumns) {
      dictIndex.set(c, new Map(values.map((value, code) => [value, code])));
    }
    const columnDefs = headers.map((header, c) => (
      dictColumns.has(c) ? `${quoteIdentifier(header)} INTEGER` : `${quoteIdentifier(header)} TEXT`
    )).join(', ');
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(type)}`);
    db.exec(`CREATE TABLE ${quoteIdentifier(type)} (
      "_rid" INTEGER PRIMARY KEY, "_id" TEXT, "_lon" REAL, "_lat" REAL,
      "_min_lon" REAL, "_max_lon" REAL, "_min_lat" REAL, "_max_lat" REAL,
      "_geom" BLOB, ${columnDefs}
    )`);
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(`rtree_${type}`)}`);
    db.exec(`CREATE VIRTUAL TABLE ${quoteIdentifier(`rtree_${type}`)} USING rtree("id", "min_lon", "max_lon", "min_lat", "max_lat")`);
    const insert = db.prepare(
      `INSERT INTO ${quoteIdentifier(type)} ("_rid","_id","_lon","_lat","_min_lon","_max_lon","_min_lat","_max_lat","_geom",${headers.map(quoteIdentifier).join(',')}) VALUES (${['_rid','_id','_lon','_lat','_min_lon','_max_lon','_min_lat','_max_lat','_geom',...headers].map(() => '?').join(',')})`,
    );
    const insertRtree = db.prepare(`INSERT INTO ${quoteIdentifier(`rtree_${type}`)} VALUES (?, ?, ?, ?, ?)`);

    const materialIndex = headerIndex.get('MATERIAL') ?? headerIndex.get('CD_INDD_MATERIAL_PG_DESC') ?? -1;
    const poleTypeIndex = headerIndex.get('TIPO_PG') ?? headerIndex.get('CD_TIPO_PG_DESC') ?? -1;
    const installationTypeIndex = headerIndex.get('TIPO_INSTA') ?? headerIndex.get('TIPO_SIGLA') ?? headerIndex.get('NU_TIPO_INSTALACAO_MT_ID_DESC') ?? -1;
    const conductorIndex = headerIndex.get('CONDUTOR_A') ?? headerIndex.get('CONDUTOR_N') ?? -1;

    const stats = {
      count: 0, located: 0, missing: 0, duplicates: 0, idPresent: 0, lengthMeters: 0,
      material: new Map(), poleType: new Map(), installationType: new Map(), conductor: new Map(),
    };
    const ids = new Set();
    const hotspots = new Map();
    const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    const boundUpdate = (lon, lat) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      if (lon < bounds.west) bounds.west = lon;
      if (lon > bounds.east) bounds.east = lon;
      if (lat < bounds.south) bounds.south = lat;
      if (lat > bounds.north) bounds.north = lat;
    };
    let rid = 0;
    const layerManifest = { rows: 0, rejects: 0, files: [] };

    emit(`${type}: fase B (carga)…`);
    for (let fileNumber = 0; fileNumber < layerFiles.length; fileNumber++) {
      const info = layerFiles[fileNumber];
      throwIfCancelled(token);
      phase('load', { layer: type, file: path.basename(info.file), fileNumber: fileNumber + 1, fileCount: layerFiles.length });
      const parseFile = info.encoding === 'utf-8' ? info.file : await transcodeToUtf8(info.file, info.encoding);
      let fileRows = 0;
      let fileRejects = 0;
      try {
        db.exec('BEGIN');
        try {
          const sourceIdx = info.headers.map((header) => headerIndex.get(header));
          await streamRows(parseFile, info.delimiter, (sourceRow, _headers, lineNumber) => {
            if (sourceRow.length !== info.headers.length) {
              fileRejects += 1;
              layerManifest.rejects += 1;
              recordReject(type, info.file, lineNumber, `colunas ${sourceRow.length} ≠ ${info.headers.length} do cabeçalho`, sourceRow);
              return;
            }
            const row = new Array(headers.length);
            for (let c = 0; c < headers.length; c++) row[c] = '';
            for (let s = 0; s < sourceIdx.length; s++) {
              const target = sourceIdx[s];
              if (target >= 0) row[target] = sourceRow[s] == null ? '' : String(sourceRow[s]);
            }
            // Codificação por dicionário (sem perda: códigos ↔ textos no manifesto do banco).
            for (const [c, map] of dictIndex) {
              const value = row[c];
              if (value === '' || value == null) row[c] = null;
              else row[c] = map.get(value) ?? value;
            }

            const id = idIndex >= 0 ? String(row[idIndex] ?? '').trim() : '';
            const length = lengthIndex >= 0 ? toNumber(row[lengthIndex]) : NaN;
            let lon = lonIndex >= 0 ? toNumber(row[lonIndex]) : NaN;
            let lat = latIndex >= 0 ? toNumber(row[latIndex]) : NaN;
            const geometry = wktIndex >= 0 ? String(row[wktIndex] ?? '') : '';
            let bbox = null;
            // O WKT é a posição autoritativa: as colunas NU_LONGITUDE/NU_LATITUDE
            // vêm defasadas em ~94% dos postes (50–200 m de deslocamento).
            if (geometry) {
              bbox = scanWkt(geometry);
              if (bbox) {
                lon = bbox.firstLon;
                lat = bbox.firstLat;
              } else if (Number.isFinite(lon) && Number.isFinite(lat) && type === 'poste') {
                bbox = { firstLon: lon, firstLat: lat, minLon: lon, maxLon: lon, minLat: lat, maxLat: lat };
              }
            } else if (Number.isFinite(lon) && Number.isFinite(lat)) {
              bbox = { firstLon: lon, firstLat: lat, minLon: lon, maxLon: lon, minLat: lat, maxLat: lat };
            }

            const hasPoint = Number.isFinite(lon) && Number.isFinite(lat);
            insert.run(
              rid, id || null,
              hasPoint ? lon : null, hasPoint ? lat : null,
              bbox ? bbox.minLon : null, bbox ? bbox.maxLon : null,
              bbox ? bbox.minLat : null, bbox ? bbox.maxLat : null,
              encodeGeometry(geometry),
              ...row,
            );
            if (bbox) {
              insertRtree.run(rid, bbox.minLon, bbox.maxLon, bbox.minLat, bbox.maxLat);
              const key = `${Math.floor(bbox.firstLon * 100)},${Math.floor(bbox.firstLat * 100)}`;
              hotspots.set(key, (hotspots.get(key) || 0) + 1);
              boundUpdate(bbox.minLon, bbox.minLat);
              boundUpdate(bbox.maxLon, bbox.maxLat);
            }
            stats.count += 1;
            if (hasPoint) stats.located += 1;
            else stats.missing += 1;
            if (Number.isFinite(length)) stats.lengthMeters += length;
            if (id) {
              if (ids.has(id)) stats.duplicates += 1;
              else {
                ids.add(id);
                stats.idPresent += 1;
              }
            }
            if (type === 'poste') {
              if (materialIndex >= 0) bump(stats.material, row[materialIndex]);
              if (poleTypeIndex >= 0) bump(stats.poleType, row[poleTypeIndex]);
            } else if (type === 'inst') {
              if (installationTypeIndex >= 0) bump(stats.installationType, row[installationTypeIndex]);
            } else if (conductorIndex >= 0) {
              bump(stats.conductor, row[conductorIndex]);
            }
            rid += 1;
            fileRows += 1;
          }, {
            token,
            fileSize: info.size,
            onChunk: ({ bytes, totalBytes }) => phase('load-progress', {
              layer: type, file: path.basename(info.file), bytes, totalBytes,
            }),
          });
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } finally {
        if (parseFile !== info.file) fs.rmSync(parseFile, { force: true });
      }
      layerManifest.rows += fileRows;
      manifest.files.push({
        file: path.relative(SOURCE, info.file), layer: type, bytes: info.size,
        rows: fileRows, rejects: fileRejects, encoding: info.encoding, delimiter: info.delimiter,
        headerColumns: info.headers.length, conflict: info.conflict || false,
      });
      emit(`${type}: ${path.basename(info.file)} -> ${formatInt(fileRows)} linhas (${info.encoding}, delim ${JSON.stringify(info.delimiter)}) · total ${formatInt(stats.count)}`);
    }

    const distribution = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);
    const dictMeta = {};
    for (const [c, values] of dictColumns) dictMeta[headers[c]] = values;
    const layerMeta = {
      type, name: LAYER_TITLES[type], headers,
      count: stats.count, located: stats.located, missing: stats.missing,
      duplicates: stats.duplicates, idPresent: stats.idPresent, lengthMeters: stats.lengthMeters,
      material: distribution(stats.material), poleType: distribution(stats.poleType),
      installationType: distribution(stats.installationType), conductor: distribution(stats.conductor),
      dicts: dictMeta,
      bounds: Number.isFinite(bounds.west) ? bounds : null,
      hotspots: [...hotspots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400)
        .map(([key, count]) => {
          const [cx, cy] = key.split(',').map(Number);
          return { cx, cy, count };
        }),
      indexes: {
        id: idIndex, lon: lonIndex, lat: latIndex, wkt: wktIndex,
        angle: headerIndex.get('NU_ANGULO') ?? -1,
        startPole: headers.findIndex((header) => /^NU_PG_INI/.test(header)),
        endPole: headers.findIndex((header) => /^NU_PG_FIN/.test(header)),
        pole: headerIndex.get('NU_PG_ID') ?? -1,
        length: lengthIndex,
      },
    };
    layersMeta.push(layerMeta);
    manifest.layers[type] = {
      rows: stats.count, located: stats.located, missing: stats.missing,
      duplicates: stats.duplicates, rejects: layerManifest.rejects,
      headers: headers.length, dictColumns: dictColumns.size,
      files: byLayer[type].map((info) => path.relative(SOURCE, info.file)),
    };
    ids.clear();
    hotspots.clear();
    emit(`${type}: ${formatInt(stats.count)} registros · ${formatInt(stats.located)} localizados · ${(stats.lengthMeters / 1000).toFixed(1)} km`);
  }

  // Vínculos pré-computados (lookup indexado, sem varredura no app).
  throwIfCancelled(token);
  emit('Montando vínculos poste↔instalação/rede…');
  const linkCounts = { inst: 0, nets: 0 };
  db.exec('DROP TABLE IF EXISTS "_link_pole_inst"');
  db.exec('DROP TABLE IF EXISTS "_link_pole_net"');
  db.exec('CREATE TABLE "_link_pole_inst" ("pole" TEXT, "inst_rid" INTEGER)');
  db.exec('CREATE TABLE "_link_pole_net" ("pole" TEXT, "layer" TEXT, "net_rid" INTEGER)');
  const insertLinkInst = db.prepare('INSERT INTO "_link_pole_inst" VALUES (?, ?)');
  const insertLinkNet = db.prepare('INSERT INTO "_link_pole_net" VALUES (?, ?, ?)');
  const poleOf = (layerType, candidates) => {
    const layer = layersMeta.find((item) => item.type === layerType);
    if (!layer) return -1;
    for (const name of candidates) {
      const index = layer.headers.indexOf(name);
      if (index >= 0) return index;
    }
    return -1;
  };
  db.exec('BEGIN');
  try {
    const instPole = poleOf('inst', ['NU_PG_ID']);
    if (instPole >= 0) {
      const instLayer = layersMeta.find((item) => item.type === 'inst');
      const poleHeader = instLayer.headers[instPole];
      const select = db.prepare(`SELECT "_rid" AS rid, ${quoteIdentifier(poleHeader)} AS pole FROM "inst"`);
      select.setReturnArrays(true);
      for (const [rid, pole] of select.iterate()) {
        const key = String(pole ?? '').trim();
        if (!key) continue;
        insertLinkInst.run(key, rid);
        linkCounts.inst += 1;
      }
    }
    for (const layerType of ['bt', 'mt']) {
      const start = poleOf(layerType, ['NU_PG_INICIAL_ID', 'NU_PG_INI']);
      const end = poleOf(layerType, ['NU_PG_FINAL_ID', 'NU_PG_FIN']);
      if (start < 0 && end < 0) continue;
      const layerHeaders = layersMeta.find((item) => item.type === layerType).headers;
      const cols = [`"_rid" AS rid`];
      if (start >= 0) cols.push(`${quoteIdentifier(layerHeaders[start])} AS p0`);
      if (end >= 0 && end !== start) cols.push(`${quoteIdentifier(layerHeaders[end])} AS p1`);
      const select = db.prepare(`SELECT ${cols.join(', ')} FROM "${layerType}"`);
      select.setReturnArrays(true);
      for (const values of select.iterate()) {
        const rid = values[0];
        for (let k = 1; k < values.length; k++) {
          const key = String(values[k] ?? '').trim();
          if (!key) continue;
          insertLinkNet.run(key, layerType, rid);
          linkCounts.nets += 1;
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('CREATE INDEX "_link_pole_inst_idx" ON "_link_pole_inst" ("pole")');
  db.exec('CREATE INDEX "_link_pole_net_idx" ON "_link_pole_net" ("pole")');
  emit(`Vínculos: ${formatInt(linkCounts.inst)} instalação↔poste · ${formatInt(linkCounts.nets)} trecho↔poste`);

  throwIfCancelled(token);
  emit('Criando índices…');
  for (const layer of layersMeta) {
    db.exec(`CREATE INDEX ${quoteIdentifier(`idx_${layer.type}_id`)} ON ${quoteIdentifier(layer.type)} ("_id")`);
    db.exec(`CREATE INDEX ${quoteIdentifier(`idx_${layer.type}_lonlat`)} ON ${quoteIdentifier(layer.type)} ("_lon", "_lat")`);
  }

  const totalRows = layersMeta.reduce((total, layer) => total + layer.count, 0);
  const totalLocated = layersMeta.reduce((total, layer) => total + layer.located, 0);
  const totalLength = layersMeta.reduce((total, layer) => total + layer.lengthMeters, 0);
  const schema = {
    format: 'neogrid-sqlite', version: 2, builtAt: Date.now(), source: SOURCE,
    rows: totalRows, located: totalLocated, totalLength,
    layers: layersMeta,
    links: linkCounts,
    rejects: manifest.rejectsTotal,
    imports: manifest.files,
  };
  db.prepare('INSERT OR REPLACE INTO meta ("key", "value") VALUES (?, ?)').run('schema', JSON.stringify(schema));
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA optimize');
  db.close();

  // Validação: contagens do banco × linhas lidas; rejeitos dentro do limite.
  manifest.rows = totalRows;
  manifest.located = totalLocated;
  manifest.totalLength = totalLength;
  manifest.links = linkCounts;
  const rejectShare = totalRows ? manifest.rejectsTotal / totalRows : 0;
  const info = fs.statSync(OUTPUT);
  manifest.outputBytes = info.size;

  // Comparação com o mês anterior.
  if (manifestoBase && fs.existsSync(manifestoBase)) {
    try {
      const base = JSON.parse(fs.readFileSync(manifestoBase, 'utf8'));
      const deltas = {};
      for (const type of LAYER_ORDER) {
        const before = base.layers?.[type];
        const after = manifest.layers[type];
        if (!before || !after) continue;
        const beforeCols = new Set(before.files?.flatMap(() => []) || []);
        deltas[type] = {
          rows: (after.rows || 0) - (before.rows || 0),
          headers: (after.headers || 0) - (before.headers || 0),
          rejects: after.rejects || 0,
        };
      }
      const baseFiles = new Set((base.files || []).map((item) => item.file));
      const nowFiles = new Set(manifest.files.map((item) => item.file));
      manifest.previous = {
        builtAt: base.builtAt || null,
        rows: base.rows || 0,
        deltas,
        newFiles: [...nowFiles].filter((file) => !baseFiles.has(file)),
        missingFiles: [...baseFiles].filter((file) => !nowFiles.has(file)),
      };
      emit(`Mês anterior: ${formatInt(base.rows || 0)} registros → agora ${formatInt(totalRows)} (Δ ${formatInt(totalRows - (base.rows || 0))})`);
      if (manifest.previous.newFiles.length) emit(`Arquivos novos: ${manifest.previous.newFiles.join(', ')}`);
      if (manifest.previous.missingFiles.length) emit(`Arquivos ausentes: ${manifest.previous.missingFiles.join(', ')}`);
    } catch (error) {
      emit(`AVISO: não foi possível comparar manifestos: ${error.message}`);
    }
  }
  // Colunas novas por camada (união atual × anterior).
  if (manifestoBase && manifest.previous) {
    try {
      const base = JSON.parse(fs.readFileSync(manifestoBase, 'utf8'));
      manifest.newColumns = {};
      for (const type of LAYER_ORDER) {
        const before = new Set();
        for (const item of base.files || []) {
          if (item.layer === type && Array.isArray(item.headers)) {
            for (const header of item.headers) before.add(header);
          }
        }
        if (!before.size) continue;
        const now = new Set();
        for (const item of manifest.files) {
          if (item.layer !== type) continue;
          const full = byLayer[type].flatMap((fileInfo) => fileInfo.headers);
          for (const header of full) now.add(header);
        }
        const added = [...now].filter((header) => !before.has(header));
        const removed = [...before].filter((header) => !now.has(header));
        if (added.length || removed.length) manifest.newColumns[type] = { added, removed };
      }
    } catch {
      /* manifesto antigo sem detalhe de colunas */
    }
  }
  for (const item of manifest.files) {
    const info = fileInfos.find((entry) => path.relative(SOURCE, entry.file) === item.file);
    item.headers = info ? info.headers : [];
  }

  const manifestoPath = manifestoOut || `${OUTPUT}.manifesto.json`;
  fs.writeFileSync(manifestoPath, JSON.stringify(manifest, null, 2), 'utf8');
  emit(`Manifesto: ${manifestoPath}`);

  if (rejectShare > rejectLimit) {
    fs.rmSync(OUTPUT, { force: true });
    throw new Error(
      `Rejeitos acima do limite: ${formatInt(manifest.rejectsTotal)} (${(rejectShare * 100).toFixed(2)}% > ${(rejectLimit * 100).toFixed(2)}%). Banco descartado; verifique o manifesto.`,
    );
  }

  emit(`Banco criado: ${OUTPUT}`);
  emit(`Tamanho: ${(info.size / 1024 / 1024).toFixed(1)} MB`);
  emit(`${formatInt(totalRows)} registros · ${formatInt(totalLocated)} localizados · ${(totalLength / 1000).toFixed(1)} km · rejeitos ${formatInt(manifest.rejectsTotal)} · ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
  return { manifest, manifestoOut: manifestoPath, output: OUTPUT };
  } // buildIntoDatabase
}

async function closeDatabase(db) {
  try {
    db.close();
  } catch { /* ignore */ }
}

module.exports = { buildDatabase, BuildCancelled };
