/**
 * 算路（design/prd/19-creative.md §4、20-creative-contract.md §1「路线」）。
 *
 * 一段行程 = 同一人物两条相邻事件之间，从 A 地点到 B 地点按指定交通方式沿边表算。
 * 先看作者手绘、再看 AI 推断（未确认也算，画虚线），最后才问路网。
 * 算不出来就是 none + failure（人话），绝不拿直线冒充路线。
 *
 * 边表过滤按故事时刻、可通行性、交通方式、修订版本一起做：改造层里的封路、拆桥、
 * 新增古道都在这一刻生效。
 */

import type pg from 'pg';
import type { GeoJSON, RouteKind, CreativeRouteLeg, StoryTime, TransportMode } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { boundsOf } from './story-time';
import { legIdFor, legPathOf, modeOf, type CreativeDocument } from './world';
import type { WorldEvent } from '@reinlab/contracts';

const METERS_PER_DEGREE = 111_320;

/** 起点/终点离路网多远以内可以接上：超过就说「离路网太远」，不悄悄拉一条线。 */
export const SNAP_MAX_METERS = 2_000;

const tOf = (time: StoryTime): number | null => boundsOf(time).start;
const endT = (time: StoryTime): number | null => boundsOf(time).end;

export type RoutedLeg = {
  kind: RouteKind;
  path: GeoJSON.LineString | null;
  distanceKm: number | null;
  durationMin: number | null;
  failure: string | null;
};

/** 沿折线量距离（公里），用来给手绘与推断路线算耗时。 */
export function pathDistanceKm(path: GeoJSON.LineString): number {
  let meters = 0;
  for (let index = 1; index < path.coordinates.length; index += 1) {
    const [lng1, lat1] = path.coordinates[index - 1];
    const [lng2, lat2] = path.coordinates[index];
    const metersPerLng = METERS_PER_DEGREE * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    meters += Math.hypot((lng2 - lng1) * metersPerLng, (lat2 - lat1) * METERS_PER_DEGREE);
  }
  return Math.round(meters) / 1000;
}

export function pointOf(geometry: GeoJSON.Geometry | null | undefined): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === 'Point') return geometry.coordinates as [number, number];
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    // 圈选的位置按中心接路网：这是「在这一带」，不是精确点到点。
    const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0]?.[0];
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const sum = ring.reduce((acc, item) => [acc[0] + item[0], acc[1] + item[1]] as [number, number], [0, 0] as [number, number]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }
  return null;
}

type EdgeFilter = {
  networks: string[];
  at: number;
  closedOsmIds: string[];
};

/** 这一刻生效的封路（改造层的 passability）。外观和通行分开：只有明确的封路才拦。 */
export function closedOsmIdsAt(document: CreativeDocument, at: number): string[] {
  const closed = new Set<string>();
  for (const edit of document.edits) {
    if (edit.effect !== 'passability') continue;
    if (edit.passable?.open !== false) continue;
    const from = edit.valid?.from?.t ?? edit.valid?.from?.range?.[0] ?? null;
    const to = edit.valid?.to?.t ?? edit.valid?.to?.range?.[1] ?? null;
    if (from !== null && at < from) continue;
    if (to !== null && at > to) continue;
    const osmId = edit.target?.osm?.id;
    if (typeof osmId === 'number')
      // 瓦片上的 feature.id = osm_id*10 + 偏移；floor(id/10) 就是 OSM id（见 network.ts）。
      closed.add(String(Math.floor(osmId / 10)));
  }
  return [...closed];
}

const networksFor = (mode: TransportMode): string[] => {
  if (mode.network === 'water') return ['water', 'any'];
  if (mode.network === 'road') return ['road', 'any'];
  if (mode.network === 'any') return ['road', 'water', 'any'];
  return [];
};

