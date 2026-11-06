// 前端唯一允许的计算：move 段按时间比例沿服务端给的折线取点（契约 §1 Track 注释）。
// 其余都是纯显示：把服务端给的轨迹、标签摆到画面上，不判断冲突、不算路程、不换算历法。
import type { CreativeRouteLeg, LngLat, Track, WorldEvent } from '../../../../../packages/contracts/src/creative';

/** 沿折线按长度比例取点（经度按纬度余弦缩放，只为画面上走得匀）。 */
export function pointAlong(coords: LngLat[], frac: number): LngLat | null {
  if (!coords.length) return null;
  if (coords.length === 1 || frac <= 0) return coords[0];
  if (frac >= 1) return coords[coords.length - 1];
  const k = Math.cos((coords[0][1] * Math.PI) / 180);
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][0] - coords[i - 1][0]) * k, dy = coords[i][1] - coords[i - 1][1];
    const d = Math.hypot(dx, dy); seg.push(d); total += d;
  }
  let want = frac * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const f = seg[i] ? Math.min(1, want / seg[i]) : 0, a = coords[i], b = coords[i + 1];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    want -= seg[i];
  }
  return coords[coords.length - 1];
}

export type Pos = {
  entityId: string;
  state: 'at' | 'move' | 'unknown' | 'dead' | 'none';   // none = 这个时刻没有轨迹（还没出场 / 已经离场）
  at: LngLat | null;
  eventId?: string; legId?: string; routeKind?: CreativeRouteLeg['kind']; why?: string;
};

/** 某一故事时刻每个人物在哪：只读服务端的 spans。 */
export function positionsAt(tracks: Track[], legs: Map<string, CreativeRouteLeg>, t: number): Pos[] {
  return tracks.map(tr => {
    let dead = false;
    for (const s of tr.spans) if (s.kind === 'dead' && t >= s.t0) dead = true;
    if (dead) return { entityId: tr.entityId, state: 'dead', at: null };
    const s = tr.spans.find(x => x.kind !== 'dead' && t >= x.t0 && t <= (x as { t1: number }).t1);
    if (!s) return { entityId: tr.entityId, state: 'none', at: null };
    if (s.kind === 'at') return { entityId: tr.entityId, state: 'at', at: s.at, eventId: s.eventId };
    if (s.kind === 'unknown') return { entityId: tr.entityId, state: 'unknown', at: null, why: s.why };
    if (s.kind === 'move') {
      const leg = legs.get(s.legId);
      const coords = (leg?.path?.coordinates ?? []) as LngLat[];
      const frac = s.t1 > s.t0 ? (t - s.t0) / (s.t1 - s.t0) : 1;
      return { entityId: tr.entityId, state: 'move', at: pointAlong(coords, frac), legId: s.legId, routeKind: s.routeKind };
    }
    return { entityId: tr.entityId, state: 'none', at: null };
  });
}

/** 时间轴上「此刻」的读法：最近一个已开始事件的服务端标签 + 过去了多久（只是时长加减，不换算历法）。 */
export function nowLabel(events: WorldEvent[], t: number): { label: string; plus: string } | null {
  let best: WorldEvent | null = null;
  for (const e of events) if (e.start.t != null && e.start.t <= t && (!best || e.start.t > best.start.t!)) best = e;
  if (!best) return null;
  return { label: best.start.label, plus: dur(t - best.start.t!) };
}

/** 分钟数 → 「2 天 3 小时」这种人话（时长，不是日期）。 */
export function dur(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m === 0) return '';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  return [d ? `${d} 天` : '', h ? `${h} 小时` : '', r && !d ? `${r} 分` : ''].filter(Boolean).join(' ');
}

/** 改造层生效时间段的边界：时间轴跨过边界时才重取 edits/geojson。 */
export function bucketOf(bounds: number[], t: number) {
  let i = 0; while (i < bounds.length && t >= bounds[i]) i++; return i;
}

export function bboxOf(coords: LngLat[]): [[number, number], [number, number]] | null {
  if (!coords.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y); }
  return [[w, s], [e, n]];
}
