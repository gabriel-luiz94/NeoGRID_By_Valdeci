/* Camada lida sob demanda de um banco SQLite gerado pelo scripts/build-sqlite.js.
   Expõe a mesma interface pública do LayerStore, mas sem manter as linhas em
   memória: os registros entram em cache somente quando consultados. */
import { LAYER_META, DEFAULT_FIELD_PATTERNS, IMPORTANT_COLUMN_PATTERNS, hiddenHeader } from './schema.js';
import { parseWkt, wktFirstPoint, ringsBounds } from './geometry.js';
import { clearInstallationCache } from './labels.js';
import { dbRows, dbRow } from './database-client.js';

const textAt = (row, index) => {
  if (index < 0 || row[index] == null) return '';
  return String(row[index]).trim();
};

const pointFromRow = (store, row) => {
  // O WKT é a posição autoritativa; as colunas de coordenadas podem vir defasadas.
  if (store.wkt >= 0 && row[store.wkt]) {
    const point = wktFirstPoint(row[store.wkt]);
    if (point) return point;
  }
  if (store.gx >= 0 && row[store.gx] != null && row[store.gx] !== '') {
    const lon = Number(String(row[store.gx]).trim().replace(',', '.'));
    const lat = Number(String(row[store.gy] ?? '').trim().replace(',', '.'));
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }
  const bbox = store.bboxes.get(store.ridOfRow?.get(row) ?? -1);
  if (bbox && Number.isFinite(bbox[0]) && Number.isFinite(bbox[2])) {
    return [(bbox[0] + bbox[1]) / 2, (bbox[2] + bbox[3]) / 2];
  }
  return null;
};

export class SqliteStore {
  constructor(type, meta) {
    this.type = type;
    this.meta = LAYER_META[type];
    this.isDatabase = true;
    this.headers = [...(meta.headers || [])];
    this.bounds = meta.bounds || null;
    this.hotspots = Array.isArray(meta.hotspots) ? meta.hotspots : [];
    // Cache esparso: rows[rid] = array de células (somente linhas consultadas).
    this.rows = [];
    this.X = [];
    this.Y = [];
    this.bboxes = new Map();
    this.geomText = new Map();
    this.ridOfRow = new Map();
    this._cacheOrder = [];
    this.grid = new Map();
    this.geo = new Map();
    this.by = new Map();
    this.mp = new Map();
    this.idBuckets = new Map();
    this._ix = new Map();
    this._patternIx = new Map();
    this.installationInfo = new Map();
    this.pending = new Map();
    const distribution = (pairs) => new Map((pairs || []).map(([name, count]) => [name, count]));
    this.stats = {
      count: meta.count || 0,
      located: meta.located || 0,
      missing: (meta.count || 0) - (meta.located || 0),
      duplicates: meta.duplicates || 0,
      utmSuspect: false,
      lengthMeters: meta.lengthMeters || 0,
      idPresent: meta.idPresent || 0,
      material: distribution(meta.material),
      poleType: distribution(meta.poleType),
      installationType: distribution(meta.installationType),
      conductor: distribution(meta.conductor),
    };
    const indexes = meta.indexes || {};
    this.gx = indexes.lon ?? -1;
    this.gy = indexes.lat ?? -1;
    this.wkt = indexes.wkt ?? -1;
    this.angle = indexes.angle ?? -1;
    this.poleId = indexes.pole ?? -1;
    this.startPole = indexes.startPole ?? -1;
    this.endPole = indexes.endPole ?? -1;
    this.idIndex = indexes.id ?? -1;
    this.lengthIndex = indexes.length ?? -1;
    this.materialIndex = this.headers.indexOf('MATERIAL') >= 0
      ? this.headers.indexOf('MATERIAL')
      : this.headers.indexOf('CD_INDD_MATERIAL_PG_DESC');
    this.poleTypeIndex = this.headers.indexOf('TIPO_PG') >= 0
      ? this.headers.indexOf('TIPO_PG')
      : this.headers.indexOf('CD_TIPO_PG_DESC');
    this.installationTypeIndex = this.headers.indexOf('TIPO_INSTA') >= 0
      ? this.headers.indexOf('TIPO_INSTA')
      : this.headers.indexOf('TIPO_SIGLA') >= 0
        ? this.headers.indexOf('TIPO_SIGLA')
        : this.headers.indexOf('NU_TIPO_INSTALACAO_MT_ID_DESC');
    this.conductorIndex = this.headers.indexOf('CONDUTOR_A') >= 0
      ? this.headers.indexOf('CONDUTOR_A')
      : this.headers.indexOf('CONDUTOR_N');
    this.idx = {
      id: this.idIndex,
      start: this.startPole,
      end: this.endPole,
      angle: this.angle,
      pole: this.poleId,
      wkt: this.wkt,
      gx: this.gx,
      gy: this.gy,
    };
  }