const edgeWhere = (filter: EdgeFilter) => {
  const networks = filter.networks.map((item) => `'${item.replace(/[^a-z]/g, '')}'`).join(',');
  const closed = filter.closedOsmIds.length
    ? ` and (osm_id is null or osm_id not in (${filter.closedOsmIds.map((item) => Number(item)).filter(Number.isSafeInteger).join(',')}))`
    : '';
  return `network in (${networks || "''"}) and passable
    and (valid_from is null or valid_from <= ${Math.round(filter.at)})
    and (valid_to is null or valid_to >= ${Math.round(filter.at)})${closed}`;
};

async function nearestNode(
  client: pg.PoolClient,
  input: { account: string; dossier: string },
  point: [number, number],
  filter: EdgeFilter,
): Promise<{ node: string; meters: number } | null> {
  const result = await client.query<{ node: string; meters: number }>(
    `with valid as (
       select source, target, geom from creative_edge
        where account_id=$1 and dossier_id=$2 and ${edgeWhere(filter)}
     ), nodes as (
       select source node, st_startpoint(geom) geom from valid
       union all
       select target node, st_endpoint(geom) geom from valid
     )
     select node::text node,
            st_distance(geom::geography, st_setsrid(st_makepoint($3,$4),4326)::geography) meters
       from nodes order by meters asc limit 1`,
    [input.account, input.dossier, point[0], point[1]],
  );
  const row = result.rows[0];
  return row ? { node: row.node, meters: Number(row.meters) } : null;
}

type DijkstraEdge = { id: string; source: string; target: string; coordinates: [number, number][] };

/** 用 pgRouting 算一条最短路；几何按 path 顺序拼，方向跟边走。 */
async function dijkstra(
  client: pg.PoolClient,
  input: { account: string; dossier: string },
  from: string,
  to: string,
  speedKmPerHour: number,
  filter: EdgeFilter,
): Promise<DijkstraEdge[]> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(input.account) || !UUID.test(input.dossier))
    throw new ApiFailure('SCOPE_DENIED', 403, '路网查询的档案标识无效。');
  const speed = Math.max(speedKmPerHour, 0.1).toFixed(6);
  const sql = `select id, source, target, length_km / ${speed}::double precision as cost,
      case when oneway then -1 else length_km / ${speed}::double precision end as reverse_cost
     from creative_edge
    where account_id='${input.account.replace(/'/g, '')}' and dossier_id='${input.dossier.replace(/'/g, '')}'
      and ${edgeWhere(filter)}`;
  const path = await client.query<{ edge: string }>(
    `select edge::text edge from pgr_dijkstra($1,$2::bigint,$3::bigint,true) where edge <> -1 order by path_seq`,
    [sql, from, to],
  );
  const ids = path.rows.map((row) => groupEdge(row.edge)).filter((item): item is string => Boolean(item));
  if (!ids.length) return [];
  const edges = await client.query<{ id: string; source: string; target: string; coordinates: [number, number][] }>(
    `select id::text id, source::text source, target::text target,
            st_asgeojson(geom)::json -> 'coordinates' coordinates
       from creative_edge
      where account_id=$1 and dossier_id=$2 and id = any($3::bigint[])`,
    [input.account, input.dossier, ids],
  );
  const byId = new Map(edges.rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
}

/** PostgreSQL 的 bigint 可能以 string 或 {id} 形状回；统一成字符串。 */
function groupEdge(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && 'id' in value) return String((value as { id: unknown }).id);
  return null;
}

function assemblePath(edges: DijkstraEdge[], first: [number, number], last: [number, number]): GeoJSON.LineString {
  const coordinates: [number, number][] = [];
  for (const edge of edges) {
    const points = edge.coordinates;
    if (!points.length) continue;
    const forward =
      coordinates.length === 0
        ? closer(points[0], first) <= closer(points[points.length - 1], first)
        : closer(points[0], coordinates[coordinates.length - 1]) <= closer(points[points.length - 1], coordinates[coordinates.length - 1]);
    const ordered = forward ? points : [...points].reverse();
    for (const point of ordered) {
      const previous = coordinates[coordinates.length - 1];
      if (previous && Math.abs(previous[0] - point[0]) < 1e-9 && Math.abs(previous[1] - point[1]) < 1e-9) continue;
      coordinates.push([point[0], point[1]]);
    }
  }
  if (!coordinates.length) coordinates.push(first, last);
  return { type: 'LineString', coordinates };
}

