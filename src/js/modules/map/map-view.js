import { bus } from '../../core/bus.js';
import { icon } from '../../core/dom.js';
import { esc, fmtCoord, fmtInt, fmtKm, fmtNum } from '../../core/format.js';
import { settings, updateSetting } from '../../core/settings.js';
import { library } from '../../data/library.js';
import { LAYER_META, LAYER_TYPES } from '../../data/schema.js';
import { featureSubtitle, featureTitle } from '../../data/labels.js';
import { MapRenderer } from './renderer.js';
import { Inspector } from './inspector.js';
import { BASEMAPS, createBasemapLayer, getBasemap } from './basemaps.js';

const MM_PER_PX = 0.0002645833;
const RAD = Math.PI / 180;

const niceDistance = (target) => {
  if (!Number.isFinite(target) || target <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(target));
  const base = target / power;
  const nice = base >= 5 ? 5 : base >= 2 ? 2 : 1;
  return nice * power;
};

const formatDistance = (meters) => {
  if (meters >= 1000) return `${fmtNum(meters / 1000)} km`;
  if (meters >= 1) return `${Math.round(meters)} m`;
  return `${meters.toFixed(1).replace('.', ',')} m`;
};

export class MapView {
  constructor(options = {}) {
    this.options = options;
    this.map = null;
    this.renderer = null;
    this.inspector = null;
    this.activeLayers = { poste: true, bt: true, mt: true, inst: true };
    this.currentBasemapId = settings.basemap;
    this.currentBasemapLayer = null;
    this.basemapLayers = new Map();
    this.basemapOpacity = 0;
    this.dxfMode = false;
    this.suppressClickUntil = 0;
    this.noticeDismissed = new Set();
    this.noticeSource = '';
    this.tileErrorCount = 0;
    this.tileErrorWarned = false;
    this.markerLayer = L.layerGroup();
    this._scaleFrame = 0;
    this._coordsFrame = 0;
    this._lastCoords = null;
    this.panelHidden = false;
    this.inspectorOpen = false;
  }

  init() {
    this.mapElement = document.querySelector('#map');
    this.stageElement = document.querySelector('#mapStage');
    this.map = L.map(this.mapElement, {
      zoomControl: false,
      attributionControl: true,
      zoomSnap: 0,
      zoomDelta: 0.5,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
      minZoom: 3,
      maxZoom: 22,
      worldCopyJump: false,
    }).setView([-8.05, -34.9], 12);

    this.map.attributionControl.setPrefix('');
    this.markerLayer.addTo(this.map);

    this.inspector = new Inspector({
      onSelect: (type, index) => this.focusFeature(type, index),
      onOpenRow: (type, index) => this.options.openRow?.(type, index),
      onClose: () => this.clearSelection(),
    });

    this.renderer = new MapRenderer(this.map, {
      getSettings: () => settings,
      getVisibleLayers: () => this.activeLayers,
      onStats: (stats) => this.handleStats(stats),
    });

    this.createBasemaps();
    this.bindMapEvents();
    this.bindControls();
    this.bindBus();
    this.updateLayerPanel();
    this.updateMiniStats();
    this.updateEmptyState();
    this.syncSettingsUi();
    this.restoreMapPanel();
    document.querySelector('.map-layout')?.classList.add('is-inspector-hidden');
    this.inspectorOpen = false;
    this.updateScale();
    this.renderer.schedule();

    window.addEventListener('resize', () => this.invalidate());
    return this;
  }

  createBasemaps() {
    for (const definition of BASEMAPS) {
      if (!definition.url) continue;
      const layer = createBasemapLayer(definition);
      layer.on('tileerror', () => this.handleTileError());
      this.basemapLayers.set(definition.id, layer);
    }
    this.applyBasemap(settings.basemap, { silent: true });
    this.renderBasemapGrid();
  }

  handleTileError() {
    this.tileErrorCount += 1;
    if (this.tileErrorWarned || this.tileErrorCount < 5) return;
    this.tileErrorWarned = true;
    import('../../ui/toast.js').then(({ toast }) => {
      toast.warning(
        'Mapa de fundo indisponível',
        'Não foi possível carregar as imagens. Verifique a conexão ou escolha outro fundo no painel do mapa.',
        { duration: 7000 },
      );
    });
  }

