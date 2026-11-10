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
import {
  AdvisorBody,
  AssetSelectedBody,
  AssetVersionBody,
  AssetBody,
  GenerateBody,
  ImpactScanBody,
  ImportBody,
  ImportWorkBody,
  OpsBody,
  ProposalsQuery,
  VersionBody,
  WorkCreate,
  WorkOpsBody,
} from '../creative/schema';
import { impactOf } from '../creative/impact';
import { beginScan, runScan, type ScanDeps } from '../creative/scan';
import { judgeRules, type JudgeDeps } from '../creative/rule-judge';
import { previewOf } from '../creative/preview';
import { shotsOfScene } from '../creative/shots';
import { appendEvents } from '../creative/events';
import type { WorkDocument } from '../creative/work';
import { readAsset, retryUnsaved, runAssetVersion, selectVersion, startAssetVersion, stopAssetVersion } from '../creative/asset-service';
import { readImage, saveImage } from '../creative/image/store';
import { describeFile, describeVideoFile, selectedVersions } from '../creative/asset-query';
import type { ImageProvider } from '../creative/image/provider';
import { cutScene, runTake, selectTake, startTake } from '../creative/takes';
import { clearSites, listSites, openBrowser } from '../creative/browser';
import type { VideoDeps } from '../creative/video/pipeline';
import { readEffectiveSnapshot } from '../creative/work-service';
import { generateJobOf, readGenerateJob, runGenerate, startGenerate, stopGenerate } from '../creative/writer';
import { advise } from '../creative/advisor';
import { importJobOf, previewImport, readImportJob, runImport, setImportState, startImport } from '../creative/import-job';
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
  readDraftDiff,
  readSnapshot,
  readTracks,
  rangeOf,
  recheck,
  runNetworkImport,
  saveVersion,
  readVersion,
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
  /** 1C：扫正文的模型通道；没配就扫不了（照实说）。 */
  impactScan?: ScanDeps;
  /** 29 号：自然语言规则判定用的模型通道。 */
  ruleJudge?: JudgeDeps;
  /** 素材浏览器（契约 §14.8）。 */
  browser?: import('../creative/browser').BrowserDeps;
  /** MVP-3 3B：出片平台（Seedance + TOS + ffmpeg）。 */
  video?: VideoDeps;
  /** MVP-2：出图的平台（没配时出图返回明确错误，不伪造）。 */
  imageProvider?: ImageProvider;
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
    let pendingGenerates: string[] = [];
    type WorkOpsInput = { baseRevision?: number; ops: WorkOp[] };
    const response = await mutate<WorkOpsInput>(
      c,
      database,
      WorkOpsBody as unknown as z.ZodType<WorkOpsInput>,
      async (client, input) => {
        const result = await applyWorkBatch(client, account, dossier, workId, {
          ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
          ops: input.ops,
        });
        pendingGenerates = result.pendingGenerates;
        return {
          status: 200,
          body: { revision: result.revision, work: result.work } as unknown as JsonValue,
        };
      },
    );
    // 1C：sync.suggest 起的生成任务在事务外跑
    for (const jobId of pendingGenerates)
      void runGenerate(database, options.writer ?? {}, account, dossier, jobId).catch(() => undefined);
    return response;
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
  /** 只分章、不抽取、不落库：导入向导第一步先给作者看分章结果。 */
  app.post('/v1/creative/worlds/:dossierId/works/:workId/import/preview', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const workId = c.req.param('workId');
    const parsed = ImportWorkBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new ApiFailure('INVALID_INPUT', 400, '请求字段不符合要求，请检查输入。');
    const input = parsed.data;
    const text =
      'assetId' in input
        ? await database.withAccount(account, async (client) => {
            const asset = (
              await client.query<{ content: string }>(
                'select content from creative_asset where id=$1 and account_id=$2 and dossier_id=$3',
                [input.assetId, account, dossier],
              )
            ).rows[0];
            if (!asset) throw new ApiFailure('ASSET_NOT_FOUND', 404, '找不到这份上传的原文。');
            return asset.content;
          })
        : input.text;
    return database.withAccount(account, async (client) => {
      const preview: unknown = await previewImport(client, account, dossier, workId, { text });
      return c.json(preview as Record<string, unknown>);
    });
  });

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

  // ── 1C：版本差异、影响清单、按作品看 ─────────────
  /** 草稿相对最新版本的差异（存版本前先看）。注意要在 /versions/:n 之前匹配。 */
  app.get('/v1/creative/worlds/:dossierId/versions/draft', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const body: unknown = await readDraftDiff(client, c.get('accountId'), c.req.param('dossierId'));
      return c.json(body as Record<string, unknown>);
    }),
  );

  app.get('/v1/creative/worlds/:dossierId/versions/:n', (c) => {
    const n = Number(c.req.param('n'));
    if (!Number.isSafeInteger(n) || n < 1) throw new ApiFailure('INVALID_INPUT', 400, '版本号要从 1 起。');
    return database.withAccount(c.get('accountId'), async (client) => {
      const body: unknown = await readVersion(client, c.get('accountId'), c.req.param('dossierId'), n);
      return c.json(body as Record<string, unknown>);
    });
  });

  app.get('/v1/creative/worlds/:dossierId/impact', (c) => {
    const from = Number(c.req.query('from') ?? 1);
    const to = Number(c.req.query('to') ?? 0);
    if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to < 1)
      throw new ApiFailure('INVALID_INPUT', 400, 'from / to 要是正整数版本号。');
    return database.withAccount(c.get('accountId'), async (client) => {
      const body: unknown = await impactOf(client, c.get('accountId'), c.req.param('dossierId'), from, to);
      return c.json(body as Record<string, unknown>);
    });
  });

  app.post('/v1/creative/worlds/:dossierId/impact/scan', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    let scan: { from: number; to: number } | null = null;
    const response = await mutate(c, database, ImpactScanBody, async (client, input) => {
      const document = await beginScan(client, account, dossier, input.from, input.to);
      scan = { from: input.from, to: input.to };
      return { status: 202, body: document as unknown as JsonValue };
    });
    const started = scan as { from: number; to: number } | null;
    if (started)
      void runScan({ db: database, ...(options.impactScan ?? {}) }, account, dossier, started.from, started.to).catch((error) => {
        console.error(
          JSON.stringify({ code: 'CREATIVE_SCAN_FAILED', message: String((error as Error)?.message ?? error).slice(0, 200) }),
        );
      });
    return response;
  });

  // ── MVP-3：白模与镜头（契约 §13.4）──────────────────
  app.get('/v1/creative/worlds/:dossierId/places/:placeId/whitebox', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const state = await loadWorld(client, c.get('accountId'), c.req.param('dossierId'));
      const placeId = c.req.param('placeId');
      const boxes = (state.document.whiteboxes ?? []) as { placeId: string; version: number; prims: unknown[]; updatedAt: string }[];
      const wanted = c.req.query('version');
      const box = wanted
        ? boxes.find((item) => item.placeId === placeId && item.version === Number(wanted))
        : boxes.filter((item) => item.placeId === placeId).sort((a, b) => a.version - b.version).at(-1);
      const body = box ?? { placeId, version: 0, prims: [], updatedAt: new Date(0).toISOString() };
      return c.json(body as Record<string, unknown>);
    }),
  );

  app.get('/v1/creative/worlds/:dossierId/works/:workId/scenes/:sceneId/shots', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const account = c.get('accountId');
      const dossier = c.req.param('dossierId');
      const state = await loadWorld(client, account, dossier);
      const workRow = (
        await client.query<{ document: WorkDocument }>(
          'select document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
          [account, dossier, c.req.param('workId')],
        )
      ).rows[0];
      const selected = await selectedVersions(client, account, dossier);
      const sceneId = c.req.param('sceneId');
      const shots = shotsOfScene(state.document, workRow?.document ?? null, c.req.param('workId'), sceneId, selected);
      const cut = ((state.document.cuts ?? []) as Record<string, unknown>[]).find(
        (item) => item.workId === c.req.param('workId') && item.sceneId === sceneId,
      );
      const takeIds = new Set(shots.map((shot) => shot.id));
      const takes = ((state.document.takes ?? []) as { shotId?: string }[]).filter((take) => takeIds.has(String(take.shotId)));
      return c.json({ shots, takes, cut: cut ?? { workId: c.req.param('workId'), sceneId, shots: [] } });
    }),
  );

  /** 前端录的白模预演：视频 + 首帧，存成资产（和出图同一套存储）。 */
  app.post('/v1/creative/worlds/:dossierId/shots/:shotId/preview', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const shotId = c.req.param('shotId');
    const form = await c.req.parseBody();
    const video = form.video;
    const poster = form.poster;
    if (!(video instanceof File)) throw new ApiFailure('INVALID_INPUT', 400, '要带一段预演视频（字段名 video）。');
    if (video.size > 100 * 1024 * 1024) throw new ApiFailure('TOO_LARGE', 413, '预演片段太大了（上限 100 MB）。');
    const videoBytes = new Uint8Array(await video.arrayBuffer());
    const videoMime = video.type || 'video/webm';
    let posterBytes: Uint8Array | null = null;
    let posterMime = 'image/png';
    if (poster instanceof File) {
      posterBytes = new Uint8Array(await poster.arrayBuffer());
      posterMime = poster.type || 'image/png';
    }
    const result = await database.withAccount(account, async (client) => {
      const state = await loadWorld(client, account, dossier, { lock: true });
      const list = (state.document.shots ?? []) as { id: string; preview?: unknown }[];
      const shot = list.find((item) => item.id === shotId);
      if (!shot) throw new ApiFailure('SHOT_NOT_FOUND', 404, '没有这个镜头。');
      const file = await saveImage(client, { account, dossier, bytes: videoBytes, mime: videoMime, width: null, height: null });
      const posterFile = posterBytes
        ? await saveImage(client, { account, dossier, bytes: posterBytes, mime: posterMime, width: null, height: null })
        : null;
      const previewId = `pv_${file.fileId.slice(0, 12)}`;
      (shot as { preview?: unknown }).preview = {
        previewId,
        url: file.url,
        posterUrl: posterFile?.url ?? null,
        at: new Date().toISOString(),
        mime: videoMime,
      };
      const revision = state.revision + 1;
      await client.query('update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2', [
        account,
        dossier,
        revision,
        JSON.stringify(state.document),
      ]);
      // 统一推整场镜头（契约 §13.5：shots: Shot[]）
      const workId = (shot as { workId?: string }).workId ?? '';
      const sceneId = (shot as { sceneId?: string }).sceneId ?? '';
      const sceneShots = ((state.document.shots ?? []) as { workId?: string; sceneId?: string }[])
        .filter((item) => item.workId === workId && item.sceneId === sceneId)
        .sort((a, b) => Number((a as { n?: number }).n ?? 0) - Number((b as { n?: number }).n ?? 0));
      await appendEvents(client, { account, dossier }, [
        { type: 'creative.shot', data: { workId, sceneId, shots: sceneShots } },
      ]);
      return { previewId, url: file.url, posterUrl: posterFile?.url ?? null };
    });
    return c.json(result, 201);
  });

  // ── 素材浏览器（契约 §14.8）──────────────────
  app.post('/v1/creative/browser/open', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = typeof body?.url === 'string' ? body.url : '';
    if (!/^https?:\/\//.test(url)) throw new ApiFailure('INVALID_INPUT', 400, '要一个 http(s) 链接。');
    const result = await openBrowser(options.browser ?? {}, url);
    return c.json(result);
  });
  app.get('/v1/creative/browser/sites', async (c) => c.json(await listSites(options.browser ?? {})));
  app.delete('/v1/creative/browser/sites/:domain', async (c) =>
    c.json(await clearSites(options.browser ?? {}, c.req.param('domain'))),
  );
  app.delete('/v1/creative/browser/sites', async (c) => c.json(await clearSites(options.browser ?? {})));

  // ── MVP-3 3B：出片候选、选用、拼片（契约 §13.9）──────────────────
  const TakeBody = z
    .object({
      resolution: z.enum(['480p', '720p']).optional(),
      durationSec: z.number().int().min(4).max(10).optional(),
      note: z.string().max(300).optional(),
      draftTakeId: z.string().min(1).max(64).optional(),
    })
    .strict();

  app.post('/v1/creative/worlds/:dossierId/shots/:shotId/takes', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const shotId = c.req.param('shotId');
    let takeId: string | null = null;
    const response = await mutate(c, database, TakeBody, async (client, input) => {
      const take = await startTake(client, account, dossier, shotId, {
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.durationSec ? { durationSec: input.durationSec } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.draftTakeId ? { draftTakeId: input.draftTakeId } : {}),
      });
      takeId = take.id;
      return { status: 201, body: take as unknown as JsonValue };
    });
    const started = takeId as string | null;
    if (started)
      void runTake({ db: database, ...(options.video ? options.video : {}) }, account, dossier, started).catch((error) => {
        console.error(JSON.stringify({ code: 'CREATIVE_TAKE_FAILED', message: String((error as Error)?.message ?? error).slice(0, 200) }));
      });
    return response;
  });

  app.post('/v1/creative/worlds/:dossierId/takes/:takeId/retry', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const takeId = c.req.param('takeId');
    const response = await mutate(c, database, z.object({}).strict(), async () => ({ status: 200, body: { retried: true } as JsonValue }));
    void runTake({ db: database, ...(options.video ? options.video : {}) }, account, dossier, takeId).catch(() => undefined);
    return response;
  });

  app.put('/v1/creative/worlds/:dossierId/shots/:shotId/selected', (c) =>
    mutate(c, database, z.object({ takeId: z.string().min(1).max(64).nullable() }).strict(), async (client, input) => {
      const shots: unknown = await selectTake(client, c.get('accountId'), c.req.param('dossierId'), c.req.param('shotId'), input.takeId);
      return { status: 200, body: shots as JsonValue };
    }),
  );

  app.post('/v1/creative/worlds/:dossierId/scenes/:sceneId/cut', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const sceneId = c.req.param('sceneId');
    const state = await database.withAccount(account, (client) => loadWorld(client, account, dossier));
    const shot = ((state.document.shots ?? []) as { sceneId?: string; workId?: string }[]).find((item) => item.sceneId === sceneId);
    if (!shot?.workId) throw new ApiFailure('SHOT_NOT_FOUND', 404, '这一场还没有镜头。');
    const cut = await cutScene({ db: database, ...(options.video ? options.video : {}) }, account, dossier, shot.workId, sceneId);
    return c.json(cut as unknown as Record<string, unknown>);
  });

  // ── MVP-2：人物形象（契约 §12.3）──────────────────
  app.get('/v1/creative/worlds/:dossierId/entities/:entityId/asset', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const body: unknown = await readAsset(client, c.get('accountId'), c.req.param('dossierId'), c.req.param('entityId'));
      return c.json(body as Record<string, unknown>);
    }),
  );

  app.post('/v1/creative/worlds/:dossierId/entities/:entityId/asset/versions', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const entityId = c.req.param('entityId');
    let started: { versionId: string; views?: ('portrait' | 'front' | 'side' | 'back')[] } | null = null;
    const response = await mutate(c, database, AssetVersionBody, async (client, input) => {
      const result = await startAssetVersion(client, account, dossier, entityId, {
        ...(input.views ? { views: input.views } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.from ? { from: input.from } : {}),
      });
      started = { versionId: result.version.id, ...(input.views ? { views: input.views } : {}) };
      return { status: 201, body: { asset: result.asset, version: result.version } as unknown as JsonValue };
    });
    const job = started as { versionId: string; views?: ('portrait' | 'front' | 'side' | 'back')[] } | null;
    if (job)
      void runAssetVersion({ db: database, ...(options.imageProvider ? { provider: options.imageProvider } : {}) }, account, dossier, entityId, job.versionId, {
        ...(job.views ? { views: job.views } : {}),
      }).catch((error) => {
        console.error(JSON.stringify({ code: 'CREATIVE_ASSET_FAILED', message: String((error as Error)?.message ?? error).slice(0, 200) }));
      });
    return response;
  });

  app.post('/v1/creative/worlds/:dossierId/entities/:entityId/asset/versions/:versionId/retry', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const entityId = c.req.param('entityId');
    const versionId = c.req.param('versionId');
    const response = await mutate(c, database, z.object({}).strict(), async () => ({ status: 200, body: { retried: true } as JsonValue }));
    void retryUnsaved({ db: database, ...(options.imageProvider ? { provider: options.imageProvider } : {}) }, account, dossier, entityId, versionId).catch(
      () => undefined,
    );
    return response;
  });

  app.post('/v1/creative/worlds/:dossierId/entities/:entityId/asset/versions/:versionId/stop', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const body: unknown = await stopAssetVersion(
        client,
        c.get('accountId'),
        c.req.param('dossierId'),
        c.req.param('entityId'),
        c.req.param('versionId'),
      );
      return c.json(body as Record<string, unknown>);
    }),
  );

  app.put('/v1/creative/worlds/:dossierId/entities/:entityId/asset/selected', (c) =>
    mutate(c, database, AssetSelectedBody, async (client, input) => {
      const body: unknown = await selectVersion(
        client,
        c.get('accountId'),
        c.req.param('dossierId'),
        c.req.param('entityId'),
        input.versionId,
      );
      return { status: 200, body: body as JsonValue };
    }),
  );

  /** 图片文件：带登录校验；?download=1 给原图下载。 */
  app.get('/v1/creative/assets/files/:fileId', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const file = await readImage(client, { account: c.get('accountId'), fileId: c.req.param('fileId') });
      const download = c.req.query('download') === '1';
      let disposition: string | undefined;
      if (download) {
        const fileId = c.req.param('fileId');
        const info = await describeFile(client, c.get('accountId'), fileId);
        const ext = file.mime === 'image/jpeg' ? 'jpg' : file.mime === 'image/png' ? 'png' : file.mime === 'video/mp4' ? 'mp4' : 'webp';
        let name = `image-${fileId.slice(0, 8)}`;
        if (file.mime === 'video/mp4') {
          const videoInfo = await describeVideoFile(client, c.get('accountId'), fileId);
          if (videoInfo) name = videoInfo;
        } else if (info) {
          const entity = (
            await client.query<{ name: string }>(
              "select item->>'name' name from creative_world, jsonb_array_elements(document->'entities') item where dossier_id=$1 and item->>'id'=$2",
              [info.dossierId, info.entityId],
            )
          ).rows[0]?.name;
          const viewLabel: Record<string, string> = { portrait: '立绘', front: '正面', side: '侧面', back: '背面' };
          name = `${entity ?? '人物'}-${viewLabel[info.view] ?? info.view}-第${info.versionN}版`;
        }
        const ascii = `${fileId.slice(0, 8)}.${ext}`;
        disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(`${name}.${ext}`)}`;
      }
      return c.body(new Uint8Array(file.bytes), 200, {
        'content-type': file.mime,
        'cache-control': 'private, max-age=31536000, immutable',
        ...(disposition ? { 'content-disposition': disposition } : {}),
      });
    }),
  );

  /** 1D：提议采纳以后看板上的样子（只算不落库，按提议+修订缓存）。 */
  app.get('/v1/creative/worlds/:dossierId/proposals/:proposalId/preview', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const workId = c.req.query('workId') ?? null;
      const body: unknown = await previewOf(
        client,
        c.get('accountId'),
        c.req.param('dossierId'),
        c.req.param('proposalId'),
        workId,
      );
      return c.json(body as Record<string, unknown>);
    }),
  );

  /** 29 号：让模型判自然语言规则（结果标「疑似」，按事件指纹缓存，不重复花钱）。 */
  app.post('/v1/creative/worlds/:dossierId/rules/judge', async (c) => {
    const account = c.get('accountId');
    const dossier = c.req.param('dossierId');
    const result = await judgeRules(database, options.ruleJudge ?? {}, account, dossier);
    const rechecked = await database.withAccount(account, (client) => recheck(client, account, dossier));
    return c.json({
      judged: result.judged,
      skipped: result.skipped,
      cost: result.cost,
      check: rechecked.check,
    } as unknown as Record<string, unknown>);
  });

  /** 按作品看：它实际用的设定组合（check 也按组合算）。 */
  app.get('/v1/creative/worlds/:dossierId/works/:workId/effective', (c) =>
    database.withAccount(c.get('accountId'), async (client) => {
      const body = await readEffectiveSnapshot(client, c.get('accountId'), c.req.param('dossierId'), c.req.param('workId'));
      return c.json(body);
    }),
  );

  /** 设定顾问：一句话提一条设定（加人物、加规则……），先自己跑硬检查再交。 */
  app.post('/v1/creative/worlds/:dossierId/advisor', (c) =>
    mutate(c, database, AdvisorBody, async (client, input) => {
      const result = await advise(client, c.get('accountId'), c.req.param('dossierId'), options.advisor ?? {}, input.query, input.workId ? { workId: input.workId } : {});
      return {
        status: 200,
        body: {
          proposals: result.proposals,
          cost: result.cost,
          ...(result.declined ? { declined: result.declined } : {}),
        } as unknown as JsonValue,
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
      ...(c.req.query('sort') ? { sort: c.req.query('sort') } : {}),
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
        ...(query.sort ? { sort: query.sort } : {}),
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

