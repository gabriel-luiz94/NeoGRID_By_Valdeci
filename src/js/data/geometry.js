const EARTH_RADIUS = 6371008.8;

export function parseWkt(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  if (!text) return [];
  text = text.replace(/^SRID=\d+;/i, '');
  if (!/LINE|POINT|POLYGON/i.test(text)) return [];

  const rings = [];
  const groups = [...text.matchAll(/\(([^()]*)\)/g)];
  for (const group of groups) {
    const points = [];
    for (const pair of group[1].split(',')) {
      const values = pair.trim().split(/\s+/).map(Number);
      if (values.length >= 2 && Number.isFinite(values[0]) && Number.isFinite(values[1])) {
        points.push([values[1], values[0]]);
      }
    }
    if (points.length) rings.push(points);
  }
  return rings;
}

export function wktFirstPoint(raw) {
  if (!raw) return null;
  const match = String(raw).replace(/^SRID=\d+;/i, '').match(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

export function haversine(a, b) {
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function ringLength(ring) {
  let total = 0;
  for (let i = 1; i < ring.length; i++) total += haversine(ring[i - 1], ring[i]);
  return total;
}

export function ringsLength(rings) {
  return rings.reduce((total, ring) => total + ringLength(ring), 0);
}

export function ringsBounds(rings) {
  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      const [lat, lon] = point;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      north = Math.max(north, lat);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      west = Math.min(west, lon);
    }
  }
  if (!Number.isFinite(north)) return null;
  return { north, south, east, west };
}

export function looksGeographic(lat, lon) {
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
