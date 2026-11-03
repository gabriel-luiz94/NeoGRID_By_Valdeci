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

export function parseCoordinateQuery(query) {
  const cleaned = String(query).replace(/[°()]/g, '').trim();
  const match = cleaned.match(/^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/);
  if (!match) return null;
  let a = Number(match[1].replace(',', '.'));
  let b = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return [a, b];
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