  applyBasemap(id, { silent = false } = {}) {
    const definition = getBasemap(id);
    if (!definition) return;
    if (this.currentBasemapLayer) {
      this.map.removeLayer(this.currentBasemapLayer);
      this.currentBasemapLayer = null;
    }
    this.currentBasemapId = definition.id;
    if (definition.url) {
      const layer = this.basemapLayers.get(definition.id);
      if (layer) {
        layer.addTo(this.map);
        this.currentBasemapLayer = layer;
      }
    }
    this.map.getPane('tilePane').style.opacity = String(1 - this.basemapOpacity / 100);
    // Sem fundo o mapa vira uma folha branca, mesmo no tema escuro.
    document.body.classList.toggle('is-basemap-none', definition.id === 'none');
    this.syncBasemapGrid();
    if (!silent) updateSetting('basemap', definition.id);
  }

  setOpacity(value) {
    this.basemapOpacity = Math.max(0, Math.min(90, Number(value) || 0));
    this.map.getPane('tilePane').style.opacity = String(1 - this.basemapOpacity / 100);
    const input = document.querySelector('#basemapOpacity');
    if (input) {
      input.value = this.basemapOpacity;
      input.style.setProperty('--range-progress', `${(this.basemapOpacity / 90) * 100}%`);
    }
    const label = document.querySelector('#opacityValue');
    if (label) label.textContent = `${this.basemapOpacity}%`;
  }

  getVisibleLayers() {
    return { ...this.activeLayers };
  }

  visibleLayerTypes() {
    return LAYER_TYPES.filter((type) => this.activeLayers[type]);
  }

  setLayer(type, visible) {
    if (!(type in this.activeLayers)) return;
    this.activeLayers[type] = Boolean(visible);
    this.updateLayerPanel();
    this.renderer.schedule();
    bus.emit('layers:changed');
  }

  restoreMapPanel() {
    // O painel de camadas segue o menu lateral; começa aberto e só recolhe com ele.
    this.setPanelHidden(false, { refresh: false });
  }

  setPanelHidden(hidden, { refresh = true } = {}) {
    this.panelHidden = Boolean(hidden);
    const layout = document.querySelector('.map-layout');
    layout?.classList.toggle('is-panel-hidden', this.panelHidden);
    if (refresh) setTimeout(() => this.invalidate(), 30);
  }

  setInspectorOpen(open) {
    const next = Boolean(open);
    const changed = next !== this.inspectorOpen;
    this.inspectorOpen = next;
    const layout = document.querySelector('.map-layout');
    layout?.classList.toggle('is-inspector-hidden', !this.inspectorOpen);
    if (changed) setTimeout(() => this.invalidate(), 30);
  }

  setDxfMode(active) {
    this.dxfMode = Boolean(active);
    this.stageElement.classList.toggle('is-dxf-selecting', this.dxfMode);
  }

  /** No módulo Projeto só o desenho do projeto aparece: as camadas e o inspetor saem de cena. */
  setProjectMode(active) {
    this.stageElement.classList.toggle('is-projeto-ativo', Boolean(active));
    if (active) this.clearSelection();
  }

  suppressClicks(milliseconds = 350) {
    this.suppressClickUntil = Date.now() + milliseconds;
  }

  bindMapEvents() {
    const scheduleScale = () => {
      if (this._scaleFrame) return;
      this._scaleFrame = requestAnimationFrame(() => {
        this._scaleFrame = 0;
        this.updateScale();
      });
    };

    this.map.on('moveend zoomend resize', () => {
      this.renderer.schedule();
      scheduleScale();
      bus.emit('map:moved', this.map.getBounds());
    });
    this.map.on('move zoom', () => {
      scheduleScale();
      bus.emit('map:moving', this.map.getBounds());
    });
    this.map.on('mousemove', (event) => this.updateCoords(event.latlng));
    this.map.on('mouseout', () => this.updateCoords(null));
    this.map.on('click', (event) => this.handleMapClick(event));

    this.map.getContainer().addEventListener('click', (event) => {
      const button = event.target.closest?.('.popup-hit');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const index = Number(button.dataset.index);
      if (Number.isInteger(index)) {
        this.map.closePopup();
        this.selectFeature(button.dataset.type, index);
      }
    });
  }

