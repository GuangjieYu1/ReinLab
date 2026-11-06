/**
 * 路网导入（design/prd/19-creative.md §3、20-creative-contract.md §2「路网导入」）。
 *
 * 两种来源：
 * - OSM：Overpass 取一块区域的所有 highway。用 `out body geom` 一起拿 node id 和坐标，
 *   所以边表的 source / target 是真实 OSM node id，不需要按坐标容差猜拓扑。
 *   单块范围上限：经度×纬度面积 ≤ 0.25 平方度，且 way 数 ≤ 40000（详见导入失败提示）。
 * - Azgaar：接受它自己导出的 Routes GeoJSON（Tools → Export → Export to GeoJSON → routes）。
 *   那份文件的坐标已经是经纬度，不需要换算；没有 node id，节点 key 用坐标哈希。
 *
 * 底图只负责展示，不把瓦片当路网；边表才是算路的依据。
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiFailure } from '../api/errors';
import type { CreativeDocument } from './world';
import { boundsOf } from './story-time';

export type OverpassResponse = { ok: boolean; status: number; text: () => Promise<string> };
export type OverpassTransport = (url: string, body: string) => Promise<OverpassResponse>;

const USER_AGENT = 'ReinLab/1.0 (creative bench network import; +https://openstreetmap.org)';
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
/** 单块范围上限：0.25 平方度 ≈ 55 km × 55 km（赤道附近）；城区密集到这个量级已经够写一个城。 */
export const MAX_BBOX_AREA_DEG2 = 0.25;
export const MAX_WAYS = 40_000;

export type EdgeRow = {
  source: bigint;
  target: bigint;
  coordinates: [number, number][];
  lengthKm: number;
  roadClass: string | null;
  name: string | null;
  network: 'road' | 'water' | 'any';
  oneway: boolean;
  passable: boolean;
  validFrom: number | null;
  validTo: number | null;
  kind: 'osm' | 'azgaar' | 'edit' | 'manual' | 'inferred';
  editId: string | null;
  osmType: string | null;
  osmId: bigint | null;
};

let transport: OverpassTransport | undefined;
let endpointOverride: string | null = null;
/** 测试注入取数通道；生产走真 fetch。 */
export function configureCreativeOverpass(input: { transport?: OverpassTransport; endpoint?: string | null }) {
  transport = input.transport;
  endpointOverride = input.endpoint ?? null;
}
/**
 * 公共 Overpass 常常忙：官方的都排不过来。这里按顺序试几个实例，
 * 谁先回就用谁（同一个导入里后续查询记着它）。local.env 里配 OVERPASS_URL 优先。
 * 全部失败就照实报「连不上」，不伪造空路网。
 */
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
/** 这一次导入里已经证明能用的实例：后面的查询先问它。 */
let preferred: string | null = null;
const endpoints = (): string[] => {
  const first = endpointOverride ?? (process.env.OVERPASS_URL?.trim() || null);
  const ordered = [preferred, first, ...MIRRORS].filter(
    (item, index, list): item is string => Boolean(item) && list.indexOf(item) === index,
  );
  return ordered;
};

const realTransport: OverpassTransport = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  return { ok: response.ok, status: response.status, text: () => response.text() };
};

/** 节点 key：OSM 用真实 node id；Azgaar / 手绘没有 node id，用坐标哈希（8 字节 → 正数 bigint）。 */
export function nodeKeyFor(coordinate: [number, number]): bigint {
  const hash = createHash('sha1')
    .update(`${coordinate[0].toFixed(6)},${coordinate[1].toFixed(6)}`)
    .digest();
  return BigInt('0x' + hash.subarray(0, 7).toString('hex'));
}

/** 度制长度：用于按长度切分改造层的线段（够用，边表里的正式长度由 PostGIS 算）。 */
function quickLengthKm(points: [number, number][]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [lng1, lat1] = points[index - 1];
    const [lng2, lat2] = points[index];
    const metersPerLat = 111_320;
    const metersPerLng = 111_320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    total += Math.hypot((lng2 - lng1) * metersPerLng, (lat2 - lat1) * metersPerLat) / 1000;
  }
  return total;
}

