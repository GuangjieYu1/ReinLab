import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MLMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { CreativeRouteLeg, Entity, GeoJSON, LngLat } from '../../../../../packages/contracts/src/creative';
import type { MapConfig } from '../../explore/live/adapter';
import { CARD, FONT, FONT_BOLD, INK, MUTED, ORANGE, PAPER, rhineStyle, withKey } from '../../explore/live/mapStyle';
import { bboxOf, type Pos } from './geo';
import type { EditFeatures } from './adapter';

const EMPTY = { type: 'FeatureCollection' as const, features: [] };
const CJK = '"PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
export const RED = '#d6322b', AMBER = '#e0a100';

export type DrawMode = { kind: 'point' | 'line' | 'polygon'; hint: string; onDone: (g: GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon) => void; onCancel: () => void };
export type MapPick = { kind: 'place' | 'leg' | 'person' | 'edit' | 'event'; id: string };
type Flag = 'hard' | 'suspect';

/** 空白世界（没有真实底图）：米灰纸面，只画世界观自己的东西。 */
function blankStyle(glyphs?: string): StyleSpecification {
  return { version: 8, ...(glyphs ? { glyphs } : {}), sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': PAPER } }] };
}

function addLayers(map: MLMap) {
  for (const id of ['cw-net', 'cw-edits', 'cw-legs', 'cw-trails', 'cw-places', 'cw-events', 'cw-people', 'cw-draw']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  const add = (l: maplibregl.AddLayerObject, before?: string) => { if (!map.getLayer(l.id)) map.addLayer(l, before && map.getLayer(before) ? before : undefined); };
  // 导入的路网（架空世界没有底图路，只能自己画）：细墨线压在最底下
  add({ id: 'cw-net', type: 'line', source: 'cw-net', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': INK, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 14, 1.6], 'line-opacity': ['case', ['==', ['get', 'passable'], false], 0.2, 0.55] } });
  // 改造层：隐藏是一块纸色遮罩；新增按样式画
  add({ id: 'cw-edit-hide', type: 'fill', source: 'cw-edits', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'effect'], 'hide']], paint: { 'fill-color': PAPER, 'fill-opacity': 0.88 } });
  add({ id: 'cw-edit-area', type: 'fill', source: 'cw-edits', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!=', ['get', 'effect'], 'hide']], paint: { 'fill-color': INK, 'fill-opacity': 0.06 } });
  add({ id: 'cw-edit-line', type: 'line', source: 'cw-edits', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'style'], 'water', '#7e9aa8', 'wall', INK, '#8a6a3e'],
      'line-width': ['match', ['get', 'style'], 'wall', 4, 'ancient_road', 3, 2.4],
      'line-dasharray': ['match', ['get', 'style'], 'ancient_road', ['literal', [2.5, 1.2]], ['literal', [1, 0]]],
      'line-opacity': ['case', ['==', ['get', 'passOpen'], false], 0.35, 0.9] } });
  add({ id: 'cw-edit-pt', type: 'circle', source: 'cw-edits', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': CARD, 'circle-stroke-color': '#8a6a3e', 'circle-stroke-width': 2 } });
  add({ id: 'cw-edit-label', type: 'symbol', source: 'cw-edits', layout: { 'text-field': ['coalesce', ['get', 'name'], ['get', 'title']], 'text-font': FONT, 'text-size': 11, 'symbol-placement': ['case', ['==', ['geometry-type'], 'LineString'], 'line', 'point'] as never, 'text-offset': [0, 1] },
    paint: { 'text-color': '#6b5230', 'text-halo-color': CARD, 'text-halo-width': 2 } });
  // 路线：路网 / 手绘实线，推断虚线；高亮橙色，冲突红黄
  add({ id: 'cw-leg-hi', type: 'line', source: 'cw-legs', filter: ['get', 'hi'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'flag'], 'hard', RED, 'suspect', AMBER, ORANGE], 'line-width': 8, 'line-opacity': 0.35 } });
  add({ id: 'cw-leg', type: 'line', source: 'cw-legs', filter: ['!=', ['get', 'kind'], 'inferred'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['case', ['get', 'sel'], ORANGE, ['==', ['get', 'flag'], 'hard'], RED, ['==', ['get', 'flag'], 'suspect'], AMBER, INK], 'line-width': 2.6, 'line-opacity': ['case', ['get', 'dim'], 0.18, 1] } });
  add({ id: 'cw-leg-inf', type: 'line', source: 'cw-legs', filter: ['==', ['get', 'kind'], 'inferred'], layout: { 'line-join': 'round' },
    paint: { 'line-color': ['case', ['get', 'sel'], ORANGE, ['==', ['get', 'flag'], 'hard'], RED, ['==', ['get', 'flag'], 'suspect'], AMBER, INK], 'line-width': 2.6, 'line-opacity': ['case', ['get', 'dim'], 0.18, 1], 'line-dasharray': [1.6, 1.4] } });
  add({ id: 'cw-leg-tag', type: 'symbol', source: 'cw-legs', filter: ['!=', ['get', 'tag'], ''], layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'tag'], 'text-font': FONT_BOLD, 'text-size': 10.5, 'text-letter-spacing': 0.15 },
    paint: { 'text-color': INK, 'text-halo-color': CARD, 'text-halo-width': 3, 'text-opacity': ['case', ['get', 'dim'], 0.25, 1] } });
  // 地点
  add({ id: 'cw-place', type: 'circle', source: 'cw-places', paint: { 'circle-radius': ['case', ['get', 'sel'], 7, 5], 'circle-color': ['case', ['get', 'sel'], ORANGE, CARD], 'circle-stroke-color': INK, 'circle-stroke-width': 1.6 } });
  add({ id: 'cw-place-name', type: 'symbol', source: 'cw-places', layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11.5, 'text-anchor': 'top', 'text-offset': [0, 0.7] },
    paint: { 'text-color': MUTED, 'text-halo-color': CARD, 'text-halo-width': 2 } });
  // 走过的轨迹：播放时人物身后留下的线，走完就固定下来
  add({ id: 'cw-trail', type: 'line', source: 'cw-trails', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['case', ['get', 'sel'], ORANGE, '#c45a12'], 'line-width': 3.4, 'line-opacity': 0.85 } }, 'cw-place');
  // 事件：按种类用不同的章（停留 / 行程 / 相遇 / 出生 / 亡故 / 其他），只在有坐标的地点上画
  add({ id: 'cw-event', type: 'symbol', source: 'cw-events', filter: ['!=', ['get', 'state'], 'future'],
    layout: { 'icon-image': ['get', 'icon'], 'icon-size': ['case', ['==', ['get', 'state'], 'now'], 1.25, 1], 'icon-allow-overlap': true, 'icon-anchor': 'bottom', 'icon-offset': [0, -4] },
    paint: { 'icon-opacity': ['case', ['==', ['get', 'state'], 'past'], 0.4, 1] } });
  add({ id: 'cw-event-label', type: 'symbol', source: 'cw-events', filter: ['==', ['get', 'state'], 'now'],
    layout: { 'text-field': ['get', 'title'], 'text-font': FONT_BOLD, 'text-size': 11.5, 'text-anchor': 'bottom', 'text-offset': [0, -3.1], 'text-allow-overlap': true },
    paint: { 'text-color': CARD, 'text-halo-color': ORANGE, 'text-halo-width': 4 } });
  // 人物：此刻的位置，头像（有立绘用立绘，没有用名字首字）
  add({ id: 'cw-person-ring', type: 'circle', source: 'cw-people', filter: ['has', 'flag'], paint: { 'circle-radius': 21, 'circle-color': 'transparent', 'circle-stroke-color': ['match', ['get', 'flag'], 'hard', RED, AMBER], 'circle-stroke-width': 2.5 } });
  add({ id: 'cw-person', type: 'symbol', source: 'cw-people', layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'icon-opacity': ['case', ['get', 'faded'], 0.4, ['get', 'inferred'], 0.75, 1] } });
  add({ id: 'cw-person-name', type: 'symbol', source: 'cw-people', layout: { 'text-field': ['get', 'label'], 'text-font': FONT_BOLD, 'text-size': 12.5, 'text-anchor': 'left', 'text-offset': [1.7, 0], 'text-allow-overlap': true },
    paint: { 'text-color': INK, 'text-halo-color': CARD, 'text-halo-width': 3, 'text-opacity': ['case', ['get', 'faded'], 0.5, 1] } });
  // 正在画
  add({ id: 'cw-draw-fill', type: 'fill', source: 'cw-draw', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ORANGE, 'fill-opacity': 0.12 } });
  add({ id: 'cw-draw-line', type: 'line', source: 'cw-draw', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': ORANGE, 'line-width': 2.4 } });
  add({ id: 'cw-draw-pt', type: 'circle', source: 'cw-draw', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': ORANGE, 'circle-stroke-color': CARD, 'circle-stroke-width': 1.5 } });
}

// ── 画在画布上的图标：事件章、人物头像（styleimagemissing 时按 id 现画） ──
const PR = 2;
function canvas(size: number) { const c = document.createElement('canvas'); c.width = c.height = size * PR; const g = c.getContext('2d')!; g.scale(PR, PR); return { c, g }; }
function drawIcon(map: MLMap, id: string, portraits?: Map<string, string>) {
  if (map.hasImage(id)) return;
  const [type, a = '', b = '', c, d] = id.split(':');
  if (type === 'ev') {
    // ev:flag:hearsay —— 事件统一一种标记：墨色菱形；冲突描红黄边，传闻/梦境/假设用空心虚线
    const S = 16, { c: cv, g } = canvas(S + 6), o = 3 + S / 2, h = a === '' ? 0 : 1;
    g.beginPath(); g.moveTo(o, 3); g.lineTo(3 + S, o); g.lineTo(o, 3 + S); g.lineTo(3, o); g.closePath();
    if (b === '1') { g.setLineDash([2.5, 2]); g.fillStyle = CARD; g.fill(); g.lineWidth = 1.6; g.strokeStyle = INK; g.stroke(); g.setLineDash([]); }
    else { g.fillStyle = INK; g.fill(); }
    if (h) { g.lineWidth = 2.4; g.strokeStyle = a === 'hard' ? RED : AMBER; g.stroke(); }
    map.addImage(id, g.getImageData(0, 0, cv.width, cv.height), { pixelRatio: PR }); return;
  }
  if (type === 'av') {
    // av:entityId:sel:首字[:p] —— 圆头像：先画首字，有立绘就异步换成立绘
    const S = 34, { c: cv, g } = canvas(S + 6), r = S / 2, o = 3 + r, sel = b === '1';
    const ring = () => { g.beginPath(); g.arc(o, o, r, 0, Math.PI * 2); g.lineWidth = 2.5; g.strokeStyle = sel ? ORANGE : CARD; g.stroke(); };
    g.beginPath(); g.arc(o, o, r, 0, Math.PI * 2); g.fillStyle = sel ? ORANGE : INK; g.fill(); ring();
    g.fillStyle = CARD; g.font = `600 16px ${CJK}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(c ?? '', o, o + 1);
    map.addImage(id, g.getImageData(0, 0, cv.width, cv.height), { pixelRatio: PR });
    const url = d === 'p' ? portraits?.get(a) : undefined;
    if (url) { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => {
      g.save(); g.beginPath(); g.arc(o, o, r, 0, Math.PI * 2); g.clip();
      const k = Math.max(S / img.width, S / img.height); g.drawImage(img, o - (img.width * k) / 2, o - (img.height * k) / 2.6, img.width * k, img.height * k); g.restore(); ring();
      if (map.hasImage(id)) map.updateImage(id, g.getImageData(0, 0, cv.width, cv.height));
    }; img.src = url; }
  }
}

type Props = {
  cfg: MapConfig | null; real: boolean;
  places: Entity[]; edits: EditFeatures; legs: CreativeRouteLeg[];
  people: (Pos & { name: string })[];
  sel: { entityId?: string; legIds?: string[]; placeId?: string };
  flags: { legs: Map<string, Flag>; people: Map<string, Flag> };
  hiLegs: Set<string>;
  focus: { coords: LngLat[]; n: number } | null;
  draw: DrawMode | null;
  onPick: (p: MapPick) => void;
  /** 视野变了：导入 OSM 时按当前视野截一块。 */
  onView: (bbox: [number, number, number, number]) => void;
  /** 这一刻：null = 静态（全部路线、全部事件章，不画人物）；否则路线变淡，画走过的轨迹、人物、已发生 / 正在发生的事件。 */
  moment?: { trails: { entityId: string; lines: LngLat[][] }[] } | null;
  /** 有地点坐标的事件；state 由外面按 t 算好（static 时全是 all）。 */
  events?: { id: string; title: string; at: LngLat; state: 'all' | 'past' | 'now' | 'future'; flag?: Flag; hearsay?: boolean }[];
  /** 人物立绘（有的话当头像）。 */
  portraits?: Map<string, string>;
  /** 路网几何（`network/geojson`）；有真实底图时不传。 */
  network?: unknown;
};

export default function WorldMap(p: Props) {
  const box = useRef<HTMLDivElement>(null), mapRef = useRef<MLMap | null>(null), ready = useRef(false);
  const latest = useRef(p); latest.current = p;
  const drawPts = useRef<LngLat[]>([]), netShown = useRef<unknown>(undefined);

  const refresh = () => {
    const map = mapRef.current, q = latest.current; if (!map || !ready.current) return;
    const set = (id: string, data: unknown) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data as never);
    // 路网要素多，只在换了数据时才重设
    if (netShown.current !== (q.network ?? null)) {
      const first = !netShown.current; netShown.current = q.network ?? null; set('cw-net', q.network ?? EMPTY);
      // 第一次拿到路网、世界里又还没有地点时，缩放到路网范围（架空世界的坐标可能在任何地方）
      const cs = ((q.network as { features?: { geometry?: { coordinates?: number[][] } }[] } | null)?.features ?? []).flatMap(f => f.geometry?.coordinates ?? []);
      if (first && cs.length && !q.places.some(e => e.place?.geo)) map.fitBounds([[Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1]))], [Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))]], { padding: 60, duration: 0 });
    }
    set('cw-edits', { type: 'FeatureCollection', features: q.edits.features.filter(f => f.geometry).map(f => ({ ...f, properties: { ...f.properties, passOpen: (f.properties as any)?.passable?.open ?? null } })) });
    set('cw-legs', { type: 'FeatureCollection', features: q.legs.filter(l => l.path).map(l => ({ type: 'Feature', geometry: l.path,
      properties: { id: l.id, kind: l.kind, sel: !!q.sel.legIds?.includes(l.id), hi: q.hiLegs.has(l.id), flag: q.flags.legs.get(l.id) ?? '',
        dim: !!q.moment && !q.sel.legIds?.includes(l.id),
        tag: l.kind === 'inferred' ? '推断' : l.kind === 'manual' ? '手绘' : '' } })) });
    set('cw-places', { type: 'FeatureCollection', features: q.places.filter(e => e.place?.geo?.type === 'Point').map(e => ({ type: 'Feature', geometry: e.place!.geo, properties: { id: e.id, name: e.name, sel: q.sel.placeId === e.id } })) });
    set('cw-trails', { type: 'FeatureCollection', features: (q.moment?.trails ?? []).flatMap(tr => tr.lines.map(c => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: { id: tr.entityId, sel: q.sel.entityId === tr.entityId } }))) });
    set('cw-events', { type: 'FeatureCollection', features: (q.events ?? []).map(e => ({ type: 'Feature', geometry: { type: 'Point', coordinates: e.at },
      properties: { id: e.id, title: e.title, state: e.state, icon: `ev:${e.flag ?? ''}:${e.hearsay ? 1 : 0}` } })) });
    set('cw-people', { type: 'FeatureCollection', features: q.people.flatMap(x => { const at = x.at ?? (q.moment ? x.last : null); if (!at || !(q.moment || q.sel.entityId === x.entityId)) return [];
      const sel = q.sel.entityId === x.entityId, pic = q.portraits?.get(x.entityId);
      return [{ type: 'Feature', geometry: { type: 'Point', coordinates: at },
      properties: { id: x.entityId, label: x.at ? (x.routeKind === 'inferred' ? `${x.name} · 推断` : x.name) : `${x.name} · ?`, sel, inferred: x.routeKind === 'inferred', faded: !x.at,
        icon: `av:${x.entityId}:${sel ? 1 : 0}:${x.name.slice(0, 1)}${pic ? ':p' : ''}`,
        ...(q.flags.people.has(x.entityId) ? { flag: q.flags.people.get(x.entityId) } : {}) } }]; }) });
    const d = q.draw, pts = drawPts.current;
    set('cw-draw', !d || !pts.length ? EMPTY : { type: 'FeatureCollection', features: [
      ...pts.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} })),
      ...(pts.length > 1 ? [{ type: 'Feature', geometry: d.kind === 'polygon' && pts.length > 2 ? { type: 'Polygon', coordinates: [[...pts, pts[0]]] } : { type: 'LineString', coordinates: pts }, properties: {} }] : []),
    ] });
  };

  useEffect(() => {
    const q = latest.current;
    const coords: LngLat[] = [
      ...q.places.flatMap(e => e.place?.geo?.type === 'Point' ? [e.place.geo.coordinates as LngLat] : []),
      ...q.legs.flatMap(l => (l.path?.coordinates ?? []) as LngLat[]),
    ];
    const fit = bboxOf(coords);
    const map = new maplibregl.Map({
      container: box.current!, style: q.real && q.cfg ? rhineStyle(q.cfg, 'vector') : blankStyle(q.cfg?.vector.glyphs),
      ...(q.cfg ? { transformRequest: withKey(q.cfg) } : {}), localIdeographFontFamily: CJK, attributionControl: { compact: true },
      ...(fit ? { bounds: fit, fitBoundsOptions: { padding: 60, maxZoom: 15 } } : { center: [116.39, 39.9], zoom: 3 }),
      doubleClickZoom: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('style.load', () => { addLayers(map); ready.current = true; refresh(); });
    map.on('styleimagemissing', e => drawIcon(map, e.id, latest.current.portraits));
    const view = () => { const b = map.getBounds(); latest.current.onView([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]); };
    map.on('load', view); map.on('moveend', view);
    map.on('click', e => {
      const d = latest.current.draw;
      if (d) {
        const c: LngLat = [e.lngLat.lng, e.lngLat.lat];
        if (d.kind === 'point') { drawPts.current = []; d.onDone({ type: 'Point', coordinates: c }); return; }
        drawPts.current = [...drawPts.current, c]; refresh(); return;
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ['cw-person', 'cw-event', 'cw-place', 'cw-leg', 'cw-leg-inf', 'cw-edit-line', 'cw-edit-pt', 'cw-edit-area'] })[0];
      if (!hit?.properties) return;
      const l = hit.layer.id, id = String(hit.properties.id ?? hit.properties.editId ?? '');
      if (!id) return;
      latest.current.onPick({ kind: l === 'cw-person' ? 'person' : l === 'cw-event' ? 'event' : l === 'cw-place' ? 'place' : l.startsWith('cw-leg') ? 'leg' : 'edit', id });
    });
    map.on('dblclick', () => {
      // 双击前浏览器还会发两次 click，同一点会被记两遍：去掉相邻的重复点
      const d = latest.current.draw, pts = drawPts.current.filter((c, i, a) => i === 0 || Math.abs(c[0] - a[i - 1][0]) + Math.abs(c[1] - a[i - 1][1]) > 1e-7);
      if (!d || d.kind === 'point') return;
      if ((d.kind === 'line' && pts.length >= 2) || (d.kind === 'polygon' && pts.length >= 3)) {
        drawPts.current = [];
        d.onDone(d.kind === 'line' ? { type: 'LineString', coordinates: pts } : { type: 'Polygon', coordinates: [[...pts, pts[0]]] });
      }
    });
    for (const l of ['cw-person', 'cw-event', 'cw-place', 'cw-leg', 'cw-leg-inf', 'cw-edit-line', 'cw-edit-pt']) {
      map.on('mouseenter', l, () => { if (!latest.current.draw) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', l, () => { map.getCanvas().style.cursor = latest.current.draw ? 'crosshair' : ''; });
    }
    return () => { ready.current = false; map.remove(); mapRef.current = null; };
  }, [p.cfg, p.real]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(refresh);
  useEffect(() => {
    drawPts.current = [];
    const m = mapRef.current; if (m) m.getCanvas().style.cursor = p.draw ? 'crosshair' : '';
    refresh();
  }, [p.draw]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = mapRef.current, f = p.focus; if (!m || !f) return;
    const b = bboxOf(f.coords); if (!b) return;
    if (f.coords.length === 1) m.easeTo({ center: f.coords[0], zoom: Math.max(m.getZoom(), 14), duration: 500 });
    else m.fitBounds(b, { padding: 80, maxZoom: 15, duration: 500 });
  }, [p.focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc 取消正在画的；Backspace 撤销上一个点
  useEffect(() => {
    if (!p.draw) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { drawPts.current = []; latest.current.draw?.onCancel(); }
      if (e.key === 'Backspace' && drawPts.current.length) { drawPts.current = drawPts.current.slice(0, -1); refresh(); e.preventDefault(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [p.draw]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="cw-map">
    <div ref={box} className="cw-map-gl" />
    {p.draw && <div className="cw-draw-hint"><b>{p.draw.hint}</b><span>{p.draw.kind === 'point' ? '在地图上点一下' : '逐点点击，双击结束 · 退格撤一点 · Esc 取消'}</span>
      <button className="rh-btn" onClick={() => { drawPts.current = []; p.draw?.onCancel(); }}>取消</button></div>}
    <div className="cw-legend rh-micro"><span><i className="is-solid" />路网 / 手绘</span><span><i className="is-dash" />AI 推断（未确认）</span><span><i className="is-old" />改造层</span>{p.moment ? <span><i className="is-now" />走过的路</span> : <span>全部路线</span>}<span><i className="is-ev" />事件</span>{!p.real && <span>无真实底图</span>}</div>
  </div>;
}
