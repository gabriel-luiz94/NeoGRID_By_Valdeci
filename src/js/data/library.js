import { bus } from '../core/bus.js';
import { LAYER_META, LAYER_TYPES } from './schema.js';
import { LayerStore } from './layer-store.js';
import { SqliteStore } from './sqlite-store.js';
import { featureSubtitle } from './labels.js';

// Campos pesquisáveis além do identificador: [camada, nomes aceitos da coluna, rótulo].
const CAMPOS_BUSCA = [
  ['poste', ['DE_BARRAMENTO', 'DE_BARRAMEN'], 'barramento'],
  ['inst', ['DE_PLACA'], 'placa'],
];

class Library {
  constructor() {
    this.stores = {};
    this.searchFields = { estado: 'pronto', erro: null };
    this.revision = 0;
    this.importHistory = [];
    this.exportHistory = [];
    this.lastImportAt = 0;
    this.dbInfo = null;
  }

  isDatabase() {
    return Boolean(this.dbInfo);
  }

  openDatabase(info) {
    if (!info || !Array.isArray(info.layers)) throw new Error('Base SQLite inválida.');
    this.stores = {};
    for (const meta of info.layers) {
      if (!meta?.type || !LAYER_TYPES.includes(meta.type)) continue;
      this.stores[meta.type] = new SqliteStore(meta.type, meta);
    }
    this.dbInfo = {
      path: info.path || '',
      size: info.size || 0,
      rows: info.rows || 0,
      builtAt: info.builtAt || 0,
      source: info.source || '',
    };
    this.importHistory.unshift({
      id: crypto.randomUUID(),
      at: Date.now(),
      fileName: (info.path || '').split(/[\\/]/).pop() || 'base.sqlite',
      type: 'database',
      rows: info.rows || 0,
      size: info.size || 0,
    });
    if (this.importHistory.length > 30) this.importHistory.length = 30;
    this.lastImportAt = Date.now();
    this.revision += 1;
    bus.emit('imports:changed', this.importHistory);
    bus.emit('data:changed', this.summary());
  }

  async closeDatabase() {
    try {
      await window.desktop?.dbClose?.();
    } catch {
      /* ignore */
    }
    this.dbInfo = null;
  }

  get(type) {
    return this.stores[type] || null;
  }

  ensure(type) {
    if (!this.stores[type]) this.stores[type] = new LayerStore(type);
    return this.stores[type];
  }

  addBatch(type, headers, rows) {
    if (!LAYER_TYPES.includes(type)) throw new Error(`Camada inválida: ${type}`);
    const store = this.ensure(type);
    const added = store.addRows(headers, rows);
    this.revision += 1;
    return added;
  }

  addImport(meta) {
    const record = {
      id: crypto.randomUUID(),
      at: Date.now(),
      ...meta,
    };
    this.importHistory.unshift(record);
    if (this.importHistory.length > 30) this.importHistory.length = 30;
    this.lastImportAt = record.at;
    bus.emit('imports:changed', this.importHistory);
    return record;
  }

  notifyDataChanged() {
    this.revision += 1;
    bus.emit('data:changed', this.summary());
  }

  storesWithData() {
    return LAYER_TYPES.map((type) => this.stores[type]).filter((store) => store && store.stats.count > 0);
  }

  hasData() {
    return this.storesWithData().length > 0;
  }

  get totalRows() {
    return this.storesWithData().reduce((total, store) => total + store.stats.count, 0);
  }

  get totalLength() {
    return this.storesWithData().reduce((total, store) => total + store.stats.lengthMeters, 0);
  }

  summary() {
    const layers = {};
    let totalRows = 0;
    let located = 0;
    let missing = 0;
    let duplicates = 0;
    let lengthBt = 0;
    let lengthMt = 0;
    let utmSuspect = false;

    for (const type of LAYER_TYPES) {
      const store = this.stores[type];
      const count = store?.stats.count || 0;
      layers[type] = {
        count,
        located: store?.stats.located || 0,
        missing: store?.stats.missing || 0,
        length: store?.stats.lengthMeters || 0,
      };
      totalRows += count;
      located += store?.stats.located || 0;
      missing += store?.stats.missing || 0;
      duplicates += store?.stats.duplicates || 0;
      if (store?.stats.utmSuspect) utmSuspect = true;
      if (type === 'bt') lengthBt = store?.stats.lengthMeters || 0;
      if (type === 'mt') lengthMt = store?.stats.lengthMeters || 0;
    }

    const fileCount = this.importHistory.length;
    return {
      layers,
      totalRows,
      located,
      missing,
      duplicates,
      lengthBt,
      lengthMt,
      totalLength: lengthBt + lengthMt,
      locatedPct: totalRows ? (located / totalRows) * 100 : 0,
      duplicatePct: totalRows ? (duplicates / totalRows) * 100 : 0,
      utmSuspect,
      fileCount,
      lastImportAt: this.lastImportAt,
      stores: this.storesWithData().length,
    };
  }

