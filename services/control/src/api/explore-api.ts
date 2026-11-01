/**
 * 探索台页面接口（design/prd/07-explore-contract.md 第 2、3 节）。
 *
 * 页面与 Agent 走同一组服务函数：这里只解析入参、拿账户事务、提交后推事件。
 * 写请求都要求 Idempotency-Key（由 mutate 保证），同一批 ops 重放返回原收据。
 */
import { Hono } from "hono";
import type { CameraGroup, Op } from "@reinlab/contracts";
import { mutate } from "./context";
import type { ApiContext, ApiEnv } from "./context";
import type { Database } from "../db/database";
import { ApiFailure } from "./errors";
import { z } from "zod";
import {
  OpsBody,
  OfflinePackBody,
  FieldEventsBody,
  PhotoBatchBody,
  AssignBody,
  PickBody,
  AnchorBody,
  ConfirmClockBody,
  SplitClockBody,
  TravelogueBody,
  ProfileBody,
  ProfilePatchBody,
  SettingsBody,
  isIanaTimezone,
} from "../explore/schema";
import { runWeatherCheck } from "../explore/weather-check";
import {
  applyOps,
  accountTimezone,
  loadPlan,
  readPlan,
  saveTimezone,
  weatherView,
  type OpsOutcome,
} from "../explore/service";
import type { WeatherTransport } from "../explore/weather";
import type { WeatherJudge } from "../explore/weather-judge";
import type { WeatherCheckOutcome } from "../explore/weather-check";
import {
  REF_IMAGE_MAX_BYTES,
  addUploadedRef,
  readRefImage,
  removeRef,
  type ExploreStorage,
} from "../explore/refs";
import {
  createProfile,
  deleteProfile,
  listProfiles,
  updateProfile,
} from "../explore/profiles";
import { planUsage } from "../explore/usage";
import { searchPlaces } from "../explore/providers";
import {
  defaultFontFile,
  generateBook,
  prepareBook,
  readBook,
  saveSnapshot,
  SNAPSHOT_MAX_BYTES,
} from "../explore/book-job";
import { mapConfigFrom, type MapConfig } from "../explore/map-config";
import { publishAccountEvent } from "../dossier/service";
import { appendFieldEvents, listFieldEvents } from "../explore/field";
import { readRevision, snapshotRevision } from "../explore/revisions";
import {
  createBatch,
  assignPhotos,
  cropOf,
  deletePhoto,
  listPhotos,
  photoRow,
  pickPhotos,
  readBatch,
  storageUsage,
  type PhotoDeps,
} from "../explore/photos";
import type { PhotoStore } from "../explore/photo-store";
import { actualTimeline, addAnchor, cameraGroups, confirmGroup, splitGroup } from "../explore/clock";
import {
  buildComparison,
  latestTravelogue,
  registerTravelogueArtifact,
  renderExport,
  saveTravelogue,
} from "../explore/review";
import {
  createOfflinePack,
  defaultOfflineFetch,
  lightSnapshot,
  offlineGlyph,
  offlineTile,
  offlineTileJson,
  readOfflinePack,
  type OfflineFetch,
  type OfflineOptions,
} from "../explore/offline";

export type ExploreApiOptions = {
  /** 地图公开配置来源；缺省时按空配置（页面显示底图未配置）。 */
  mapConfig?: () => MapConfig;
  /** 天气取数通道；缺省用真实 fetch，测试可注入。 */
  weatherTransport?: WeatherTransport;
  /** 天气判断的模型通道；没有就只记录数据变化、不下结论。 */
  weatherJudge?: WeatherJudge;
  /** 参考图等文件的存放端口。 */
  exploreStorage?: ExploreStorage;
  /** 中文 PDF 用的字体文件（开源黑体 TTF）。 */
  pdfFontFile?: string;
  /** 离线包代取瓦片/字形的取数通道；缺省真实 fetch，测试可注入。 */
  offlineFetch?: OfflineFetch;
  /** 照片原图与派生图的存放端口；没有就明确失败，不假装存好了。 */
  photoStore?: PhotoStore;
  /** 档案所在磁盘剩余字节（空间检查用）。 */
  photoFreeBytes?: () => Promise<number>;
};

/** 批次生效后推给页面：页面本地修订 +1 时直接应用，否则重拉。 */
export function publishOps(account: string, outcome: OpsOutcome) {
  if (!outcome.applied.length) return;
  publishAccountEvent(account, outcome.bench, {
    type: "explore.op",
    dossierId: outcome.dossierId,
    revision: outcome.revision,
    applied: outcome.applied,
  });
}

