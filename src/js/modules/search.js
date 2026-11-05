import { library } from '../data/library.js';
import { LAYER_META } from '../data/schema.js';

import { icon } from '../core/dom.js';
import { describeCoordinate, esc } from '../core/format.js';
import { toast } from '../ui/toast.js';

let deps = {};
let els = {};
let suggestions = [];
let selectedIndex = -1;
let loading = false;
let timer = 0;
let controller = null;
let coordinateError = '';
let addressFailed = false;
let localBusy = false;
let localPending = null;
let localSeq = 0;
let fieldTimer = 0;

const NOME_CAMPO = { barramento: 'Barramento', placa: 'Placa' };

// Códigos e coordenadas não saem do computador nas sugestões automáticas de endereço.
const parecerCodigo = (query) => !/\s/.test(query) && /\d/.test(query);

function hide() {
  if (!els.results) return;
  els.results.hidden = true;
  els.results.innerHTML = '';
  suggestions = [];
  selectedIndex = -1;
}

function addressItem(feature) {
  const properties = feature.properties || {};
  const street = properties.street
    ? `${properties.street}${properties.housenumber ? `, ${properties.housenumber}` : ''}`
    : '';
  const title = properties.name || street || properties.city || properties.county || 'Endereço';
  const parts = [
    properties.name && street ? street : '',
    properties.district,
    properties.city || properties.county,
    properties.state,
  ].filter(Boolean);
  return {
    kind: 'address',
    label: title,
    subtitle: [...new Set(parts)].join(' · '),
    lat: feature.geometry?.coordinates?.[1],
    lon: feature.geometry?.coordinates?.[0],
  };
}

function render() {
  if (!els.results) return;
  if (!els.search.value.trim()) {
    hide();
    return;
  }
  const groups = [];
  if (coordinateError) groups.push(`<div class="search-empty">${esc(coordinateError)}</div>`);
  const situacao = library.isDatabase() ? library.searchFields : null;
  if (situacao?.estado === 'preparando') {
    groups.push('<div class="search-loading"><span class="search-spinner"></span> Preparando a busca por barramento e placa. Só acontece na primeira abertura da base.</div>');
  } else if (situacao?.estado === 'erro') {
    groups.push(`<div class="search-empty">Busca por barramento e placa indisponível: ${esc(situacao.erro || 'erro desconhecido')}</div>`);
  }
  if (!suggestions.length && !loading) {
    els.results.hidden = false;
    if (localBusy) groups.push('<div class="search-loading"><span class="search-spinner"></span> Buscando na base…</div>');
    else if (addressFailed) groups.push('<div class="search-empty">Sugestões de endereço indisponíveis.<br>Pressione Enter para tentar a busca completa.</div>');
    else if (!coordinateError) groups.push('<div class="search-empty">Nenhum resultado.<br>Pressione <strong>Enter</strong> para buscar o endereço no OpenStreetMap.</div>');
    els.results.innerHTML = groups.join('');
    return;
  }

  const locals = suggestions.filter((item) => item.kind === 'local');
  const coordinates = suggestions.filter((item) => item.kind === 'coordinate');
  const addresses = suggestions.filter((item) => item.kind === 'address');

  if (locals.length) {
    groups.push(`<div class="search-group-label">Ativos na base</div>${locals.map((item, index) => {
      const meta = LAYER_META[item.type];
      const position = suggestions.indexOf(item);
      return `<button class="search-result ${position === selectedIndex ? 'is-selected' : ''}" data-index="${position}" type="button">
        <span class="search-result-icon is-${item.type}">${icon(meta.icon)}</span>
        <span class="search-result-copy"><strong>${esc(item.label)}</strong><small>${esc(item.subtitle || meta.singular)}</small></span>
        <span class="search-result-trailing">${icon('arrow-up-right')}</span>
      </button>`;
    }).join('')}`);
  }

  if (coordinates.length) {
    groups.push(`<div class="search-group-label">Coordenada</div>${coordinates.map((item) => {
      const position = suggestions.indexOf(item);
      return `<button class="search-result ${position === selectedIndex ? 'is-selected' : ''}" data-index="${position}" type="button">
        <span class="search-result-icon">${icon('crosshair')}</span>
        <span class="search-result-copy"><strong>${esc(item.label)}</strong><small>${esc(item.subtitle)}</small></span>
        <span class="search-result-trailing">${icon('arrow-up-right')}</span>
      </button>`;
    }).join('')}`);
  }

  if (addresses.length) {
    groups.push(`<div class="search-group-label">Endereços ${loading ? '<span class="search-spinner" style="display:inline-block;vertical-align:middle;margin-left:4px"></span>' : ''}</div>${addresses.map((item) => {
      const position = suggestions.indexOf(item);
      return `<button class="search-result ${position === selectedIndex ? 'is-selected' : ''}" data-index="${position}" type="button">
        <span class="search-result-icon">${icon('pin')}</span>
        <span class="search-result-copy"><strong>${esc(item.label)}</strong><small>${esc(item.subtitle || 'Endereço')}</small></span>
        <span class="search-result-trailing">${icon('arrow-up-right')}</span>
      </button>`;
    }).join('')}`);
  } else if (loading && locals.length) {
    groups.push(`<div class="search-loading"><span class="search-spinner"></span> Buscando endereços…</div>`);
  }

  els.results.hidden = false;
  els.results.innerHTML = groups.join('');
}

