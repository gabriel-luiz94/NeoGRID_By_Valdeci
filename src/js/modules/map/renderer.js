import { library } from '../../data/library.js';
import { installationInfo } from '../../data/labels.js';
import { cssVar } from '../../core/format.js';
import {
  aciHex,
  blockAnchorPoint,
  blockColorIndex,
  blockFor,
  dxfSettingsVersion,
  getDxfLibraryText,
  loadDxfSettings,
  parseDxfBlocks,
  renderLabel,
  templateContext,
} from '../dxf/dxf-settings.js';

const MIN_ZOOM = 15;
const PAD = 0.25;
const RAD = Math.PI / 180;
const LINE_HEIGHT = 12;
const FONT = '600 11px "Inter Variable", "Segoe UI", system-ui, sans-serif';

const dist2 = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const u = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return (px - ax - u * dx) ** 2 + (py - ay - u * dy) ** 2;
};

export class MapRenderer {
  constructor(map, options = {}) {
    this.map = map;
    this.getSettings = options.getSettings || (() => ({}));
    this.getVisibleLayers = options.getVisibleLayers || (() => ({ poste: true, bt: true, mt: true, inst: true }));
    this.onStats = options.onStats || (() => {});
    this.selection = null;
    this.frame = 0;
    this.occupancy = new Map();
    this.labelCount = 0;
    this.widthCache = new Map();
    this.labelCache = new Map();
    this.blockCache = { poste: new Map(), inst: new Map() };
    this.cacheRevision = -1;
    this.labelFactor = 1;
    this.dbBusy = false;
    this.dbQueued = false;
    this.dbGeneration = 0;
    this.projectionScale = 1;
    this.originX = 0;
    this.originY = 0;
    this.padX = 0;
    this.padY = 0;
    this.pixelX = 0;
    this.pixelY = 0;
    this.lastStats = { visible: 0, labels: 0, elapsed: 0, truncated: false, lowZoom: false };
    this.accent = cssVar('--accent', '#f5a524');
    this.dxfVersion = -1;
    this.dxfSettings = null;
    this.dxfBlocks = new Map();
    this.dxfLibraryText = '';

    this.canvas = document.createElement('canvas');
    this.canvas.style.pointerEvents = 'none';
    this.canvas.className = 'map-data-canvas';
    this.context = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    map.getPane('overlayPane').appendChild(this.canvas);

    this._onZoomStart = () => {
      this.canvas.style.visibility = 'hidden';
    };
    this._onZoomEnd = () => {
      this.canvas.style.visibility = 'visible';
      this.schedule();
    };
    map.on('zoomstart', this._onZoomStart);
    map.on('zoomend', this._onZoomEnd);

    document.fonts?.ready?.then(() => {
      this.widthCache.clear();
      this.schedule();
    });
  }

  setSelected(selection) {
    this.selection = selection;
    this.schedule();
  }

  refreshAccent() {
    this.accent = cssVar('--accent', '#f5a524');
    this.schedule();
  }

  readDxfSettings() {
    this.dxfVersion = dxfSettingsVersion();
    this.dxfSettings = loadDxfSettings();
    this.dxfLibraryText = getDxfLibraryText(this.dxfSettings);
    this.dxfBlocks = new Map(
      parseDxfBlocks(this.dxfLibraryText).map((block) => [block.name.toUpperCase(), block]),
    );
    this.labelCache.clear();
    this.blockCache.poste.clear();
    this.blockCache.inst.clear();
    this.cacheRevision = library.revision;
  }

  refreshDxfSettings() {
    this.readDxfSettings();
    this.schedule();
  }

  syncDataRevision() {
    if (this.cacheRevision === library.revision) return;
    this.cacheRevision = library.revision;
    this.labelCache.clear();
    this.blockCache.poste.clear();
    this.blockCache.inst.clear();
  }

  blockNameFor(kind, store, index) {
    const cache = this.blockCache[kind];
    if (!cache || !store) return '';
    if (cache.has(index)) return cache.get(index);
    const name = blockFor(this.dxfSettings, store, store.rows[index], kind) || '';
    if (cache.size > 80000) cache.clear();
    cache.set(index, name);
    return name;
  }

