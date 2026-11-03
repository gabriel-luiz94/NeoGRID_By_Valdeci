import { LAYER_META, DEFAULT_FIELD_PATTERNS, IMPORTANT_COLUMN_PATTERNS, hiddenHeader } from './schema.js';
import { parseWkt, wktFirstPoint, ringsLength, ringsBounds } from './geometry.js';
import { clearInstallationCache } from './labels.js';

const pointFromRow = (store, row) => {
  // O WKT é a posição autoritativa; as colunas GEO_X/GEO_Y (ou NU_LONGITUDE/
  // NU_LATITUDE) podem vir defasadas em relação à geometria.
  if (store.wkt >= 0 && row[store.wkt]) {
    const point = wktFirstPoint(row[store.wkt]);
    if (point) return point;
  }
  if (store.gx >= 0 && row[store.gx] != null && row[store.gx] !== '') {
    const lon = Number(String(row[store.gx]).trim().replace(',', '.'));
    const lat = Number(String(row[store.gy] ?? '').trim().replace(',', '.'));
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }
  return null;
};

const numberAt = (row, index) => {
  if (index < 0 || row[index] == null || row[index] === '') return 0;
  const value = Number(String(row[index]).trim().replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
};

const textAt = (row, index) => {
  if (index < 0 || row[index] == null) return '';
  return String(row[index]).trim();
};

const bump = (map, key) => {
  const label = key || 'Não informado';
  map.set(label, (map.get(label) || 0) + 1);
};

export class LayerStore {
  constructor(type) {
    this.type = type;
    this.meta = LAYER_META[type];
    this.headers = [];
    this.rows = [];
    this.X = [];
    this.Y = [];
    this.grid = new Map();
    this.geo = new Map();
    this.by = new Map();
    this.mp = new Map();
    this.idBuckets = new Map();
    this._ix = new Map();
    this._patternIx = new Map();
    this.installationInfo = new Map();
    this.stats = {
      count: 0,
      located: 0,
      missing: 0,
      duplicates: 0,
      utmSuspect: false,
      lengthMeters: 0,
      material: new Map(),
      poleType: new Map(),
      installationType: new Map(),
      conductor: new Map(),
    };
    this.idx = {};
  }

  prep() {
    const find = (name) => this.headers.indexOf(name);
    const findAny = (...names) => {
      for (const name of names) {
        const index = find(name);
        if (index >= 0) return index;
      }
      return -1;
    };
    this._ix.clear();
    this._patternIx.clear();
    this.gx = findAny('GEO_X', 'NU_LONGITUDE', 'LONGITUDE', 'LON', 'CD_LONGITUDE');
    this.gy = findAny('GEO_Y', 'NU_LATITUDE', 'LATITUDE', 'LAT', 'CD_LATITUDE');
    this.wkt = findAny('GEOMETRIA_WKT');
    this.angle = findAny('NU_ANGULO');
    this.poleId = findAny('NU_PG_ID');
    this.barramentoIndex = findAny('DE_BARRAMEN', 'DE_BARRAMENTO');
    this.startPole = this.headers.findIndex((header) => /^NU_PG_INI/.test(header));
    this.endPole = this.headers.findIndex((header) => /^NU_PG_FIN/.test(header));
    this.installationId = findAny('NU_INSTALA', 'NU_INSTALACAO_MT_ID', 'NU_INSTALACAO_BT_ID');
    this.idIndex = this.type === 'poste'
      ? this.poleId
      : this.type === 'inst'
        ? this.installationId
        : this.headers.findIndex((header) => /^NU_TRECHO/.test(header));
    this.lengthIndex = find('NU_COMPRIMENTO_REAL') >= 0 ? find('NU_COMPRIMENTO_REAL') : find('SHP_LENGTH');
    this.materialIndex = find('MATERIAL') >= 0 ? find('MATERIAL') : find('CD_INDD_MATERIAL_PG_DESC');
    this.poleTypeIndex = find('TIPO_PG') >= 0 ? find('TIPO_PG') : find('CD_TIPO_PG_DESC');
    this.installationTypeIndex = find('TIPO_INSTA') >= 0
      ? find('TIPO_INSTA')
      : find('TIPO_SIGLA') >= 0
        ? find('TIPO_SIGLA')
        : find('NU_TIPO_INSTALACAO_MT_ID_DESC');
    this.conductorIndex = find('CONDUTOR_A') >= 0 ? find('CONDUTOR_A') : find('CONDUTOR_N');
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
        if (!hiddenHeader(header) && !/_(DESC)$/.test(header)) {
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

  addRows(fileHeaders, rows) {
    const sourceHeaders = fileHeaders.map((header) => String(header || '').replace(/^\uFEFF/, '').trim().toUpperCase());
    let headersChanged = false;

    if (!this.headers.length) {
      this.headers = [...sourceHeaders];
      headersChanged = true;
    } else {
      for (const header of sourceHeaders) {
        if (!this.headers.includes(header)) {
          this.headers.push(header);
          headersChanged = true;
        }
      }
    }

    if (headersChanged) {
      this.prep();
      clearInstallationCache(this);
      this._ix.clear();
      this._patternIx.clear();
    }

    const remap = sourceHeaders.map((header) => this.headers.indexOf(header));
    const identity = remap.length === this.headers.length && remap.every((index, position) => index === position);
    let added = 0;

    for (const sourceRow of rows) {
      if (!Array.isArray(sourceRow)) continue;
      let row = sourceRow;
      if (!identity) {
        row = new Array(this.headers.length);
        for (let j = 0; j < remap.length; j++) row[remap[j]] = sourceRow[j] ?? '';
      }

      const index = this.rows.length;
      this.rows.push(row);
      const point = pointFromRow(this, row);
      if (point) {
        const [lon, lat] = point;
        this.X[index] = lon;
        this.Y[index] = lat;
        this.stats.located += 1;
        if (Math.abs(lon) > 180 || Math.abs(lat) > 90) this.stats.utmSuspect = true;
        const key = `${Math.floor(lon * 100)},${Math.floor(lat * 100)}`;
        const cell = this.grid.get(key);
        if (cell) cell.push(index);
        else this.grid.set(key, [index]);
      } else {
        this.X[index] = NaN;
        this.Y[index] = NaN;
        this.stats.missing += 1;
      }

      if (this.type === 'poste') {
        const id = this.idx.id >= 0 ? textAt(row, this.idx.id) : '';
        this.registerId(id, index);
        bump(this.stats.material, this.materialIndex >= 0 ? textAt(row, this.materialIndex) : '');
        bump(this.stats.poleType, this.poleTypeIndex >= 0 ? textAt(row, this.poleTypeIndex) : '');
      } else if (this.type === 'inst') {
        const id = this.idx.id >= 0 ? textAt(row, this.idx.id) : '';
        this.registerId(id, index);
        const pole = this.idx.pole >= 0 ? textAt(row, this.idx.pole) : '';
        if (pole) this.linkPole(pole, index);
        bump(this.stats.installationType, this.installationTypeIndex >= 0 ? textAt(row, this.installationTypeIndex) : '');
      } else {
        const id = this.idx.id >= 0 ? textAt(row, this.idx.id) : '';
        this.registerId(id, index);
        const start = this.idx.start >= 0 ? textAt(row, this.idx.start) : '';
        const end = this.idx.end >= 0 ? textAt(row, this.idx.end) : '';
        if (start) this.linkPole(start, index);
        if (end) this.linkPole(end, index);
        bump(this.stats.conductor, this.conductorIndex >= 0 ? textAt(row, this.conductorIndex) : '');
        let length = this.lengthIndex >= 0 ? numberAt(row, this.lengthIndex) : 0;
        if (!length && this.wkt >= 0 && row[this.wkt]) {
          const rings = parseWkt(row[this.wkt]);
          length = ringsLength(rings);
        }
        this.stats.lengthMeters += length;
      }

      this.stats.count += 1;
      added += 1;
    }

    return added;
  }

  registerId(id, index) {
    if (!id) return;
    if (this.by.has(id)) {
      this.stats.duplicates += 1;
    } else {
      this.by.set(id, index);
    }
    const key = id.slice(0, 3).toUpperCase();
    const bucket = this.idBuckets.get(key);
    if (bucket) bucket.push(index);
    else this.idBuckets.set(key, [index]);
  }

  linkPole(poleId, index) {
    if (!poleId) return;
    const list = this.mp.get(poleId);
    if (list) list.push(index);
    else this.mp.set(poleId, [index]);
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
    if (!rings) {
      if (this.geo.size > 100000) {
        // Drop the oldest parsed geometries without throwing away the whole cache.
        let remove = 20000;
        for (const key of this.geo.keys()) {
          this.geo.delete(key);
          if (--remove <= 0) break;
        }
      }
      rings = this.wkt >= 0 ? parseWkt(this.rows[index]?.[this.wkt]) : [];
      this.geo.set(index, rings);
    }
    return rings;
  }

  getBounds(index) {
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

  collectInBounds(bounds) {
    const west = Math.min(bounds.west, bounds.east);
    const east = Math.max(bounds.west, bounds.east);
    const south = Math.min(bounds.south, bounds.north);
    const north = Math.max(bounds.south, bounds.north);
    const x0 = Math.floor(west * 100) - 1;
    const x1 = Math.floor(east * 100) + 1;
    const y0 = Math.floor(south * 100) - 1;
    const y1 = Math.floor(north * 100) + 1;
    const seen = new Set();
    const result = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.grid.get(`${cx},${cy}`);
        if (!cell) continue;
        for (const index of cell) {
          if (seen.has(index)) continue;
          seen.add(index);
          if (this.type === 'poste' || this.type === 'inst') {
            if (this.X[index] >= west && this.X[index] <= east && this.Y[index] >= south && this.Y[index] <= north) {
              result.push(index);
            }
          } else {
            const box = this.getBounds(index);
            if (box && box.east >= west && box.west <= east && box.north >= south && box.south <= north) {
              result.push(index);
            }
          }
        }
      }
    }
    return result;
  }

  rawHeaders() {
    return this.headers;
  }

  clear() {
    this.headers = [];
    this.rows = [];
    this.X = [];
    this.Y = [];
    this.grid.clear();
    this.geo.clear();
    this.by.clear();
    this.mp.clear();
    this.idBuckets.clear();
    this.installationInfo.clear();
    this.stats = {
      count: 0,
      located: 0,
      missing: 0,
      duplicates: 0,
      utmSuspect: false,
      lengthMeters: 0,
      material: new Map(),
      poleType: new Map(),
      installationType: new Map(),
      conductor: new Map(),
    };
    this._ix.clear();
    this._patternIx.clear();
    this.prep();
  }
}