  composition() {
    return LAYER_TYPES.map((type) => ({
      type,
      name: LAYER_META[type].name,
      color: LAYER_META[type].color,
      count: this.stores[type]?.stats.count || 0,
    })).filter((item) => item.count > 0);
  }

  distribution(type, field) {
    const store = this.stores[type];
    if (!store) return [];
    const map = store.stats[field];
    if (!map) return [];
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  quality() {
    const summary = this.summary();
    let idTotal = 0;
    let idPresent = 0;
    for (const store of this.storesWithData()) {
      if (store.idx.id < 0) continue;
      idTotal += store.stats.count;
      idPresent += store.isDatabase ? (store.stats.idPresent || 0) : store.by.size;
    }
    return {
      ...summary,
      idPct: idTotal ? (idPresent / idTotal) * 100 : 0,
      idPresent,
      idTotal,
    };
  }

  searchIds(query, limit = 12) {
    const term = String(query || '').trim();
    if (term.length < 3) return [];
    const alvo = term.toUpperCase();
    const key = term.slice(0, 3).toUpperCase();
    const results = [];
    for (const type of ['poste', 'inst', 'bt', 'mt']) {
      const store = this.stores[type];
      if (!store || !store.stats.count) continue;
      const bucket = store.idBuckets.get(key) || [];
      const seen = new Set();
      for (const index of bucket) {
        if (seen.has(index)) continue;
        seen.add(index);
        const row = store.rows[index];
        const id = store.idx.id >= 0 ? String(row[store.idx.id] ?? '').trim() : '';
        if (!id || !id.toUpperCase().startsWith(alvo)) continue;
        const exacto = id.toUpperCase() === alvo;
        results.push({
          type,
          index,
          id,
          label: id,
          subtitle: featureSubtitle(store, index),
          exact: exacto,
          rank: exacto ? 0 : 1,
        });
        if (results.length >= limit * 2) break;
      }
    }
    // Sem base SQLite não há índice: os campos são percorridos nas linhas em memória.
    // O termo vale em qualquer posição do valor (ex.: "44357" acha "H044357").
    for (const [type, nomes, campo] of CAMPOS_BUSCA) {
      const store = this.stores[type];
      if (!store || !store.stats.count) continue;
      const coluna = nomes.map((nome) => store.headers.indexOf(nome)).find((posicao) => posicao >= 0);
      if (coluna === undefined) continue;
      for (let index = 0; index < store.rows.length && results.length < limit * 4; index += 1) {
        const valor = String(store.rows[index]?.[coluna] ?? '').trim();
        if (!valor) continue;
        const upper = valor.toUpperCase();
        if (!upper.includes(alvo)) continue;
        const exacto = upper === alvo;
        results.push({
          type,
          index,
          id: valor,
          label: valor,
          campo,
          codigo: store.idx.id >= 0 ? String(store.rows[index][store.idx.id] ?? '').trim() : '',
          subtitle: featureSubtitle(store, index),
          exact: exacto,
          rank: exacto ? 0 : upper.startsWith(alvo) ? 1 : 2,
        });
      }
    }
    results.sort((a, b) => {
      if ((a.rank ?? 2) !== (b.rank ?? 2)) return (a.rank ?? 2) - (b.rank ?? 2);
      if (a.id.length !== b.id.length) return a.id.length - b.id.length;
      return a.id.localeCompare(b.id, 'pt-BR', { numeric: true });
    });
    return results.slice(0, limit);
  }

  async searchIdsAsync(query, limit = 12) {
    const term = String(query || '').trim();
    if (term.length < 3 || !this.isDatabase()) return [];
    const { dbSearch, dbSearchFields } = await import('./database-client.js');
    const results = [];
    try {
      const campos = await dbSearchFields(term, limit);
      this.searchFields = { estado: campos.estado, erro: campos.erro };
      for (const hit of campos.hits) {
        const store = this.stores[hit.type];
        if (!store || !store.stats.count) continue;
        await store.ensureRows([hit.i]);
        if (!store.rows[hit.i]) continue;
        results.push({
          type: hit.type,
          index: hit.i,
          id: hit.valor,
          label: hit.valor,
          campo: hit.campo,
          codigo: hit.id,
          subtitle: featureSubtitle(store, hit.i),
          exact: hit.valor.toUpperCase() === term.toUpperCase(),
          rank: hit.valor.toUpperCase() === term.toUpperCase() ? 0 : hit.valor.toUpperCase().startsWith(term.toUpperCase()) ? 1 : 2,
        });
      }
    } catch (erro) {
      this.searchFields = { estado: 'erro', erro: erro?.message || String(erro) };
    }
    for (const type of ['poste', 'inst', 'bt', 'mt']) {
      const store = this.stores[type];
      if (!store || !store.stats.count) continue;
      let hits = [];
      try {
        hits = await dbSearch(type, term, limit);
      } catch {
        continue;
      }
      if (!hits.length) continue;
      await store.ensureRows(hits.map((hit) => hit.i));
      for (const hit of hits) {
        const row = store.rows[hit.i];
        if (!row) continue;
        results.push({
          type,
          index: hit.i,
          id: hit.id,
          label: hit.id,
          subtitle: featureSubtitle(store, hit.i),
          exact: hit.id.toLowerCase() === term.toLowerCase(),
          rank: hit.id.toLowerCase() === term.toLowerCase() ? 0 : hit.id.toLowerCase().startsWith(term.toLowerCase()) ? 1 : 2,
        });
        if (results.length >= limit * 2) break;
      }
    }
    results.sort((a, b) => {
      if ((a.rank ?? 2) !== (b.rank ?? 2)) return (a.rank ?? 2) - (b.rank ?? 2);
      if (a.id.length !== b.id.length) return a.id.length - b.id.length;
      return a.id.localeCompare(b.id, 'pt-BR', { numeric: true });
    });
    return results.slice(0, limit);
  }

  async findByIdAsync(id) {
    const term = String(id || '').trim();
    if (!term || !this.isDatabase()) return null;
    const { dbFindById } = await import('./database-client.js');
    for (const type of ['poste', 'inst', 'bt', 'mt']) {
      const store = this.stores[type];
      if (!store) continue;
      try {
        const index = await dbFindById(type, term);
        if (index != null) {
          await store.ensureRow(index);
          return { type, index };
        }
      } catch {
        /* próxima camada */
      }
    }
    return null;
  }

  async collectInBoundsAsync(type, bounds, limit = 200000) {
    const store = this.stores[type];
    if (!store) return [];
    if (!store.isDatabase) return store.collectInBounds(bounds);
    const { dbIdsInBounds } = await import('./database-client.js');
    const west = Math.min(bounds.west, bounds.east);
    const east = Math.max(bounds.west, bounds.east);
    const south = Math.min(bounds.south, bounds.north);
    const north = Math.max(bounds.south, bounds.north);
    const ids = await dbIdsInBounds(type, { west, east, south, north }, limit);
    await store.ensureRows(ids);
    return ids.filter((id) => store.rows[id] !== undefined);
  }

  findById(id) {
    const term = String(id || '').trim();
    if (!term) return null;
    for (const type of ['poste', 'inst', 'bt', 'mt']) {
      const store = this.stores[type];
      const index = store?.by.get(term);
      if (index != null) return { type, index };
    }
    return null;
  }

  collectInBounds(type, bounds) {
    return this.stores[type]?.collectInBounds(bounds) || [];
  }

  addExport(entry) {
    const record = {
      id: crypto.randomUUID(),
      at: Date.now(),
      ...entry,
    };
    this.exportHistory.unshift(record);
    if (this.exportHistory.length > 30) this.exportHistory.length = 30;
    bus.emit('exports:changed', this.exportHistory);
    return record;
  }

  clearExports() {
    this.exportHistory = [];
    bus.emit('exports:changed', this.exportHistory);
  }

  clear() {
    this.stores = {};
    this.importHistory = [];
    this.lastImportAt = 0;
    this.dbInfo = null;
    this.revision += 1;
    bus.emit('data:changed', this.summary());
  }
}

export const library = new Library();
