/**
 * 创作台接口（20-creative-contract.md §2）。
 *
 * 只做三件事：认身份（/v1/* 中间件已经做了）、按档案开一个事务、把服务层结果原样回给页面。
 * 判定、路程、时间换算、修法全在 creative/ 里算，这里不推断。
 */

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { JsonValue, CreativeOp } from '@reinlab/contracts';
import { ApiFailure } from './errors';
import { mutate, type ApiEnv } from './context';
import type { Database } from '../db/database';
import { AssetBody, ImportBody, OpsBody, VersionBody } from '../creative/schema';
import {
  applyBatch,
  beginNetworkImport,
  loadWorld,
  readSnapshot,
  readTracks,
  rangeOf,
  recheck,
  runNetworkImport,
  saveVersion,
  type OpsOutcome,
} from '../creative/service';
import { editsGeoJson } from '../creative/edits';
import { readEvents } from '../creative/events';
import { runInference, type RouteInferenceDeps } from '../creative/route-agent';
import { validateBbox, type OverpassTransport } from '../creative/network';

/** 只读按钮（全部重查）不带正文，也走 mutate 拿幂等记账。 */
const EmptyBody = z.object({}).strict();

export type CreativeApiOptions = {
  /** AI 推断路线的模型通道；没配就只记「没开」，不伪造路线。 */
  routeInference?: RouteInferenceDeps;
  /** Overpass 取数通道（测试注入）。 */
  overpass?: OverpassTransport;
};

/** 同一条腿只跑一次推断：页面连点、批量改时间都不会叠着跑。 */
const inFlight = new Set<string>();

