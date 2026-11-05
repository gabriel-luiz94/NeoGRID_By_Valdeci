export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function stripAccents(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toUpperCase();
}

export function parseNumber(value) {
  if (value == null || value === '') return NaN;
  const normalized = typeof value === 'number'
    ? value
    : Number(String(value).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(normalized) ? normalized : NaN;
}

export function isBlank(value) {
  return value == null || String(value).trim() === '';
}

const intFmt = new Intl.NumberFormat('pt-BR');
const decFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const dec2Fmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

export const fmtInt = (value) => intFmt.format(Number(value) || 0);
export const fmtNum = (value) => decFmt.format(Number(value) || 0);
export const fmtNum2 = (value) => dec2Fmt.format(Number(value) || 0);

export function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${decFmt.format(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${decFmt.format(value / 1024 ** 2)} MB`;
  return `${decFmt.format(value / 1024 ** 3)} GB`;
}

export function fmtKm(meters) {
  const value = Number(meters) || 0;
  if (value >= 1000) return `${decFmt.format(value / 1000)} km`;
  return `${decFmt.format(value)} m`;
}

export function fmtLength(meters) {
  const value = Number(meters) || 0;
  return value ? `${decFmt.format(value)} m` : '';
}

export function fmtPct(value) {
  return `${decFmt.format(Number(value) || 0)}%`;
}

export function fmtCoord(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toFixed(digits).replace('.', ',');
}

export function fmtDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString('pt-BR');
}

export function fmtDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.toLocaleDateString('pt-BR')} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

export function timeAgo(timestamp) {
  const delta = Date.now() - Number(timestamp || 0);
  if (!Number.isFinite(delta) || delta < 0) return 'agora';
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return fmtDate(timestamp);
}

export function truncate(value, max = 60) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Graus, minutos e segundos com hemisfério: 8°03'41"S 34°53'33"O (ou graus decimais: 8,0615 S 34,8925 O).
function parseHemisferios(texto) {
  const parte = /(\d{1,3}(?:[.,]\d+)?)\s*[°º]?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*['’′]?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*(?:["”″]|'')?)?)?\s*([NSLOEW])(?=[\s,;]|\d|$)/gi;
  const partes = [...texto.matchAll(parte)];
  if (partes.length !== 2) return null;
  if (texto.replace(parte, '').replace(/[\s,;]/g, '')) return null;
  const numero = (valor) => Number(String(valor || 0).replace(',', '.'));
  let lat = null;
  let lon = null;
  for (const [, graus, minutos, segundos, letra] of partes) {
    if (numero(minutos) >= 60 || numero(segundos) >= 60) return null;
    const valor = numero(graus) + numero(minutos) / 60 + numero(segundos) / 3600;
    const hemisferio = letra.toUpperCase();
    if (hemisferio === 'N') lat = valor;
    else if (hemisferio === 'S') lat = -valor;
    else if (hemisferio === 'L' || hemisferio === 'E') lon = valor;
    else lon = -valor;
  }
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

export function parseCoordinateQuery(query) {
  const texto = String(query).replace(/[()]/g, '').trim();
  const hemisferios = parseHemisferios(texto);
  if (hemisferios) return hemisferios;
  const cleaned = texto.replace(/°/g, '').trim();
  const match = cleaned.match(/^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/);
  if (!match) return null;
  let a = Number(match[1].replace(',', '.'));
  let b = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
  // "-34,89 -8,06" (longitude antes da latitude) seria o mar do Uruguai; em Pernambuco faz sentido invertido.
  if (a >= -42 && a <= -34 && b >= -10 && b <= -7) [a, b] = [b, a];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return [a, b];
}

const UTM_BANDAS = 'CDEFGHJKLMNPQRSTUVWX';

/** UTM para latitude/longitude em graus, no elipsoide GRS80 (SIRGAS 2000). */
export function utmParaLatLon(x, y, fuso, sul) {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep = e2 / (1 - e2);
  const raiz = Math.sqrt(1 - e2);
  const e1 = (1 - raiz) / (1 + raiz);
  const mu = (sul ? y - 1e7 : y) / k0 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const p1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const seno = Math.sin(p1);
  const cosseno = Math.cos(p1);
  const tangente = Math.tan(p1);
  const C = ep * cosseno ** 2;
  const T = tangente ** 2;
  const denominador = 1 - e2 * seno ** 2;
  const N = a / Math.sqrt(denominador);
  const R = a * (1 - e2) / denominador ** 1.5;
  const D = (x - 500000) / (N * k0);
  const lat = p1 - (N * tangente / R) * (D ** 2 / 2
    - (5 + 3 * T + 10 * C - 4 * C ** 2 - 9 * ep) * D ** 4 / 24
    + (61 + 90 * T + 298 * C + 45 * T ** 2 - 252 * ep - 3 * C ** 2) * D ** 6 / 720);
  const dLon = (D - (1 + 2 * T + C) * D ** 3 / 6
    + (5 - 2 * C + 28 * T - 3 * C ** 2 + 8 * ep + 24 * T ** 2) * D ** 5 / 120) / cosseno;
  return [lat * 180 / Math.PI, (fuso - 1) * 6 - 180 + 3 + dLon * 180 / Math.PI];
}

// UTM como no Google Earth: 25M 289000 9108000, 25 M 289000.00 m E 9108000.00 m S ou UTM 25M 289000 9108000.
function parseUtm(texto) {
  const zona = texto.trim().toUpperCase().match(/^(?:UTM\s*)?(\d{1,2})\s*([A-Z])\s+(.+)$/);
  if (!zona) return null;
  const resto = zona[3].replace(/(\d)\s*(?:M\s*)?[ENSLWO]?(?=[\s,;]|$)/g, '$1');
  const numeros = resto.match(/^(\d+(?:[.,]\d+)?)\s*[,;\s]\s*(\d+(?:[.,]\d+)?)$/);
  if (!numeros) return null;
  const fuso = Number(zona[1]);
  const letra = zona[2];
  const x = Number(numeros[1].replace(',', '.'));
  const y = Number(numeros[2].replace(',', '.'));
  if (fuso < 1 || fuso > 60) return { erro: `Fuso UTM ${fuso} não existe: use de 1 a 60.` };
  const banda = UTM_BANDAS.indexOf(letra);
  if (banda < 0) return { erro: `A letra ${letra} não é uma faixa UTM. No exemplo 25M, o fuso é 25 e a faixa é M.` };
  if (x < 100000 || x > 900000 || y < 0 || y > 10000000) {
    return { erro: 'Coordenada UTM fora do intervalo: X vai de 100.000 a 900.000 e Y de 0 a 10.000.000.' };
  }
  const bandaDe = (lat) => Math.min(19, Math.max(0, Math.floor((lat + 80) / 8)));
  let sul = banda < 10;
  let [lat, lon] = utmParaLatLon(x, y, fuso, sul);
  let aviso = '';
  if (Math.abs(bandaDe(lat) - banda) > 1) {
    // "25S" costuma significar hemisfério sul, embora S seja uma faixa do hemisfério norte.
    const comoSul = utmParaLatLon(x, y, fuso, true);
    if (letra === 'S' && Math.abs(comoSul[0]) <= 80) {
      sul = true;
      [lat, lon] = comoSul;
      aviso = ' · S lido como hemisfério sul';
    } else {
      return { erro: `O Y ${numeros[2]} não corresponde à faixa ${letra} do fuso ${fuso}. Confira a letra e os valores.` };
    }
  }
  return { lat, lon, fuso, letra, x, y, aviso };
}

/**
 * Interpreta o que foi digitado como coordenada.
 * Devolve null se não parecer coordenada, { erro } se parecer e estiver errada,
 * ou { lat, lon, label, subtitle }.
 */
export function describeCoordinate(query) {
  const decimal = (valor) => valor.toFixed(6).replace('.', ',');
  const utm = parseUtm(String(query));
  if (utm?.erro) return utm;
  if (utm) {
    const inteiro = (valor) => String(Math.round(valor * 100) / 100);
    return {
      lat: utm.lat,
      lon: utm.lon,
      label: `UTM ${utm.fuso}${utm.letra} ${inteiro(utm.x)} ${inteiro(utm.y)}`,
      subtitle: `${decimal(utm.lat)}, ${decimal(utm.lon)} · SIRGAS 2000${utm.aviso}`,
    };
  }
  const geografica = parseCoordinateQuery(query);
  if (geografica) {
    return {
      lat: geografica[0],
      lon: geografica[1],
      label: `${decimal(geografica[0])}, ${decimal(geografica[1])}`,
      subtitle: 'Coordenada geográfica · WGS 84',
    };
  }
  // X e Y sem o fuso apontam para lugares diferentes em cada fuso: é preciso informá-lo.
  const numeros = String(query).trim().match(/^(\d{5,7}(?:[.,]\d+)?)\s*[,;\s]\s*(\d{6,8}(?:[.,]\d+)?)$/);
  if (numeros) return { erro: `Para UTM, informe também o fuso e a faixa. Exemplo: 25M ${numeros[1]} ${numeros[2]}` };
  return null;
}

export function csvEscape(value, delimiter = ';') {
  const text = value == null ? '' : String(value);
  if (text.includes('"')) return `"${text.replace(/"/g, '""')}"`;
  if (text.includes(delimiter) || text.includes('\n') || text.includes('\r')) {
    return `"${text}"`;
  }
  return text;
}

export function downloadText(content, filename, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const result = document.execCommand('copy');
    area.remove();
    return result;
  }
}

export function safeFilename(name) {
  return String(name || 'arquivo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

export const cssVar = (name, fallback = '') =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
