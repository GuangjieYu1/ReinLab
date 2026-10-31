// 计划书用的地图快照（契约第 7 节）：离屏地图、矢量底图，按 key 适配范围后导出 PNG。
// key = 'overview'（全程）或某个停留点 id（局部）。不动用户正在看的地图。
import maplibregl from 'maplibre-gl';
import type { ExplorePlan } from '../../../../../packages/contracts/src/explore';
import type { MapConfig } from './adapter';
import { rhineStyle, withKey } from './mapStyle';
import { addOverlays, fillOverlays, planBounds } from './LiveMap';
import { boundsOf, center, dest } from './overlays';

const SIZE = { overview: [1600, 1000], stop: [1200, 900] } as const;

export async function renderSnapshot(cfg: MapConfig, plan: ExplorePlan, key: string): Promise<Blob> {
  const stop = key === 'overview' ? undefined : plan.stops.find(s => s.id === key);
  if (key !== 'overview' && !stop) throw Error(`计划里没有这个停留点：${key}`);
  const [w, h] = stop ? SIZE.stop : SIZE.overview;
  const div = document.createElement('div');
  div.style.cssText = `position:fixed;left:-10000px;top:0;width:${w / 2}px;height:${h / 2}px;`;
  document.body.appendChild(div);
  let bounds = stop ? null : planBounds(plan);
  if (stop) {
    const c = center(stop);
    bounds = stop.geometry.type === 'Polygon' ? boundsOf(stop.geometry.coordinates[0] as [number, number][]) : boundsOf([dest(c, 315, 350), dest(c, 135, 350)]);
  }
  const map = new maplibregl.Map({
    container: div, style: rhineStyle(cfg, 'vector'), transformRequest: withKey(cfg), pixelRatio: 2, interactive: false, attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    // 点名标在点的右侧：右边多留，靠边的点名不被截（地图宽 800 / 600 CSS 像素）
    ...(bounds ? { bounds, fitBoundsOptions: { padding: { top: 60, bottom: 60, left: 60, right: stop ? 200 : 240 }, maxZoom: 17 } } : { center: plan.destination?.center ?? [0, 0], zoom: 13 }),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(Error('地图加载超时，没能导出快照')), 30000);
      map.once('style.load', () => { addOverlays(map); fillOverlays(map, plan, [], stop?.id ?? null, null); });
      map.once('idle', () => { window.clearTimeout(timer); resolve(); });
      map.once('error', e => { window.clearTimeout(timer); reject(e.error ?? Error('地图加载失败')); });
    });
    // 等一帧，确保最后的图层也画进了缓冲区
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return await new Promise<Blob>((resolve, reject) => map.getCanvas().toBlob(b => b ? resolve(b) : reject(Error('导出图片失败')), 'image/png'));
  } finally {
    map.remove(); div.remove();
  }
}

/** 计划书需要哪些快照：精简版只要总览，详细版加每个已确认停留点。 */
export const neededKeys = (plan: ExplorePlan, variant: 'brief' | 'full') =>
  ['overview', ...(variant === 'full' ? plan.stops.filter(s => s.state === 'confirmed').map(s => s.id) : [])];