const closer = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

export type RouteRequest = {
  from: { placeId: string; point: [number, number] | null; label: string };
  to: { placeId: string; point: [number, number] | null; label: string };
  modeId: string | null;
  at: number;
};

/** 一段行程按路网算：先接最近节点，再 dijkstra，最后按边的方向拼几何。 */
export async function routeOnNetwork(
  client: pg.PoolClient,
  input: { account: string; dossier: string; document: CreativeDocument },
  request: RouteRequest,
): Promise<RoutedLeg> {
  const mode = modeOf(input.document, request.modeId);
  if (!mode) return { kind: 'none', path: null, distanceKm: null, durationMin: null, failure: '这段行程没指定交通方式。' };
  const networks = networksFor(mode);
  if (!networks.length)
    return {
      kind: 'none', path: null, distanceKm: null, durationMin: null,
      failure: `「${mode.name}」不走路网，程序算不了这段路；要么换一种交通方式，要么手绘一段。`,
    };
  if (!request.from.point)
    return { kind: 'none', path: null, distanceKm: null, durationMin: null, failure: `「${request.from.label}」没有坐标，接不上路网。` };
  if (!request.to.point)
    return { kind: 'none', path: null, distanceKm: null, durationMin: null, failure: `「${request.to.label}」没有坐标，接不上路网。` };

  const filter: EdgeFilter = { networks, at: request.at, closedOsmIds: closedOsmIdsAt(input.document, request.at) };
  const start = await nearestNode(client, input, request.from.point, filter);
  const finish = await nearestNode(client, input, request.to.point, filter);
  if (!start || !finish)
    return { kind: 'none', path: null, distanceKm: null, durationMin: null, failure: '这一刻的路网上没有这类边，先在右栏导入路网或加改造层。' };
  if (start.meters > SNAP_MAX_METERS)
    return {
      kind: 'none', path: null, distanceKm: null, durationMin: null,
      failure: `「${request.from.label}」离这一刻可通行的路网最近还有 ${(start.meters / 1000).toFixed(1)} km，接不上。`,
    };
  if (finish.meters > SNAP_MAX_METERS)
    return {
      kind: 'none', path: null, distanceKm: null, durationMin: null,
      failure: `「${request.to.label}」离这一刻可通行的路网最近还有 ${(finish.meters / 1000).toFixed(1)} km，接不上。`,
    };

  const edges = await dijkstra(client, input, start.node, finish.node, mode.kmPerHour, filter);
  if (!edges.length)
    return {
      kind: 'none', path: null, distanceKm: null, durationMin: null,
      failure: `「${request.from.label}」到「${request.to.label}」这一刻在路网里不连通（可能被拆桥、封路或本来就没路）。`,
    };
  const path = assemblePath(edges, request.from.point, request.to.point);
  const distanceKm = Math.round(pathDistanceKm(path) * 1000) / 1000;
  return {
    kind: 'network',
    path,
    distanceKm,
    durationMin: Math.round((distanceKm / Math.max(mode.kmPerHour, 0.1)) * 60),
    failure: null,
  };
}

/** 人物 → 相邻两件事之间的行程。 */
export type LegPlan = {
  entityId: string;
  fromEvent: WorldEvent;
  toEvent: WorldEvent;
  legId: string;
  modeId: string | null;
};