/** Agent 移动视野：即时传给页面，不存档、刷新后不重放。 */
export function publishCamera(
  account: string,
  bench: string,
  camera: { dossierId: string; runId: string; viewport: unknown; basemap: string },
) {
  publishAccountEvent(account, bench, { type: "explore.camera", ...camera });
}

export function registerExploreApi(app: Hono<ApiEnv>, database: Database, options: ExploreApiOptions = {}) {
  app.get("/v1/explore/plans/:dossierId", (c) =>
    database.withAccount(c.get("accountId"), async (client) =>
      c.json(await readPlan(client, c.get("accountId"), c.req.param("dossierId"))),
    ),
  );

  app.post("/v1/explore/plans/:dossierId/ops", async (c) => {
    const account = c.get("accountId");
    const dossierId = c.req.param("dossierId");
    let settled: OpsOutcome | null = null;
    const response = await mutate(c, database, OpsBody, async (client, input) => {
      const outcome = await applyOps(client, account, dossierId, {
        baseRevision: input.baseRevision,
        ops: input.ops as Op[],
        actor: "page",
      });
      settled = outcome;
      return {
        status: 200,
        body: {
          revision: outcome.revision,
          applied: outcome.applied,
          pending: outcome.pending,
        },
      };
    });
    // mutate 返回后才算提交完成；幂等重放不会重复推事件（settled 为空）。
    if (settled) publishOps(account, settled);
    return response;
  });

  // ── 现场记录（第二版第 1 批，契约 §2.2）────────────────────────
  // 记录是附加事实，不参与计划修订：按设备 clientId 幂等，更正是一条新记录。
  app.post("/v1/explore/plans/:dossierId/field-events", async (c) => {
    const account = c.get("accountId");
    const dossierId = c.req.param("dossierId");
    let settled: Awaited<ReturnType<typeof appendFieldEvents>> | null = null;
    let planRevision = 0;
    const response = await mutate(c, database, FieldEventsBody, async (client, input) => {
      const { plan } = await loadPlan(client, account, dossierId);
      planRevision = plan.revision;
      settled = await appendFieldEvents(client, {
        account,
        dossier: dossierId,
        document: plan.document,
        events: input.events,
      });
      return {
        status: 200,
        body: { results: settled.results, planRevision: plan.revision },
      };
    });
    // 幂等重放返回原收据、不重复推事件（settled 为空）。
    if (settled && (settled as { inserted: number }).inserted)
      publishAccountEvent(account, "exploration", {
        type: "explore.field",
        dossierId,
        planRevision,
        results: (settled as { results: unknown }).results,
      });
    return response;
  });

  app.get("/v1/explore/plans/:dossierId/field-events", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      const { plan } = await loadPlan(client, account, dossier);
      return c.json({
        items: await listFieldEvents(client, { account, dossier, document: plan.document }),
      });
    }),
  );

  // 某一修订的计划快照：出发时那一版，回顾对照用。
  app.get("/v1/explore/plans/:dossierId/revisions/:revision", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      const revision = Number(c.req.param("revision"));
      const { plan } = await loadPlan(client, account, dossier);
      try {
        return c.json(await readRevision(client, account, dossier, revision));
      } catch (error) {
        // 从没有业务批次写过这份计划时，当前正文就是那一版：回填一份，别让出发时的计划查不到。
        if (
          error instanceof ApiFailure &&
          error.code === "REVISION_NOT_FOUND" &&
          revision === plan.revision
        ) {
          await snapshotRevision(client, {
            account,
            dossier,
            revision: plan.revision,
            state: plan.state,
            document: plan.document,
          });
          return c.json(await readRevision(client, account, dossier, revision));
        }
        throw error;
      }
    }),
  );

  // ── 离线包（契约 §2.1）──────────────────────────────────────
  const offlineOptions = (): OfflineOptions => ({
    storage: options.exploreStorage ?? unavailableStorage(),
    mapConfig: options.mapConfig ?? (() => mapConfigFrom({})),
    ...(options.offlineFetch ? { fetch: options.offlineFetch } : {}),
  });

  app.post("/v1/explore/plans/:dossierId/offline-packs", (c) =>
    mutate(c, database, OfflinePackBody, async (client, input) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      const { plan } = await loadPlan(client, account, dossier);
      return {
        status: 201,
        body: {
          pack: await createOfflinePack(
            client,
            account,
            dossier,
            { plan, day: input.day, ...(input.detail ? { detail: input.detail } : {}) },
            offlineOptions(),
          ),
        },
      };
    }),
  );

  // 清单直接返回（和 POST 的 { pack } 不同）：准备页「检查完整性」拿到的就是清单本身。
  app.get("/v1/explore/plans/:dossierId/offline-packs/:packId", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) =>
      c.json(
        await readOfflinePack(
          client,
          c.get("accountId"),
          c.req.param("dossierId"),
          c.req.param("packId"),
        ),
      ),
    ),
  );

  // 只代取清单里列过的瓦片；超上限明确拒绝，不悄悄漏图。
  app.get("/v1/explore/offline-tiles/:packId/:z/:x/:y", (c) => {
    const coord = {
      z: Number(c.req.param("z")),
      x: Number(c.req.param("x")),
      y: Number(c.req.param("y")),
    };
    if (![coord.z, coord.x, coord.y].every((value) => Number.isInteger(value) && value >= 0))
      throw new ApiFailure("OFFLINE_TILE_NOT_FOUND", 404, "瓦片坐标不对。");
    return database.withAccount(c.get("accountId"), async (client) => {
      const tile = await offlineTile(
        client,
        c.get("accountId"),
        { packId: c.req.param("packId"), ...coord },
        offlineOptions(),
      );
      return new Response(tile.bytes, {
        headers: {
          "content-type": tile.mime,
          "content-length": String(tile.bytes.length),
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      });
    });
  });

  // 字形按账户共用：不同离线包要的是同一批拉丁/标点区段，不按包重复存。
  app.get("/v1/explore/offline-glyphs/:fontstack/:range", async (c) => {
    const glyph = await offlineGlyph(
      { fontstack: c.req.param("fontstack"), range: c.req.param("range") },
      offlineOptions(),
    );
    return new Response(glyph.bytes, {
      headers: {
        "content-type": glyph.mime,
        "content-length": String(glyph.bytes.length),
        "cache-control": "private, max-age=86400",
      },
    });
  });

  // 离线源 TileJSON：页面把样式里的矢量源指到这里，就只会跟我们要清单里的瓦片。
  app.get("/v1/explore/offline-packs/:packId/tilejson", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) =>
      c.json(
        await offlineTileJson(
          client,
          c.get("accountId"),
          { packId: c.req.param("packId"), origin: requestOrigin(c) },
          offlineOptions(),
        ),
      ),
    ),
  );

  app.get("/v1/explore/plans/:dossierId/offline-light", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const { plan } = await loadPlan(client, c.get("accountId"), c.req.param("dossierId"));
      const day = c.req.query("day") || plan.document.days[0];
      if (!day) throw new ApiFailure("OFFLINE_NO_STOPS", 409, "这份计划还没有拍摄日。");
      return c.json({ planRevision: plan.revision, ...lightSnapshot(plan.document, day) });
    }),
  );

  // ── 照片与回顾（第二版第 3 批，契约 §2.3–2.5）────────────────────
  const photoDeps = (): PhotoDeps => ({
    store: options.photoStore ?? unavailablePhotoStore(),
    ...(options.photoFreeBytes ? { freeBytes: options.photoFreeBytes } : {}),
  });

  app.post("/v1/explore/plans/:dossierId/photo-batches", (c) =>
    mutate(c, database, PhotoBatchBody, async (client, input) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      await loadPlan(client, account, dossier);
      const created = await createBatch(client, account, dossier, input, photoDeps());
      // 给页面的端点要是绝对地址：tus 客户端拿它当 base 解析 Location，相对地址会直接抛错。
      return {
        status: 201,
        body: {
          ...created,
          uploadUrl: `${requestOrigin(c)}/backend${created.uploadUrl}`,
        },
      };
    }),
  );

  app.get("/v1/explore/plans/:dossierId/photo-batches/:batchId", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) =>
      c.json({
        batch: await readBatch(
          client,
          c.get("accountId"),
          c.req.param("dossierId"),
          c.req.param("batchId"),
        ),
      }),
    ),
  );

  app.get("/v1/explore/plans/:dossierId/photos", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) =>
      c.json(
        await listPhotos(client, {
          account: c.get("accountId"),
          dossier: c.req.param("dossierId"),
          ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
          ...(c.req.query("stopId") ? { stopId: c.req.query("stopId") } : {}),
          ...(c.req.query("group") ? { group: c.req.query("group") } : {}),
        }),
      ),
    ),
  );

  app.post("/v1/explore/plans/:dossierId/photos/assign", (c) =>
    mutate(c, database, AssignBody, async (client, input) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      const { plan } = await loadPlan(client, account, dossier);
      const changed = await assignPhotos(client, {
        account,
        dossier,
        photoIds: input.photoIds,
        stopId: input.stopId,
        document: plan.document,
      });
      return { status: 200, body: { changed } };
    }),
  );

  app.post("/v1/explore/plans/:dossierId/photos/pick", (c) =>
    mutate(c, database, PickBody, async (client, input) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      await loadPlan(client, account, dossier);
      const changed = await pickPhotos(client, {
        account,
        dossier,
        photoIds: input.photoIds,
        picked: input.picked,
      });
      return { status: 200, body: { changed } };
    }),
  );

  const media = (kind: "thumb" | "preview" | "original") => (c: any) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) => {
      const dossier = c.req.param("dossierId");
      const account = c.get("accountId");
      const row = await photoRow(client, account, dossier, c.req.param("pid"));
      const store = options.photoStore ?? unavailablePhotoStore();
      const name = kind === "original" ? "original.jpg" : `${kind}.jpg`;
      const bytes = row.status === "ready" ? await store.read(dossier, row.id, name) : null;
      if (!bytes) throw new ApiFailure("PHOTO_MEDIA_MISSING", 404, "这张照片的图还没生成好。");
      return new Response(bytes, {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(bytes.length),
          // 派生图会随重算变，短缓存就够；原图只读，长一点。
          "cache-control": kind === "original" ? "private, max-age=86400" : "private, max-age=300",
          ...(kind === "original" ? { "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}` } : {}),
          "x-content-type-options": "nosniff",
        },
      });
    });
  app.get("/v1/explore/plans/:dossierId/photos/:pid/thumb", media("thumb"));
  app.get("/v1/explore/plans/:dossierId/photos/:pid/preview", media("preview"));
  app.get("/v1/explore/plans/:dossierId/photos/:pid/original", media("original"));

  // 细看用的原图裁切：x/y/w/h 都是画框 0–1 的比例。
  app.get("/v1/explore/plans/:dossierId/photos/:pid/crop", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) => {
      const number = (value: string | undefined, fallback: number) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
      };
      const rect = {
        x: number(c.req.query("x"), 0),
        y: number(c.req.query("y"), 0),
        w: number(c.req.query("w"), 0.25) || 0.25,
        h: number(c.req.query("h"), 0.25) || 0.25,
      };
      const dossier = c.req.param("dossierId");
      const row = await photoRow(client, c.get("accountId"), dossier, c.req.param("pid"));
      if (row.status !== "ready") throw new ApiFailure("PHOTO_MEDIA_MISSING", 404, "这张照片还没处理好。");
      const store = options.photoStore ?? unavailablePhotoStore();
      const bytes = await cropOf(store.originalPath(dossier, row.id), rect);
      return new Response(bytes, {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(bytes.length),
          "cache-control": "private, max-age=60",
          "x-content-type-options": "nosniff",
        },
      });
    }),
  );

  app.delete("/v1/explore/plans/:dossierId/photos/:pid", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      await deletePhoto(
        client,
        { account: c.get("accountId"), dossier: c.req.param("dossierId"), photoId: c.req.param("pid") },
        photoDeps(),
      );
      return c.body(null, 204);
    }),
  );

  app.get("/v1/explore/plans/:dossierId/storage", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      await loadPlan(client, c.get("accountId"), c.req.param("dossierId"));
      return c.json(await storageUsage(photoDeps(), c.req.param("dossierId")));
    }),
  );

  app.get("/v1/explore/plans/:dossierId/clock", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const { plan } = await loadPlan(client, c.get("accountId"), c.req.param("dossierId"));
      return c.json({
        groups: await cameraGroups(client, {
          account: c.get("accountId"),
          dossier: c.req.param("dossierId"),
          document: plan.document,
        }),
      });
    }),
  );

  const publishClock = (account: string, dossier: string, groups: CameraGroup[]) => {
    for (const group of groups)
      publishAccountEvent(account, "exploration", {
        type: "explore.clock",
        dossierId: dossier,
        groupId: group.id,
        status: group.status,
      });
  };

  app.post("/v1/explore/plans/:dossierId/clock/:groupId/anchor", async (c) => {
    const account = c.get("accountId");
    const dossier = c.req.param("dossierId");
    const groupId = c.req.param("groupId");
    let groups: CameraGroup[] | null = null;
    const response = await mutate(c, database, AnchorBody, async (client, input) => {
      const { plan } = await loadPlan(client, account, dossier);
      const group = await addAnchor(client, {
        account,
        dossier,
        groupId,
        photoId: input.photoId,
        ...(input.eventClientId ? { eventClientId: input.eventClientId } : {}),
        ...(input.time ? { time: input.time } : {}),
        document: plan.document,
      });
      groups = await cameraGroups(client, { account, dossier, document: plan.document });
      return { status: 200, body: { group } };
    });
    if (groups) publishClock(account, dossier, groups);
    return response;
  });

  app.post("/v1/explore/plans/:dossierId/clock/:groupId/confirm", async (c) => {
    const account = c.get("accountId");
    const dossier = c.req.param("dossierId");
    const groupId = c.req.param("groupId");
    let groups: CameraGroup[] | null = null;
    const response = await mutate(c, database, ConfirmClockBody, async (client, input) => {
      const { plan } = await loadPlan(client, account, dossier);
      const group = await confirmGroup(client, {
        account,
        dossier,
        groupId,
        timezone: input.timezone,
        offsetSec: input.offsetSec,
        document: plan.document,
      });
      groups = await cameraGroups(client, { account, dossier, document: plan.document });
      return { status: 200, body: { group } };
    });
    if (groups) publishClock(account, dossier, groups);
    return response;
  });

  app.post("/v1/explore/plans/:dossierId/clock/:groupId/split", async (c) => {
    const account = c.get("accountId");
    const dossier = c.req.param("dossierId");
    const groupId = c.req.param("groupId");
    let groups: CameraGroup[] | null = null;
    const response = await mutate(c, database, SplitClockBody, async (client, input) => {
      const { plan } = await loadPlan(client, account, dossier);
      groups = await splitGroup(client, {
        account,
        dossier,
        groupId,
        beforePhotoId: input.beforePhotoId,
        document: plan.document,
      });
      return { status: 200, body: { groups } };
    });
    if (groups) publishClock(account, dossier, groups);
    return response;
  });

  app.get("/v1/explore/plans/:dossierId/actual", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      const { plan } = await loadPlan(client, account, dossier);
      const revisionParam = Number(c.req.query("revision"));
      let document = plan.document;
      if (Number.isInteger(revisionParam) && revisionParam > 0) {
        // 看的是某一版计划的对照：用那个修订的停留点，其它（照片、记录）还是现在的事实。
        const snapshot = await readRevision(client, account, dossier, revisionParam).catch(() => null);
        if (snapshot) document = { ...document, stops: snapshot.plan.stops };
      }
      return c.json({ items: await actualTimeline(client, { account, dossier, document }) });
    }),
  );

  app.get("/v1/explore/plans/:dossierId/review", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      const { plan } = await loadPlan(client, account, dossier);
      return c.json({
        comparison: await buildComparison(client, {
          account,
          dossier,
          revision: plan.revision,
          document: plan.document,
        }),
        travelogue: await latestTravelogue(client, account, dossier),
      });
    }),
  );

  app.put("/v1/explore/plans/:dossierId/review/travelogue", (c) =>
    mutate(c, database, TravelogueBody, async (client, input) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      await loadPlan(client, account, dossier);
      const travelogue = await saveTravelogue(client, {
        account,
        dossier,
        baseRevision: input.baseRevision,
        markdown: input.markdown,
      });
      return { status: 200, body: travelogue };
    }),
  );

  app.get("/v1/explore/plans/:dossierId/review/travelogue/export", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const account = c.get("accountId");
      const dossier = c.req.param("dossierId");
      const format = c.req.query("format") === "html" ? "html" : "md";
      const revisionParam = Number(c.req.query("revision"));
      const travelogue = await latestTravelogue(client, account, dossier);
      if (!travelogue) throw new ApiFailure("TRAVELOGUE_MISSING", 404, "还没有游记可以导出。");
      const wanted = Number.isInteger(revisionParam) && revisionParam > 0 ? revisionParam : travelogue.revision;
      const row = (
        await client.query(
          "select revision,markdown,photo_ids,sources,created_at from explore_travelogue where account_id=$1 and dossier_id=$2 and revision=$3",
          [account, dossier, wanted],
        )
      ).rows[0];
      if (!row) throw new ApiFailure("TRAVELOGUE_MISSING", 404, "找不到这一版游记。");
      const title = `${(await client.query("select title from dossier where account_id=$1 and id=$2", [account, dossier])).rows[0]?.title ?? "游记"} · 游记`;
      const rendered = renderExport(
        {
          id: `${dossier}:${row.revision}`,
          revision: Number(row.revision),
          markdown: row.markdown,
          photoIds: row.photo_ids ?? [],
          sources: row.sources ?? [],
          updatedAt: new Date(row.created_at).toISOString(),
        },
        format,
        { title, dossierId: dossier },
      );
      await registerTravelogueArtifact(client, { account, dossier, revision: wanted, format });
      return new Response(rendered.bytes, {
        headers: {
          "content-type": rendered.mime,
          "content-length": String(rendered.bytes.length),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(rendered.fileName)}`,
        },
      });
    }),
  );

  app.get("/v1/explore/plans/:dossierId/weather", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const dossier = c.req.param("dossierId");
      // 天气视图自己会读计划行；下次检查时刻也由它带上（页面显示「下次 08:00 自动看天气」）。
      return c.json(
        await weatherView(client, c.get("accountId"), dossier, {
          stopId: c.req.query("stopId") || undefined,
          refresh: c.req.query("refresh") === "1",
          transport: options.weatherTransport,
        }),
      );
    }),
  );

  app.get("/v1/explore/plans/:dossierId/suggestions", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      // 先确认这份档案是自己的探索档案（不然空列表会看起来像"没有建议"）。
      await loadPlan(client, c.get("accountId"), c.req.param("dossierId"));
      const rows = (
        await client.query(
          `select id, effects, state, created_at from approval
            where account_id=$1 and dossier_id=$2
              and effects->0->>'kind'='explore.weatherSuggestion'
            order by created_at desc limit 20`,
          [c.get("accountId"), c.req.param("dossierId")],
        )
      ).rows;
      return c.json({
        items: rows.map((row) => {
          const effect = Array.isArray(row.effects) ? row.effects[0] : row.effects;
          return {
            id: row.id,
            forRevision: effect?.forRevision ?? 0,
            summary: effect?.summary ?? "",
            changes: Array.isArray(effect?.changes) ? effect.changes : [],
            // 建议卡的状态：批准即已应用（应用失败会转成过期/不适用）。
            state:
              row.state === "pending"
                ? "pending"
                : row.state === "approved"
                  ? "applied"
                  : row.state === "rejected"
                    ? "dismissed"
                    : "stale",
          };
        }),
      });
    }),
  );

  // 手动跑同一套检查：验收时不必守到 08/16/23。它只跑这一次，不改变日程。
  app.post("/v1/explore/plans/:dossierId/weather/check", async (c) => {
    const account = c.get("accountId");
    const dossierId = c.req.param("dossierId");
    let outcome: Awaited<ReturnType<typeof runWeatherCheck>> | null = null;
    const response = await mutate(c, database, z.object({}).strict(), async (client) => {
      outcome = await runWeatherCheck(client, account, dossierId, {
        judge: options.weatherJudge,
        transport: options.weatherTransport,
        reason: "manual",
      });
      return {
        status: 200,
        body: {
          state: outcome.state,
          summary: outcome.summary,
          checkedAt: outcome.checkedAt,
          suggestionId: outcome.suggestionId ?? null,
        },
      };
    });
    if (outcome) publishAccountEvent(account, "exploration", (outcome as WeatherCheckOutcome).event);
    return response;
  });

  app.post("/v1/explore/plans/:dossierId/refs", async (c) => {
    const account = c.get("accountId");
    const dossierId = c.req.param("dossierId");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    const kind = String(form?.get("kind") ?? "style");
    if (!file || typeof file === "string")
      throw new ApiFailure("REF_FILE_REQUIRED", 400, "需要上传一张图片。");
    if ((file as File).size > REF_IMAGE_MAX_BYTES)
      throw new ApiFailure("REF_TOO_LARGE", 413, "图片太大了，换一张小于 8MB 的。");
    const bytes = Buffer.from(await (file as File).arrayBuffer());
    const stopId = form?.get("stopId");
    return database.withAccount(account, async (client) => {
      await loadPlan(client, account, dossierId);
      const ref = await addUploadedRef(client, options.exploreStorage ?? unavailableStorage(), {
        account,
        dossier: dossierId,
        bytes,
        mime: String((file as File).type ?? ""),
        kind: kind === "same-spot" ? "same-spot" : "style",
        stopId: typeof stopId === "string" && stopId ? stopId : null,
      });
      return c.json(ref, 201);
    });
  });

  app.delete("/v1/explore/plans/:dossierId/refs/:refId", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      await removeRef(client, options.exploreStorage, {
        account: c.get("accountId"),
        dossier: c.req.param("dossierId"),
        id: c.req.param("refId"),
      });
      return c.body(null, 204);
    }),
  );

  app.get("/v1/explore/plans/:dossierId/refs/:refId/image", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) => {
      const file = await readRefImage(client, options.exploreStorage, {
        account: c.get("accountId"),
        dossier: c.req.param("dossierId"),
        id: c.req.param("refId"),
      });
      if (!file) throw new ApiFailure("REF_NOT_FOUND", 404, "找不到这张参考图。");
      return new Response(file.bytes, {
        headers: {
          "content-type": file.mime,
          "cache-control": "private, max-age=300",
          // 只在这份档案的会话里显示，别的站点不能嵌。
          "x-content-type-options": "nosniff",
        },
      });
    }),
  );

  app.get("/v1/explore/plans/:dossierId/usage", (c) =>
    // loadPlan 会补建默认计划行，所以这里不能用只读事务。
    database.withAccount(c.get("accountId"), async (client) => {
      await loadPlan(client, c.get("accountId"), c.req.param("dossierId"));
      return c.json(await planUsage(client, c.get("accountId"), c.req.param("dossierId")));
    }),
  );

  app.get("/v1/profiles", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) =>
      c.json({ items: await listProfiles(client, c.get("accountId"), c.req.query("type")) }),
    ),
  );

  app.post("/v1/profiles", (c) =>
    mutate(c, database, ProfileBody, async (client, input) => ({
      status: 201,
      body: await createProfile(client, c.get("accountId"), input as unknown as Record<string, unknown>),
    })),
  );

  app.patch("/v1/profiles/:id", (c) =>
    mutate(c, database, ProfilePatchBody, async (client, input) => ({
      status: 200,
      body: await updateProfile(
        client,
        c.get("accountId"),
        c.req.param("id"),
        input as unknown as Record<string, unknown>,
      ),
    })),
  );

  app.delete("/v1/profiles/:id", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      await deleteProfile(client, c.get("accountId"), c.req.param("id"));
      return c.body(null, 204);
    }),
  );

  // 页面导出的地图快照：按「修订 + 键」保存，同一修订同一键重传覆盖。
  app.post("/v1/explore/plans/:dossierId/snapshots", async (c) => {
    const account = c.get("accountId");
    const dossierId = c.req.param("dossierId");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string")
      throw new ApiFailure("SNAPSHOT_FILE_REQUIRED", 400, "需要上传一张 PNG 地图快照。");
    if ((file as File).size > SNAPSHOT_MAX_BYTES)
      throw new ApiFailure("SNAPSHOT_TOO_LARGE", 413, "地图快照太大了。");
    const bytes = Buffer.from(await (file as File).arrayBuffer());
    return database.withAccount(account, async (client) => {
      const saved = await saveSnapshot(client, options.exploreStorage ?? unavailableStorage(), {
        account,
        dossier: dossierId,
        revision: Number(form?.get("revision") ?? 0),
        key: String(form?.get("key") ?? "overview"),
        bytes,
        attribution: form?.get("attribution") ? String(form?.get("attribution")) : null,
        basemap: form?.get("basemap") ? String(form?.get("basemap")) : null,
      });
      return c.json(saved, 201);
    });
  });

  // 生成计划书：先校验修订与素材，202 之后再异步排版。
  app.post("/v1/explore/plans/:dossierId/books", async (c) => {
    const account = c.get("accountId");
    const dossierId = c.req.param("dossierId");
    let started: Awaited<ReturnType<typeof prepareBook>> | null = null;
    const response = await mutate(c, database, z.object({
      variant: z.enum(["brief", "full"]),
      revision: z.number().int().positive(),
    }).strict(), async (client, input) => {
      started = await prepareBook(client, {
        account,
        dossier: dossierId,
        variant: input.variant,
        revision: input.revision,
      });
      return { status: 202, body: { jobId: started.artifactId } };
    });
    if (started)
      void generateBook(
        {
          db: database,
          storage: options.exploreStorage ?? unavailableStorage(),
          fontFile: options.pdfFontFile ?? defaultFontFile(),
          publish: (target, event) => publishAccountEvent(target, "exploration", event),
        },
        { account, dossier: dossierId, plan: started },
      );
    return response;
  });

  // 打开已生成的计划书（PDF）。
  app.get("/v1/explore/plans/:dossierId/books/:artifactId/file", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) => {
      const book = await readBook(client, options.exploreStorage ?? unavailableStorage(), {
        account: c.get("accountId"),
        dossier: c.req.param("dossierId"),
        artifactId: c.req.param("artifactId"),
      });
      return new Response(book.bytes, {
        headers: {
          "content-type": book.mime,
          "cache-control": "private, max-age=0, must-revalidate",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(book.title)}.pdf`,
        },
      });
    }),
  );

  // 页面搜索框：国内走高德、海外走 ORS；缺配置就照实说缺哪项。
  app.get("/v1/explore/places", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) => {
      const nearParam = c.req.query("near");
      const near = nearParam
        ? (nearParam.split(",").map(Number) as [number, number])
        : null;
      if (near && (near.length !== 2 || !near.every((value) => Number.isFinite(value))))
        throw new ApiFailure("INVALID_INPUT", 400, "near 要写成 lng,lat。");
      // 只读：不补建计划行，只取这份计划的目的地时区来挑服务商。
      const dossierId = c.req.query("dossierId");
      let timezone: string | null = null;
      if (dossierId)
        timezone =
          (
            await client.query(
              "select document->'destination'->>'timezone' tz from explore_plan where account_id=$1 and dossier_id=$2",
              [c.get("accountId"), dossierId],
            )
          ).rows[0]?.tz ?? null;
      const items = await searchPlaces({
        q: c.req.query("q") ?? "",
        near,
        timezone,
        ...(c.req.query("provider") ? { provider: c.req.query("provider") } : {}),
      });
      return c.json({ items });
    }),
  );

  app.get("/v1/explore/map-config", (c) =>
    c.json((options.mapConfig ?? (() => mapConfigFrom({})))()),
  );

  app.get("/v1/account/settings", (c) =>
    database.withAccountSnapshot(c.get("accountId"), async (client) =>
      c.json({ timezone: await accountTimezone(client, c.get("accountId")) }),
    ),
  );

  app.put("/v1/account/settings", (c) =>
    mutate(c, database, SettingsBody, async (client, input) => {
      if (!isIanaTimezone(input.timezone))
        throw new ApiFailure("INVALID_TIMEZONE", 400, "时区要写成 IANA 名字，比如 Asia/Shanghai。");
      await saveTimezone(client, c.get("accountId"), input.timezone);
      return { status: 200, body: { timezone: input.timezone } };
    }),
  );
}

