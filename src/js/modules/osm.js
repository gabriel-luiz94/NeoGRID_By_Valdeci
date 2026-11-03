/**
 * OpenStreetMap street network (arruamento).
 *
 * Kept apart from the DXF exporter so the user can download the streets, inspect them on the map
 * and only later decide whether the DXF should include them. Every request goes through the main
 * process when running in Electron (no CORS, real User-Agent and a single timeout).
 */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/**
 * Highway values that are not part of the street layout (paths, stairs, construction sites...).
 * Everything else is kept, so the drawing still shows service roads and pedestrian streets.
 */
const IGNORED_HIGHWAYS = new Set([
  'proposed', 'construction', 'raceway', 'bus_guideway', 'platform', 'corridor', 'elevator',
  'steps', 'footway', 'path', 'bridleway', 'cycleway', 'abandoned', 'razed', 'planned',
]);

const MAX_AREA_KM2 = 60;

async function requestText(url, body, headers = {}, timeoutMs = 60000) {
  if (window.desktop?.fetchText) {
    const result = await window.desktop.fetchText({ url, body, headers, timeoutMs });
    if (!result?.ok) throw new Error(result?.error || `HTTP ${result?.status || 0}`);
    return result.text || '';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: body == null ? 'GET' : 'POST',
      body: body == null ? undefined : body,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** OpenStreetMap's main API, used when every Overpass mirror is unavailable. */
async function fetchOsmMap(bounds) {
  const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].join(',');
  const xml = await requestText(
    `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`,
    null,
    { Accept: 'application/xml' },
  );
  if (!xml || typeof DOMParser === 'undefined') throw new Error('DOMParser indisponível');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('resposta inválida do OpenStreetMap');
  const nodes = new Map();
  doc.querySelectorAll('node').forEach((node) => {
    const lat = Number(node.getAttribute('lat'));
    const lon = Number(node.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(node.getAttribute('id'), [lat, lon]);
  });
  const streets = [];
  doc.querySelectorAll('way').forEach((way) => {
    const tags = new Map();
    way.querySelectorAll('tag').forEach((tag) => tags.set(tag.getAttribute('k'), tag.getAttribute('v')));
    const highway = String(tags.get('highway') || '').toLowerCase();
    if (!highway || IGNORED_HIGHWAYS.has(highway)) return;
    const pts = [...way.querySelectorAll('nd')]
      .map((nd) => nodes.get(nd.getAttribute('ref')))
      .filter(Boolean);
    if (pts.length >= 2) {
      streets.push({
        id: `osm-${way.getAttribute('id') || `${pts[0][0]},${pts[0][1]}`}`,
        pts,
        nome: tags.get('name') || '',
        rodovia: highway,
      });
    }
  });
  if (!streets.length) throw new Error('nenhuma via na área');
  return streets;
}

function boundsAreaKm2(bounds) {
  const heightKm = Math.abs(bounds.north - bounds.south) * 111.32;
  const midLat = (bounds.north + bounds.south) / 2;
  const widthKm = Math.abs(bounds.east - bounds.west) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  return Math.abs(widthKm * heightKm);
}

/**
 * Download every highway in the bounds. `onProgress({host, round, phase})` receives updates.
 * The area is intentionally limited: a huge Overpass response freezes the renderer and usually
 * times out. The caller can ask the user to zoom in instead.
 */
export async function fetchStreets(bounds, onProgress = () => {}) {
  const area = boundsAreaKm2(bounds);
  if (area > MAX_AREA_KM2) {
    throw new Error(
      `área muito grande (${area.toFixed(0)} km²) para o arruamento; selecione uma área menor (até ${MAX_AREA_KM2} km²)`,
    );
  }
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(',');
  // Servidor com folga (60s) para não devolver resposta parcial; o cliente espera até 90s.
  const query = `[out:json][timeout:60];way["highway"](${bbox});out tags geom;`;
  const failures = [];
  const totalMirrors = OVERPASS_ENDPOINTS.length * 2;

  for (let round = 0; round < 2; round++) {
    for (let mirror = 0; mirror < OVERPASS_ENDPOINTS.length; mirror++) {
      const endpoint = OVERPASS_ENDPOINTS[mirror];
      const attempt = round * OVERPASS_ENDPOINTS.length + mirror + 1;
      try {
        onProgress({ host: new URL(endpoint).hostname, round, phase: 'download', attempt, total: totalMirrors });
        const text = await requestText(
          endpoint,
          `data=${encodeURIComponent(query)}`,
          { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          90000,
        );
        if (/remark/i.test(text) && /timed?\s*out/i.test(text)) {
          throw new Error('resposta parcial do servidor (timeout interno)');
        }
        const data = JSON.parse(text);
        const osmLines = (data.elements || [])
          .filter((element) => element.type === 'way' && Array.isArray(element.geometry))
          .filter((element) => {
            const highway = String(element.tags?.highway || '').toLowerCase();
            return highway && !IGNORED_HIGHWAYS.has(highway);
          })
          .map((element) => ({
            id: `osm-${element.id}`,
            pts: element.geometry.filter(Boolean).map((point) => [point.lat, point.lon]),
            nome: element.tags?.name || '',
            rodovia: String(element.tags?.highway || ''),
          }))
          .filter((street) => street.pts.length >= 2);
        if (osmLines.length) return osmLines;
        failures.push(`${new URL(endpoint).hostname}: sem vias na área`);
      } catch (error) {
        const host = (() => {
          try { return new URL(endpoint).hostname; } catch { return endpoint; }
        })();
        failures.push(`${host}: ${error.name === 'AbortError' ? 'tempo esgotado' : error.message}`);
      }
    }
    if (round === 0) await new Promise((resolve) => setTimeout(resolve, 1600));
  }

  try {
    onProgress({ host: 'api.openstreetmap.org', round: 2, phase: 'fallback', attempt: totalMirrors + 1, total: totalMirrors + 1 });
    return await fetchOsmMap(bounds);
  } catch (error) {
    failures.push(`api.openstreetmap.org: ${error.message}`);
  }
  throw new Error(failures.slice(-4).join('; '));
}

const inside = (bounds, lat, lon) => lat >= bounds.south && lat <= bounds.north
  && lon >= bounds.west && lon <= bounds.east;

/** True when any segment of the street touches (or enters) the rectangle. */
export function streetIntersectsBounds(street, bounds) {
  const pts = street?.pts || [];
  if (pts.length < 2) return false;
  for (const [lat, lon] of pts) if (inside(bounds, lat, lon)) return true;
  // No vertex inside: test whether a segment crosses the rectangle.
  const edges = [
    [bounds.west, bounds.south, bounds.east, bounds.south],
    [bounds.east, bounds.south, bounds.east, bounds.north],
    [bounds.east, bounds.north, bounds.west, bounds.north],
    [bounds.west, bounds.north, bounds.west, bounds.south],
  ];
  for (let index = 1; index < pts.length; index++) {
    const [lat1, lon1] = pts[index - 1];
    const [lat2, lon2] = pts[index];
    for (const [x1, y1, x2, y2] of edges) {
      if (segmentsIntersect(lon1, lat1, lon2, lat2, x1, y1, x2, y2)) return true;
    }
  }
  return false;
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const cross = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSegment = (px, py, qx, qy, rx, ry) => Math.min(px, qx) <= rx + 1e-12
    && rx <= Math.max(px, qx) + 1e-12 && Math.min(py, qy) <= ry + 1e-12
    && ry <= Math.max(py, qy) + 1e-12;
  if (Math.abs(d1) < 1e-12 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (Math.abs(d2) < 1e-12 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  if (Math.abs(d3) < 1e-12 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (Math.abs(d4) < 1e-12 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

export function filterStreetsForBounds(streets, bounds) {
  return (streets || []).filter((street) => streetIntersectsBounds(street, bounds));
}

export function streetsBounds(streets) {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const street of streets || []) {
    for (const [lat, lon] of street.pts || []) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
  }
  if (!Number.isFinite(south)) return null;
  return { south, west, north, east };
}

export { MAX_AREA_KM2 };