  prep() {
    this._ix.clear();
    this._patternIx.clear();
  }

  colIndex(name) {
    if (this._ix.has(name)) return this._ix.get(name);
    const index = this.headers.indexOf(String(name).toUpperCase());
    this._ix.set(name, index);
    return index;
  }

  col(row, name) {
    const index = this.colIndex(name);
    return textAt(row, index);
  }

  field(row, names) {
    for (const name of names) {
      const value = this.col(row, name);
      if (value) return value;
    }
    return '';
  }

  indexesMatching(pattern) {
    const key = pattern.toString();
    if (this._patternIx.has(key)) return this._patternIx.get(key);
    const result = [];
    this.headers.forEach((header, index) => {
      if (pattern.test(header)) result.push(index);
    });
    this._patternIx.set(key, result);
    return result;
  }

  effectiveFieldHeaders() {
    const selected = DEFAULT_FIELD_PATTERNS[this.type] || [];
    const headers = [];
    for (const pattern of selected) {
      for (const index of this.indexesMatching(pattern)) {
        if (!hiddenHeader(this.headers[index]) && !headers.includes(this.headers[index])) {
          headers.push(this.headers[index]);
        }
      }
    }
    if (!headers.length) {
      for (const header of this.headers) {
        if (!hiddenHeader(header) && !/_DESC$/.test(header)) {
          headers.push(header);
          if (headers.length >= 8) break;
        }
      }
    }
    return headers;
  }

  importantColumns() {
    const patterns = IMPORTANT_COLUMN_PATTERNS[this.type] || [];
    const columns = [];
    for (const pattern of patterns) {
      for (const index of this.indexesMatching(pattern)) {
        const header = this.headers[index];
        if (!hiddenHeader(header) && !columns.includes(header)) columns.push(header);
      }
    }
    if (!columns.length) {
      for (const header of this.headers) {
        if (!hiddenHeader(header)) {
          columns.push(header);
          if (columns.length >= 7) break;
        }
      }
    }
    return columns.slice(0, 9);
  }

  has(rid) {
    return this.rows[rid] !== undefined;
  }

  cachePackets(packets) {
    for (const packet of packets || []) {
      const rid = Number(packet.i);
      if (!Number.isInteger(rid) || rid < 0 || rid >= this.stats.count) continue;
      if (this.rows[rid] === undefined) {
        this.rows[rid] = packet.row || [];
        this.ridOfRow.set(packet.row, rid);
        if (packet.b) this.bboxes.set(rid, packet.b);
        if (packet.geom) this.geomText.set(rid, packet.geom);
        const point = pointFromRow(this, this.rows[rid]);
        if (point) {
          this.X[rid] = point[0];
          this.Y[rid] = point[1];
        }
        this._cacheOrder.push(rid);
      }
    }
    this.trimCache();
  }

  trimCache() {
    const MAX_CACHED = 40000;
    const TRIM_TO = 25000;
    if (this._cacheOrder.length <= MAX_CACHED) return;
    const remove = this._cacheOrder.length - TRIM_TO;
    for (let n = 0; n < remove; n++) {
      const rid = this._cacheOrder[n];
      const row = this.rows[rid];
      if (row !== undefined) this.ridOfRow.delete(row);
      delete this.rows[rid];
      delete this.X[rid];
      delete this.Y[rid];
      this.bboxes.delete(rid);
      this.geomText.delete(rid);
      this.geo.delete(rid);
    }
    this._cacheOrder.splice(0, remove);
  }

