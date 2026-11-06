/**
 * 创作台接口（20-creative-contract.md §2）。
 *
 * 只做三件事：认身份（/v1/* 中间件已经做了）、按档案开一个事务、把服务层结果原样回给页面。
 * 判定、路程、时间换算、修法全在 creative/ 里算，这里不推断。
 */

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { JsonValue, CreativeOp, WorkOp } from '@reinlab/contracts';
import { ApiFailure } from './errors';
import { mutate, type ApiEnv } from './context';
import type { Database } from '../db/database';
import { AdvisorBody, AssetBody, GenerateBody, ImportBody, ImportWorkBody, OpsBody, ProposalsQuery, VersionBody, WorkCreate, WorkOpsBody } from '../creative/schema';
import { generateJobOf, readGenerateJob, runGenerate, startGenerate, stopGenerate } from '../creative/writer';
import { advise } from '../creative/advisor';
import { importJobOf, readImportJob, runImport, setImportState, startImport } from '../creative/import-job';
import {
  applyWorkBatch,
  createWork,
  exportWork,
  listProposals,
  listWorks,
  readWork,
} from '../creative/work-service';
import {
  applyBatch,
  beginNetworkImport,
  loadWorld,
  readNetworkGeoJson,
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
  /** 按章抽取的模型通道；没配就导入直接失败（不伪造抽取结果）。 */
  importExtraction?: import('../creative/import-job').ImportDeps;
  /** 写作助手（按场景生成）；没配就生成直接失败。 */
  writer?: import('../creative/writer').WriterDeps;
  /** 设定顾问；没配就直接说开不了。 */
  advisor?: import('../creative/advisor').AdvisorDeps;
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
    return database.withAccount(c.get('accountId'), async (client) => {
      // 快照类型（含 20 种 op 与提议）太大，直接交给 c.json 会把泛型推断撑爆。
      const snapshot: unknown = await readSnapshot(client, c.get('accountId'), c.req.param('dossierId'), parsed);
      return c.json(snapshot as Record<string, unknown>);
    });
  });

  /** 改：一个原子批次，revision +1，然后自动做一次（增量）检查。 */
  app.post('/v1/creative/worlds/:dossierId/ops', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    let outcome: OpsOutcome | null = null;
    // 20 种 op 的判别联合让 zod 推断太深（TS2589）：这里明确收窄成实际用的形状。
    type OpsInput = { baseRevision?: number; ops: CreativeOp[] };
    const response = await mutate<OpsInput>(c, database, OpsBody as unknown as z.ZodType<OpsInput>, async (client, input) => {
      const result = await applyBatch(client, account, dossier, {
        ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
        ops: input.ops,
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
      const result: unknown = await readTracks(
        client,
        c.get('accountId'),
        c.req.param('dossierId'),
        range,
        entityIds.length ? entityIds : undefined,
      );
      return c.json(result as Record<string, unknown>);
    });
  });

  /** 改造层：这一时刻生效的改造（新增几何、隐藏范围、改名、样式）。 */
  app.get('/v1/creative/worlds/:dossierId/edits/geojson', (c) => {
    const raw = c.req.query('t');
    const at = raw === undefined || raw === '' ? null : Number(raw);
    if (at !== null && !Number.isFinite(at)) throw new ApiFailure('INVALID_INPUT', 400, 't 要是故事时间的分钟数。');
    return database.withAccount(c.get('accountId'), async (client) => {
      const body: unknown = await editsGeoJson(client, c.get('accountId'), c.req.param('dossierId'), at);
      return c.json(body as Record<string, unknown>);
    });
  });

  /**
   * 路网几何（只读，1A 遗留 4）：架空世界没有底图路，页面得自己画。
   * `?bbox=西,南,东,北` 只取一块；不传就是整个世界观。单次要素有上限。
   */
  app.get('/v1/creative/worlds/:dossierId/network/geojson', (c) => {
    const raw = c.req.query('bbox');
    let bbox: [number, number, number, number] | null = null;
    if (raw !== undefined && raw !== '') {
      const parts = raw.split(',').map((item) => Number(item.trim()));
      if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value)))
        throw new ApiFailure('INVALID_INPUT', 400, 'bbox 要用「西,南,东,北」四个数字。');
      if (parts[0] >= parts[2] || parts[1] >= parts[3])
        throw new ApiFailure('INVALID_INPUT', 400, 'bbox 两个角写反了：西 < 东，南 < 北。');
      bbox = parts as [number, number, number, number];
    }
    return database.withAccount(c.get('accountId'), async (client) => {
      const body: unknown = await readNetworkGeoJson(client, c.get('accountId'), c.req.param('dossierId'), bbox);
      return c.json(body as Record<string, unknown>);
    });
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

  // ── 作品（1B，契约 §5.2）──────────────────────
  app.get('/v1/creative/worlds/:dossierId/works', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const works: unknown = await listWorks(client, c.get('accountId'), c.req.param('dossierId'));
      return c.json(works as Record<string, unknown>[]);
    }),
  );

  app.post('/v1/creative/worlds/:dossierId/works', (c) =>
    mutate(c, database, WorkCreate, async (client, input) => {
      const work = await createWork(client, c.get('accountId'), c.req.param('dossierId'), {
        kind: input.kind ?? 'novel',
        title: input.title,
        targetWords: input.targetWords ?? null,
      });
      return { status: 201, body: work as unknown as JsonValue };
    }),
  );

  app.get('/v1/creative/worlds/:dossierId/works/:workId', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const work: unknown = await readWork(
        client,
        c.get('accountId'),
        c.req.param('dossierId'),
        c.req.param('workId'),
      );
      return c.json(work as Record<string, unknown>);
    }),
  );

  app.post('/v1/creative/worlds/:dossierId/works/:workId/ops', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const workId = c.req.param('workId');
    type WorkOpsInput = { baseRevision?: number; ops: WorkOp[] };
    return mutate<WorkOpsInput>(
      c,
      database,
      WorkOpsBody as unknown as z.ZodType<WorkOpsInput>,
      async (client, input) => {
        const result = await applyWorkBatch(client, account, dossier, workId, {
          ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
          ops: input.ops,
        });
        return {
          status: 200,
          body: { revision: result.revision, work: result.work } as unknown as JsonValue,
        };
      },
    );
  });

  app.get('/v1/creative/worlds/:dossierId/works/:workId/export', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const format = c.req.query('format') === 'docx' ? 'docx' : 'md';
      const result = await exportWork(
        client,
        c.get('accountId'),
        c.req.param('dossierId'),
        c.req.param('workId'),
        format,
      );
      return new Response(result.body as unknown as ReadableStream | string, {
        headers: {
          'content-type': result.contentType,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
          'cache-control': 'no-store',
        },
      });
    }),
  );

  // ── 导入原文（1B，契约 §5.2）──────────────────
  app.post('/v1/creative/worlds/:dossierId/works/:workId/import', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const workId = c.req.param('workId');
    let jobId: string | null = null;
    const response = await mutate(c, database, ImportWorkBody, async (client, input) => {
      const source =
        'assetId' in input
          ? await (async () => {
              const asset = (
                await client.query<{ content: string; name: string; format: string }>(
                  'select content, name, format from creative_asset where id=$1 and account_id=$2 and dossier_id=$3',
                  [input.assetId, account, dossier],
                )
              ).rows[0];
              if (!asset) throw new ApiFailure('ASSET_NOT_FOUND', 404, '找不到这份上传的原文。');
              return { text: asset.content, title: asset.name, assetId: input.assetId };
            })()
          : { text: input.text, ...(input.title ? { title: input.title } : {}) };
      const started = await startImport(client, account, dossier, workId, source);
      jobId = started.job.id;
      return { status: 202, body: importJobOf(started.job) as unknown as JsonValue };
    });
    if (jobId && options.importExtraction)
      void runImport(database, account, dossier, jobId, options.importExtraction).catch((error) => {
        console.error(
          JSON.stringify({ code: 'CREATIVE_IMPORT_FAILED', message: String((error as Error)?.message ?? error).slice(0, 200) }),
        );
      });
    return response;
  });

  app.get('/v1/creative/worlds/:dossierId/imports/:jobId', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const job = await readImportJob(client, c.get('accountId'), c.req.param('dossierId'), c.req.param('jobId'));
      const body: unknown = importJobOf(job);
      return c.json(body as Record<string, unknown>);
    }),
  );

  for (const action of ['pause', 'resume'] as const)
    app.post(`/v1/creative/worlds/:dossierId/imports/:jobId/${action}`, async (c) => {
      const account = c.get('accountId');
      const dossier = c.req.param('dossierId');
      let jobId: string | null = null;
      const response = await mutate(c, database, EmptyBody, async (client) => {
        const job = await setImportState(client, account, dossier, c.req.param('jobId'), action);
        jobId = job.id;
        return { status: 200, body: importJobOf(job) as unknown as JsonValue };
      });
      if (action === 'resume' && jobId && options.importExtraction)
        void runImport(database, account, dossier, jobId, options.importExtraction).catch(() => undefined);
      return response;
    });

  // ── 生成与顾问（1B，契约 §5.2）──────────────
  app.post('/v1/creative/worlds/:dossierId/works/:workId/generate', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const workId = c.req.param('workId');
    let jobId: string | null = null;
    const response = await mutate(c, database, GenerateBody, async (client, input) => {
      const job = await startGenerate(client, account, dossier, workId, {
        sceneIds: input.sceneIds,
        mode: input.mode ?? 'draft',
        ...(input.hint ? { hint: input.hint } : {}),
        ...(input.range ? { range: input.range } : {}),
      });
      jobId = job.id;
      return { status: 202, body: generateJobOf(job) as unknown as JsonValue };
    });
    if (jobId)
      void runGenerate(database, options.writer ?? {}, account, dossier, jobId).catch((error) => {
        console.error(
          JSON.stringify({ code: 'CREATIVE_GENERATE_FAILED', message: String((error as Error)?.message ?? error).slice(0, 200) }),
        );
      });
    return response;
  });

  app.get('/v1/creative/worlds/:dossierId/generate/:jobId', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const job = await readGenerateJob(client, c.get('accountId'), c.req.param('dossierId'), c.req.param('jobId'));
      const body: unknown = generateJobOf(job);
      return c.json(body as Record<string, unknown>);
    }),
  );

  app.post('/v1/creative/worlds/:dossierId/generate/:jobId/stop', (c) =>
    mutate(c, database, EmptyBody, async (client) => {
      const job = await stopGenerate(client, c.get('accountId'), c.req.param('dossierId'), c.req.param('jobId'));
      return { status: 200, body: generateJobOf(job) as unknown as JsonValue };
    }),
  );

  /** 设定顾问：一句话提一条设定（加人物、加规则……），先自己跑硬检查再交。 */
  app.post('/v1/creative/worlds/:dossierId/advisor', (c) =>
    mutate(c, database, AdvisorBody, async (client, input) => {
      const result = await advise(client, c.get('accountId'), c.req.param('dossierId'), options.advisor ?? {}, input.query);
      return {
        status: 200,
        body: { proposals: result.proposals, cost: result.cost } as unknown as JsonValue,
      };
    }),
  );

  /** 待确认提议分页（1B 提议多，单独取）。 */
  app.get('/v1/creative/worlds/:dossierId/proposals', (c) => {
    const parsed = ProposalsQuery.safeParse({
      ...(c.req.query('kind') ? { kind: c.req.query('kind') } : {}),
      ...(c.req.query('batchId') ? { batchId: c.req.query('batchId') } : {}),
      ...(c.req.query('doubt') ? { doubt: c.req.query('doubt') } : {}),
      ...(c.req.query('status') ? { status: c.req.query('status') } : {}),
      ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
      ...(c.req.query('limit') ? { limit: c.req.query('limit') } : {}),
    });
    if (!parsed.success) throw new ApiFailure('INVALID_INPUT', 400, '筛选条件不符合要求。');
    const query = parsed.data;
    const cursor = query.cursor === undefined ? 0 : Number(query.cursor);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1)
      throw new ApiFailure('INVALID_INPUT', 400, 'cursor 和 limit 要是正整数。');
    return database.withAccount(c.get('accountId'), async (client) => {
      const page: unknown = await listProposals(client, c.get('accountId'), c.req.param('dossierId'), {
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.batchId ? { batchId: query.batchId } : {}),
        ...(query.doubt ? { doubt: query.doubt === 'true' } : {}),
        ...(query.status ? { status: query.status } : {}),
        cursor,
        limit,
      });
      return c.json(page as Record<string, unknown>);
    });
  });

  /** 存一个版本（1A 只保留，界面在 1C）。 */
  app.post('/v1/creative/worlds/:dossierId/versions', (c) =>
    mutate(c, database, VersionBody, async (client, input) => {
      const version = await saveVersion(client, c.get('accountId'), c.req.param('dossierId'), input.summary ?? '');
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