function markSelected() {
  els.results?.querySelectorAll('.search-result').forEach((button) => {
    button.classList.toggle('is-selected', Number(button.dataset.index) === selectedIndex);
  });
  const selected = els.results?.querySelector('.search-result.is-selected');
  selected?.scrollIntoView({ block: 'nearest' });
}

function choose(item) {
  if (!item) return;
  if (item.kind === 'local') {
    els.search.value = item.id;
    hide();
    deps.mapView?.focusFeature(item.type, item.index);
    deps.mapView?.map?.getContainer()?.focus?.();
    return;
  }
  if (item.kind === 'address' || item.kind === 'coordinate') {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
    els.search.value = item.label;
    hide();
    deps.mapView?.focusLatLng(item.lat, item.lon, 17);
  }
}

async function photonSearch(query) {
  controller?.abort();
  controller = new AbortController();
  const center = deps.mapView?.map?.getCenter();
  const params = new URLSearchParams({ limit: '8', q: query });
  if (center) {
    params.set('lat', center.lat.toFixed(5));
    params.set('lon', center.lng.toFixed(5));
  }
  const response = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: controller.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const seen = new Set();
  return (data.features || [])
    .filter((feature) => feature.properties?.countrycode === 'BR')
    .map(addressItem)
    .filter((item) => {
      const key = `${item.label}|${item.subtitle}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Number.isFinite(item.lat) && Number.isFinite(item.lon);
    });
}

async function nominatimSearch(query) {
  const bounds = deps.mapView?.map?.getBounds();
  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: '6',
    'accept-language': 'pt-BR',
    countrycodes: 'br',
    q: query,
  });
  if (bounds) {
    params.set('viewbox', `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`);
    params.set('bounded', '0');
  }
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function suggest(query) {
  if (query !== els.search.value.trim()) return;
  loading = true;
  render();
  try {
    const addresses = await photonSearch(query);
    if (query !== els.search.value.trim()) return;
    addressFailed = false;
    suggestions = [...suggestions.filter((item) => item.kind !== 'address'), ...addresses];
  } catch (error) {
    // Mantém os resultados locais; só os endereços ficam indisponíveis.
    if (error.name !== 'AbortError') addressFailed = true;
  } finally {
    loading = false;
    if (query === els.search.value.trim()) render();
  }
}

function localItem(item) {
  const singular = LAYER_META[item.type].singular;
  const origem = item.campo
    ? `${NOME_CAMPO[item.campo] || item.campo} · ${singular}${item.codigo ? ` ${item.codigo}` : ''}`
    : singular;
  // O resumo do ativo pode repetir o valor procurado, que já é o título do resultado.
  const resumo = String(item.subtitle || '').split(' · ').filter((parte) => parte && parte !== item.id);
  return { kind: 'local', ...item, label: item.id, subtitle: [origem, ...resumo].join(' · ') };
}

function allLocal(query) {
  return library.searchIds(query, 8).map(localItem);
}

async function allLocalAsync(query) {
  if (!library.isDatabase()) return allLocal(query);
  return (await library.searchIdsAsync(query, 8)).map(localItem);
}

function coordinateItems(query) {
  const coordinate = describeCoordinate(query);
  coordinateError = coordinate?.erro || '';
  return coordinate && !coordinate.erro ? [{ kind: 'coordinate', ...coordinate }] : [];
}

function runInput() {
  const query = els.search.value.trim();
  clearTimeout(timer);
  clearTimeout(fieldTimer);
  controller?.abort();
  loading = false;
  localBusy = false;
  localPending = null;
  addressFailed = false;
  coordinateError = '';
  localSeq += 1;
  if (query.length < 3) {
    hide();
    return;
  }
  const coordinates = coordinateItems(query);
  const ehCoordenada = coordinates.length > 0 || Boolean(coordinateError);
  const database = library.isDatabase();
  suggestions = [...(database || ehCoordenada ? [] : allLocal(query)), ...coordinates];
  selectedIndex = -1;
  if (database && !ehCoordenada) {
    const seq = localSeq;
    localBusy = true;
    localPending = allLocalAsync(query).then((locals) => {
      if (seq !== localSeq) return;
      suggestions = [...locals, ...suggestions.filter((item) => item.kind !== 'local')];
    }).catch(() => {}).finally(() => {
      if (seq !== localSeq) return;
      localBusy = false;
      localPending = null;
      render();
      // Enquanto o índice é gerado, repete a busca para o resultado aparecer sozinho.
      if (library.searchFields.estado === 'preparando') {
        fieldTimer = setTimeout(() => {
          if (!els.results.hidden && document.activeElement === els.search) runInput();
        }, 3000);
      }
    });
  }
  render();
  if (!ehCoordenada && !parecerCodigo(query)) timer = setTimeout(() => suggest(query), 360);
}

async function enterSearch() {
  const query = els.search.value.trim();
  if (!query) return;
  // A busca na base pode ainda estar em curso: sem esperá-la, um código iria para o serviço de endereços.
  if (localPending) await localPending;
  if (query !== els.search.value.trim()) return;
  if (suggestions.length && selectedIndex >= 0) {
    choose(suggestions[selectedIndex]);
    return;
  }
  if (suggestions.length) {
    choose(suggestions[0]);
    return;
  }
  // Coordenada inválida não vira busca de endereço: o aviso já está na lista.
  if (coordinateError) {
    render();
    return;
  }
  // Com o índice ainda em preparo, o código pode existir: não vale procurá-lo como endereço.
  if (parecerCodigo(query) && library.isDatabase() && library.searchFields.estado === 'preparando') {
    render();
    return;
  }

  clearTimeout(timer);
  controller?.abort();
  loading = true;
  els.results.hidden = false;
  els.results.innerHTML = '<div class="search-loading"><span class="search-spinner"></span> Buscando endereço…</div>';
  try {
    const results = await nominatimSearch(query);
    if (!results.length) {
      suggestions = [];
      els.results.innerHTML = '<div class="search-empty">Nenhum endereço encontrado para esta busca.</div>';
      return;
    }
    suggestions = results.map((result) => ({
      kind: 'address',
      label: result.display_name,
      subtitle: 'OpenStreetMap',
      lat: Number(result.lat),
      lon: Number(result.lon),
    }));
    selectedIndex = 0;
    render();
    if (suggestions.length === 1) choose(suggestions[0]);
  } catch (error) {
    els.results.innerHTML = '<div class="search-empty">Não foi possível buscar o endereço. Verifique a conexão.</div>';
    toast.error('Busca indisponível', 'Não foi possível consultar o serviço de endereços.');
  } finally {
    loading = false;
  }
}

function init(options = {}) {
  deps = options;
  els = {
    wrap: document.querySelector('#searchWrap'),
    search: document.querySelector('#globalSearch'),
    results: document.querySelector('#searchResults'),
  };
  if (!els.search) return;

  els.search.addEventListener('input', runInput);
  els.search.addEventListener('focus', () => {
    if (els.search.value.trim().length >= 3 && suggestions.length) render();
  });
  els.search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && suggestions.length) {
      event.preventDefault();
      selectedIndex = (selectedIndex + 1) % suggestions.length;
      markSelected();
    } else if (event.key === 'ArrowUp' && suggestions.length) {
      event.preventDefault();
      selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
      markSelected();
    } else if (event.key === 'Escape') {
      hide();
      els.search.blur();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      enterSearch();
    }
  });

  els.results?.addEventListener('mousedown', (event) => {
    const button = event.target.closest('.search-result');
    if (!button) return;
    event.preventDefault();
    const item = suggestions[Number(button.dataset.index)];
    if (item) choose(item);
  });

  document.addEventListener('mousedown', (event) => {
    if (!els.wrap?.contains(event.target)) hide();
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      els.search.focus();
      els.search.select();
    }
  });

  window.__searchTest = { choose, suggestions: () => suggestions, pendente: () => localPending };
}

export const search = { init, hide };