  bindControls() {
    document.querySelector('#mapZoomIn')?.addEventListener('click', () => this.map.zoomIn(1));
    document.querySelector('#mapZoomOut')?.addEventListener('click', () => this.map.zoomOut(1));
    document.querySelector('#mapFit')?.addEventListener('click', () => this.fitData());
    document.querySelector('#mapScale1000')?.addEventListener('click', () => this.goToScale(settings.scale));
    document.querySelector('#mapLabels')?.addEventListener('click', () => {
      bus.emit('labels:open');
    });
    document.querySelector('#mapFullscreen')?.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      this.invalidate();
      const button = document.querySelector('#mapFullscreen');
      if (button) {
        button.innerHTML = icon(document.fullscreenElement ? 'minimize' : 'maximize');
        button.dataset.tooltip = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
      }
    });

    document.querySelectorAll('[data-panel-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-panel-tab]').forEach((item) => item.classList.toggle('is-active', item === button));
        document.querySelectorAll('[data-panel]').forEach((pane) => {
          const active = pane.dataset.panel === button.dataset.panelTab;
          pane.hidden = !active;
          pane.classList.toggle('is-active', active);
        });
      });
    });

    document.querySelector('#layerList')?.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-layer-toggle]');
      if (!checkbox) return;
      this.setLayer(checkbox.dataset.layerToggle, checkbox.checked);
    });

    document.querySelector('#layerList')?.addEventListener('click', (event) => {
      const action = event.target.closest('[data-layer-action]');
      if (!action) return;
      this.fitLayer(action.dataset.layer);
    });

    document.querySelector('#toggleAllLayers')?.addEventListener('click', () => {
      const types = library.storesWithData().map((store) => store.type);
      if (!types.length) return;
      const anyActive = types.some((type) => this.activeLayers[type]);
      for (const type of types) this.activeLayers[type] = !anyActive;
      this.updateLayerPanel();
      this.renderer.schedule();
    });

    document.querySelector('#basemapGrid')?.addEventListener('click', (event) => {
      const option = event.target.closest('[data-basemap]');
      if (!option) return;
      this.applyBasemap(option.dataset.basemap);
    });

    const opacity = document.querySelector('#basemapOpacity');
    opacity?.addEventListener('input', () => this.setOpacity(opacity.value));
    this.setOpacity(opacity?.value || 0);

    document.querySelector('#toggleLabels')?.addEventListener('change', (event) => {
      updateSetting('labels', event.target.checked);
    });
    document.querySelector('#labelZoom')?.addEventListener('change', (event) => {
      updateSetting('labelZoom', Number(event.target.value));
    });
    document.querySelector('#toggleScalebar')?.addEventListener('change', (event) => {
      updateSetting('scalebar', event.target.checked);
    });
    document.querySelector('#toggleNorth')?.addEventListener('change', (event) => {
      updateSetting('north', event.target.checked);
    });

    document.querySelector('#mapNoticeClose')?.addEventListener('click', () => {
      const notice = document.querySelector('#mapNotice');
      if (notice?.dataset.key) this.noticeDismissed.add(notice.dataset.key);
      this.hideNotice();
    });
  }

  bindBus() {
    bus.on('data:changed', () => {
      this.noticeDismissed.clear();
      this.updateLayerPanel();
      this.updateMiniStats();
      this.updateEmptyState();
      this.inspector.refresh();
      this.renderer.schedule();
      if (this.currentBasemapId === 'none') this.applyBasemap('none', { silent: true });
    });

    bus.on('feature:selected', (feature) => {
      this.setInspectorOpen(Boolean(feature));
    });

    bus.on('settings:changed', ({ key }) => {
      if (['labels', 'labelZoom', 'maxElements', 'maxLabels', 'dpr', 'adaptive', 'scalebar', 'north', 'basemap', 'all'].includes(key)) {
        this.syncSettingsUi();
        if (key === 'basemap' && settings.basemap !== this.currentBasemapId) this.applyBasemap(settings.basemap, { silent: true });
        this.renderer.schedule();
      }
      if (key === 'fields' || key === 'all') {
        this.inspector.refresh();
      }
      if (key === 'appearance' || key === 'theme' || key === 'accent' || key === 'all') {
        this.renderer.refreshAccent();
      }
      if (key === 'density' || key === 'all') {
        this.invalidate();
      }
    });

    bus.on('dxf:settings-changed', () => {
      this.renderer.refreshDxfSettings();
    });

    bus.on('map:utm-warning', () => {
      this.showNotice('As coordenadas parecem estar em UTM. O mapa espera latitude/longitude (WGS 84).', 'utm', { source: 'external' });
    });
  }

  updateCoords(latlng) {
    const label = document.querySelector('#statusCoords');
    if (!label) return;
    if (!latlng) {
      if (this._lastCoords !== null) {
        label.textContent = '—';
        this._lastCoords = null;
      }
      return;
    }
    this._pendingLatLng = latlng;
    if (this._coordsFrame) return;
    this._coordsFrame = requestAnimationFrame(() => {
      this._coordsFrame = 0;
      const point = this._pendingLatLng;
      if (!point) return;
      const text = `${fmtCoord(point.lat, 5)}, ${fmtCoord(point.lng, 5)}`;
      label.textContent = text;
      this._lastCoords = text;
    });
  }

  updateScale() {
    if (!this.map) return;
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    const resolution = (156543.03392 * Math.cos(center.lat * RAD)) / 2 ** zoom;
    const denominator = resolution / MM_PER_PX;
    const scaleLabel = `1:${fmtInt(Math.round(denominator / 10) * 10)}`;
    const scaleText = document.querySelector('#mapScaleLabel');
    const statusScale = document.querySelector('#statusScale');
    const statusZoom = document.querySelector('#statusZoom');
    if (scaleText) scaleText.textContent = scaleLabel;
    if (statusScale) statusScale.textContent = scaleLabel;
    if (statusZoom) statusZoom.textContent = `Zoom ${zoom % 1 === 0 ? zoom : zoom.toFixed(1)}`;

    const bar = document.querySelector('#mapScaleBar');
    const distance = document.querySelector('#mapScaleDistance');
    if (bar && distance) {
      const targetMeters = resolution * 72;
      const nice = niceDistance(targetMeters);
      const width = Math.max(24, Math.min(128, nice / resolution));
      bar.style.width = `${width.toFixed(1)}px`;
      distance.textContent = formatDistance(nice);
    }
  }

  updateLayerPanel() {
    const list = document.querySelector('#layerList');
    if (!list) return;
    const summaries = library.summary().layers;
    const stores = library.storesWithData();
    if (!stores.length) {
      list.innerHTML = '<div class="layer-empty">Nenhuma camada carregada.<br>Importe os CSVs para visualizar os ativos.</div>';
      const toggle = document.querySelector('#toggleAllLayers');
      if (toggle) toggle.textContent = 'Ocultar tudo';
      return;
    }
    list.innerHTML = stores.map((store) => {
      const type = store.type;
      const meta = LAYER_META[type];
      const count = summaries[type]?.count || 0;
      const hidden = !this.activeLayers[type];
      return `
        <div class="layer-row ${hidden ? 'is-off' : ''}" data-layer-row="${type}">
          <input type="checkbox" class="switch" data-layer-toggle="${type}" ${hidden ? '' : 'checked'} aria-label="Exibir ${meta.name}">
          <span class="layer-swatch ${meta.kind === 'line' ? 'is-line' : ''}" style="--c:${meta.color}"></span>
          <div class="layer-info">
            <strong>${meta.name}</strong>
            <span>${fmtInt(count)} registro${count === 1 ? '' : 's'}</span>
          </div>
          <button class="layer-action" data-layer-action="${type}" data-layer="${type}" title="Ir para esta camada" aria-label="Ir para ${meta.name}">
            ${icon('crosshair')}
          </button>
        </div>`;
    }).join('');
    const toggle = document.querySelector('#toggleAllLayers');
    if (toggle) {
      const anyActive = stores.some((store) => this.activeLayers[store.type]);
      toggle.textContent = anyActive ? 'Ocultar tudo' : 'Mostrar tudo';
    }
  }

  updateMiniStats() {
    const host = document.querySelector('#mapStats');
    if (!host) return;
    const summary = library.summary();
    const length = summary.lengthBt + summary.lengthMt;
    host.innerHTML = `
      <span><strong>${fmtInt(summary.totalRows)}</strong> registros</span>
      <span><strong>${summary.totalRows ? `${fmtNum(summary.locatedPct)}%` : '—'}</strong> georreferenciados</span>
      <span><strong>${length ? fmtKm(length) : '—'}</strong> de rede</span>
      <span><strong>${summary.stores}</strong> camadas</span>`;
  }

  updateEmptyState() {
    const overlay = document.querySelector('#mapEmptyOverlay');
    if (!overlay) return;
    overlay.hidden = library.hasData();
  }

  syncSettingsUi() {
    const labels = document.querySelector('#toggleLabels');
    if (labels) labels.checked = Boolean(settings.labels);
    const labelZoom = document.querySelector('#labelZoom');
    if (labelZoom) labelZoom.value = String(settings.labelZoom);
    const labelZoomChip = document.querySelector('#labelZoomChip');
    if (labelZoomChip) labelZoomChip.textContent = `Zoom ${settings.labelZoom}`;
    const labelsButton = document.querySelector('#mapLabels');
    labelsButton?.classList.toggle('is-active', Boolean(settings.labels));
    const scalebar = document.querySelector('#toggleScalebar');
    if (scalebar) scalebar.checked = Boolean(settings.scalebar);
    const north = document.querySelector('#toggleNorth');
    if (north) north.checked = Boolean(settings.north);
    const scaleControl = document.querySelector('#mapScaleControl');
    if (scaleControl) scaleControl.hidden = !settings.scalebar;
    const northControl = document.querySelector('#mapNorth');
    if (northControl) northControl.hidden = !settings.north;
    const scaleButtonText = document.querySelector('#mapScale1000 .tool-text');
    if (scaleButtonText) scaleButtonText.textContent = `1:${fmtInt(settings.scale)}`;
    this.syncBasemapGrid();
  }

  syncBasemapGrid() {
    document.querySelectorAll('#basemapGrid [data-basemap]').forEach((option) => {
      option.classList.toggle('is-active', option.dataset.basemap === this.currentBasemapId);
    });
    this.emitPerf();
  }

  renderBasemapGrid() {
    const grid = document.querySelector('#basemapGrid');
    if (!grid) return;
    grid.innerHTML = BASEMAPS.map((definition) => `
      <button class="basemap-option ${definition.id === this.currentBasemapId ? 'is-active' : ''}" data-basemap="${definition.id}" type="button">
        <span class="basemap-preview ${definition.className}"></span>
        <span class="basemap-copy"><strong>${definition.name}</strong><small>${definition.provider}</small></span>
        <span class="basemap-check">${icon('check')}</span>
      </button>`).join('');
  }

  handleStats(stats) {
    const perfVisible = document.querySelector('#perfVisible');
    const perfLabels = document.querySelector('#perfLabels');
    const perfTime = document.querySelector('#perfTime');
    if (perfVisible) perfVisible.textContent = fmtInt(stats.visible);
    if (perfLabels) perfLabels.textContent = fmtInt(stats.labels);
    if (perfTime) perfTime.textContent = `${Math.max(0, stats.elapsed).toFixed(0)} ms`;

    if (!library.hasData()) {
      if (this.noticeSource === 'renderer') this.hideNotice();
      return;
    }

    if (stats.lowZoom) {
      this.showNotice('Aproxime o zoom para ver os elementos.', 'zoom', { source: 'renderer' });
    } else if (stats.reason === 'truncated') {
      this.showNotice('Muitos elementos nesta tela. Aproxime o zoom para ver todos.', 'truncated', { source: 'renderer' });
    } else if (stats.reason === 'empty-area') {
      this.showNotice('Nenhum elemento nesta área. Pressione F para ir à concentração de dados.', 'empty-area', { source: 'renderer' });
    } else if (this.noticeSource === 'renderer') {
      this.hideNotice();
    }
  }

  showNotice(message, key, { source = 'external' } = {}) {
    const notice = document.querySelector('#mapNotice');
    const text = document.querySelector('#mapNoticeText');
    if (!notice || !text) return;
    if (this.noticeDismissed.has(key)) return;
    text.textContent = message;
    notice.dataset.key = key;
    notice.hidden = false;
    this.noticeSource = source;
  }

  hideNotice() {
    const notice = document.querySelector('#mapNotice');
    if (notice) {
      notice.hidden = true;
      notice.dataset.key = '';
    }
    this.noticeSource = '';
  }

  async handleMapClick(event) {
    if (Date.now() < this.suppressClickUntil || this.dxfMode || this.clickCapture?.()) return;
    this.map.closePopup();
    if (!library.hasData()) return;
    if (this.map.getZoom() < 15) return;

    const hits = library.isDatabase()
      ? await this.renderer.findAtAsync(event.containerPoint, event.latlng)
      : this.renderer.findAt(event.containerPoint, event.latlng);
    if (!hits.length) {
      this.clearSelection();
      return;
    }
    if (hits.length === 1) {
      this.selectFeature(hits[0].type, hits[0].index);
      return;
    }

    const rows = hits.map((hit) => {
      const store = library.get(hit.type);
      const meta = LAYER_META[hit.type];
      return `<button class="popup-hit" data-type="${hit.type}" data-index="${hit.index}">
        <i style="--c:${meta.color}"></i>
        <span><strong>${esc(featureTitle(store, hit.index))}</strong><small>${esc(meta.singular)}${featureSubtitle(store, hit.index) ? ` · ${esc(featureSubtitle(store, hit.index))}` : ''}</small></span>
        ${icon('chevron-right')}
      </button>`;
    }).join('');

    const popup = L.popup({ maxWidth: 330, className: 'hit-popup', closeButton: true, autoPan: true })
      .setLatLng(event.latlng)
      .setContent(`<div class="popup-hits"><div class="popup-hits-title">${hits.length} ativos neste ponto</div>${rows}</div>`)
      .openOn(this.map);

    setTimeout(() => {
      const container = popup.getElement();
      if (container) L.DomEvent.disableClickPropagation(container);
    }, 0);
  }

  async selectFeature(type, index) {
    const store = library.get(type);
    if (!store || index == null || index >= store.stats.count) return;
    if (store.isDatabase && store.rows[index] === undefined) {
      try {
        await store.ensureRow(index);
      } catch {
        return;
      }
    }
    this.renderer.setSelected({ type, index });
    this.inspector.setFeature(type, index);
  }

  clearSelection() {
    this.renderer.setSelected(null);
    this.inspector.clear();
    this.map.closePopup();
  }

  async focusFeature(type, index, { animate = true } = {}) {
    const store = library.get(type);
    if (!store || index == null || index >= store.stats.count) return;
    if (store.isDatabase && store.rows[index] === undefined) {
      try {
        await store.ensureRow(index);
      } catch {
        return;
      }
    }
    this.options.navigate?.('map');
    this.clearSearchMarker();
    this.map.closePopup();
    const meta = LAYER_META[type];
    if (meta.kind === 'line') {
      const bounds = store.getBounds(index);
      if (bounds) {
        const leafletBounds = L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
        if (leafletBounds.isValid()) {
          this.map.fitBounds(leafletBounds.pad(0.35), {
            animate,
            maxZoom: 19,
            paddingTopLeft: [30, 60],
            paddingBottomRight: [30, 90],
          });
        }
      }
    } else {
      const point = store.getPoint(index);
      if (point) {
        const zoom = Math.max(this.map.getZoom(), 19);
        this.map.setView(point, Math.min(zoom, 21), { animate });
      }
    }
    this.selectFeature(type, index);
    this.updateScale();
  }

  focusLatLng(lat, lon, zoom = 17, { marker = true } = {}) {
    this.options.navigate?.('map');
    this.map.setView([lat, lon], zoom, { animate: true });
    if (marker) {
      this.markerLayer.clearLayers();
      const divIcon = L.divIcon({
        className: 'search-marker-wrap',
        html: '<div class="search-marker"></div>',
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });
      L.marker([lat, lon], { icon: divIcon, keyboard: false }).addTo(this.markerLayer);
    }
    this.updateScale();
  }

  clearSearchMarker() {
    this.markerLayer.clearLayers();
  }

  fitData({ animate = true } = {}) {
    if (!library.hasData()) {
      import('../../ui/toast.js').then(({ toast }) => {
        toast.info('Nenhum dado carregado', 'Importe os CSVs para navegar até a área dos ativos.');
      });
      return;
    }
    if (library.isDatabase()) {
      const layers = this.visibleLayerTypes();
      let best = null;
      for (const type of layers) {
        const store = library.get(type);
        const spot = store?.hotspots?.[0];
        if (spot && (!best || spot.count > best.count)) best = spot;
      }
      if (!best) {
        // Sem hotspots: usa o centro da primeira camada com limites.
        for (const type of layers) {
          const bounds = library.get(type)?.bounds;
          if (bounds) {
            this.map.setView([(bounds.south + bounds.north) / 2, (bounds.west + bounds.east) / 2], 12, { animate });
            this.clearSearchMarker();
            return;
          }
        }
        import('../../ui/toast.js').then(({ toast }) => {
          toast.warning('Nenhuma camada visível', 'Ative ao menos uma camada para navegar até os dados.');
        });
        return;
      }
      this.map.setView([(best.cy + 0.5) / 100, (best.cx + 0.5) / 100], 19, { animate });
      this.clearSearchMarker();
      return;
    }
    const layers = this.visibleLayerTypes();
    let best = null;
    let bestCount = 0;
    for (const type of layers) {
      const store = library.get(type);
      if (!store) continue;
      for (const [key, indexes] of store.grid) {
        if (indexes.length > bestCount) {
          bestCount = indexes.length;
          best = { key, type };
        }
      }
    }
    if (!best) {
      import('../../ui/toast.js').then(({ toast }) => {
        toast.warning('Nenhuma camada visível', 'Ative ao menos uma camada para navegar até os dados.');
      });
      return;
    }
    const [x, y] = best.key.split(',').map(Number);
    this.map.setView([(y + 0.5) / 100, (x + 0.5) / 100], 19, { animate });
    this.clearSearchMarker();
  }

  fitLayer(type) {
    const store = library.get(type);
    if (!store || !store.stats.count) {
      import('../../ui/toast.js').then(({ toast }) => {
        toast.info('Camada sem dados', `${LAYER_META[type].name} não possui registros.`);
      });
      return;
    }
    if (!this.activeLayers[type]) {
      this.activeLayers[type] = true;
      this.updateLayerPanel();
      this.renderer.schedule();
    }
    if (store.isDatabase) {
      const spot = store.hotspots?.[0];
      if (spot) {
        this.options.navigate?.('map');
        this.map.setView([(spot.cy + 0.5) / 100, (spot.cx + 0.5) / 100], Math.max(16, Math.min(18, this.map.getZoom())), { animate: true });
        return;
      }
      const bounds = store.bounds;
      if (bounds) {
        this.options.navigate?.('map');
        this.map.setView([(bounds.south + bounds.north) / 2, (bounds.west + bounds.east) / 2], 12, { animate: true });
      }
      return;
    }
    if (!store.grid.size) {
      import('../../ui/toast.js').then(({ toast }) => {
        toast.info('Camada sem dados', `${LAYER_META[type].name} não possui registros localizados.`);
      });
      return;
    }
    let bestKey = null;
    let bestCount = 0;
    for (const [key, indexes] of store.grid) {
      if (indexes.length > bestCount) {
        bestCount = indexes.length;
        bestKey = key;
      }
    }
    if (!bestKey) return;
    const [x, y] = bestKey.split(',').map(Number);
    this.options.navigate?.('map');
    this.map.setView([(y + 0.5) / 100, (x + 0.5) / 100], Math.max(16, Math.min(18, this.map.getZoom())), { animate: true });
  }

  goToScale(denominator = 1000) {
    const center = this.map.getCenter();
    const zoom = Math.log2((156543.03392 * Math.cos(center.lat * RAD)) / (denominator * MM_PER_PX));
    this.map.setView(center, zoom, { animate: true });
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      this.stageElement.requestFullscreen?.().catch(() => {});
    }
  }

  invalidate() {
    if (!this.map) return;
    this.map.invalidateSize({ animate: false });
    this.renderer.schedule();
    this.updateScale();
  }

  emitPerf() {
    const visible = document.querySelector('#perfVisible');
    if (visible && this.renderer?.lastStats) {
      visible.textContent = fmtInt(this.renderer.lastStats.visible);
    }
  }

  getBounds() {
    return this.map.getBounds();
  }

  destroy() {
    this.renderer?.destroy();
    this.map?.remove();
  }
}