export function validateBbox(bbox: unknown): [number, number, number, number] {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((value) => typeof value === 'number' && Number.isFinite(value)))
    throw new ApiFailure('INVALID_INPUT', 400, '区域要用 [西, 南, 东, 北] 四个经纬度写。');
  const [west, south, east, north] = bbox as [number, number, number, number];
  if (west >= east || south >= north)
    throw new ApiFailure('INVALID_INPUT', 400, '区域的两个角写反了：西 < 东，南 < 北。');
  if (Math.abs(west) > 180 || Math.abs(east) > 180 || Math.abs(south) > 90 || Math.abs(north) > 90)
    throw new ApiFailure('INVALID_INPUT', 400, '经纬度超出范围。');
  const area = (east - west) * (north - south);
  if (area > MAX_BBOX_AREA_DEG2)
    throw new ApiFailure(
      'NETWORK_BBOX_TOO_LARGE',
      422,
      `这块区域 ${area.toFixed(3)} 平方度，超过单块上限 ${MAX_BBOX_AREA_DEG2} 平方度（约 55 km × 55 km）。拆小一点再导入。`,
    );
  return [west, south, east, north];
}

const ROAD_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service',
  'living_street', 'pedestrian', 'track', 'path', 'footway', 'steps', 'bridleway', 'cycleway', 'road',
]);

export type OverpassWay = {
  type: string;
  id: number;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
};

/** Overpass 的 way（`out body geom`）→ 边。缺坐标或缺 node 列表的整条跳过，不补。 */
export function edgesFromOverpass(ways: OverpassWay[]): EdgeRow[] {
  const rows: EdgeRow[] = [];
  for (const way of ways) {
    if (way.type !== 'way') continue;
    const tags = way.tags ?? {};
    const roadClass = tags.highway ?? null;
    if (!roadClass || !ROAD_CLASSES.has(roadClass)) continue;
    const nodes = way.nodes ?? [];
    const geometry = way.geometry ?? [];
    if (nodes.length < 2 || geometry.length !== nodes.length) continue;
    for (let index = 1; index < nodes.length; index += 1) {
      const from: [number, number] = [geometry[index - 1].lon, geometry[index - 1].lat];
      const to: [number, number] = [geometry[index].lon, geometry[index].lat];
      if (from[0] === to[0] && from[1] === to[1]) continue;
      const access = (tags.access ?? '').toLowerCase();
      rows.push({
        source: BigInt(nodes[index - 1]),
        target: BigInt(nodes[index]),
        coordinates: [from, to],
        lengthKm: quickLengthKm([from, to]),
        roadClass,
        name: tags.name ?? null,
        network: 'road',
        oneway: ['yes', 'true', '1', '-1'].includes((tags.oneway ?? '').toLowerCase()),
        passable: !['no', 'private'].includes(access),
        validFrom: null,
        validTo: null,
        kind: 'osm',
        editId: null,
        osmType: 'way',
        osmId: BigInt(way.id),
      });
    }
  }
  return rows;
}

/**
 * 取 OSM：一次拿全，超过上限就明确拒绝，不让一次导入把库撑爆。
 *
 * 只发一个查询（不再先数一遍：公共实例很慢，两次查询等于双倍等待）。
 * 上限两头都卡：Overpass 侧 [maxsize] 兜住响应体积，拿到以后再看 way 数。
 */
export async function fetchOsmEdges(
  bbox: [number, number, number, number],
  channel?: OverpassTransport,
): Promise<EdgeRow[]> {
  const send = channel ?? transport ?? realTransport;
  const bboxText = `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`;
  const backoff = [1_000, 3_000, 6_000];
  const ask = async (query: string): Promise<{ status: number; text: string }> => {
    let last: { status: number; text: string } = { status: 0, text: '' };
    for (let round = 0; round < 2; round += 1)
      for (const url of endpoints()) {
        try {
          const response = await send(url, 'data=' + encodeURIComponent(query));
          last = { status: response.status, text: await response.text() };
          if (response.ok) {
            preferred = url;
            return last;
          }
          if (!TRANSIENT.has(response.status)) return last;
        } catch (error) {
          last = { status: 0, text: String((error as Error)?.message ?? error) };
        }
        await new Promise((done) => setTimeout(done, backoff[Math.min(round, backoff.length - 1)]));
      }
    return last;
  };

  const data = await ask(
    `[out:json][timeout:180][maxsize:268435456];way["highway"](${bboxText});out body geom;`,
  );
  if (data.status !== 200)
    throw new ApiFailure(
      'NETWORK_IMPORT_FAILED',
      503,
      `Overpass 返回 ${data.status || '连不上'}，路网没导进来。公共实例忙的时候可以在 local.env 里配 OVERPASS_URL 换一个。`,
    );
  const parsed = (() => {
    try {
      return JSON.parse(data.text) as { elements?: OverpassWay[]; remark?: string };
    } catch {
      throw new ApiFailure('NETWORK_IMPORT_FAILED', 503, 'Overpass 返回的不是 JSON，路网没导进来。');
    }
  })();
  const elements = parsed.elements ?? [];
  if (!elements.length && parsed.remark)
    throw new ApiFailure('NETWORK_IMPORT_FAILED', 503, `Overpass 说这次没跑完：${String(parsed.remark).slice(0, 200)}`);
  const ways = elements.filter((item) => item.type === 'way');
  if (ways.length > MAX_WAYS)
    throw new ApiFailure(
      'NETWORK_TOO_MANY_WAYS',
      422,
      `这块区域有 ${ways.length} 条路，超过单块上限 ${MAX_WAYS}。拆小一点再导入。`,
    );
  const rows = edgesFromOverpass(ways);
  if (!rows.length) throw new ApiFailure('NETWORK_EMPTY', 422, '这块区域没取到带几何的道路，换一块或换一个来源。');
  return rows;
}

