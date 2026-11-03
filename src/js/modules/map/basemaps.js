export const BASEMAPS = [
  {
    id: 'satellite',
    name: 'Satélite',
    provider: 'Esri World Imagery',
    className: 'basemap-satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 22, maxNativeZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' },
  },
  {
    id: 'streets',
    name: 'Ruas',
    provider: 'Esri Street Map',
    className: 'basemap-streets',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 22, maxNativeZoom: 19, attribution: 'Esri' },
  },
  {
    id: 'carto-dark',
    name: 'Escuro',
    provider: 'CARTO Dark Matter',
    className: 'basemap-dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { subdomains: 'abcd', maxZoom: 22, attribution: '© OpenStreetMap © CARTO' },
  },
  {
    id: 'carto-voyager',
    name: 'Voyager',
    provider: 'CARTO Voyager',
    className: 'basemap-osm',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: { subdomains: 'abcd', maxZoom: 22, attribution: '© OpenStreetMap © CARTO' },
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    provider: 'Comunidade OSM',
    className: 'basemap-osm',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 22, maxNativeZoom: 19, attribution: '© OpenStreetMap', referrerPolicy: 'origin' },
  },
  {
    id: 'none',
    name: 'Sem fundo',
    provider: 'Grade local',
    className: 'basemap-none',
    url: null,
    options: {},
  },
];

export function getBasemap(id) {
  return BASEMAPS.find((item) => item.id === id) || BASEMAPS[0];
}

export function createBasemapLayer(def) {
  if (!def?.url) return null;
  return L.tileLayer(def.url, {
    ...def.options,
    detectRetina: false,
  });
}
