import { stripAccents } from '../core/format.js';

export const LAYER_TYPES = ['poste', 'bt', 'mt', 'inst'];

export const LAYER_META = {
  poste: {
    key: 'poste',
    name: 'Postes',
    singular: 'Poste',
    color: '#fbbf24',
    cssVar: '--layer-poste',
    icon: 'i-pin',
    kind: 'point',
    filePattern: /poste/i,
  },
  bt: {
    key: 'bt',
    name: 'Rede BT',
    singular: 'Trecho BT',
    color: '#2dd4bf',
    cssVar: '--layer-bt',
    icon: 'i-zap',
    kind: 'line',
    filePattern: /rede[\s_-]*bt|bt[\s_-]*rede/i,
  },
  mt: {
    key: 'mt',
    name: 'Rede MT',
    singular: 'Trecho MT',
    color: '#fb7185',
    cssVar: '--layer-mt',
    icon: 'i-bolt',
    kind: 'line',
    filePattern: /rede[\s_-]*mt|mt[\s_-]*rede/i,
  },
  inst: {
    key: 'inst',
    name: 'Instalações',
    singular: 'Instalação',
    color: '#a78bfa',
    cssVar: '--layer-inst',
    icon: 'i-grid',
    kind: 'point',
    filePattern: /instala/i,
  },
};

export const DEFAULT_FIELD_PATTERNS = {
  poste: [/^NU_PG_ID$/, /^NU_ANGULO$/, /NU_ALTURA/, /NU_ESFORCO/, /DE_BARRAMEN/, /NU_INSTALA/, /MATERIAL/, /^TIPO_PG$/],
  bt: [/NU_TRECHO/, /NU_INSTALA/, /CONDUTOR|CABO/, /^CD_FASE$/, /NU_COMPRIMENTO_REAL/],
  mt: [/NU_TRECHO/, /NU_INSTALA/, /CONDUTOR|CABO/, /^CD_FASE$/, /NU_COMPRIMENTO_REAL/],
  inst: [/^TIPO_INSTA$/, /^DE_PLACA$/, /NU_INSTALA/, /NU_INSTALACAO_MT_ID/, /^NU_PG_ID$/, /^NU_ANGULO$/],
};

export const IMPORTANT_COLUMN_PATTERNS = {
  poste: [/^NU_PG_ID$/, /NU_ALTURA/, /NU_ESFORCO/, /MATERIAL/, /^TIPO_PG$/, /DE_BARRAMEN/, /^NU_ANGULO$/],
  bt: [/NU_TRECHO/, /NU_PG_INI/, /NU_PG_FIN/, /CONDUTOR_A/, /CONDUTOR_N/, /^CD_FASE$/, /NU_COMPRIMENTO_REAL/],
  mt: [/NU_TRECHO/, /NU_PG_INI/, /NU_PG_FIN/, /CONDUTOR_A/, /CONDUTOR_N/, /^CD_FASE$/, /NU_COMPRIMENTO_REAL/],
  inst: [/NU_INSTALA/, /NU_INSTALACAO_MT_ID/, /^TIPO_INSTA$/, /^DE_PLACA$/, /^NU_PG_ID$/, /NU_ANGULO/],
};

export const HIDDEN_FIELD_PATTERN = /_DESC$|^GEOMETRIA_WKT$|^SHP_/;

export function hiddenHeader(name) {
  return HIDDEN_FIELD_PATTERN.test(String(name || '').toUpperCase());
}

export function detectLayerByName(filename) {
  const name = stripAccents(String(filename || ''));
  for (const type of ['poste', 'bt', 'mt', 'inst']) {
    if (LAYER_META[type].filePattern.test(name)) {
      // Evita que "rede_mt" seja lido como "instalação" antes da rede MT.
      if (type === 'inst' && /rede/.test(name)) continue;
      return type;
    }
  }
  // Padrões alternativos comuns de exportação
  if (/poste|ponto.?de.?rede|pole/i.test(name)) return 'poste';
  if (/instal|equip|trafo|chave/i.test(name)) return 'inst';
  if (/rede.*(bt|baixa)/i.test(name)) return 'bt';
  if (/rede.*(mt|media)/i.test(name)) return 'mt';
  return null;
}

export function detectLayerByHeaders(headers) {
  const list = (headers || []).map((header) => stripAccents(String(header || '')).toUpperCase());
  const has = (pattern) => list.some((header) => pattern.test(header));
  if (has(/^GEOMETRIA_WKT$|NU_PG_INI|NU_PG_FIN|NU_TRECHO/)) {
    if (has(/^NU_TRECHO_MT|^NU_CONDUTOR_MT|^NU_ALIMENTADOR_MT|^CD_TENSAO|^NU_TENSAO|^TENSAO/)) return 'mt';
    if (has(/^NU_TRECHO_BT|^NU_CONDUTOR_BT/)) return 'bt';
    if (has(/^NU_TENSAO$|^CD_TENSAO$|^TENSAO/) || has(/^NU_FASE$/)) {
      const tension = list.find((h) => /TENSAO/.test(h));
      return tension ? 'mt' : 'bt';
    }
    return 'bt';
  }
  if (has(/^TIPO_INSTA$|^DE_PLACA$|^NU_TIPO_INSTALACAO/)) return 'inst';
  if (has(/NU_ALTURA|NU_ESFORCO|DE_BARRAMEN|^TIPO_PG$/)) return 'poste';
  return null;
}

export function headerMatches(header, patterns) {
  return patterns.some((pattern) => pattern.test(header));
}

export function prettyLayerName(type) {
  return LAYER_META[type]?.name || type;
}

export function suggestionFor(feature) {
  return {
    title: feature.title,
    subtitle: feature.subtitle,
    icon: feature.icon || LAYER_META[feature.type]?.icon || 'i-pin',
    tone: feature.type,
  };
}
