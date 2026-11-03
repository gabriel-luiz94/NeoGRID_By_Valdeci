import { library } from '../data/library.js';
import { LAYER_META } from '../data/schema.js';

import { icon } from '../core/dom.js';
import { esc, parseCoordinateQuery } from '../core/format.js';
import { toast } from '../ui/toast.js';

let deps = {};
let els = {};
let suggestions = [];
let selectedIndex = -1;
let loading = false;
let timer = 0;
let controller = null;

const isAddress = (item) => item.kind === 'address' || item.kind === 'coordinate';

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
  if (!suggestions.length && !loading) {
    els.results.hidden = false;
    els.results.innerHTML = `<div class="search-empty">Nenhum resultado.<br>Pressione <strong>Enter</strong> para buscar o endereço no OpenStreetMap.</div>`;
    return;
  }

  const locals = suggestions.filter((item) => item.kind === 'local');
  const addresses = suggestions.filter(isAddress);
  const groups = [];

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

  if (addresses.length) {
    groups.push(`<div class="search-group-label">Endereços ${loading ? '<span class="search-spinner" style="display:inline-block;vertical-align:middle;margin-left:4px"></span>' : ''}</div>${addresses.map((item) => {
      const position = suggestions.indexOf(item);
      return `<button class="search-result ${position === selectedIndex ? 'is-selected' : ''}" data-index="${position}" type="button">
        <span class="search-result-icon">${icon(item.kind === 'coordinate' ? 'crosshair' : 'pin')}</span>
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
    const coordinate = parseCoordinateQuery(query);
    const coordinateItems = coordinate
      ? [{
          kind: 'coordinate',
          label: `${coordinate[0].toFixed(6).replace('.', ',')}, ${coordinate[1].toFixed(6).replace('.', ',')}`,
          subtitle: 'Coordenada geográfica · WGS 84',
          lat: coordinate[0],
          lon: coordinate[1],
        }]
      : [];
    suggestions = [
      ...(library.isDatabase() ? await allLocalAsync(query) : allLocal(query)),
      ...coordinateItems,
      ...addresses,
    ];
  } catch (error) {
    if (error.name !== 'AbortError') {
      // Mantém os resultados locais; endereços ficam indisponíveis silenciosamente.
      const locals = library.isDatabase() ? [] : allLocal(query);
      if (!locals.length && !parseCoordinateQuery(query)) {
        els.results.innerHTML = '<div class="search-empty">Sugestões de endereço indisponíveis.<br>Pressione Enter para tentar a busca completa.</div>';
        els.results.hidden = false;
      }
    }
  } finally {
    loading = false;
    if (query === els.search.value.trim()) render();
  }
}

function allLocal(query) {
  const local = library.searchIds(query, 6);
  return local.map((item) => ({
    kind: 'local',
    ...item,
    label: item.id,
    subtitle: [LAYER_META[item.type].singular, item.subtitle].filter(Boolean).join(' · '),
  }));
}

async function allLocalAsync(query) {
  if (!library.isDatabase()) return allLocal(query);
  const local = await library.searchIdsAsync(query, 6);
  return local.map((item) => ({
    kind: 'local',
    ...item,
    label: item.id,
    subtitle: [LAYER_META[item.type].singular, item.subtitle].filter(Boolean).join(' · '),
  }));
}

function runInput() {
  const query = els.search.value.trim();
  clearTimeout(timer);
  controller?.abort();
  loading = false;
  if (query.length < 3) {
    hide();
    return;
  }
  const coordinate = parseCoordinateQuery(query);
  if (library.isDatabase()) {
    suggestions = coordinate ? [{
      kind: 'coordinate',
      label: `${coordinate[0].toFixed(6).replace('.', ',')}, ${coordinate[1].toFixed(6).replace('.', ',')}`,
      subtitle: 'Coordenada geográfica · WGS 84',
      lat: coordinate[0],
      lon: coordinate[1],
    }] : [];
    selectedIndex = suggestions.length ? 0 : -1;
    render();
    if (suggestions.length) selectedIndex = -1;
    timer = setTimeout(() => suggest(query), 360);
    // Busca local no banco em paralelo (assíncrona).
    allLocalAsync(query).then((locals) => {
      if (query !== els.search.value.trim()) return;
      suggestions = [...locals, ...suggestions.filter((item) => item.kind !== 'local')];
      if (query === els.search.value.trim()) render();
    }).catch(() => {});
    return;
  }
  suggestions = [
    ...allLocal(query),
    ...(coordinate ? [{
      kind: 'coordinate',
      label: `${coordinate[0].toFixed(6).replace('.', ',')}, ${coordinate[1].toFixed(6).replace('.', ',')}`,
      subtitle: 'Coordenada geográfica · WGS 84',
      lat: coordinate[0],
      lon: coordinate[1],
    }] : []),
  ];
  selectedIndex = suggestions.length ? 0 : -1;
  render();
  if (suggestions.length) selectedIndex = -1;
  timer = setTimeout(() => suggest(query), 360);
}

async function enterSearch() {
  const query = els.search.value.trim();
  if (!query) return;
  if (suggestions.length && selectedIndex >= 0) {
    choose(suggestions[selectedIndex]);
    return;
  }
  if (suggestions.length) {
    choose(suggestions[0]);
    return;
  }
  const coordinate = parseCoordinateQuery(query);
  if (coordinate) {
    deps.mapView?.focusLatLng(coordinate[0], coordinate[1], 17);
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

  window.__searchTest = { choose, suggestions: () => suggestions };
}

export const search = { init, hide };
