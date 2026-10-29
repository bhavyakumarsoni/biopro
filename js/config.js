// Site configuration.
//
// MAP BASEMAP — NO API KEY IS REQUIRED.
// The default basemap (CARTO "Dark Matter", built from OpenStreetMap) is free and keyless.
// If its tiles cannot be loaded, the map automatically falls back to the standard
// OpenStreetMap tiles. The road network, ants, pheromone and routing never depend on tiles:
// they run from the bundled OpenStreetMap graph in data/.
//
// OPTIONAL: if you prefer MapTiler's basemap, create a free key at https://cloud.maptiler.com,
// restrict it to your domain (e.g. biopro-nu.vercel.app) in MapTiler's dashboard, and paste it
// below. Browser map keys are public by design, so the domain restriction is what protects it.
export const MAP_CONFIG = {
  maptilerKey: '',
};

export const TILE_PROVIDERS = {
  maptiler: {
    name: 'MapTiler Dataviz Dark',
    url: 'https://api.maptiler.com/maps/dataviz-dark/{z}/{x}/{y}.png?key={key}',
    options: { maxZoom: 19, attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  },
  carto: {
    name: 'CARTO Dark Matter',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { subdomains: 'abcd', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' },
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    dark: true, // darkened with a CSS filter to match the dashboard
  },
};

/** Ordered list of basemap providers to try. */
export function tileProviderChain(config = MAP_CONFIG) {
  const chain = [];
  if (config.maptilerKey && String(config.maptilerKey).trim()) {
    const p = TILE_PROVIDERS.maptiler;
    chain.push({ ...p, url: p.url.replace('{key}', encodeURIComponent(String(config.maptilerKey).trim())) });
  }
  chain.push(TILE_PROVIDERS.carto, TILE_PROVIDERS.osm);
  return chain;
}
