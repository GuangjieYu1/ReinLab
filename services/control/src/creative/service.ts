/**
 * 创作台世界观服务（20-creative-contract.md §2）：
 * 读取快照、原子操作批次（revision +1）、版本、检查、路网导入、轨迹。
 *
 * 一个批次在一个事务里改完：document、边表、检查结果、操作记录、事件流一起提交；
 * 任何一步失败整批回滚，页面看到的还是上一版。
 */

import type pg from 'pg';
import type {
  CheckRun,
  CreativeAppliedOp,
  CreativeRouteLeg,
  ItemChange,
  Proposal,
  WorldSnapshot,
  WorldVersion,
} from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { runCheck } from './check';
import { appendEvents, cursorOf } from './events';
import { buildLegs } from './routing';
import { buildTracks, type TrackRange } from './tracks';
import { edgeCount, fetchOsmEdges, importAzgaar, insertEdges, syncEditEdges, type OverpassTransport } from './network';
import { applyOps, emptyDocument, worldOf, type CreativeDocument } from './world';
import { diffDocuments } from './items';
import { selectedPortraits } from './asset-query';

export type WorldState = {
  revision: number;
  document: CreativeDocument;
  latestVersion: number;
};

/** 控制面进程的启动时刻：比它早的「导入中」就是上一个进程留下的，启动时改成失败（1A 遗留 3）。 */
export const PROCESS_STARTED_AT = new Date().toISOString();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertUuid = (value: string) => {
  if (!UUID.test(value)) throw new ApiFailure('DOSSIER_NOT_FOUND', 404, '找不到这份档案。');
};

