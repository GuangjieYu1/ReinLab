import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MLMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Basemap, CanvasObject, ExplorePlan, LngLat, Viewport } from '../../../../../packages/contracts/src/explore';
import type { MapConfig } from './adapter';
import { CARD, FONT, FONT_BOLD, INK, MUTED, ORANGE, rhineStyle, withKey } from './mapStyle';
import { boundsOf, canvasFeatures, center, routeFeatures, stopFeatures, sunFeatures } from './overlays';
import { localToDate, sunPos } from './sunlive';

const EMPTY = { type: 'FeatureCollection' as const, features: [] };
const CJK = '"PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

/** 箭头头部：一个朝上的三角，按末段方位旋转。 */
function arrowImage() {
  const n = 24, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d')!; g.beginPath(); g.moveTo(n / 2, 2); g.lineTo(n - 4, n - 3); g.lineTo(4, n - 3); g.closePath(); g.fillStyle = '#ffffff'; g.fill();
  return g.getImageData(0, 0, n, n);
}

/** 计划图层：停留点、街区、路线、画布、太阳线。换底图后要重新挂。 */
export function addOverlays(map: MLMap) {
  if (!map.hasImage('rh-arrow')) map.addImage('rh-arrow', arrowImage(), { sdf: true });
  for (const id of ['areas', 'routes', 'cv-fills', 'cv-lines', 'cv-heads', 'cv-notes', 'sun', 'stops']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  const add = (l: maplibregl.AddLayerObject) => { if (!map.getLayer(l.id)) map.addLayer(l); };
  add({ id: 'area-fill', type: 'fill', source: 'areas', paint: { 'fill-color': ['case', ['==', ['get', 'state'], 'candidate'], ORANGE, INK], 'fill-opacity': ['case', ['get', 'sel'], 0.14, 0.06] } });
  add({ id: 'area-line-c', type: 'line', source: 'areas', filter: ['==', ['get', 'state'], 'candidate'], paint: { 'line-color': ORANGE, 'line-width': 1.6, 'line-dasharray': [3, 2] } });
  add({ id: 'area-line', type: 'line', source: 'areas', filter: ['==', ['get', 'state'], 'confirmed'], paint: { 'line-color': INK, 'line-width': 1.6 } });
  add({ id: 'route', type: 'line', source: 'routes', paint: { 'line-color': INK, 'line-width': 2.2, 'line-dasharray': [2, 1.4] }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  add({ id: 'cv-fill', type: 'fill', source: 'cv-fills', paint: { 'fill-color': ['case', ['==', ['get', 'author'], 'agent'], ORANGE, INK], 'fill-opacity': 0.08 } });
  add({ id: 'cv-line', type: 'line', source: 'cv-lines', paint: { 'line-color': ['case', ['==', ['get', 'author'], 'agent'], ORANGE, INK], 'line-width': 2.6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  add({ id: 'cv-head', type: 'symbol', source: 'cv-heads', layout: { 'icon-image': 'rh-arrow', 'icon-size': 0.7, 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true }, paint: { 'icon-color': ['case', ['==', ['get', 'author'], 'agent'], ORANGE, INK] } });
  add({ id: 'sun-fov', type: 'fill', source: 'sun', filter: ['==', ['get', 'k'], 'fov'], paint: { 'fill-color': INK, 'fill-opacity': 0.09 } });
  add({ id: 'sun-line', type: 'line', source: 'sun', filter: ['!=', ['get', 'k'], 'fov'], layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['match', ['get', 'k'], 'sun', ORANGE, 'rise', ORANGE, 'sun-blocked', MUTED, INK],
      'line-width': ['match', ['get', 'k'], 'sun', 3, 'shadow', 2.2, 1.4],
      'line-opacity': ['match', ['get', 'k'], 'shadow', 0.55, 'set', 0.6, 'rise', 0.7, 1],
      'line-dasharray': ['match', ['get', 'k'], 'sun', ['literal', [1, 0]], ['literal', [2, 2]]] } });
  add({ id: 'cv-note', type: 'symbol', source: 'cv-notes', layout: { 'text-field': ['get', 'text'], 'text-font': FONT, 'text-size': 11.5, 'text-max-width': 12, 'text-anchor': 'top', 'text-offset': [0, 0.6], 'text-allow-overlap': true },
    paint: { 'text-color': ['case', ['==', ['get', 'author'], 'agent'], '#b84d00', INK], 'text-halo-color': CARD, 'text-halo-width': 3 } });
  add({ id: 'cv-dot', type: 'circle', source: 'cv-notes', paint: { 'circle-radius': 4, 'circle-color': ['case', ['==', ['get', 'author'], 'agent'], ORANGE, INK], 'circle-stroke-color': CARD, 'circle-stroke-width': 1.5 } });
  add({ id: 'stop-pt', type: 'circle', source: 'stops',
    paint: { 'circle-radius': ['case', ['get', 'sel'], 14, 12],
      'circle-color': ['case', ['get', 'sel'], ORANGE, ['==', ['get', 'state'], 'confirmed'], INK, CARD],
      'circle-stroke-color': ['case', ['all', ['==', ['get', 'state'], 'candidate'], ['!', ['get', 'sel']]], ORANGE, INK], 'circle-stroke-width': 2 } });
  add({ id: 'stop-no', type: 'symbol', source: 'stops', layout: { 'text-field': ['get', 'label'], 'text-font': FONT_BOLD, 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': ['case', ['all', ['==', ['get', 'state'], 'confirmed'], ['!', ['get', 'sel']]], CARD, INK] } });
  add({ id: 'stop-name', type: 'symbol', source: 'stops', layout: { 'text-field': ['get', 'name'], 'text-font': FONT_BOLD, 'text-size': 12, 'text-anchor': 'left', 'text-offset': [1.5, 0], 'text-max-width': 10 },
    paint: { 'text-color': INK, 'text-halo-color': CARD, 'text-halo-width': 3 } });
}

/** 把计划数据灌进图层。 */
export function fillOverlays(map: MLMap, plan: ExplorePlan, canvas: CanvasObject[], selected: string | null, sun: ReturnType<typeof sunFeatures> | null) {
  const set = (id: string, data: unknown) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data as never);
  const s = stopFeatures(plan, selected), cv = canvasFeatures(canvas);
  set('stops', s.points); set('areas', s.areas); set('routes', routeFeatures(plan));
  set('cv-lines', cv.lines); set('cv-fills', cv.fills); set('cv-notes', cv.notes); set('cv-heads', cv.heads);
  set('sun', sun ?? EMPTY);
}

export function planBounds(plan: ExplorePlan) {
  const pts: LngLat[] = plan.stops.map(center);
  for (const r of plan.routes) if (r.geometry) pts.push(...(r.geometry.coordinates as LngLat[]));
  if (!pts.length && plan.destination) pts.push(plan.destination.center);
  return boundsOf(pts);
}

type Props = {
  cfg: MapConfig; plan: ExplorePlan; canvas: CanvasObject[];
  basemap: Basemap; selected: string | null; onSelect: (id: string) => void;
  day: string; tz: string; minutes: number; horizonAlt: (stopId: string, az: number) => number | null;
  initialView: Viewport | null; camera: { viewport: Viewport; basemap?: Basemap; n: number } | null;
  focus?: { at: LngLat; n: number } | null;   // 页面要求飞到某处（搜索结果）：飞完在那里弹出操作
  following: boolean; onFollow: (v: boolean) => void; onBasemap: (b: Basemap) => void;
  onView: (v: Viewport) => void; onMapClick: (at: LngLat, screen: { x: number; y: number }) => void;
};

export default function LiveMap(p: Props) {
  const box = useRef<HTMLDivElement>(null), mapRef = useRef<MLMap | null>(null), ready = useRef(false);
  const latest = useRef(p); latest.current = p;

  const refresh = () => {
    const map = mapRef.current, q = latest.current; if (!map || !ready.current) return;
    const stop = q.plan.stops.find(s => s.id === q.selected);
    let sun = null;
    if (stop) {
      // 时间线的分钟数相对当前选中的那天；山影按此刻太阳方位查地平线
      const c = center(stop), az = sunPos(localToDate(q.day, q.minutes, q.tz), c[0], c[1]).az;
      sun = sunFeatures(stop, q.day, q.tz, q.minutes, map.getZoom(), q.horizonAlt(stop.id, az));
    }
    fillOverlays(map, q.plan, q.canvas, q.selected, sun);
  };

  useEffect(() => {
    const q = latest.current;
    const fit = planBounds(q.plan);
    const map = new maplibregl.Map({
      container: box.current!, style: rhineStyle(q.cfg, q.basemap), transformRequest: withKey(q.cfg), localIdeographFontFamily: CJK,
      attributionControl: { compact: true },
      ...(q.initialView ? { center: q.initialView.center, zoom: q.initialView.zoom, bearing: q.initialView.bearing, pitch: q.initialView.pitch }
        : fit ? { bounds: fit, fitBoundsOptions: { padding: 80, maxZoom: 16 } } : { center: [116.39, 39.9], zoom: 3 }),
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('style.load', () => { addOverlays(map); ready.current = true; refresh(); });
    // 一加载就报一次视野：页面搜地点要用地图中心
    map.once('load', () => { const c = map.getCenter(); latest.current.onView({ center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }); });
    map.on('zoomend', refresh);
    // 用户自己动了地图：不再跟随助手（助手的视野变化没有 originalEvent）
    map.on('movestart', e => { if ((e as { originalEvent?: unknown }).originalEvent) latest.current.onFollow(false); });
    map.on('moveend', () => { const c = map.getCenter(); if (box.current) box.current.dataset.center = `${c.lng.toFixed(4)},${c.lat.toFixed(4)},${map.getZoom().toFixed(1)}`; latest.current.onView({ center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }); });
    map.on('click', e => {
      const hit = map.queryRenderedFeatures(e.point, { layers: ['stop-pt', 'stop-no', 'area-fill'] })[0];
      if (hit?.properties?.id) latest.current.onSelect(String(hit.properties.id));
      else latest.current.onMapClick([e.lngLat.lng, e.lngLat.lat], { x: e.point.x, y: e.point.y });
    });
    for (const l of ['stop-pt', 'area-fill']) { map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; }); map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; }); }
    return () => { ready.current = false; map.remove(); mapRef.current = null; };
  }, [p.cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  // 换底图：整份样式换掉，style.load 时重新挂计划图层
  const lastBase = useRef(p.basemap);
  useEffect(() => {
    const map = mapRef.current; if (!map || lastBase.current === p.basemap) return;
    lastBase.current = p.basemap; ready.current = false;
    map.setStyle(rhineStyle(p.cfg, p.basemap));
  }, [p.basemap, p.cfg]);

  useEffect(refresh, [p.plan, p.canvas, p.selected, p.minutes, p.day, p.tz]); // eslint-disable-line react-hooks/exhaustive-deps

  // 计划第一次有了停留点 / 刚定了目的地：跟随状态下飞过去对准（助手没发视野事件时也不至于停在全国图）
  const had = useRef({ stops: p.plan.stops.length, dest: p.plan.destination?.name ?? null });
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const prev = had.current, dest = p.plan.destination?.name ?? null;
    had.current = { stops: p.plan.stops.length, dest };
    if (!p.following) return;
    if (prev.stops === 0 && p.plan.stops.length > 0) { const b = planBounds(p.plan); if (b) map.fitBounds(b, { padding: 90, maxZoom: 16, duration: 900 }); }
    else if (!prev.dest && dest && p.plan.stops.length === 0 && p.plan.destination) map.flyTo({ center: p.plan.destination.center, zoom: 12, duration: 900 });
  }, [p.plan.stops.length, p.plan.destination?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // 选中的停留点落在右侧卡片底下或画面外：把它挪到左边可见处（卡片约 300px 宽）
  useEffect(() => {
    const map = mapRef.current, st = p.plan.stops.find(s => s.id === p.selected);
    if (!map || !st) return;
    const pt = map.project(center(st)), w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
    if (pt.x > 40 && pt.x < w - 320 && pt.y > 40 && pt.y < h - 40) return;
    map.easeTo({ center: center(st), offset: [-160, 0], duration: 500 });
  }, [p.selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // 助手移动视野：跟随时平滑飞过去；不跟随就不动用户的镜头
  useEffect(() => {
    const map = mapRef.current, c = p.camera; if (!map || !c) return;
    if (c.basemap && c.basemap !== p.basemap) p.onBasemap(c.basemap);
    if (!p.following) return;
    map.easeTo({ center: c.viewport.center, zoom: c.viewport.zoom, bearing: c.viewport.bearing, pitch: c.viewport.pitch, duration: 800 });
  }, [p.camera?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // 重新点「跟随助手」：立刻飞到助手最后一次设定的视野
  const wasFollowing = useRef(p.following);
  useEffect(() => {
    const map = mapRef.current, c = p.camera;
    if (map && p.following && !wasFollowing.current && c) map.easeTo({ center: c.viewport.center, zoom: c.viewport.zoom, bearing: c.viewport.bearing, pitch: c.viewport.pitch, duration: 800 });
    wasFollowing.current = p.following;
  }, [p.following]); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索结果：飞过去，到了在那个位置弹出「问助手 / 加笔记」
  useEffect(() => {
    const map = mapRef.current, f = p.focus; if (!map || !f) return;
    map.flyTo({ center: f.at, zoom: Math.max(map.getZoom(), 15.5), duration: 900 });
    map.once('moveend', () => { const pt = map.project(f.at); latest.current.onMapClick(f.at, { x: pt.x, y: pt.y }); });
  }, [p.focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="exl-map" ref={box} />;
}
