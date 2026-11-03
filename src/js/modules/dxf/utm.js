const RAD = Math.PI / 180;

export function utm(lat, lon, zone) {
  const a = 6378137;
  const flattening = 1 / 298.257222101;
  const k0 = 0.9996;
  const e2 = flattening * (2 - flattening);
  const ep = e2 / (1 - e2);
  const phi = lat * RAD;
  const deltaLon = (lon - ((zone - 1) * 6 - 180 + 3)) * RAD;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan;
  const C = ep * cos * cos;
  const A = deltaLon * cos;
  const M = a * (
    (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3) / 3072 * Math.sin(6 * phi)
  );
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep) * A ** 5) / 120) + 500000;
  let y = k0 * (M + N * tan * (A * A / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep) * A ** 6) / 720));
  if (lat < 0) y += 1e7;
  return [x, y];
}

export function utmZone(lon) {
  return Math.floor((lon + 180) / 6) + 1;
}

export function boundsSizeMeters(bounds) {
  const centerLat = (bounds.north + bounds.south) / 2;
  return {
    width: Math.abs(bounds.east - bounds.west) * 111320 * Math.cos(centerLat * RAD),
    height: Math.abs(bounds.north - bounds.south) * 111320,
  };
}

export function dxfText(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, (character) => `\\U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}