export type AzgaarRoute = {
  geometry?: { type: string; coordinates?: unknown };
  properties?: { id?: number; group?: string; name?: string | null };
};

export type AzgaarParse = {
  edges: EdgeRow[];
  routes: number;
  skipped: number;
  /** 比例：Azgaar 的 1 像素 = distanceScale 个长度单位；GeoJSON 已经是经纬度，这里只作参考记录。 */
  kmPerDegLat: number | null;
};

/** Azgaar 的 Routes GeoJSON：LineString + properties.group（roads / trails / searoutes）。 */
export function edgesFromAzgaar(content: string): AzgaarParse {
  let parsed: { type?: string; features?: AzgaarRoute[] };
  try {
    parsed = JSON.parse(content) as { type?: string; features?: AzgaarRoute[] };
  } catch {
    throw new ApiFailure('AZGAAR_UNREADABLE', 422, '这份文件不是 JSON。请用 Azgaar 的 Tools → Export → Export to GeoJSON → routes 导出。');
  }
  const features = Array.isArray(parsed.features) ? parsed.features : [];
  if (!features.length)
    throw new ApiFailure('AZGAAR_UNREADABLE', 422, '文件里没有要素。请导出 Routes GeoJSON（不是 cells，也不是 .map）。');
  const edges: EdgeRow[] = [];
  let routes = 0;
  let skipped = 0;
  for (const feature of features) {
    const coordinates = feature.geometry?.coordinates;
    if (feature.geometry?.type !== 'LineString' || !Array.isArray(coordinates)) {
      skipped += 1;
      continue;
    }
    const points = coordinates
      .filter((point): point is [number, number] => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map((point) => [Number(point[0]), Number(point[1])] as [number, number]);
    if (points.length < 2) {
      skipped += 1;
      continue;
    }
    routes += 1;
    const group = feature.properties?.group ?? 'roads';
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      if (from[0] === to[0] && from[1] === to[1]) continue;
      edges.push({
        source: nodeKeyFor(from),
        target: nodeKeyFor(to),
        coordinates: [from, to],
        lengthKm: quickLengthKm([from, to]),
        roadClass: group,
        name: feature.properties?.name ?? null,
        network: group === 'searoutes' ? 'water' : 'road',
        oneway: false,
        passable: true,
        validFrom: null,
        validTo: null,
        kind: 'azgaar',
        editId: null,
        osmType: null,
        osmId: typeof feature.properties?.id === 'number' ? BigInt(feature.properties.id) : null,
      });
    }
  }
  if (!edges.length)
    throw new ApiFailure('AZGAAR_NO_ROUTES', 422, '这份 GeoJSON 里没有可用的道路线段（需要 LineString）。');
  return { edges, routes, skipped, kmPerDegLat: 111.32 };
}

const INSERT_EDGE = `insert into creative_edge(
  account_id,dossier_id,source,target,geom,length_km,road_class,name,network,oneway,passable,
  valid_from,valid_to,kind,edit_id,osm_type,osm_id,version)
  values($1,$2,$3,$4,
    ST_SetSRID(ST_MakeLine(ARRAY[ST_MakePoint($5,$6),ST_MakePoint($7,$8)]),4326),
    ST_Length(ST_SetSRID(ST_MakeLine(ARRAY[ST_MakePoint($5,$6),ST_MakePoint($7,$8)]),4326)::geography)/1000,
    $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`;