  labelsFor(type, store, index) {
    const key = `${type}:${index}`;
    const cached = this.labelCache.get(key);
    if (cached) return cached;
    const row = store.rows[index];
    const context = templateContext(store, row, type, this.dxfSettings);
    if (type === 'inst') {
      const info = installationInfo(store, index);
      context.TIPO_INSTA = context.TIPO_INSTA || info.name;
      context.DE_PLACA = context.DE_PLACA || info.plate;
    }
    const lines = renderLabel(this.dxfSettings.labels?.[type], context, {
      settings: this.dxfSettings,
      type,
    });
    if (this.labelCache.size > 80000) this.labelCache.clear();
    this.labelCache.set(key, lines);
    return lines;
  }

  blockColor(kind, fallback = '#fbbf24') {
    const index = blockColorIndex(this.dxfSettings, kind, 7);
    if (index > 0) return aciHex(index, fallback);
    return aciHex(this.dxfSettings?.colors?.[kind], fallback);
  }

  drawBlock(block, x, y, rotation, color, size, anchor = 'base') {
    if (!block?.shapes?.length) return false;
    const bounds = block.bounds;
    if (!bounds || (bounds.width <= 0 && bounds.height <= 0)) return false;
    const scale = size / Math.max(bounds.width, bounds.height);
    if (!Number.isFinite(scale) || scale <= 0) return false;
    const context = this.context;
    const [anchorX, anchorY] = blockAnchorPoint(block, anchor);
    context.save();
    context.translate(x, y);
    context.rotate(-rotation);
    context.scale(scale, -scale);
    context.translate(-anchorX, -anchorY);
    context.strokeStyle = color;
    context.lineWidth = 1.4 / scale;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    this.drawShapes(block.shapes, 0);
    context.restore();
    return true;
  }

