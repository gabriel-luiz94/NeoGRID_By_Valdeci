import { library } from '../../data/library.js';
import { installationInfo, num } from '../../data/labels.js';
import { utmZone, utm, dxfText } from './utm.js';
import {
  blockColorIndex,
  blockFor,
  blockInsertionPoint,
  extractBlockDefinitions,
  getDxfLibraryText,
  loadDxfSettings,
  parseDxfBlocks,
  renderLabel,
  templateContext,
} from './dxf-settings.js';
import { fetchStreets, streetIntersectsBounds } from '../osm.js';

// Kept as a re-export because the QA screenshot mode imports fetchStreets from this module.
export { fetchStreets };

export function collectForExport(bounds, visibleLayers) {
  const result = { poste: [], inst: [], bt: [], mt: [], ruas: [] };
  for (const type of ['poste', 'inst', 'bt', 'mt']) {
    if (!visibleLayers[type]) continue;
    result[type] = library.collectInBounds(type, bounds);
  }
  return result;
}

export async function collectForExportAsync(bounds, visibleLayers, limit = 200000) {
  const result = { poste: [], inst: [], bt: [], mt: [], ruas: [] };
  for (const type of ['poste', 'inst', 'bt', 'mt']) {
    if (!visibleLayers[type]) continue;
    result[type] = await library.collectInBoundsAsync(type, bounds, limit);
  }
  return result;
}

export function countCollected(collected) {
  const counts = {};
  let total = 0;
  for (const type of ['poste', 'inst', 'bt', 'mt']) {
    counts[type] = collected[type]?.length || 0;
    total += counts[type];
  }
  return { counts, total };
}

