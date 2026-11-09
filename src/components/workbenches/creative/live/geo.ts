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

/** 折线从起点走到 frac 处的那一截（走过的轨迹）。 */
export function sliceAlong(coords: LngLat[], frac: number): LngLat[] {
  if (coords.length < 2 || frac >= 1) return coords;
  if (frac <= 0) return coords.slice(0, 1);
  const end = pointAlong(coords, frac)!, k = Math.cos((coords[0][1] * Math.PI) / 180);
  let total = 0; const seg: number[] = [];
  for (let i = 1; i < coords.length; i++) { const d = Math.hypot((coords[i][0] - coords[i - 1][0]) * k, coords[i][1] - coords[i - 1][1]); seg.push(d); total += d; }
  let want = frac * total, i = 0;
  while (i < seg.length - 1 && want > seg[i]) { want -= seg[i]; i++; }
  return [...coords.slice(0, i + 1), end];
}

/** 到 t 为止每个人走过的路：走完的路段整段、正在走的取到当前点。只读服务端 spans 和路段几何。 */
export function trailsAt(tracks: Track[], legs: Map<string, CreativeRouteLeg>, t: number): { entityId: string; lines: LngLat[][] }[] {
  return tracks.map(tr => ({ entityId: tr.entityId, lines: tr.spans.flatMap(s => {
    if (s.kind !== 'move' || s.t0 > t) return [];
    const coords = (legs.get(s.legId)?.path?.coordinates ?? []) as LngLat[];
    const line = s.t1 <= t ? coords : sliceAlong(coords, s.t1 > s.t0 ? (t - s.t0) / (s.t1 - s.t0) : 1);
    return line.length > 1 ? [line] : [];
  }) })).filter(x => x.lines.length);
}

export type Pos = {
  entityId: string;
  state: 'at' | 'move' | 'unknown' | 'dead' | 'none';   // none = 这个时刻没有轨迹（还没出场 / 已经离场）
  at: LngLat | null;
  /** 此刻位置未定时，最后一次知道的位置（地图上淡显，不当成此刻的位置）。 */
  last?: LngLat | null;
  eventId?: string; legId?: string; routeKind?: CreativeRouteLeg['kind']; why?: string;
};

/** 某一故事时刻每个人物在哪：只读服务端的 spans。 */
export function positionsAt(tracks: Track[], legs: Map<string, CreativeRouteLeg>, t: number): Pos[] {
  return tracks.map(tr => {
    let dead = false;
    for (const s of tr.spans) if (s.kind === 'dead' && t >= s.t0) dead = true;
    if (dead) return { entityId: tr.entityId, state: 'dead', at: null };
    // 同一刻可能有几段重叠（比如一条只精确到月的事件盖住整个月）：在场、在路上优先于位置未定，同类取最短的
    const rank = (k: string) => k === 'at' ? 0 : k === 'move' ? 1 : 2;
    const s = tr.spans.filter(x => x.kind !== 'dead' && t >= x.t0 && t <= (x as { t1: number }).t1)
      .sort((a, b) => rank(a.kind) - rank(b.kind) || ((a as { t1: number }).t1 - a.t0) - ((b as { t1: number }).t1 - b.t0))[0];
    const last = lastKnown(tr, legs, t);
    if (!s) return { entityId: tr.entityId, state: 'none', at: null, last };
    if (s.kind === 'at') return { entityId: tr.entityId, state: 'at', at: s.at, eventId: s.eventId };
    if (s.kind === 'unknown') return { entityId: tr.entityId, state: 'unknown', at: null, why: s.why, last };
    if (s.kind === 'move') {
      const leg = legs.get(s.legId);
      const coords = (leg?.path?.coordinates ?? []) as LngLat[];
      const frac = s.t1 > s.t0 ? (t - s.t0) / (s.t1 - s.t0) : 1;
      return { entityId: tr.entityId, state: 'move', at: pointAlong(coords, frac), legId: s.legId, routeKind: s.routeKind };
    }
    return { entityId: tr.entityId, state: 'none', at: null };
  });
}

function lastKnown(tr: Track, legs: Map<string, CreativeRouteLeg>, t: number): LngLat | null {
  let best: { t: number; at: LngLat } | null = null;
  for (const s of tr.spans) {
    if (s.kind === 'at' && s.at && s.t0 <= t && (!best || s.t0 >= best.t)) best = { t: Math.min(t, s.t1), at: s.at };
    if (s.kind === 'move' && s.t1 <= t && (!best || s.t1 >= best.t)) { const c = (legs.get(s.legId)?.path?.coordinates ?? []) as LngLat[]; if (c.length) best = { t: s.t1, at: c[c.length - 1] }; }
  }
  return best?.at ?? null;
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