  drawShapes(shapes, depth) {
    if (depth > 5) return;
    const context = this.context;
    for (const shape of shapes) {
      if (shape.type === 'insert') {
        const nested = this.dxfBlocks.get(String(shape.name || '').toUpperCase());
        if (!nested?.shapes?.length) continue;
        context.save();
        context.translate(shape.p[0], shape.p[1]);
        context.rotate(-shape.rotation);
        context.scale(shape.sx || 1, shape.sy || 1);
        context.translate(-(nested.base?.[0] || 0), -(nested.base?.[1] || 0));
        this.drawShapes(nested.shapes, depth + 1);
        context.restore();
        continue;
      }
      context.beginPath();
      if (shape.type === 'line') {
        context.moveTo(shape.a[0], shape.a[1]);
        context.lineTo(shape.b[0], shape.b[1]);
      } else if (shape.type === 'circle') {
        context.arc(shape.c[0], shape.c[1], shape.r, 0, Math.PI * 2);
      } else if (shape.type === 'arc') {
        const steps = 24;
        const sweep = shape.end - shape.start;
        for (let i = 0; i <= steps; i++) {
          const angle = shape.start + (sweep * i) / steps;
          const x = shape.c[0] + Math.cos(angle) * shape.r;
          const y = shape.c[1] + Math.sin(angle) * shape.r;
          if (i === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
      } else if (shape.points?.length >= 2) {
        context.moveTo(shape.points[0][0], shape.points[0][1]);
        for (let i = 1; i < shape.points.length; i++) context.lineTo(shape.points[i][0], shape.points[i][1]);
        if (shape.closed) context.closePath();
      } else {
        continue;
      }
      context.stroke();
    }
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  project(lon, lat) {
    const sin = Math.sin(lat * RAD);
    this.pixelX = ((lon + 180) / 360) * this.projectionScale - this.originX;
    this.pixelY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * this.projectionScale - this.originY;
  }

  width(text) {
    let measured = this.widthCache.get(text);
    if (measured == null) {
      measured = this.context.measureText(text).width;
      if (this.widthCache.size > 30000) this.widthCache.clear();
      this.widthCache.set(text, measured);
    }
    return measured;
  }

  isFree(x0, y0, x1, y1) {
    for (let a = x0 >> 6; a <= x1 >> 6; a++) {
      for (let b = y0 >> 6; b <= y1 >> 6; b++) {
        const bucket = this.occupancy.get(a * 100000 + b);
        if (!bucket) continue;
        for (const box of bucket) {
          if (x0 < box[2] && x1 > box[0] && y0 < box[3] && y1 > box[1]) return false;
        }
      }
    }
    return true;
  }

  occupy(x0, y0, x1, y1) {
    const box = [x0, y0, x1, y1];
    for (let a = x0 >> 6; a <= x1 >> 6; a++) {
      for (let b = y0 >> 6; b <= y1 >> 6; b++) {
        const key = a * 100000 + b;
        const bucket = this.occupancy.get(key);
        if (bucket) bucket.push(box);
        else this.occupancy.set(key, [box]);
      }
    }
  }

  label(lines, x, y, color, mode = 'right', angle = 0, maxLabels = Infinity) {
    this.labelAttempts += 1;
    if (this.labelCount >= maxLabels || this.labelAttempts > maxLabels * 5 || !lines.length) return;
    let height = lines.length * LINE_HEIGHT + 2;
    let width = 2;
    for (const line of lines) width = Math.max(width, this.width(line) + 2);

    const boxes = [];
    if (mode === 'center') {
      const count = Math.max(1, Math.ceil(width / 12));
      const radius = height / 2 - 1;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let index = 0; index < count; index++) {
        const offset = ((index + 0.5) / count - 0.5) * width;
        boxes.push([
          x + cos * offset - radius,
          y + sin * offset - radius,
          x + cos * offset + radius,
          y + sin * offset + radius,
        ]);
      }
    } else if (mode === 'left') {
      boxes.push([x - width, y - height / 2, x, y + height / 2]);
    } else {
      boxes.push([x, y - height / 2, x + width, y + height / 2]);
    }

    for (const box of boxes) {
      if (!this.isFree(box[0], box[1], box[2], box[3])) return;
    }
    for (const box of boxes) this.occupy(box[0], box[1], box[2], box[3]);

    this.labelCount += 1;
    const context = this.context;
    context.save();
    context.translate(x, y);
    if (mode === 'center') context.rotate(angle);
    context.textAlign = mode === 'center' ? 'center' : mode === 'left' ? 'right' : 'left';
    context.textBaseline = 'middle';
    context.lineWidth = 3;
    context.lineJoin = 'round';
    context.strokeStyle = 'rgba(3, 8, 12, .92)';
    context.fillStyle = color;
    lines.forEach((line, index) => {
      const offsetY = (index - (lines.length - 1) / 2) * LINE_HEIGHT;
      context.strokeText(line, 0, offsetY);
      context.fillText(line, 0, offsetY);
    });
    context.restore();
  }

  visibleIndexes(capValue) {
    const active = this.getVisibleLayers();
    const bounds = this.map.getBounds().pad(PAD * 1.1);
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const x0 = Math.floor(west * 100) - 1;
    const x1 = Math.floor(east * 100) + 1;
    const y0 = Math.floor(south * 100) - 1;
    const y1 = Math.floor(north * 100) + 1;
    const cap = Math.max(1000, Number(capValue) || 12000);
    const result = { poste: [], bt: [], mt: [], inst: [], truncated: false };

    for (const type of ['poste', 'bt', 'mt', 'inst']) {
      const store = library.get(type);
      if (!store || !active[type]) continue;
      const list = result[type];
      outer: for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const cell = store.grid.get(`${cx},${cy}`);
          if (!cell) continue;
          for (const index of cell) {
            const lon = store.X[index];
            const lat = store.Y[index];
            if (lon < west || lon > east || lat < south || lat > north) continue;
            if (list.length >= cap) {
              result.truncated = true;
              break outer;
            }
            list.push(index);
          }
        }
      }
    }
    return result;
  }

