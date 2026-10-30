// 莱茵风格的矢量底图（OpenMapTiles 结构，OpenFreeMap 托管）。配色沿用原京都示意图：
// 米灰底、白色街道带细描边、灰蓝水系、浅灰建筑、墨黑文字、橙色只留给计划本身。
import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';
import type { MapConfig } from './adapter';

export const INK = '#141213', PAPER = '#f0eeea', CARD = '#fbfbf9', ORANGE = '#ff7a1a', MUTED = '#9a9792';
const WATER = '#c4ccd0', WATERLINE = '#b9c3c8', BUILDING = '#e1dfda', PARK = '#e6e6df';

export const FONT = ['Noto Sans Regular'], FONT_BOLD = ['Noto Sans Bold'];
const name: any = ['coalesce', ['get', 'name:zh'], ['get', 'name'], ['get', 'name:latin']];

function vectorLayers(): LayerSpecification[] {
  const road = (id: string, classes: string[], width: [number, number, number, number], color = CARD): LayerSpecification[] => [
    { id: `${id}-case`, type: 'line', source: 'v', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', classes]],
      paint: { 'line-color': '#14121333', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], width[0], width[1] + 1, width[2], width[3] + 1.5] }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
    { id, type: 'line', source: 'v', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', classes]],
      paint: { 'line-color': color, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], width[0], width[1], width[2], width[3]] }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
  ];
  return [
    { id: 'bg', type: 'background', paint: { 'background-color': PAPER } },
    { id: 'park', type: 'fill', source: 'v', 'source-layer': 'park', paint: { 'fill-color': PARK } },
    { id: 'landcover-wood', type: 'fill', source: 'v', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest', 'grass']]], paint: { 'fill-color': PARK, 'fill-opacity': 0.7 } },
    { id: 'water', type: 'fill', source: 'v', 'source-layer': 'water', paint: { 'fill-color': WATER } },
    { id: 'waterway', type: 'line', source: 'v', 'source-layer': 'waterway', paint: { 'line-color': WATERLINE, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 3] } },
    { id: 'building', type: 'fill', source: 'v', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': BUILDING, 'fill-outline-color': '#14121333' } },
    ...road('path', ['path', 'track'], [13, 0.4, 18, 2], '#fbfbf9cc'),
    ...road('minor', ['minor', 'service'], [12, 0.6, 18, 7]),
    ...road('mid', ['tertiary', 'secondary'], [10, 0.8, 18, 11]),
    ...road('major', ['primary', 'trunk', 'motorway'], [8, 1, 18, 14]),
    { id: 'rail', type: 'line', source: 'v', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': '#14121366', 'line-width': 1, 'line-dasharray': [3, 3] } },
    { id: 'road-name', type: 'symbol', source: 'v', 'source-layer': 'transportation_name', minzoom: 14,
      layout: { 'symbol-placement': 'line', 'text-field': name, 'text-font': FONT, 'text-size': 10, 'text-letter-spacing': 0.1 }, paint: { 'text-color': MUTED, 'text-halo-color': CARD, 'text-halo-width': 1.5 } },
    { id: 'water-name', type: 'symbol', source: 'v', 'source-layer': 'water_name',
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': 11, 'text-letter-spacing': 0.2 }, paint: { 'text-color': '#7e8a92', 'text-halo-color': PAPER, 'text-halo-width': 1.5 } },
    { id: 'poi', type: 'symbol', source: 'v', 'source-layer': 'poi', minzoom: 15, filter: ['<=', ['get', 'rank'], 20],
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': 10.5, 'text-max-width': 8 }, paint: { 'text-color': '#6b6865', 'text-halo-color': PAPER, 'text-halo-width': 1.5 } },
    { id: 'place', type: 'symbol', source: 'v', 'source-layer': 'place',
      layout: { 'text-field': name, 'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 15], 'text-letter-spacing': 0.15 }, paint: { 'text-color': INK, 'text-halo-color': PAPER, 'text-halo-width': 2 } },
  ];
}

/** 底图样式。satellite=true 时叠卫星影像在最下层（矢量的道路和地名关掉，只留计划图层）。 */
export function rhineStyle(cfg: MapConfig, basemap: 'vector' | 'satellite'): StyleSpecification {
  const sources: StyleSpecification['sources'] = { v: { type: 'vector', url: cfg.vector.tilejson, attribution: cfg.vector.attribution } };
  const layers = vectorLayers();
  if (cfg.contours) {
    sources.c = { type: 'vector', url: cfg.contours.tilejson };
    layers.splice(layers.findIndex(l => l.id === 'water') + 1, 0,
      { id: 'contour', type: 'line', source: 'c', 'source-layer': 'contour', paint: { 'line-color': '#14121322', 'line-width': ['match', ['get', 'nth_line'], 10, 1, 5, 0.8, 0.5] } });
  }
  if (basemap === 'satellite' && cfg.satellite) {
    sources.s = { type: 'raster', url: cfg.satellite.tilejson, tileSize: 256, attribution: cfg.satellite.attribution };
    return { version: 8, glyphs: cfg.vector.glyphs, sources, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': INK } }, { id: 'sat', type: 'raster', source: 's' },
      ...layers.filter(l => l.id === 'place' || l.id === 'water-name')] };
  }
  return { version: 8, glyphs: cfg.vector.glyphs, sources, layers };
}

/** MapTiler 资源补上公开 key（服务商端已限制来源）。 */
export const withKey = (cfg: MapConfig) => (url: string) => {
  if (cfg.publicKey && /api\.maptiler\.com/.test(url) && !/[?&]key=/.test(url)) return { url: url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(cfg.publicKey) };
  return { url };
};