export async function insertEdges(
  client: pg.PoolClient,
  input: { account: string; dossier: string; revision: number },
  rows: EdgeRow[],
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    await client.query(INSERT_EDGE, [
      input.account, input.dossier, row.source.toString(), row.target.toString(),
      row.coordinates[0][0], row.coordinates[0][1], row.coordinates[1][0], row.coordinates[1][1],
      row.roadClass, row.name, row.network, row.oneway, row.passable,
      row.validFrom, row.validTo, row.kind, row.editId, row.osmType,
      row.osmId === null ? null : row.osmId.toString(), input.revision,
    ]);
    inserted += 1;
  }
  return inserted;
}

const timeOf = (time: { t: number | null; range?: [number, number] | null } | null | undefined): number | null =>
  time ? (time.range ? time.range[0] : boundsOf(time).start) : null;
const endOf = (time: { t: number | null; range?: [number, number] | null } | null | undefined): number | null =>
  time ? (time.range ? time.range[1] : boundsOf(time).end) : null;

/**
 * 改造层的道路写进同一张边表：新增古道、桥按故事时间生效，算路跟着变。
 * 每次批次之后重算这一档（1A 一个世界观只有一块区域，代价很小）。
 */
export async function syncEditEdges(
  client: pg.PoolClient,
  input: { account: string; dossier: string; revision: number },
  document: CreativeDocument,
): Promise<number> {
  await client.query(
    "delete from creative_edge where account_id=$1 and dossier_id=$2 and kind='edit'",
    [input.account, input.dossier],
  );
  const rows: EdgeRow[] = [];
  for (const edit of document.edits) {
    if (edit.effect !== 'add') continue;
    const style = edit.props?.style;
    if (style !== 'road' && style !== 'ancient_road') continue;
    const geometry = edit.geometry;
    if (!geometry) continue;
    const lines: [number, number][][] = [];
    if (geometry.type === 'LineString') lines.push(geometry.coordinates as [number, number][]);
    if (geometry.type === 'MultiLineString') lines.push(...((geometry.coordinates as unknown) as [number, number][][]));
    const validFrom = timeOf(edit.valid?.from ?? null);
    const validTo = endOf(edit.valid?.to ?? null);
    for (const points of lines) {
      for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1];
        const to = points[index];
        if (from[0] === to[0] && from[1] === to[1]) continue;
        rows.push({
          source: nodeKeyFor(from),
          target: nodeKeyFor(to),
          coordinates: [from, to],
          lengthKm: quickLengthKm([from, to]),
          roadClass: style,
          name: edit.props?.name ?? edit.title,
          network: 'road',
          oneway: false,
          passable: edit.passable?.open === false ? false : true,
          validFrom,
          validTo,
          kind: 'edit',
          editId: edit.id,
          osmType: null,
          osmId: null,
        });
      }
    }
  }
  return rows.length ? insertEdges(client, input, rows) : 0;
}

export async function importOsm(
  client: pg.PoolClient,
  input: { account: string; dossier: string; revision: number; bbox: [number, number, number, number]; channel?: OverpassTransport },
): Promise<number> {
  const rows = await fetchOsmEdges(input.bbox, input.channel);
  await client.query(
    "delete from creative_edge where account_id=$1 and dossier_id=$2 and kind='osm'",
    [input.account, input.dossier],
  );
  return insertEdges(client, input, rows);
}

export async function importAzgaar(
  client: pg.PoolClient,
  input: { account: string; dossier: string; revision: number; content: string },
): Promise<{ edges: number; routes: number; skipped: number }> {
  const parsed = edgesFromAzgaar(input.content);
  await client.query(
    "delete from creative_edge where account_id=$1 and dossier_id=$2 and kind='azgaar'",
    [input.account, input.dossier],
  );
  const inserted = await insertEdges(client, input, parsed.edges);
  return { edges: inserted, routes: parsed.routes, skipped: parsed.skipped };
}

export async function edgeCount(
  client: pg.PoolClient,
  input: { account: string; dossier: string },
): Promise<number> {
  const result = await client.query<{ n: string }>(
    'select count(*)::text n from creative_edge where account_id=$1 and dossier_id=$2',
    [input.account, input.dossier],
  );
  return Number(result.rows[0]?.n ?? 0);
}