  drawSelection(accent) {
    const selection = this.selection;
    if (!selection) return;
    const store = library.get(selection.type);
    if (!store || !this.getVisibleLayers()[selection.type]) return;
    const context = this.context;
    const index = selection.index;

    if (selection.type === 'poste' || selection.type === 'inst') {
      const point = store.getPoint(index);
      if (!point) return;
      this.project(point[1], point[0]);
      context.save();
      context.strokeStyle = accent;
      context.fillStyle = 'rgba(245, 165, 36, .12)';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(this.pixelX, this.pixelY, 13, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.globalAlpha = 0.45;
      context.beginPath();
      context.arc(this.pixelX, this.pixelY, 19, 0, Math.PI * 2);
      context.stroke();
      context.restore();
      return;
    }

    const rings = store.getGeometry(index);
    if (!rings.length) return;
    context.save();
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = accent;
    context.globalAlpha = 0.18;
    context.lineWidth = 12;
    this.traceRings(rings);
    context.stroke();
    context.globalAlpha = 0.95;
    context.lineWidth = 2;
    context.setLineDash([7, 5]);
    this.traceRings(rings);
    context.stroke();
    context.restore();
  }

  traceRings(rings) {
    const context = this.context;
    context.beginPath();
    for (const ring of rings) {
      for (let index = 0; index < ring.length; index++) {
        const point = ring[index];
        if (!Number.isFinite(point[1]) || !Number.isFinite(point[0])) continue;
        this.project(point[1], point[0]);
        if (index) context.lineTo(this.pixelX, this.pixelY);
        else context.moveTo(this.pixelX, this.pixelY);
      }
    }
  }

  render() {
    const started = performance.now();
    const frame = this.beginFrame(started);
    if (!frame) return;
    if (library.isDatabase()) {
      this.renderDatabase(frame);
      return;
    }
    const visible = this.visibleIndexes(frame.elementCap);
    this.drawVisible(visible, frame);
  }

  beginFrame(started) {
    const size = this.map.getSize();
    if (!size.x || !size.y) return null;

    const settings = this.getSettings();
    if (!this.dxfSettings || this.dxfVersion !== dxfSettingsVersion()) this.readDxfSettings();
    this.syncDataRevision();
    const dxf = this.dxfSettings;
    const zoom = this.map.getZoom();
    const adaptive = settings.adaptive !== false;
    let dpr = Number(settings.dpr) || 0;
    if (dpr <= 0) dpr = Math.min(window.devicePixelRatio || 1, adaptive ? 1.5 : 2);
    if (adaptive) dpr = Math.min(dpr, 1.5);
    dpr = Math.max(1, Math.min(3, dpr));
    if (document.body.classList.contains('is-printing')) {
      dpr = Math.max(1, Math.min(2, Math.sqrt(9e7 / (size.x * size.y))));
    }
    const capSetting = Math.max(1000, Number(settings.maxElements) || 12000);
    const elementCap = adaptive ? Math.min(capSetting, 12000) : capSetting;
    const labelCapSetting = Math.max(0, Number(settings.maxLabels) || 2000);
    const labelCap = adaptive ? Math.min(labelCapSetting, 1200) : labelCapSetting;

    this.padX = Math.round(size.x * PAD);
    this.padY = Math.round(size.y * PAD);
    const width = size.x + 2 * this.padX;
    const height = size.y + 2 * this.padY;

    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }

    L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([-this.padX, -this.padY]));
    this.canvas.style.visibility = 'visible';
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.context.clearRect(0, 0, width, height);
    this.context.font = FONT;
    this.occupancy = new Map();
    this.labelCount = 0;
    this.labelAttempts = 0;

    const hasData = library.hasData();
    if (zoom < MIN_ZOOM) {
      this.lastStats = {
        visible: 0,
        labels: 0,
        elapsed: performance.now() - started,
        truncated: false,
        lowZoom: true,
        hasData,
        reason: 'zoom',
      };
      this.onStats(this.lastStats);
      return null;
    }