/** 没有配置存放目录时：上传明确失败，不假装存好了。 */
function unavailableStorage(): ExploreStorage {
  const fail = () => {
    throw new ApiFailure("STORAGE_UNAVAILABLE", 503, "文件存储还没准备好，先配置存放目录。");
  };
  return {
    saveRef: fail,
    readRef: fail,
    removeRef: fail,
    saveSnapshot: fail,
    readSnapshot: fail,
    saveBook: fail,
    readBook: fail,
    savePackAsset: fail,
    readPackAsset: fail,
    saveFontAsset: fail,
    readFontAsset: fail,
  };
}

/** 没配置照片目录时：上传与派生图明确失败，不假装存好了。 */
function unavailablePhotoStore(): PhotoStore {
  const fail = () => {
    throw new ApiFailure("STORAGE_UNAVAILABLE", 503, "照片存放目录还没准备好。");
  };
  return {
    uploadsDir: fail,
    photoDir: fail,
    adoptUpload: fail,
    write: fail,
    read: fail,
    originalPath: fail,
    remove: fail,
    usedBytes: fail,
  };
}

/** 请求真正来自哪儿：LAN 反代会带 X-Forwarded-Proto/Host，页面和接口是同一个 origin。 */
function requestOrigin(c: ApiContext): string {
  const url = new URL(c.req.url);
  const proto =
    (c.req.header("X-Forwarded-Proto") ?? "").split(",")[0].trim().toLowerCase() ||
    url.protocol.replace(":", "");
  const forwarded = (c.req.header("X-Forwarded-Host") ?? "").split(",")[0].trim();
  return `${proto}://${forwarded || url.host}`;
}
