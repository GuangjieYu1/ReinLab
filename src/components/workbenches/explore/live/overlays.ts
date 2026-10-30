// 计划 → 地图叠加层（GeoJSON）。全部画在地图画布里，地图快照才能把它们一起拍进去。
import type { CanvasObject, ExplorePlan, LngLat, Stop } from '../../../../../packages/contracts/src/explore';
import { dayLight, localToDate, sunPos } from './sunlive';

type FC = { type: 'FeatureCollection'; features: any[] };
const fc = (features: any[]): FC => ({ type: 'FeatureCollection', features });

/** 停留点的显示编号：已确认按开拍时间 1、2、3…；候选按出现顺序 A、B、C…（对话里也这么叫）。 */
export function stopLabels(plan: ExplorePlan) {
  const confirmed = plan.stops.filter(s => s.state === 'confirmed').sort((a, b) => (a.window?.start ?? '~').localeCompare(b.window?.start ?? '~'));
  const out: Record<string, string> = {};
  confirmed.forEach((s, i) => { out[s.id] = String(i + 1); });
  plan.stops.filter(s => s.state === 'candidate').forEach((s, i) => { out[s.id] = String.fromCharCode(65 + (i % 26)); });
  return out;
}

export const center = (s: Stop): LngLat => s.geometry.type === 'Point' ? s.geometry.coordinates as LngLat : centroid(s.geometry.coordinates[0] as LngLat[]);
function centroid(ring: LngLat[]): LngLat { const n = ring.length - 1 || 1; let x = 0, y = 0; for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; } return [x / n, y / n]; }

/** 从一点按方位（真北顺时针，度）走 meters 米。 */
export function dest([lng, lat]: LngLat, bearing: number, meters: number): LngLat {
  const R = 6371008.8, d = meters / R, b = bearing * Math.PI / 180, p1 = lat * Math.PI / 180, l1 = lng * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((l2 * 180 / Math.PI + 540) % 360) - 180, p2 * 180 / Math.PI];
}

export function stopFeatures(plan: ExplorePlan, selected: string | null) {
  const labels = stopLabels(plan);
  const points: any[] = [], areas: any[] = [];
  for (const s of plan.stops) {
    const props = { id: s.id, label: labels[s.id], name: s.name, state: s.state, kind: s.kind, sel: s.id === selected };
    if (s.geometry.type === 'Polygon') { areas.push({ type: 'Feature', geometry: s.geometry, properties: props }); points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: center(s) }, properties: props }); }
    else points.push({ type: 'Feature', geometry: s.geometry, properties: props });
  }
  return { points: fc(points), areas: fc(areas) };
}

export const routeFeatures = (plan: ExplorePlan) => fc(plan.routes.filter(r => r.geometry).map(r => ({ type: 'Feature', geometry: r.geometry, properties: { from: r.from, to: r.to } })));

/** 画布：线、箭头、区域、笔记、标注；箭头头部用一个朝向末段方位的三角符号。 */
export function canvasFeatures(objs: CanvasObject[]) {
  const lines: any[] = [], fills: any[] = [], notes: any[] = [], heads: any[] = [];
  for (const o of objs) {
    const props = { id: o.id, kind: o.kind, author: o.author, text: o.text ?? '' };
    if (o.kind === 'area' && o.geometry.type === 'Polygon') { fills.push({ type: 'Feature', geometry: o.geometry, properties: props }); lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: o.geometry.coordinates[0] }, properties: props }); }
    else if (o.geometry.type === 'LineString' || o.geometry.type === 'MultiLineString') {
      lines.push({ type: 'Feature', geometry: o.geometry, properties: props });
      if (o.kind === 'arrow' && o.geometry.type === 'LineString' && o.geometry.coordinates.length >= 2) {
        const c = o.geometry.coordinates, a = c[c.length - 2], b = c[c.length - 1];
        const brg = Math.atan2((b[0] - a[0]) * Math.cos(b[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
        heads.push({ type: 'Feature', geometry: { type: 'Point', coordinates: b }, properties: { ...props, rot: brg } });
      }
    }
    if (o.geometry.type === 'Point') notes.push({ type: 'Feature', geometry: o.geometry, properties: props });
    else if (o.text && o.kind !== 'note') notes.push({ type: 'Feature', geometry: { type: 'Point', coordinates: o.geometry.type === 'Polygon' ? centroid(o.geometry.coordinates[0] as LngLat[]) : (o.geometry as any).coordinates.at(-1) }, properties: props });
  }
  return { lines: fc(lines), fills: fc(fills), notes: fc(notes), heads: fc(heads) };
}

/**
 * 选中停留点的光线：此刻太阳方向（被山挡住画灰虚线）、影子方向、日出 / 日落方位、拍摄朝向。
 * 线长随缩放变化，保持屏幕上大致同样长。
 */
export function sunFeatures(stop: Stop | undefined, day: string, tz: string, minutes: number, zoom: number, horizonAlt: number | null) {
  if (!stop) return fc([]);
  const at = center(stop), len = 260 * Math.pow(2, 15 - zoom);
  const p = sunPos(localToDate(day, minutes, tz), at[0], at[1]);
  const dl = dayLight(day, tz, at[0], at[1]);
  const line = (bearing: number, k: string, scale = 1) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [at, dest(at, bearing, len * scale)] }, properties: { k } });
  const out: any[] = [];
  const rise = dl.sunrise !== null ? sunPos(localToDate(day, dl.sunrise, tz), at[0], at[1]).az : null;
  const set = dl.sunset !== null ? sunPos(localToDate(day, dl.sunset, tz), at[0], at[1]).az : null;
  if (rise !== null) out.push(line(rise, 'rise', 1.1));
  if (set !== null) out.push(line(set, 'set', 1.1));
  if (p.alt > -6) {
    const blocked = p.alt <= 0 || (horizonAlt !== null && p.alt <= horizonAlt);
    out.push(line(p.az, blocked ? 'sun-blocked' : 'sun'));
    if (!blocked) out.push(line((p.az + 180) % 360, 'shadow', Math.min(1, 0.25 / Math.tan(Math.max(p.alt, 3) * Math.PI / 180))));
  }
  if (stop.facing !== undefined) {
    const fov = 30, ring = [at, ...Array.from({ length: 9 }, (_, i) => dest(at, stop.facing! - fov + i * fov / 4, len * 0.7)), at];
    out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { k: 'fov' } });
  }
  return fc(out);
}

/** 停留点与路线的范围（地图适配用）。 */
export function boundsOf(points: LngLat[]): [[number, number], [number, number]] | null {
  if (!points.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [[w, s], [e, n]];
}