export function generateDxf(bounds, denominator, streets = [], visibleLayers = { poste: true, inst: true, bt: true, mt: true }, options = {}) {
  const settings = options.settings || loadDxfSettings();
  const stores = options.stores || library;
  const storeOf = (type) => (typeof stores.get === 'function' ? stores.get(type) : stores[type]);
  const collected = options.collected || collectForExport(bounds, visibleLayers);
  const libraryText = options.libraryText ?? getDxfLibraryText(settings);
  const color = (name, fallback = 7) => {
    const value = Number(settings.colors?.[name]);
    return Number.isFinite(value) && value >= 0 && value <= 256 ? value : fallback;
  };
  const warnings = [];
  const center = {
    lat: (bounds.north + bounds.south) / 2,
    lon: (bounds.east + bounds.west) / 2,
  };
  const zone = utmZone(center.lon);
  const centerUtm = utm(center.lat, center.lon, zone);
  const scale = 1000 / denominator;
  const project = (lat, lon) => {
    const [x, y] = utm(lat, lon, zone);
    return [centerUtm[0] + (x - centerUtm[0]) * scale, centerUtm[1] + (y - centerUtm[1]) * scale];
  };

  const entities = [];
  const push = (...values) => entities.push(...values);
  const format = (value) => Number(value).toFixed(3);
  const textHeight = 1.5;
  const lineHeight = textHeight * 1.25;

  const polyline = (layer, points, closed) => {
    push(0, 'POLYLINE', 8, layer, 66, 1, 10, 0, 20, 0, 30, 0, 70, closed ? 1 : 0);
    for (const [x, y] of points) push(0, 'VERTEX', 8, layer, 10, format(x), 20, format(y), 30, 0);
    push(0, 'SEQEND', 8, layer);
  };

  const text = (layer, value, x, y, rotation = 0, alignment = 1) => {
    const content = dxfText(value);
    if (!content) return;
    push(0, 'TEXT', 8, layer, 10, format(x), 20, format(y), 30, 0, 40, format(textHeight),
      1, content, 50, format(rotation), 72, alignment, 73, 2, 11, format(x), 21, format(y), 31, 0);
  };

  const circle = (layer, x, y, radius) => {
    push(0, 'CIRCLE', 8, layer, 10, format(x), 20, format(y), 30, 0, 40, format(radius));
  };

  const insert = (layer, name, x, y, rotation = 0, colorIndex = 0) => {
    const clean = String(name || '').trim().replace(/[\r\n]/g, '').slice(0, 255);
    if (!clean) return false;
    const strokeColor = Number(colorIndex) > 0 && Number(colorIndex) <= 255 ? Number(colorIndex) : 0;
    push(0, 'INSERT', 8, layer, ...(strokeColor ? [62, strokeColor] : []), 2, clean,
      10, format(x), 20, format(y), 30, 0, 41, 1, 42, 1, 50, format(rotation));
    return true;
  };

  const block = (layer, lines, x, y, alignment = 1) => {
    lines.forEach((line, index) => {
      text(layer, line, x, y + ((lines.length - 1) / 2 - index) * lineHeight, 0, alignment);
    });
  };

  const posteStore = storeOf('poste');
  const instStore = storeOf('inst');
  const selectedBlocks = new Set();
  for (const index of collected.poste) {
    const name = blockFor(settings, posteStore, posteStore?.rows[index], 'poste');
    if (name) selectedBlocks.add(name);
  }
  for (const index of collected.inst) {
    const name = blockFor(settings, instStore, instStore?.rows[index], 'inst');
    if (name) selectedBlocks.add(name);
  }
  const blockDefinitions = extractBlockDefinitions(libraryText, [...selectedBlocks], {
    byBlock: settings.uniformBlockColors !== false,
  });
  const parsedBlocks = new Map(parseDxfBlocks(libraryText).map((block) => [block.name.toUpperCase(), block]));
  const hasBlock = (name) => {
    if (!name) return false;
    return parsedBlocks.has(name.toUpperCase());
  };
  for (const name of selectedBlocks) {
    if (!hasBlock(name)) warnings.push(`Bloco "${name}" não encontrado no DXF carregado.`);
  }
  /**
   * Inserts a block so that its configured anchor (tip, centre, base...) lands on the CSV
   * coordinate. This is what keeps the pole tip on the field coordinate instead of the CAD
   * insertion point landing in the middle of the symbol.
   */
  const insertBlock = (layer, kind, name, x, y, angleDegrees) => {
    const block = parsedBlocks.get(String(name || '').toUpperCase());
    const anchor = settings.blockAnchor?.[kind] || 'base';
    const [px, py] = block
      ? blockInsertionPoint(block, anchor, [x, y], angleDegrees)
      : [x, y];
    return insert(layer, name, px, py, angleDegrees, blockColorIndex(settings, kind, color(kind, 7)));
  };

  // Postes
  if (collected.poste.length) {
    const store = storeOf('poste');
    for (const index of collected.poste) {
      if (!store) break;
      const [x, y] = project(store.Y[index], store.X[index]);
      const angle = store.angle >= 0 ? num(store.rows[index][store.angle]) : 0;
      const theta = (-angle * Math.PI) / 180;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const blockName = blockFor(settings, store, store.rows[index], 'poste');
      if (blockName && hasBlock(blockName)) {
        insertBlock('POSTES', 'poste', blockName, x, y, angle);
      } else if (settings.shapes?.poste === 'circle') {
        circle('POSTES', x, y, 1.85);
      } else if (settings.shapes?.poste === 'triangle') {
        polyline('POSTES', [[0, 2.2], [2.2, -1.6], [-2.2, -1.6]].map(([u, v]) => [x + u, y + v]), true);
      } else {
        const halfWidth = 1.85;
        const halfHeight = 0.93;
        const corners = [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]]
          .map(([u, v]) => [x + u * cos - v * sin, y + u * sin + v * cos]);
        polyline('POSTES', corners, true);
      }
      const label = renderLabel(settings.labels?.poste, templateContext(store, store.rows[index], 'poste', settings), {
        settings,
        type: 'poste',
      });
      if (label.length) block('TXT_POSTES', label, x + 3, y, 0);
    }
  }

  // Instalações
  if (collected.inst.length) {
    const store = storeOf('inst');
    for (const index of collected.inst) {
      if (!store) break;
      const [x, y] = project(store.Y[index], store.X[index]);
      const info = installationInfo(store, index);
      const theta = -info.angle;
      const blockName = blockFor(settings, store, store.rows[index], 'inst');
      if (blockName && hasBlock(blockName)) {
        insertBlock('INSTALACOES', 'inst', blockName, x, y, (info.angle * 180) / Math.PI);
      } else {
        const shape = settings.shapes?.inst === 'auto' ? info.kind : settings.shapes?.inst;
        if (shape === 'rel' || shape === 'square') {
          polyline('INSTALACOES', [[-1.85, -1.85], [1.85, -1.85], [1.85, 1.85], [-1.85, 1.85]].map(([u, v]) => [x + u, y + v]), true);
        } else if (shape === 'trafo' || shape === 'triangle') {
          polyline('INSTALACOES', [[0, 2.4], [2.4, -1.8], [-2.4, -1.8]].map(([u, v]) => [x + u, y + v]), true);
        } else if (shape === 'chave' || shape === 'line') {
          push(0, 'LINE', 8, 'INSTALACOES',
            10, format(x - 2.6 * Math.cos(theta)), 20, format(y - 2.6 * Math.sin(theta)), 30, 0,
            11, format(x + 2.6 * Math.cos(theta)), 21, format(y + 2.6 * Math.sin(theta)), 31, 0);
        } else {
          circle('INSTALACOES', x, y, 1.3);
        }
      }
      const context = templateContext(store, store.rows[index], 'inst', settings);
      context.TIPO_INSTA = context.TIPO_INSTA || info.name;
      context.DE_PLACA = context.DE_PLACA || info.plate;
      const label = renderLabel(settings.labels?.inst, context, { settings, type: 'inst' });
      if (label.length) block('TXT_INSTALACOES', label, x - 3.4, y + 0.8, 2);
    }
  }

  // Redes
  for (const type of ['mt', 'bt']) {
    if (!collected[type].length) continue;
    const store = storeOf(type);
    if (!store) continue;
    const lineLayer = type === 'mt' ? 'REDE_MT' : 'REDE_BT';
    const textLayer = type === 'mt' ? 'TXT_MT' : 'TXT_BT';
    for (const index of collected[type]) {
      const rings = store.getGeometry(index).map((ring) => ring.map((point) => project(point[0], point[1])));
      for (const ring of rings) polyline(lineLayer, ring, false);
      const ring = rings[0];
      const label = renderLabel(settings.labels?.[type], templateContext(store, store.rows[index], type, settings), {
        settings,
        type,
      });
      if (!ring || ring.length < 2 || !label.length) continue;
      const start = ring[0];
      const end = ring[ring.length - 1];
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-6) continue;
      let theta = Math.atan2(end[1] - start[1], end[0] - start[0]);
      if (theta > Math.PI / 2) theta -= Math.PI;
      else if (theta < -Math.PI / 2) theta += Math.PI;
      const baseOffset = (type === 'mt' ? 1 : -1) * 1.2;
      label.forEach((line, lineIndex) => {
        const offset = baseOffset + (lineIndex - (label.length - 1) / 2) * lineHeight;
        text(
          textLayer,
          line,
          (start[0] + end[0]) / 2 - Math.sin(theta) * offset,
          (start[1] + end[1]) / 2 + Math.cos(theta) * offset,
          (theta * 180) / Math.PI,
          1,
        );
      });
    }
  }

  // Arruamento
  for (const street of streets) {
    const points = street.pts.map(([lat, lon]) => project(lat, lon));
    if (points.length < 2) continue;
    polyline('ARRUAMENTO', points, false);
    const label = renderLabel(settings.labels?.rua, { NOME: street.nome || '' }, { settings, type: 'rua' });
    if (!label.length || !street.nome) continue;
    const middle = Math.floor((points.length - 1) / 2);
    const start = points[middle];
    const end = points[middle + 1];
    if (!start || !end) continue;
    let theta = Math.atan2(end[1] - start[1], end[0] - start[0]);
    if (theta > Math.PI / 2) theta -= Math.PI;
    else if (theta < -Math.PI / 2) theta += Math.PI;
    label.forEach((line, lineIndex) => {
      const offset = 1.2 + (lineIndex - (label.length - 1) / 2) * lineHeight;
      text('TXT_RUAS', line, (start[0] + end[0]) / 2 - Math.sin(theta) * offset, (start[1] + end[1]) / 2 + Math.cos(theta) * offset, (theta * 180) / Math.PI, 1);
    });
  }

