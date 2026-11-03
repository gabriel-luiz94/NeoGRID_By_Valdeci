'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const ALLOWED_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);

class DatabaseManager {
  constructor() {
    this.db = null;
    this.info = null;
    this.layers = new Map();
    this.selectCache = new Map();
    this.statementCache = new Map();
  }

  isOpen() {
    return Boolean(this.db);
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
    }
    this.db = null;
    this.info = null;
    this.dicts = {};
    this.layers.clear();
    this.selectCache.clear();
    this.statementCache.clear();
  }

  open(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    const extension = path.extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error('Selecione um banco SQLite (.sqlite, .sqlite3 ou .db).');
    }
    if (!fs.existsSync(resolved)) throw new Error('Banco de dados não encontrado.');
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size < 1024) throw new Error('Arquivo de banco inválido.');

    this.close();
    const db = new DatabaseSync(resolved, { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema');
      if (!row?.value) throw new Error('Este banco não foi gerado pelo NeoGrid (metadados ausentes).');
      const schema = JSON.parse(row.value);
      if (schema?.format !== 'neogrid-sqlite' || !Array.isArray(schema.layers)) {
        throw new Error('Formato de banco não reconhecido.');
      }
      for (const layer of schema.layers) {
        if (!layer?.type || !Array.isArray(layer.headers)) continue;
        this.layers.set(layer.type, layer);
      }
      if (!this.layers.size) throw new Error('O banco não contém camadas do NeoGrid.');
      // Dicionários: { tipo: { índiceDaColuna: [textos] } } para decodificar códigos.
      this.dicts = {};
      for (const layer of schema.layers) {
        if (!layer?.dicts) continue;
        const map = {};
        for (const [header, list] of Object.entries(layer.dicts)) {
          const index = layer.headers.indexOf(header);
          if (index >= 0 && Array.isArray(list)) map[index] = list;
        }
        this.dicts[layer.type] = map;
      }
      this.db = db;
      this.info = {
        ...schema,
        path: resolved,
        size: stat.size,
        mtime: stat.mtimeMs,
      };
      db.exec('PRAGMA query_only = ON');
      db.exec('PRAGMA cache_size = -131072');
      db.exec('PRAGMA temp_store = MEMORY');
      return this.info;
    } catch (error) {
      try { db.close(); } catch { /* ignore */ }
      throw error;
    }
  }

  layer(type) {
    const layer = this.layers.get(String(type || ''));
    if (!layer) throw new Error(`Camada inválida: ${type}`);
    return layer;
  }

  selectColumns(layer) {
    if (this.selectCache.has(layer.type)) return this.selectCache.get(layer.type);
    const headers = layer.headers.map((header) => `"${String(header).replace(/"/g, '""')}"`).join(', ');
    const value = headers ? `, ${headers}` : '';
    this.selectCache.set(layer.type, value);
    return value;
  }

  prepare(key, sql) {
    if (this.statementCache.has(key)) return this.statementCache.get(key);
    const statement = this.db.prepare(sql);
    statement.setReturnArrays(true);
    this.statementCache.set(key, statement);
    return statement;
  }

  toRow(type, values) {
    // values: [_rid, _geom, _min_lon, _max_lon, _min_lat, _max_lat, ...headers]
    const [rid, geom, minLon, maxLon, minLat, maxLat, ...row] = values;
    const dicts = this.dicts?.[type];
    if (dicts) {
      for (const [index, list] of Object.entries(dicts)) {
        const code = row[index];
        if (typeof code === 'number') row[index] = list[code] ?? '';
        else if (code == null) row[index] = '';
      }
    }
    let geometry = '';
    if (geom != null) {
      if (typeof geom === 'string') {
        geometry = geom;
      } else {
        try {
          geometry = zlib.inflateSync(Buffer.from(geom)).toString('utf8');
        } catch {
          geometry = '';
        }
      }
    }
    return {
      i: Number(rid),
      row,
      geom: geometry,
      b: [minLon, maxLon, minLat, maxLat].map((value) => (value == null ? null : Number(value))),
    };
  }

  indexBounds(type) {
    return this.layer(type).bounds || null;
  }

  hotspots(type, limit = 1) {
    const layer = this.layer(type);
    const spots = Array.isArray(layer.hotspots) ? layer.hotspots : [];
    return spots.slice(0, Math.max(1, Math.min(400, Number(limit) || 1)));
  }

  rows(type, ids) {
    const layer = this.layer(type);
    const input = Array.isArray(ids) ? ids : [];
    const result = [];
    const chunkSize = 8000;
    const columns = this.selectColumns(layer);
    for (let offset = 0; offset < input.length; offset += chunkSize) {
      const chunk = input.slice(offset, offset + chunkSize)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value < layer.count);
      if (!chunk.length) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const statement = this.prepare(
        `rows:${layer.type}:${chunk.length}`,
        `SELECT "_rid", "_geom", "_min_lon", "_max_lon", "_min_lat", "_max_lat"${columns} FROM "${layer.type}" WHERE "_rid" IN (${placeholders})`,
      );
      for (const values of statement.iterate(...chunk)) result.push(this.toRow(layer.type, values));
    }
    return result;
  }

  row(type, id) {
    const layer = this.layer(type);
    const rid = Number(id);
    if (!Number.isInteger(rid) || rid < 0 || rid >= layer.count) return null;
    const columns = this.selectColumns(layer);
    const statement = this.prepare(
      `row:${layer.type}`,
      `SELECT "_rid", "_geom", "_min_lon", "_max_lon", "_min_lat", "_max_lat"${columns} FROM "${layer.type}" WHERE "_rid" = ?`,
    );
    const values = statement.get(rid);
    return values ? this.toRow(layer.type, values) : null;
  }

  viewport(type, { west, east, south, north, limit = 5000 }) {
    const layer = this.layer(type);
    const columns = this.selectColumns(layer);
    const statement = this.prepare(
      `viewport:${layer.type}`,
      `SELECT p."_rid", p."_geom", p."_min_lon", p."_max_lon", p."_min_lat", p."_max_lat"${columns.replace(/,"/g, ', p."')}
       FROM "rtree_${layer.type}" r JOIN "${layer.type}" p ON p."_rid" = r."id"
       WHERE r."max_lon" >= ? AND r."min_lon" <= ? AND r."max_lat" >= ? AND r."min_lat" <= ?
       LIMIT ?`,
    );
    const safeLimit = Math.max(1, Math.min(20000, Number(limit) || 5000));
    return statement.all(west, east, south, north, safeLimit).map((values) => this.toRow(layer.type, values));
  }

  idsInBounds(type, { west, east, south, north, limit = 200000 }) {
    const layer = this.layer(type);
    const statement = this.prepare(
      `idsInBounds:${layer.type}`,
      `SELECT r."id" FROM "rtree_${layer.type}" r
       WHERE r."max_lon" >= ? AND r."min_lon" <= ? AND r."max_lat" >= ? AND r."min_lat" <= ?
       LIMIT ?`,
    );
    return statement.all(west, east, south, north, Math.max(1, Math.min(1000000, Number(limit) || 200000)))
      .map(([rid]) => Number(rid));
  }

  search(type, term, limit = 30) {
    const layer = this.layer(type);
    const text = String(term ?? '').trim();
    if (!text) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
    const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`);
    const statement = this.prepare(
      `search:${layer.type}`,
      `SELECT "_rid", "_id" FROM "${layer.type}" WHERE "_id" LIKE ? ESCAPE '\\' ORDER BY length("_id"), "_id" LIMIT ?`,
    );
    return statement.all(`${escaped}%`, safeLimit).map(([rid, id]) => ({ i: Number(rid), id: String(id ?? '') }));
  }

  findById(type, id) {
    const layer = this.layer(type);
    const text = String(id ?? '').trim();
    if (!text) return null;
    const statement = this.prepare(
      `findById:${layer.type}`,
      `SELECT "_rid" FROM "${layer.type}" WHERE "_id" = ? LIMIT 1`,
    );
    const values = statement.get(text);
    return values ? Number(values[0]) : null;
  }

  searchWhere(layer) {
    const preferred = /^(NU_|DE_|TIPO|MATERIAL|CONDUTOR|CD_FASE|FASE|SE|ALIM|UTD|POSSE|TRAJETO|NATUREZA|KVA_TOTAL|ESTADO|SITUACAO)/;
    const columns = layer.headers.filter((header) => (
      preferred.test(header) && !/_DESC$/.test(header) && !/^GEOMETRIA_WKT$/.test(header)
    ));
    const list = columns.length ? columns : ['_id'];
    const fragment = list
      .map((header) => (header === '_id' ? '"_id"' : `"${String(header).replace(/"/g, '""')}"`))
      .map((quoted) => `${quoted} LIKE ? ESCAPE '\\'`)
      .join(' OR ');
    return { fragment: ` WHERE (${fragment})`, count: list.length };
  }

  distinct(type, field, limit = 200) {
    const layer = this.layer(type);
    const name = String(field || '').trim().toUpperCase();
    if (!name || !layer.headers.includes(name)) return [];
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const statement = this.prepare(
      `distinct:${layer.type}:${name}`,
      `SELECT "${name.replace(/"/g, '""')}" AS v, COUNT(*) AS c FROM "${layer.type}" WHERE "${name.replace(/"/g, '""')}" IS NOT NULL AND "${name.replace(/"/g, '""')}" != '' GROUP BY v ORDER BY c DESC LIMIT ?`,
    );
    return statement.all(safeLimit).map(([value]) => (value == null ? '' : String(value)));
  }

  linksForPole(poleId) {
    const pole = String(poleId ?? '').trim();
    if (!pole || !this.db) return { inst: [], nets: [] };
    const inst = this.prepare('links:inst', 'SELECT "inst_rid" FROM "_link_pole_inst" WHERE "pole" = ? LIMIT 200');
    const net = this.prepare('links:net', 'SELECT "layer", "net_rid" FROM "_link_pole_net" WHERE "pole" = ? LIMIT 200');
    return {
      inst: inst.all(pole).map(([rid]) => Number(rid)),
      nets: net.all(pole).map(([layer, rid]) => ({ layer: String(layer), rid: Number(rid) })),
    };
  }

  page(type, { offset = 0, limit = 200, search = '', sort = null, dir = 1 } = {}) {
    const layer = this.layer(type);
    const text = String(search || '').trim();
    let where = '';
    const params = [];
    if (text) {
      const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`);
      const { fragment, count } = this.searchWhere(layer);
      where = fragment;
      for (let index = 0; index < count; index++) params.push(`%${escaped}%`);
    }
    let order = '"_rid"';
    if (sort && layer.headers.includes(sort)) {
      order = `"${String(sort).replace(/"/g, '""')}" ${Number(dir) < 0 ? 'DESC' : 'ASC'}`;
    }
    const columns = this.selectColumns(layer);
    const countStatement = this.prepare(`pageCount:${layer.type}:${where ? 'q' : 'all'}`, `SELECT COUNT(*) FROM "${layer.type}"${where}`);
    const total = Number(countStatement.get(...params)?.[0] || 0);
    const offsetSafe = Math.max(0, Number(offset) || 0);
    const limitSafe = Math.max(1, Math.min(1000, Number(limit) || 200));
    const statement = this.prepare(
      `page:${layer.type}:${where ? 'q' : 'all'}:${sort || ''}:${Number(dir) < 0 ? 'd' : 'a'}`,
      `SELECT "_rid", "_geom", "_min_lon", "_max_lon", "_min_lat", "_max_lat"${columns} FROM "${layer.type}"${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    );
    const rows = statement.all(...params, limitSafe, offsetSafe).map((values) => this.toRow(layer.type, values));
    return { total, offset: offsetSafe, limit: limitSafe, rows };
  }
}

const manager = new DatabaseManager();

function registerDatabaseIpc(ipcMain, dialog) {
  const ownerFor = (event) => {
    const { BrowserWindow } = require('electron');
    return BrowserWindow.fromWebContents(event.sender) || null;
  };

  ipcMain.handle('db:open-dialog', async (event) => {
    const result = await dialog.showOpenDialog(ownerFor(event), {
      title: 'Abrir base NeoGrid (SQLite)',
      properties: ['openFile'],
      filters: [
        { name: 'Base NeoGrid', extensions: ['sqlite', 'sqlite3', 'db'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths?.length) return { opened: false, cancelled: true };
    try {
      return { opened: true, info: manager.open(result.filePaths[0]) };
    } catch (error) {
      return { opened: false, error: error.message };
    }
  });

  ipcMain.handle('db:open', async (_event, filePath) => {
    try {
      return { opened: true, info: manager.open(filePath) };
    } catch (error) {
      return { opened: false, error: error.message };
    }
  });

  ipcMain.handle('db:info', async () => (manager.info ? { opened: true, info: manager.info } : { opened: false }));

  ipcMain.handle('db:close', async () => {
    manager.close();
    return { closed: true };
  });

  const query = (channel, handler) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, result: handler(payload || {}) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  };

  query('db:viewport', ({ type, west, east, south, north, limit }) => manager.viewport(type, { west, east, south, north, limit }));
  query('db:rows', ({ type, ids }) => manager.rows(type, ids));
  query('db:row', ({ type, id }) => manager.row(type, id));
  query('db:bounds', ({ type }) => manager.indexBounds(type));
  query('db:hotspots', ({ type, limit }) => manager.hotspots(type, limit));
  query('db:ids-in-bounds', ({ type, west, east, south, north, limit }) => manager.idsInBounds(type, { west, east, south, north, limit }));
  query('db:search', ({ type, term, limit }) => manager.search(type, term, limit));
  query('db:find-by-id', ({ type, id }) => manager.findById(type, id));
  query('db:page', (payload) => manager.page(payload.type, payload));
  query('db:distinct', ({ type, field, limit }) => manager.distinct(type, field, limit));
  query('db:links', ({ pole }) => manager.linksForPole(pole));
}

module.exports = { manager, registerDatabaseIpc };