    this.updateProjection();
    return { settings, dxf, zoom, adaptive, elementCap, labelCap, hasData, started };
  }

  updateProjection() {
    const zoom = this.map.getZoom();
    this.projectionScale = 256 * 2 ** zoom;
    const min = this.map.getPixelBounds().min;
    this.originX = min.x - this.padX;
    this.originY = min.y - this.padY;
  }

  async viewportFromDatabase(bounds, elementCap) {
    const { dbViewport } = await import('../../data/database-client.js');
    const active = this.getVisibleLayers();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const result = { poste: [], bt: [], mt: [], inst: [], truncated: false };
    await Promise.all(['poste', 'bt', 'mt', 'inst'].map(async (type) => {
      const store = library.get(type);
      if (!store || !active[type]) return;
      if (!store.isDatabase) {
        // Modo misto (improvável): fatia da grade em memória.
        const list = result[type];
        const x0 = Math.floor(west * 100) - 1;
        const x1 = Math.floor(east * 100) + 1;
        const y0 = Math.floor(south * 100) - 1;
        const y1 = Math.floor(north * 100) + 1;
        outer: for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const cell = store.grid.get(`${cx},${cy}`);
            if (!cell) continue;
            for (const index of cell) {
              if (list.length >= elementCap) {
                result.truncated = true;
                break outer;
              }
              list.push(index);
            }
          }
        }
        return;
      }
      let packets = [];
      try {
        packets = await dbViewport(type, { west, east, south, north }, elementCap);
      } catch {
        return;
      }
      store.cachePackets(packets);
      const list = result[type];
      for (const packet of packets) {
        const rid = Number(packet.i);
        if (store.rows[rid] === undefined) continue;
        if (type === 'poste' || type === 'inst') {
          const lon = store.X[rid];
          const lat = store.Y[rid];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          if (lon < west || lon > east || lat < south || lat > north) continue;
        }
        list.push(rid);
      }
      if (packets.length >= elementCap) result.truncated = true;
    }));
    return result;
  }

  async renderDatabase(frame) {
    if (this.dbBusy) {
      this.dbQueued = true;
      return;
    }
    this.dbBusy = true;
    try {
      do {
        this.dbQueued = false;
        const generation = ++this.dbGeneration;
        const bounds = this.map.getBounds().pad(PAD * 1.1);
        const visible = await this.viewportFromDatabase(bounds, frame.elementCap);
        if (generation !== this.dbGeneration) continue;
        if (this.cacheRevision !== library.revision) continue;
        this.updateProjection();
        this.occupancy = new Map();
        this.labelCount = 0;
        this.labelAttempts = 0;
        this.drawVisible(visible, frame);
      } while (this.dbQueued);
    } catch {
      /* mantém o quadro anterior em caso de erro transitório */
    } finally {
      this.dbBusy = false;
    }
  }

  drawVisible(visible, frame) {
    const { settings, dxf, zoom, adaptive, labelCap, hasData, started } = frame;
    const total = visible.poste.length + visible.inst.length + visible.bt.length + visible.mt.length;
    const context = this.context;

    // Redes
    for (const type of ['mt', 'bt']) {
      const list = visible[type];
      if (!list.length) continue;
      const store = library.get(type);
      context.beginPath();
      for (const index of list) {
        for (const ring of store.getGeometry(index)) {
          for (let pointIndex = 0; pointIndex < ring.length; pointIndex++) {
            const point = ring[pointIndex];
            if (!Number.isFinite(point[1]) || !Number.isFinite(point[0])) continue;
            this.project(point[1], point[0]);
            if (pointIndex) context.lineTo(this.pixelX, this.pixelY);
            else context.moveTo(this.pixelX, this.pixelY);
          }
        }
      }
      context.strokeStyle = aciHex(dxf.colors?.[type], type === 'mt' ? '#fb7185' : '#2dd4bf');
      context.lineWidth = type === 'mt' ? (zoom >= 17 ? 5 : 3.5) : (zoom >= 17 ? 2.8 : 2);
      context.lineJoin = 'round';
      context.lineCap = 'round';
      context.stroke();
    }

    // Postes
    if (visible.poste.length) {
      const store = library.get('poste');
      const color = this.blockColor('poste', '#fbbf24');
      const blockSize = Math.max(8, Number(dxf.blockSize) || 20);
      const halfW = (zoom >= 17 ? 12 : zoom >= 16 ? 8 : 5.5) / 2;
      const halfH = (zoom >= 17 ? 6.5 : zoom >= 16 ? 4.2 : 3) / 2;
      for (const index of visible.poste) {
        const lon = store.X[index];
        const lat = store.Y[index];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        this.project(lon, lat);
        const angle = store.angle >= 0 ? Number(String(store.rows[index][store.angle] ?? '').replace(',', '.')) || 0 : 0;
        const rotation = angle * RAD;
        const blockName = this.blockNameFor('poste', store, index);
        const block = blockName ? this.dxfBlocks.get(blockName.toUpperCase()) : null;
        if (block && this.drawBlock(block, this.pixelX, this.pixelY, rotation, color, blockSize, dxf.blockAnchor?.poste || 'base')) continue;
        context.fillStyle = color;
        context.strokeStyle = 'rgba(8, 20, 28, .85)';
        context.lineWidth = 1;
        if (dxf.shapes?.poste === 'circle') {
          context.beginPath();
          context.arc(this.pixelX, this.pixelY, Math.max(halfW, halfH), 0, Math.PI * 2);
        } else if (dxf.shapes?.poste === 'triangle') {
          context.beginPath();
          context.moveTo(this.pixelX, this.pixelY - halfW * 1.2);
          context.lineTo(this.pixelX + halfW * 1.2, this.pixelY + halfH);
          context.lineTo(this.pixelX - halfW * 1.2, this.pixelY + halfH);
          context.closePath();
        } else {
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          context.beginPath();
          context.moveTo(this.pixelX - halfW * cos + halfH * sin, this.pixelY - halfW * sin - halfH * cos);
          context.lineTo(this.pixelX + halfW * cos + halfH * sin, this.pixelY + halfW * sin - halfH * cos);
          context.lineTo(this.pixelX + halfW * cos - halfH * sin, this.pixelY + halfW * sin + halfH * cos);
          context.lineTo(this.pixelX - halfW * cos - halfH * sin, this.pixelY - halfW * sin + halfH * cos);
          context.closePath();
        }
        context.fill();
        context.stroke();
      }
    }

    // Instalações
    if (visible.inst.length) {
      const store = library.get('inst');
      const color = this.blockColor('inst', '#a78bfa');
      const blockSize = Math.max(8, Number(dxf.blockSize) || 20);
      context.lineWidth = 1.5;
      context.strokeStyle = 'rgba(8, 20, 28, .9)';
      for (const index of visible.inst) {
        const lon = store.X[index];
        const lat = store.Y[index];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        this.project(lon, lat);
        const info = installationInfo(store, index);
        const blockName = this.blockNameFor('inst', store, index);
        const block = blockName ? this.dxfBlocks.get(blockName.toUpperCase()) : null;
        if (block && this.drawBlock(block, this.pixelX, this.pixelY, info.angle, color, blockSize, dxf.blockAnchor?.inst || 'base')) continue;
        const shape = dxf.shapes?.inst === 'auto' ? info.kind : dxf.shapes?.inst;
        if (shape === 'rel' || shape === 'square') {
          context.fillStyle = color;
          context.fillRect(this.pixelX - 6.5, this.pixelY - 6.5, 13, 13);
          context.strokeRect(this.pixelX - 6.5, this.pixelY - 6.5, 13, 13);
        } else if (shape === 'trafo' || shape === 'triangle') {
          context.fillStyle = color;
          context.beginPath();
          context.moveTo(this.pixelX, this.pixelY - 8.5);
          context.lineTo(this.pixelX + 8.5, this.pixelY + 6.5);
          context.lineTo(this.pixelX - 8.5, this.pixelY + 6.5);
          context.closePath();
          context.fill();
          context.stroke();
        } else if (shape === 'chave' || shape === 'line') {
          context.save();
          context.translate(this.pixelX, this.pixelY);
          context.rotate(info.angle);
          context.beginPath();
          context.moveTo(-9, 0);
          context.lineTo(9, 0);
          context.strokeStyle = color;
          context.lineWidth = 4;
          context.lineCap = 'round';
          context.stroke();
          context.restore();
          context.strokeStyle = 'rgba(8, 20, 28, .9)';
          context.lineWidth = 1.5;
        } else {
          context.fillStyle = color;
          context.beginPath();
          context.arc(this.pixelX, this.pixelY, 4.5, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      }
    }

    this.drawSelection(this.accent);

    // Rótulos
    const labelZoom = Math.max(15, Number(settings.labelZoom) || 17);
    const maxLabels = Math.max(0, Math.floor(labelCap * this.labelFactor));
    if (settings.labels && zoom >= labelZoom) {
      if (visible.poste.length) {
        const store = library.get('poste');
        for (const index of visible.poste) {
          if (this.labelCount >= maxLabels || this.labelAttempts >= maxLabels * 5) break;
          const lon = store.X[index];
          const lat = store.Y[index];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          this.project(lon, lat);
          const all = this.labelsFor('poste', store, index);
          const lines = all;
          if (!lines.length) continue;
          this.label(lines, this.pixelX + (zoom >= 17 ? 9 : 6), this.pixelY, aciHex(dxf.colors?.txtPoste, '#ffe08a'), 'right', 0, maxLabels);
        }
      }

      if (visible.inst.length) {
        const store = library.get('inst');
        for (const index of visible.inst) {
          if (this.labelCount >= maxLabels || this.labelAttempts >= maxLabels * 5) break;
          const lon = store.X[index];
          const lat = store.Y[index];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const all = this.labelsFor('inst', store, index);
          const lines = all;
          if (!lines.length) continue;
          this.project(lon, lat);
          this.label(lines, this.pixelX - 11, this.pixelY - 2, aciHex(dxf.colors?.txtInst, '#f1f5f9'), 'left', 0, maxLabels);
        }
      }

      const candidates = [];
      for (const type of ['mt', 'bt']) {
        if (this.labelAttempts >= maxLabels * 5 || candidates.length >= maxLabels * 3) break;
        const list = visible[type];
        if (!list.length) continue;
        const store = library.get(type);
        const offset = type === 'mt' ? 8 : -8;
        for (const index of list) {
          if (candidates.length >= maxLabels * 3) break;
          const rings = store.getGeometry(index);
          const ring = rings[0];
          if (!ring || ring.length < 2) continue;
          this.project(ring[0][1], ring[0][0]);
          const startX = this.pixelX;
          const startY = this.pixelY;
          this.project(ring[ring.length - 1][1], ring[ring.length - 1][0]);
          const endX = this.pixelX;
          const endY = this.pixelY;
          const dx = endX - startX;
          const dy = endY - startY;
          const length = Math.hypot(dx, dy);
          if (length < 8) continue;
          let angle = Math.atan2(dy, dx);
          if (angle > Math.PI / 2) angle -= Math.PI;
          else if (angle < -Math.PI / 2) angle += Math.PI;
          const text = this.labelsFor(type, store, index).join(' · ');
          if (!text) continue;
          candidates.push({
            length,
            text,
            angle,
            x: (startX + endX) / 2 + Math.sin(angle) * offset,
            y: (startY + endY) / 2 - Math.cos(angle) * offset,
            color: aciHex(dxf.colors?.[type === 'bt' ? 'txtBt' : 'txtMt'], type === 'bt' ? '#a7f3b8' : '#ffb4b4'),
          });
        }
      }
      candidates.sort((a, b) => b.length - a.length);
      for (const candidate of candidates) {
        this.label([candidate.text], candidate.x, candidate.y, candidate.color, 'center', candidate.angle, maxLabels);
      }
    }

    const elapsed = performance.now() - started;
    if (adaptive && total > 400) {
      if (elapsed > 55) this.labelFactor = Math.max(0.35, this.labelFactor * 0.86);
      else if (elapsed < 24) this.labelFactor = Math.min(1, this.labelFactor * 1.05);
    }

    this.lastStats = {
      visible: total,
      labels: this.labelCount,
      elapsed,
      truncated: visible.truncated,
      lowZoom: false,
      hasData,
      reason: !total && hasData ? 'empty-area' : visible.truncated ? 'truncated' : '',
    };
    this.onStats(this.lastStats);
  }

  drawFeatureFromHit(type, index) {
    const store = library.get(type);
    if (!store) return null;
    return {
      type,
      index,
      title: index,
      store,
    };
  }

  findAt(containerPoint, latlng) {
    if (this.map.getZoom() < MIN_ZOOM) return [];
    const active = this.getVisibleLayers();
    const gx = Math.floor(latlng.lng * 100);
    const gy = Math.floor(latlng.lat * 100);

    const candidatesFor = (store) => {
      const result = new Set();
      for (let x = gx - 1; x <= gx + 1; x++) {
        for (let y = gy - 1; y <= gy + 1; y++) {
          const cell = store.grid.get(`${x},${y}`);
          if (cell) for (const index of cell) result.add(index);
        }
      }
      return result;
    };

    let bestPoint = null;
    let bestDistance = 12 ** 2;
    for (const type of ['poste', 'inst']) {
      const store = library.get(type);
      if (!store || !active[type]) continue;
      for (const index of candidatesFor(store)) {
        const point = store.getPoint(index);
        if (!point) continue;
        const projected = this.map.latLngToContainerPoint(point);
        const distance = (projected.x - containerPoint.x) ** 2 + (projected.y - containerPoint.y) ** 2;
        if (distance <= bestDistance) {
          bestDistance = distance;
          bestPoint = { type, index };
        }
      }
    }
    if (bestPoint) return [bestPoint];

    const hits = [];
    for (const type of ['mt', 'bt']) {
      const store = library.get(type);
      if (!store || !active[type]) continue;
      const found = [];
      for (const index of candidatesFor(store)) {
        let minimum = 8 ** 2;
        for (const ring of store.getGeometry(index)) {
          if (ring.length < 2) continue;
          let previous = this.map.latLngToContainerPoint(ring[0]);
          for (let i = 1; i < ring.length; i++) {
            const current = this.map.latLngToContainerPoint(ring[i]);
            minimum = Math.min(minimum, dist2(containerPoint.x, containerPoint.y, previous.x, previous.y, current.x, current.y));
            previous = current;
          }
        }
        if (minimum < 8 ** 2) found.push([minimum, index]);
      }
      found.sort((a, b) => a[0] - b[0]);
      for (const [, index] of found.slice(0, 3)) hits.push({ type, index });
    }
    return hits;
  }

  async findAtAsync(containerPoint, latlng) {
    if (this.map.getZoom() < MIN_ZOOM) return [];
    const active = this.getVisibleLayers();
    // Tolerância em graus a partir de pixels.
    const cornerA = this.map.containerPointToLatLng([containerPoint.x - 12, containerPoint.y - 12]);
    const cornerB = this.map.containerPointToLatLng([containerPoint.x + 12, containerPoint.y + 12]);
    const padLng = Math.abs(cornerB.lng - cornerA.lng) / 2 || 0.0002;
    const padLat = Math.abs(cornerB.lat - cornerA.lat) / 2 || 0.0002;
    const { dbIdsInBounds } = await import('../../data/database-client.js');
    const pointHits = async (type) => {
      const store = library.get(type);
      if (!store || !active[type]) return [];
      let ids = [];
      try {
        ids = await dbIdsInBounds(type, {
          west: latlng.lng - padLng,
          east: latlng.lng + padLng,
          south: latlng.lat - padLat,
          north: latlng.lat + padLat,
        }, 200);
      } catch {
        return [];
      }
      await store.ensureRows(ids);
      let best = null;
      let bestDistance = 12 ** 2;
      for (const index of ids) {
        const point = store.getPoint(index);
        if (!point) continue;
        const projected = this.map.latLngToContainerPoint(point);
        const distance = (projected.x - containerPoint.x) ** 2 + (projected.y - containerPoint.y) ** 2;
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = { type, index };
        }
      }
      return best ? [best] : [];
    };

    for (const type of ['poste', 'inst']) {
      const found = await pointHits(type);
      if (found.length) return found;
    }

    const hits = [];
    for (const type of ['mt', 'bt']) {
      const store = library.get(type);
      if (!store || !active[type]) continue;
      let ids = [];
      try {
        ids = await dbIdsInBounds(type, {
          west: latlng.lng - padLng,
          east: latlng.lng + padLng,
          south: latlng.lat - padLat,
          north: latlng.lat + padLat,
        }, 500);
      } catch {
        continue;
      }
      await store.ensureRows(ids);
      const found = [];
      for (const index of ids) {
        let minimum = 8 ** 2;
        for (const ring of store.getGeometry(index)) {
          if (ring.length < 2) continue;
          let previous = this.map.latLngToContainerPoint(ring[0]);
          for (let i = 1; i < ring.length; i++) {
            const current = this.map.latLngToContainerPoint(ring[i]);
            minimum = Math.min(minimum, dist2(containerPoint.x, containerPoint.y, previous.x, previous.y, current.x, current.y));
            previous = current;
          }
        }
        if (minimum < 8 ** 2) found.push([minimum, index]);
      }
      found.sort((a, b) => a[0] - b[0]);
      for (const [, index] of found.slice(0, 3)) hits.push({ type, index });
    }
    return hits;
  }

  destroy() {
    this.map.off('zoomstart', this._onZoomStart);
    this.map.off('zoomend', this._onZoomEnd);
    cancelAnimationFrame(this.frame);
    this.canvas.remove();
  }
}