export function registerCreativeApi(app: Hono<ApiEnv>, database: Database, options: CreativeApiOptions = {}) {
  const scheduleInference = (account: string, dossier: string, outcome: OpsOutcome) => {
    const deps = options.routeInference;
    if (!deps) return;
    const jobs = [
      ...outcome.redraws,
      ...outcome.missingRoutes.slice(0, 3).map((leg) => ({ legId: leg.id })),
    ].filter((job, index, list) => list.findIndex((item) => item.legId === job.legId) === index);
    const fresh = jobs.filter((job) => {
      const key = `${dossier}:${job.legId}`;
      if (inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    });
    if (!fresh.length) return;
    void runInference(database, deps, account, dossier, fresh)
      .catch((error) => {
        console.error(
          JSON.stringify({
            code: 'CREATIVE_INFERENCE_FAILED',
            message: String((error as Error)?.message ?? error).slice(0, 200),
          }),
        );
      })
      .finally(() => {
        for (const job of fresh) inFlight.delete(`${dossier}:${job.legId}`);
      });
  };

  /** 快照：打开、刷新、重连都先取它；带 version 只读历史版本。 */
  app.get('/v1/creative/worlds/:dossierId', async (c) => {
    const version = c.req.query('version');
    const parsed = version === undefined ? null : Number(version);
    if (parsed !== null && (!Number.isSafeInteger(parsed) || parsed < 1))
      throw new ApiFailure('INVALID_INPUT', 400, '版本号要从 1 起。');
    return database.withAccount(c.get('accountId'), async (client) =>
      c.json((await readSnapshot(client, c.get('accountId'), c.req.param('dossierId'), parsed)) as unknown as JsonValue),
    );
  });

  /** 改：一个原子批次，revision +1，然后自动做一次（增量）检查。 */
  app.post('/v1/creative/worlds/:dossierId/ops', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    let outcome: OpsOutcome | null = null;
    const response = await mutate(c, database, OpsBody, async (client, input) => {
      const result = await applyBatch(client, account, dossier, {
        ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
        ops: input.ops as CreativeOp[],
        actor: 'user',
      });
      outcome = result;
      return {
        status: 200,
        body: {
          revision: result.revision,
          applied: result.applied,
          check: result.check,
        } as unknown as JsonValue,
      };
    });
    if (outcome) scheduleInference(account, dossier, outcome);
    return response;
  });

  /** 轨迹：时间轴范围变化就取；改动以后由事件提示重取。 */
  app.get('/v1/creative/worlds/:dossierId/tracks', (c) => {
    const range = rangeOf({ from: c.req.query('from'), to: c.req.query('to') });
    const entityIds = (c.req.query('entityIds') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return database.withAccount(c.get('accountId'), async (client) => {
      const result = await readTracks(client, c.get('accountId'), c.req.param('dossierId'), range, entityIds.length ? entityIds : undefined);
      return c.json(result as unknown as JsonValue);
    });
  });

  /** 改造层：这一时刻生效的改造（新增几何、隐藏范围、改名、样式）。 */
  app.get('/v1/creative/worlds/:dossierId/edits/geojson', (c) => {
    const raw = c.req.query('t');
    const at = raw === undefined || raw === '' ? null : Number(raw);
    if (at !== null && !Number.isFinite(at)) throw new ApiFailure('INVALID_INPUT', 400, 't 要是故事时间的分钟数。');
    return database.withAccount(c.get('accountId'), async (client) =>
      c.json((await editsGeoJson(client, c.get('accountId'), c.req.param('dossierId'), at)) as unknown as JsonValue),
    );
  });

  /** 全部重查：手动按钮。 */
  app.post('/v1/creative/worlds/:dossierId/check', (c) =>
    mutate(c, database, EmptyBody, async (client) => {
      const result = await recheck(client, c.get('accountId'), c.req.param('dossierId'));
      return { status: 200, body: result.check as unknown as JsonValue };
    }),
  );

  /** 路网导入：异步；进度和结果走 creative.network 事件。 */
  app.post('/v1/creative/worlds/:dossierId/network/import', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    let request: z.infer<typeof ImportBody> | null = null;
    const jobId = randomUUID();
    const response = await mutate(c, database, ImportBody, async (client, input) => {
      request = input;
      // 范围（含 0.25 平方度上限）当场校验：超了直接 422，不把大范围查询发给公共 Overpass
      if (input.source === 'osm') validateBbox(input.bbox);
      if (input.source === 'azgaar') {
        const asset = (
          await client.query('select id from creative_asset where id=$1 and account_id=$2 and dossier_id=$3', [
            input.assetId, account, dossier,
          ])
        ).rows[0];
        if (!asset) throw new ApiFailure('ASSET_NOT_FOUND', 404, '找不到这份上传文件，先传 Azgaar 导出的 GeoJSON。');
      }
      await beginNetworkImport(client, account, dossier, input);
      return { status: 202, body: { jobId } as unknown as JsonValue };
    });
    const settled = request as z.infer<typeof ImportBody> | null;
    if (settled)
      void runNetworkImport(database, account, dossier, settled, {
        ...(options.overpass ? { overpass: options.overpass } : {}),
      });
    return response;
  });

  /** 上传 Azgaar 导出的 Routes GeoJSON：拿到 assetId 再导入。 */
  app.post('/v1/creative/worlds/:dossierId/assets', (c) =>
    mutate(c, database, AssetBody, async (client, input) => {
      const account = c.get('accountId');
      const dossier = c.req.param('dossierId');
      await loadWorld(client, account, dossier);
      const id = randomUUID();
      await client.query(
        `insert into creative_asset(id,account_id,dossier_id,name,format,content) values($1,$2,$3,$4,$5,$6)`,
        [id, account, dossier, input.name.slice(0, 200), input.format, input.content],
      );
      return { status: 201, body: { assetId: id } as unknown as JsonValue };
    }),
  );

  /** 存一个版本（1A 只保留，界面在 1C）。 */
  app.post('/v1/creative/worlds/:dossierId/versions', (c) =>
    mutate(c, database, VersionBody, async (client, input) => {
      const version = await saveVersion(client, c.get('accountId'), c.req.param('dossierId'), input.summary);
      return { status: 201, body: version as unknown as JsonValue };
    }),
  );

  /**
   * 事件流（契约 §3）：seq 全局递增，按 after= 续订；心跳 15 秒一次。
   * 先取快照拿 cursor，再从这里订阅；跳号就重取快照。
   */
  app.get('/v1/creative/worlds/:dossierId/stream', (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    let cursor = Number(c.req.query('after') ?? 0);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
    const started = Date.now();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const push = (payload: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          clearInterval(tick);
          clearInterval(beat);
          try {
            controller.close();
          } catch {
            /* 已经关了 */
          }
        };
        const tick = setInterval(() => {
          void (async () => {
            if (closed) return;
            if (Date.now() - started > 30 * 60_000) return finish();
            const events = await database.withAccountSnapshot(account, (client) =>
              readEvents(client, { account, dossier, after: cursor }),
            ).catch(() => null);
            if (!events) return;
            for (const event of events) {
              cursor = Math.max(cursor, event.seq);
              push(event);
            }
          })();
        }, 400);
        const beat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            closed = true;
          }
        }, 15_000);
        c.req.raw.signal.addEventListener('abort', finish);
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  });
}