/** Adds the KML geometries that intersect the exported area. */
  const kmlOption = options.kml || null;
  const kmlFeatures = Array.isArray(kmlOption) ? kmlOption : (kmlOption?.features || []);
  const kmlLabels = Array.isArray(kmlOption) ? true : kmlOption?.labels !== false;
  let kmlCount = 0;
  for (const feature of kmlFeatures) {
    if (!feature) continue;
    const name = String(feature.name || '').trim();
    if (feature.kind === 'point') {
      const lat = Number(feature.lat);
      const lon = Number(feature.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < bounds.south || lat > bounds.north || lon < bounds.west || lon > bounds.east) continue;
      const [x, y] = project(lat, lon);
      circle('KML_PONTOS', x, y, 1.3);
      if (kmlLabels && name) block('TXT_KML', name.split(/\r?\n/).slice(0, 3), x + 2.2, y, 0);
      kmlCount += 1;
      continue;
    }
    if (feature.kind === 'line' && Array.isArray(feature.pts) && feature.pts.length >= 2) {
      if (!streetIntersectsBounds({ pts: feature.pts }, bounds)) continue;
      const points = feature.pts.map(([lat, lon]) => project(lat, lon));
      polyline('KML_LINHAS', points, false);
      if (kmlLabels && name && points.length >= 2) {
        const middle = Math.floor((points.length - 1) / 2);
        const start = points[middle];
        const end = points[middle + 1] || start;
        let theta = Math.atan2(end[1] - start[1], end[0] - start[0]);
        if (theta > Math.PI / 2) theta -= Math.PI;
        else if (theta < -Math.PI / 2) theta += Math.PI;
        text('TXT_KML', name, (start[0] + end[0]) / 2, (start[1] + end[1]) / 2 + 1.2, (theta * 180) / Math.PI, 1);
      }
      kmlCount += 1;
      continue;
    }
    if (feature.kind === 'polygon' && Array.isArray(feature.rings) && feature.rings.length) {
      const rings = feature.rings.filter((ring) => Array.isArray(ring) && ring.length >= 3);
      if (!rings.length) continue;
      if (!streetIntersectsBounds({ pts: rings[0] }, bounds)) continue;
      for (const ring of rings) {
        polyline('KML_AREAS', ring.map(([lat, lon]) => project(lat, lon)), true);
      }
      if (kmlLabels && name) {
        const [lat, lon] = rings[0][0];
        const [x, y] = project(lat, lon);
        text('TXT_KML', name, x + 1.5, y + 1.5, 0, 1);
      }
      kmlCount += 1;
    }
  }

  const layers = [
    ['ARRUAMENTO', color('arruamento', 9)],
    ['TXT_RUAS', color('txtRuas', 9)],
    ['KML_PONTOS', color('kmlPoint', 6)],
    ['KML_LINHAS', color('kmlLine', 5)],
    ['KML_AREAS', color('kmlArea', 4)],
    ['TXT_KML', color('kmlText', 6)],
    ['POSTES', color('poste', 2)],
    ['INSTALACOES', color('inst', 7)],
    ['REDE_BT', color('bt', 3)],
    ['REDE_MT', color('mt', 1)],
    ['TXT_POSTES', color('txtPoste', 2)],
    ['TXT_INSTALACOES', color('txtInst', 7)],
    ['TXT_BT', color('txtBt', 3)],
    ['TXT_MT', color('txtMt', 1)],
  ];


  const header = [
    0, 'SECTION', 2, 'HEADER',
    9, '$ACADVER', 1, 'AC1009',
    9, '$INSUNITS', 70, 6,
    9, '$MEASUREMENT', 70, 1,
    0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES',
    0, 'TABLE', 2, 'LTYPE', 70, 1,
    0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0,
    0, 'ENDTAB',
    0, 'TABLE', 2, 'LAYER', 70, layers.length,
    ...layers.flatMap(([name, color]) => [0, 'LAYER', 2, name, 70, 0, 62, color, 6, 'CONTINUOUS']),
    0, 'ENDTAB',
    0, 'TABLE', 2, 'STYLE', 70, 1,
    0, 'STYLE', 2, 'STANDARD', 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, 0.2, 3, 'txt', 4, '',
    0, 'ENDTAB',
    0, 'ENDSEC',
    ...(blockDefinitions
      ? [0, 'SECTION', 2, 'BLOCKS', ...blockDefinitions.replace(/\n$/, '').split('\n'), 0, 'ENDSEC']
      : []),
    0, 'SECTION', 2, 'ENTITIES',
  ];

  const content = [...header, ...entities, 0, 'ENDSEC', 0, 'EOF'].join('\n') + '\n';
  const counts = {
    poste: collected.poste.length,
    inst: collected.inst.length,
    bt: collected.bt.length,
    mt: collected.mt.length,
    ruas: streets.length,
    kml: kmlCount,
  };
  return {
    content,
    counts,
    total: counts.poste + counts.inst + counts.bt + counts.mt,
    zone,
    hemisphere: center.lat < 0 ? 'S' : 'N',
    center,
    denominator,
    warnings,
  };
}