/** 档案存在、是创作台、属于这个账户；不然一律按「找不到」处理。 */
export async function requireCreativeDossier(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<void> {
  assertUuid(dossier);
  const row = (
    await client.query('select id,bench from dossier where account_id=$1 and id=$2', [account, dossier])
  ).rows[0];
  if (!row) throw new ApiFailure('DOSSIER_NOT_FOUND', 404, '找不到这份档案。');
  if (row.bench !== 'creative') throw new ApiFailure('BENCH_UNSUPPORTED', 400, '只有创作台档案有世界观账本。');
}

/**
 * 上一个进程留下的「导入中」在启动后第一次打开时改成失败（1A 遗留 3）。
 * 导入跑在控制面进程里，进程重启就不可能还在跑；不写成失败，页面会一直转圈。
 * 只改状态、不动 revision：这不是作者的改动，页面不该因此收到 409。
 */
async function reconcileImportState(
  client: pg.PoolClient,
  input: { account: string; dossier: string },
  document: CreativeDocument,
): Promise<CreativeDocument> {
  if (document.network?.state !== "importing") return document;
  const startedAt = document.networkUpdatedAt ?? "";
  if (startedAt && startedAt >= PROCESS_STARTED_AT) return document;
  const next: CreativeDocument = {
    ...document,
    network: {
      state: "failed",
      sources: document.network.sources,
      error: "导入中断（服务重启）",
    },
    networkUpdatedAt: new Date().toISOString(),
  };
  await client
    .query(
      "update creative_world set document=$3::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2",
      [input.account, input.dossier, JSON.stringify(next)],
    )
    .then(() => appendEvents(client, input, [{ type: "creative.network", data: next.network }]))
    .catch(() => undefined);
  return next;
}

export async function loadWorld(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  options: { lock?: boolean } = {},
): Promise<WorldState> {
  await requireCreativeDossier(client, account, dossier);
  const found = (
    await client.query<{ revision: number; document: CreativeDocument }>(
      `select revision, document from creative_world where account_id=$1 and dossier_id=$2${options.lock ? ' for update' : ''}`,
      [account, dossier],
    )
  ).rows[0];
  if (!found) {
    const title = (
      await client.query<{ title: string }>('select title from dossier where account_id=$1 and id=$2', [account, dossier])
    ).rows[0]?.title ?? '世界观';
    const document = emptyDocument(title);
    await client.query(
      'insert into creative_world(account_id,dossier_id,revision,document) values($1,$2,1,$3::jsonb)',
      [account, dossier, JSON.stringify(document)],
    );
    return { revision: 1, document, latestVersion: 0 };
  }
  const latestVersion = Number(
    (
      await client.query<{ n: string | null }>(
        'select max(n)::text n from creative_version where account_id=$1 and dossier_id=$2',
        [account, dossier],
      )
    ).rows[0]?.n ?? 0,
  );
  const document = await reconcileImportState(client, { account, dossier }, found.document);
  return { revision: found.revision, document, latestVersion };
}

async function versionsOf(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<WorldVersion[]> {
  const rows = (
    await client.query<{ n: number; at: Date; summary: string; changes: number }>(
      'select n, at, summary, changes from creative_version where account_id=$1 and dossier_id=$2 order by n',
      [account, dossier],
    )
  ).rows;
  return rows.map((row) => ({ n: Number(row.n), at: row.at.toISOString(), summary: row.summary, changes: Number(row.changes) }));
}

export async function checkOf(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<CheckRun | null> {
  const row = (
    await client.query<{ run: CheckRun }>(
      'select run from creative_check where account_id=$1 and dossier_id=$2',
      [account, dossier],
    )
  ).rows[0];
  return row ? row.run : null;
}

export async function saveCheck(
  client: pg.PoolClient,
  input: { account: string; dossier: string; revision: number },
  run: CheckRun,
): Promise<void> {
  await client.query(
    `insert into creative_check(account_id,dossier_id,revision,run) values($1,$2,$3,$4::jsonb)
     on conflict (account_id,dossier_id)
     do update set revision=excluded.revision, run=excluded.run, at=now()`,
    [input.account, input.dossier, input.revision, JSON.stringify(run)],
  );
}

/** 快照：打开、刷新、重连都先取它。带 version 时只读历史版本。 */
export async function readSnapshot(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  version?: number | null,
): Promise<WorldSnapshot> {
  const state = await loadWorld(client, account, dossier);
  let document = state.document;
  let revision = state.revision;
  if (typeof version === 'number') {
    const row = (
      await client.query<{ world: CreativeDocument; changes: number; revision: number }>(
        'select world, changes, revision from creative_version where account_id=$1 and dossier_id=$2 and n=$3',
        [account, dossier, version],
      )
    ).rows[0];
    if (!row) throw new ApiFailure('VERSION_NOT_FOUND', 404, '没有这个版本。');
    document = row.world;
    // 历史快照报的是「当时那一版的修订号」，不是版本号。
    revision = Number(row.revision) || revision;
  }
  const legs = await buildLegs(client, { account, dossier, document });
  const check = typeof version === 'number' ? null : await checkOf(client, account, dossier);
  const versions = await versionsOf(client, account, dossier);
  const cursor = await cursorOf(client, { account, dossier });
  const latest = versions.length ? versions[versions.length - 1] : null;
  // 草稿上还没确认成版本的改动：按「上次存版本时的修订号」算，不是按版本号。
  const latestRevision = latest
    ? Number(
        (
          await client.query<{ revision: number }>(
            'select revision from creative_version where account_id=$1 and dossier_id=$2 and n=$3',
            [account, dossier, latest.n],
          )
        ).rows[0]?.revision ?? 0,
      )
    : 0;
  // MVP-2：人物头像用选用版本的立绘（后端直接填好，前端不自己拼）
  if (typeof version !== 'number') {
    const portraits = await selectedPortraits(client, account, dossier);
    if (portraits.size)
      for (const entity of document.entities) {
        const portrait = portraits.get(entity.id);
        if (portrait) entity.person = { ...(entity.person ?? {}), portrait };
      }
  }
  // 1C：哪些作品改写了这些条目（世界观面显示「被《X》改写」）；历史版本不挂当前作品的改写。
  const overriddenBy = typeof version === 'number' ? new Map() : await overridesOfWorks(client, account, dossier);
  const items = [
    document.entities,
    document.relations,
    document.events,
    document.modes,
    document.rules,
    document.edits,
  ] as unknown as Record<string, unknown>[][];
  for (const list of items)
    for (const item of list) {
      const owners = overriddenBy.get(String(item.id));
      if (owners) item.overriddenBy = owners;
    }
  return {
    world: worldOf(dossier, document, revision, {
      latest: latest?.n ?? 0,
      draftChanges: Math.max(0, state.revision - latestRevision),
    }),
    entities: document.entities,
    relations: document.relations,
    events: document.events,
    modes: document.modes,
    rules: document.rules,
    edits: document.edits,
    legs,
    proposals: document.proposals.filter((item) => item.status === 'pending' || item.status === 'deferred'),
    check,
    versions,
    cursor,
  };
}

export type OpsOutcome = {
  revision: number;
  applied: CreativeAppliedOp[];
  check: CheckRun;
  legs: CreativeRouteLeg[];
  document: CreativeDocument;
  redraws: { legId: string; hint?: string }[];
  missingRoutes: CreativeRouteLeg[];
};

export type ApplyRequest = {
  baseRevision?: number;
  ops: import('@reinlab/contracts').CreativeOp[];
  actor: 'user' | 'agent';
};

/** 一个批次：原子、revision +1、自动检查、推事件。 */
export async function applyBatch(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  request: ApplyRequest,
): Promise<OpsOutcome> {
  const state = await loadWorld(client, account, dossier, { lock: true });
  if (request.baseRevision !== undefined && request.baseRevision >= 0 && request.baseRevision !== state.revision) {
    const snapshot = await readSnapshot(client, account, dossier);
    throw new ApiFailure(
      'REVISION_STALE',
      409,
      '这个世界观刚被改过，请按最新状态再来一次。',
      { revision: state.revision, snapshot },
    );
  }
  const outcome = applyOps(state.document, request.ops, { actor: request.actor });
  const revision = state.revision + 1;
  const now = new Date().toISOString();

  await client.query(
    'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
    [account, dossier, revision, JSON.stringify(outcome.next)],
  );
  await syncEditEdges(client, { account, dossier, revision }, outcome.next);

  for (const applied of outcome.applied)
    await client.query(
      `insert into creative_op(account_id,dossier_id,revision,actor,op,summary,detail)
       values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [account, dossier, revision, applied.actor, applied.op, applied.summary, JSON.stringify(applied)],
    );

  const legs = await buildLegs(client, { account, dossier, document: outcome.next });
  // 存下的是这份世界观「当前的」检查结果，必须是全量：只留本批碰过的事件，会把别处还在的冲突冲掉
  // （runCheck 本来就全算一遍再筛，筛掉不省算力）。
  const check = runCheck({ document: outcome.next, legs, revision, now });
  await saveCheck(client, { account, dossier, revision }, check);
  // 手绘、重画、确认推断路线，都会让某条 leg 换样：按契约 §3 推一条完整的 RouteLeg。
  const touchedLegIds = legsTouchedBy(state.document, outcome.applied);
  const legEvents = legs
    .filter((leg) => touchedLegIds.has(leg.id))
    .map((leg) => ({ type: 'creative.leg', data: leg }));
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.op', data: { revision, applied: outcome.applied } },
    ...legEvents,
    { type: 'creative.check', data: check },
  ]);

  return {
    revision,
    applied: outcome.applied,
    check,
    legs,
    document: outcome.next,
    redraws: outcome.redraws,
    missingRoutes: legs.filter((leg) => leg.kind === 'none'),
  };
}

/** 这一批里被改到的 leg（手绘、重画、确认 route 提议）。 */
function legsTouchedBy(
  previous: CreativeDocument,
  applied: CreativeAppliedOp[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of applied) {
    if (item.op === 'route.draw' || item.op === 'route.redraw') ids.add(item.legId);
    if (item.op === 'proposal.decide' && item.decision === 'accepted') {
      const proposal = previous.proposals.find((candidate) => candidate.id === item.id);
      if (!proposal || proposal.kind !== 'route') continue;
      const inferred = previous.inferredRoutes.find((route) => route.proposalId === proposal.id);
      if (inferred) ids.add(inferred.legId);
      for (const op of item.ops ?? proposal.ops)
        if (op.op === 'route.draw') ids.add(op.legId);
    }
  }
  return ids;
}

/** 手动「全部重查」：全量算一遍，结果照常记账。 */
export async function recheck(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<{ check: CheckRun; revision: number }> {
  const state = await loadWorld(client, account, dossier, { lock: true });
  const now = new Date().toISOString();
  const legs = await buildLegs(client, { account, dossier, document: state.document });
  const check = runCheck({ document: state.document, legs, revision: state.revision, now });
  await saveCheck(client, { account, dossier, revision: state.revision }, check);
  await appendEvents(client, { account, dossier }, [{ type: 'creative.check', data: check }]);
  return { check, revision: state.revision };
}

export async function readTracks(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  range: TrackRange,
  entityIds?: string[],
): Promise<{ tracks: ReturnType<typeof buildTracks>; legs: CreativeRouteLeg[] }> {
  const state = await loadWorld(client, account, dossier);
  const legs = await buildLegs(client, { account, dossier, document: state.document });
  return { tracks: buildTracks(state.document, legs, range, entityIds), legs };
}

/** 存一个版本（1A 只要存得下取得到；界面在 1C）。 */
export async function saveVersion(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  summary: string,
): Promise<WorldVersion> {
  const state = await loadWorld(client, account, dossier, { lock: true });
  const versions = await versionsOf(client, account, dossier);
  const previous = (
    await client.query<{ n: number; revision: number }>(
      'select n, revision from creative_version where account_id=$1 and dossier_id=$2 order by n desc limit 1',
      [account, dossier],
    )
  ).rows[0];
  const n = (versions.length ? versions[versions.length - 1].n : 0) + 1;
  // 「改了 3 条」按设定条目的差异数算（契约 §6.5），不是操作条数
  const previousWorld = previous
    ? (
        await client.query<{ world: CreativeDocument }>(
          'select world from creative_version where account_id=$1 and dossier_id=$2 and n=$3',
          [account, dossier, previous.n],
        )
      ).rows[0]?.world
    : undefined;
  const changes = diffDocuments(previousWorld ?? emptyDocument(state.document.title), state.document).length;
  const label = summary.trim().slice(0, 300) || `版本 ${n}`;
  const inserted = (
    await client.query<{ at: Date }>(
      `insert into creative_version(account_id,dossier_id,n,summary,changes,revision,world)
       values($1,$2,$3,$4,$5,$6,$7::jsonb) returning at`,
      [account, dossier, n, label, changes, state.revision, JSON.stringify(state.document)],
    )
  ).rows[0];
  const version: WorldVersion = { n, at: inserted.at.toISOString(), summary: label, changes };
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.op', data: { revision: state.revision, applied: [] } },
    { type: 'creative.version', data: version },
  ]);
  return version;
}

/** 哪些作品对哪些条目做了本作品改写（世界观面要看「被谁改写」）。 */
async function overridesOfWorks(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<Map<string, { workId: string; workTitle: string }[]>> {
  const rows = (
    await client.query<{ work_id: string; title: string; document: { setting?: { overrides?: { itemId: string }[] } } }>(
      'select work_id, document->>\'title\' title, document from creative_work where account_id=$1 and dossier_id=$2',
      [account, dossier],
    )
  ).rows;
  const map = new Map<string, { workId: string; workTitle: string }[]>();
  for (const row of rows)
    for (const override of row.document.setting?.overrides ?? []) {
      const list = map.get(override.itemId) ?? [];
      if (!list.some((item) => item.workId === row.work_id))
        list.push({ workId: row.work_id, workTitle: row.title });
      map.set(override.itemId, list);
    }
  return map;
}

/** 单个版本（带这一版改了哪些条目）。 */
export async function readVersion(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  n: number,
): Promise<WorldVersion & { items: ItemChange[] }> {
  await requireCreativeDossier(client, account, dossier);
  const current = (
    await client.query<{ n: number; at: Date; summary: string; changes: number; world: CreativeDocument }>(
      'select n, at, summary, changes, world from creative_version where account_id=$1 and dossier_id=$2 and n=$3',
      [account, dossier, n],
    )
  ).rows[0];
  if (!current) throw new ApiFailure('VERSION_NOT_FOUND', 404, '没有这个版本。');
  const previous = n > 1
    ? (
        await client.query<{ world: CreativeDocument }>(
          'select world from creative_version where account_id=$1 and dossier_id=$2 and n=$3',
          [account, dossier, n - 1],
        )
      ).rows[0]?.world
    : undefined;
  return {
    n: Number(current.n),
    at: current.at.toISOString(),
    summary: current.summary,
    changes: Number(current.changes),
    items: diffDocuments(previous ?? emptyDocument(current.world.title), current.world),
  };
}

/** 草稿相对最新版本的差异（存版本前先看）。 */
export async function readDraftDiff(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<{ items: ItemChange[] }> {
  const state = await loadWorld(client, account, dossier);
  const latest = (
    await client.query<{ world: CreativeDocument }>(
      'select world from creative_version where account_id=$1 and dossier_id=$2 order by n desc limit 1',
      [account, dossier],
    )
  ).rows[0]?.world;
  return { items: diffDocuments(latest ?? emptyDocument(state.document.title), state.document) };
}

/** 单次取回路网几何的要素上限：超了就 422，让页面按 bbox 取一块（1A 遗留 4）。 */
export const NETWORK_GEOJSON_MAX = 50_000;

export type NetworkFeature = {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] } | null;
  properties: {
    kind: string;
    roadClass: string | null;
    name: string | null;
    network: string;
    oneway: boolean;
    editId: string | null;
    validFrom: number | null;
    validTo: number | null;
  };
};

/**
 * 路网的几何（只读）：架空世界（Azgaar）没有底图可看，页面要自己把路画出来。
 * 支持 bbox 只取一块；不传就取整个世界观。
 */
export async function readNetworkGeoJson(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  bbox: [number, number, number, number] | null,
): Promise<{ type: 'FeatureCollection'; features: NetworkFeature[] }> {
  await loadWorld(client, account, dossier);
  const filter = bbox
    ? 'and geom && st_makeenvelope($3,$4,$5,$6,4326)'
    : '';
  const params: unknown[] = bbox ? [account, dossier, bbox[0], bbox[1], bbox[2], bbox[3]] : [account, dossier];
  const counted = (
    await client.query<{ n: string }>(
      `select count(*)::text n from creative_edge where account_id=$1 and dossier_id=$2 ${filter}`,
      params,
    )
  ).rows[0];
  const total = Number(counted?.n ?? 0);
  if (total > NETWORK_GEOJSON_MAX)
    throw new ApiFailure(
      'NETWORK_TOO_MANY_FEATURES',
      422,
      `这一块有 ${total} 段路，超过单次上限 ${NETWORK_GEOJSON_MAX}，缩小 bbox 再取。`,
    );
  if (total === 0) return { type: 'FeatureCollection', features: [] };
  const rows = (
    await client.query<{
      kind: string;
      road_class: string | null;
      name: string | null;
      network: string;
      oneway: boolean;
      edit_id: string | null;
      valid_from: number | null;
      valid_to: number | null;
      coordinates: [number, number][];
    }>(
      `select kind, road_class, name, network, oneway, edit_id, valid_from, valid_to,
              st_asgeojson(geom)::json -> 'coordinates' coordinates
         from creative_edge where account_id=$1 and dossier_id=$2 ${filter}
        order by id`,
      params,
    )
  ).rows;
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: row.coordinates },
      properties: {
        kind: row.kind,
        roadClass: row.road_class,
        name: row.name,
        network: row.network,
        oneway: row.oneway,
        editId: row.edit_id,
        validFrom: row.valid_from,
        validTo: row.valid_to,
      },
    })),
  };
}

export type NetworkImportRequest =
  | { source: 'osm'; bbox: [number, number, number, number] }
  | { source: 'azgaar'; assetId: string };

export type NetworkImportDeps = {
  /** Overpass 取数通道（测试注入）。 */
  overpass?: OverpassTransport;
  /** 导入完成/失败以后把事件推给页面（同一份库，SSE 自己会读到）。 */
  onProgress?: (status: import('@reinlab/contracts').NetworkStatus) => void;
};

/** 导入开始：先把状态写成 importing，再异步取数（页面能立刻看到进度）。 */
export async function beginNetworkImport(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  request: NetworkImportRequest,
): Promise<{ revision: number; document: CreativeDocument }> {
  const state = await loadWorld(client, account, dossier, { lock: true });
  const next: CreativeDocument = {
    ...state.document,
    network: {
      ...state.document.network,
      state: 'importing',
      error: undefined,
    },
    networkUpdatedAt: new Date().toISOString(),
  };
  const revision = state.revision + 1;
  await client.query(
    'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
    [account, dossier, revision, JSON.stringify(next)],
  );
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.network', data: next.network },
  ]);
  return { revision, document: next };
}

export async function finishNetworkImport(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  result:
    | { ok: true; source: 'osm' | 'azgaar'; edges: number; bbox?: [number, number, number, number]; extra?: Record<string, unknown> }
    | { ok: false; error: string },
): Promise<void> {
  const state = await loadWorld(client, account, dossier, { lock: true });
  const now = new Date().toISOString();
  const edges = result.ok ? result.edges : await edgeCount(client, { account, dossier });
  const sources = result.ok
    ? [
        ...state.document.network.sources.filter((item) => item.kind !== result.source),
        {
          kind: result.source,
          ...(result.bbox ? { bbox: result.bbox } : {}),
          edges: result.edges,
          importedAt: now,
        },
      ]
    : state.document.network.sources;
  const next: CreativeDocument = {
    ...state.document,
    network: result.ok
      ? { state: edges > 0 ? 'ready' : 'none', sources }
      : { state: 'failed', sources: state.document.network.sources, error: result.error },
    networkUpdatedAt: now,
  };
  const revision = state.revision + 1;
  await client.query(
    'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
    [account, dossier, revision, JSON.stringify(next)],
  );
  // 路网一变，原来的结论就不作数了：当场按新路网重算一遍检查，别让页面看着旧结论。
  const legs = await buildLegs(client, { account, dossier, document: next });
  const check = runCheck({ document: next, legs, revision, now });
  await saveCheck(client, { account, dossier, revision }, check);
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.network', data: next.network },
    { type: 'creative.check', data: check },
  ]);
}

/** 后台导入的实际动作：取数 → 写边表 → 更新状态。失败就记 failed，不伪造成功。 */
export async function runNetworkImport(
  database: import('../db/database').Database,
  account: string,
  dossier: string,
  request: NetworkImportRequest,
  deps: NetworkImportDeps = {},
): Promise<void> {
  try {
    const payload = await database.withAccount(account, async (client) => {
      if (request.source === 'osm') {
        const rows = await fetchOsmEdges(request.bbox, deps.overpass);
        return { rows, source: 'osm' as const, bbox: request.bbox };
      }
      const asset = (
        await client.query<{ content: string }>(
          'select content from creative_asset where id=$1 and account_id=$2 and dossier_id=$3',
          [request.assetId, account, dossier],
        )
      ).rows[0];
      if (!asset) throw new ApiFailure('ASSET_NOT_FOUND', 404, '找不到这份上传文件。');
      return { content: asset.content, source: 'azgaar' as const };
    });
    await database.withAccount(account, async (client) => {
      const state = await loadWorld(client, account, dossier);
      if (payload.source === 'osm') {
        await client.query("delete from creative_edge where account_id=$1 and dossier_id=$2 and kind='osm'", [account, dossier]);
        await insertEdges(client, { account, dossier, revision: state.revision }, payload.rows);
        await finishNetworkImport(client, account, dossier, {
          ok: true, source: 'osm', edges: payload.rows.length, bbox: payload.bbox,
        });
      } else {
        const imported = await importAzgaar(client, { account, dossier, revision: state.revision, content: payload.content });
        await finishNetworkImport(client, account, dossier, {
          ok: true, source: 'azgaar', edges: imported.edges,
          extra: { routes: imported.routes, skipped: imported.skipped },
        });
      }
    });
  } catch (error) {
    const failure = error instanceof ApiFailure ? error : new ApiFailure('NETWORK_IMPORT_FAILED', 503, '路网导入失败。');
    await database
      .withAccount(account, async (client) => {
        await finishNetworkImport(client, account, dossier, { ok: false, error: failure.message });
      })
      .catch(() => undefined);
  }
}

/** 轨道查询的重试包装：SSE 或页面拖动时共用。 */
export function rangeOf(query: { from?: string; to?: string }): TrackRange {
  const parse = (value: string | undefined): number | null => {
    if (!value) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  return { from: parse(query.from), to: parse(query.to) };
}