export function planLegs(document: CreativeDocument): LegPlan[] {
  const plans: LegPlan[] = [];
  for (const entity of document.entities) {
    if (entity.kind !== 'person') continue;
    const events = document.events
      .filter((event) => {
        const participant = event.participants.find((item) => item.entityId === entity.id);
        return participant && (participant.as === 'actor' || participant.as === 'present');
      })
      .map((event) => ({ event, t: tOf(event.start) }))
      .filter((item): item is { event: WorldEvent; t: number } => item.t !== null)
      .sort((a, b) => a.t - b.t || tOf(a.event.end)! - tOf(b.event.end)!);
    for (let index = 1; index < events.length; index += 1) {
      const fromEvent = events[index - 1].event;
      const toEvent = events[index].event;
      if (fromEvent.placeId === toEvent.placeId && fromEvent.placeId) continue;
      plans.push({
        entityId: entity.id,
        fromEvent,
        toEvent,
        legId: legIdFor(entity.id, fromEvent.id, toEvent.id),
        modeId: toEvent.travel?.modeId ?? fromEvent.travel?.modeId ?? document.modes[0]?.id ?? null,
      });
    }
  }
  return plans;
}

/** 每条 leg 的完整投影：手绘 → 推断 → 路网 → none。 */
export async function buildLegs(
  client: pg.PoolClient,
  input: { account: string; dossier: string; document: CreativeDocument },
): Promise<CreativeRouteLeg[]> {
  const legs: CreativeRouteLeg[] = [];
  const cache = new Map<string, RoutedLeg>();
  for (const plan of planLegs(input.document)) {
    const manual = input.document.manualRoutes.find((item) => item.legId === plan.legId);
    const inferred = input.document.inferredRoutes.find((item) => item.legId === plan.legId);
    const mode = modeOf(input.document, plan.modeId);
    const base = {
      id: plan.legId,
      entityId: plan.entityId,
      fromEventId: plan.fromEvent.id,
      toEventId: plan.toEvent.id,
      modeId: plan.modeId,
    };
    if (manual) {
      const distanceKm = Math.round(pathDistanceKm(manual.path) * 1000) / 1000;
      legs.push({
        ...base,
        kind: 'manual',
        path: manual.path,
        distanceKm,
        durationMin: mode ? Math.round((distanceKm / Math.max(mode.kmPerHour, 0.1)) * 60) : null,
        failure: null,
        inferred: null,
      });
      continue;
    }
    if (inferred) {
      const distanceKm = Math.round(pathDistanceKm(inferred.path) * 1000) / 1000;
      legs.push({
        ...base,
        kind: 'inferred',
        path: inferred.path,
        segments: [{ from: 0, to: inferred.path.coordinates.length - 1, kind: 'inferred' }],
        distanceKm,
        durationMin: mode ? Math.round((distanceKm / Math.max(mode.kmPerHour, 0.1)) * 60) : null,
        failure: null,
        inferred: { proposalId: inferred.proposalId, why: inferred.why, sources: inferred.sources },
      });
      continue;
    }

    const fromEntity = input.document.entities.find((item) => item.id === plan.fromEvent.placeId);
    const toEntity = input.document.entities.find((item) => item.id === plan.toEvent.placeId);
    const departure = endT(plan.fromEvent.end) ?? tOf(plan.fromEvent.start) ?? 0;
    const key = `${plan.fromEvent.placeId}|${plan.toEvent.placeId}|${plan.modeId}|${departure}`;
    let routed = cache.get(key);
    if (!routed) {
      routed = await routeOnNetwork(client, input, {
        from: { placeId: plan.fromEvent.placeId ?? '', point: pointOf(fromEntity?.place?.geo), label: fromEntity?.name ?? '上一处' },
        to: { placeId: plan.toEvent.placeId ?? '', point: pointOf(toEntity?.place?.geo), label: toEntity?.name ?? '下一处' },
        modeId: plan.modeId,
        at: departure,
      });
      cache.set(key, routed);
    }
    const knownFailure = input.document.routeFailures.find((item) => item.legId === plan.legId)?.failure;
    legs.push({
      ...base,
      kind: routed.kind,
      path: routed.path,
      distanceKm: routed.distanceKm,
      durationMin: routed.durationMin,
      failure: routed.failure ?? knownFailure ?? null,
      inferred: null,
    });
  }
  return legs;
}

export function legOf(legs: CreativeRouteLeg[], legId: string): CreativeRouteLeg | undefined {
  return legs.find((item) => item.id === legId);
}

export { legPathOf };