  async ensureRows(ids) {
    const missing = [];
    for (const id of ids || []) {
      const rid = Number(id);
      if (Number.isInteger(rid) && rid >= 0 && rid < this.stats.count && this.rows[rid] === undefined && !this.pending.has(rid)) {
        missing.push(rid);
      }
    }
    if (!missing.length) return;
    const job = (async () => {
      const chunkSize = 2000;
      for (let offset = 0; offset < missing.length; offset += chunkSize) {
        const chunk = missing.slice(offset, offset + chunkSize);
        const packets = await dbRows(this.type, chunk);
        this.cachePackets(packets);
      }
    })().finally(() => {
      for (const rid of missing) this.pending.delete(rid);
    });
    for (const rid of missing) this.pending.set(rid, job);
    await job;
  }

  async ensureRow(rid) {
    const id = Number(rid);
    if (!Number.isInteger(id) || id < 0 || id >= this.stats.count) return null;
    if (this.rows[id] !== undefined) return this.rows[id];
    if (this.pending.has(id)) {
      await this.pending.get(id);
      return this.rows[id] ?? null;
    }
    const job = (async () => {
      const packet = await dbRow(this.type, id);
      if (packet) this.cachePackets([packet]);
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, job);
    await job;
    return this.rows[id] ?? null;
  }

  async sampleRow() {
    const { dbPage } = await import('./database-client.js');
    for (let offset = 0; offset < Math.min(this.stats.count, 1000); offset += 50) {
      const page = await dbPage({ type: this.type, offset, limit: 50 });
      this.cachePackets(page.rows || []);
      for (const packet of page.rows || []) {
        const rid = Number(packet.i);
        if (Number.isFinite(this.X[rid]) && Number.isFinite(this.Y[rid])) return { index: rid, row: this.rows[rid] };
      }
      if (!(page.rows || []).length) break;
    }
    return null;
  }

  distinctValuesSync() {
    return [];
  }

  async distinctValues(field, limit = 200) {
    const name = String(field || '').trim().toUpperCase();
    if (!name || !this.headers.includes(name)) return [];
    const response = await window.desktop.dbQuery('db:distinct', { type: this.type, field: name, limit });
    if (!response?.ok) return [];
    return response.result || [];
  }

  getRow(index) {
    return this.rows[index];
  }

  getPoint(index) {
    const x = this.X[index];
    const y = this.Y[index];
    if (Number.isFinite(x) && Number.isFinite(y)) return [y, x];
    return null;
  }

  getGeometry(index) {
    let rings = this.geo.get(index);
    if (rings) return rings;
    if (this.geo.size > 100000) {
      let remove = 20000;
      for (const key of this.geo.keys()) {
        this.geo.delete(key);
        if (--remove <= 0) break;
      }
    }
    const text = this.geomText.get(index) ?? (this.wkt >= 0 ? this.rows[index]?.[this.wkt] : '');
    rings = text ? parseWkt(text) : [];
    this.geo.set(index, rings);
    return rings;
  }

  getBounds(index) {
    const bbox = this.bboxes.get(index);
    if (bbox && bbox.every((value) => Number.isFinite(value))) {
      const [minLon, maxLon, minLat, maxLat] = bbox;
      return { north: maxLat, south: minLat, east: maxLon, west: minLon };
    }
    const point = this.getPoint(index);
    const rings = this.getGeometry(index);
    const box = ringsBounds(rings);
    if (box) return box;
    if (point) {
      const [lat, lon] = point;
      return { north: lat, south: lat, east: lon, west: lon };
    }
    return null;
  }

  getCenter(index) {
    const point = this.getPoint(index);
    if (point) return point;
    const bounds = this.getBounds(index);
    if (bounds) return [(bounds.north + bounds.south) / 2, (bounds.east + bounds.west) / 2];
    return null;
  }

  rawHeaders() {
    return this.headers;
  }

  clear() {
    this.rows = [];
    this.X = [];
    this.Y = [];
    this.bboxes.clear();
    this.geomText.clear();
    this.ridOfRow = new Map();
    this._cacheOrder = [];
    this.grid.clear();
    this.geo.clear();
    this.by.clear();
    this.mp.clear();
    this.idBuckets.clear();
    this.installationInfo.clear();
    this.pending.clear();
    this._ix.clear();
    this._patternIx.clear();
    clearInstallationCache(this);
  }
}
