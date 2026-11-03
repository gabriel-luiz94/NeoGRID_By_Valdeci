import { parseNumber } from '../core/format.js';

const ABREV = {
  'DUPLO T': 'DT',
  CIRCULAR: 'CIR',
  RETANGULAR: 'RET',
  FANTASMA: 'FAN',
  FLY: 'FLY',
  'TORRE AUTOPORTANTE': 'TA',
  T: 'T',
};

const isBlank = (value) => !value || String(value).trim() === '' || String(value).toUpperCase() === 'NULO';
const isZero = (value) => {
  const text = String(value ?? '').trim();
  return !text || text === '0' || text === '0.0' || text.toUpperCase() === 'NULO';
};

export function num(value) {
  const number = parseNumber(value);
  return Number.isFinite(number) ? number : 0;
}

export function poleLabelLines(store, row) {
  const alt = store.col(row, 'NU_ALTURA');
  const esf = store.col(row, 'NU_ESFORCO');
  const material = store.col(row, 'MATERIAL') || store.col(row, 'CD_INDD_MATERIAL_PG_DESC');
  const type = (store.col(row, 'TIPO_PG') || store.col(row, 'CD_TIPO_PG_DESC')).toUpperCase();
  const signature = ABREV[type] || (/\s/.test(type) ? type.split(/\s+/).map((part) => part[0]).join('') : type.slice(0, 3));
  return [
    `${signature}${alt || '?'}/${esf || '?'}`,
    store.col(row, 'DE_BARRAMEN') || store.col(row, 'DE_BARRAMENTO'),
    material,
  ].filter(Boolean);
}

export function networkConductorText(store, row) {
  const phases = [...new Set(['CONDUTOR_A', 'CONDUTOR_B', 'CONDUTOR_C']
    .map((name) => store.col(row, name))
    .filter((value) => !isZero(value)))];
  const neutral = store.col(row, 'CONDUTOR_N');
  let text = phases.join('/');
  if (!isZero(neutral)) text += (text ? ' + N ' : 'N ') + neutral;
  return text;
}

export function networkLength(store, row) {
  return num(store.col(row, 'NU_COMPRIMENTO_REAL')) || num(store.col(row, 'SHP_LENGTH'));
}

export function networkLabelText(store, row) {
  const conductor = networkConductorText(store, row);
  const length = networkLength(store, row);
  return [conductor, length ? `${length.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m` : '']
    .filter(Boolean)
    .join(' · ');
}

export function installationInfo(store, index) {
  if (!store.installationInfo) store.installationInfo = new Map();
  const cached = store.installationInfo.get(index);
  if (cached) return cached;

  const row = store.rows[index];
  const name = store.col(row, 'TIPO_INSTA')
    || store.col(row, 'TIPO_SIGLA')
    || store.col(row, 'NU_TIPO_INSTALACAO_MT_ID_DESC');
  const upper = name.toUpperCase();
  const kind = /^CHAVE FUSIVEL RELIGADORA/.test(upper) || /^CHAVE FUSÍVEL RELIGADORA/.test(upper)
    ? 'rel'
    : /^TRAFO/.test(upper)
      ? 'trafo'
      : /^CHAVE/.test(upper)
        ? 'chave'
        : 'pt';
  const info = {
    kind,
    name,
    plate: store.col(row, 'DE_PLACA'),
    angle: (num(store.col(row, 'NU_ANGULO')) * Math.PI) / 180,
  };
  store.installationInfo.set(index, info);
  return info;
}

export function clearInstallationCache(store) {
  store.installationInfo?.clear();
}

export function featureId(store, index) {
  const row = store.rows[index];
  if (!row) return '';
  const idIndex = store.idx?.id;
  if (Number.isInteger(idIndex) && idIndex >= 0) {
    const id = String(row[idIndex] ?? '').trim();
    if (id) return id;
  }
  if (store.type === 'poste') return store.col(row, 'NU_PG_ID');
  if (store.type === 'inst') return store.col(row, 'NU_INSTALA') || store.col(row, 'NU_INSTALACAO_MT_ID');
  return store.col(row, 'NU_TRECHO') || store.col(row, 'NU_TRECHO_MT_ID') || store.col(row, 'NU_TRECHO_BT_ID') || store.col(row, 'NU_INSTALA');
}

export function featureTitle(store, index) {
  const row = store.rows[index];
  if (!row) return 'Registro';
  const id = featureId(store, index);
  if (id) return id;
  if (store.type === 'poste') return `Poste ${index + 1}`;
  if (store.type === 'inst') return `Instalação ${index + 1}`;
  return `${store.type === 'mt' ? 'Trecho MT' : 'Trecho BT'} ${index + 1}`;
}

export function featureSubtitle(store, index) {
  const row = store.rows[index];
  if (!row) return '';
  if (store.type === 'poste') {
    const alt = store.col(row, 'NU_ALTURA');
    const material = store.col(row, 'MATERIAL') || store.col(row, 'CD_INDD_MATERIAL_PG_DESC');
    return [alt && `${alt} m`, material, store.col(row, 'DE_BARRAMEN') || store.col(row, 'DE_BARRAMENTO')].filter(Boolean).join(' · ');
  }
  if (store.type === 'inst') {
    const info = installationInfo(store, index);
    return [info.name, info.plate, store.col(row, 'NU_PG_ID') && `Poste ${store.col(row, 'NU_PG_ID')}`]
      .filter(Boolean)
      .join(' · ');
  }
  const length = networkLength(store, row);
  return [networkConductorText(store, row), length && `${length.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m`]
    .filter(Boolean)
    .join(' · ');
}

export const isValueBlank = isBlank;
