/**
 * 探索台页面接口（design/prd/07-explore-contract.md 第 2、3 节）。
 *
 * 页面与 Agent 走同一组服务函数：这里只解析入参、拿账户事务、提交后推事件。
 * 写请求都要求 Idempotency-Key（由 mutate 保证），同一批 ops 重放返回原收据。
 */
import { Hono } from "hono";
import type { Op } from "@reinlab/contracts";
import { mutate } from "./context";
import type { ApiEnv } from "./context";
import type { Database } from "../db/database";
import { ApiFailure } from "./errors";
import { z } from "zod";
import {
  OpsBody,
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
import { mapConfigFrom, type MapConfig } from "../explore/map-config";
import { publishAccountEvent } from "../dossier/service";

export type ExploreApiOptions = {
  /** 地图公开配置来源；缺省时按空配置（页面显示底图未配置）。 */
  mapConfig?: () => MapConfig;
  /** 天气取数通道；缺省用真实 fetch，测试可注入。 */
  weatherTransport?: WeatherTransport;
  /** 天气判断的模型通道；没有就只记录数据变化、不下结论。 */
  weatherJudge?: WeatherJudge;
  /** 参考图等文件的存放端口。 */
  exploreStorage?: ExploreStorage;
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

  app.get("/v1/explore/plans/:dossierId/weather", (c) =>
    database.withAccount(c.get("accountId"), async (client) =>
      c.json(
        await weatherView(client, c.get("accountId"), c.req.param("dossierId"), {
          stopId: c.req.query("stopId") || undefined,
          refresh: c.req.query("refresh") === "1",
          transport: options.weatherTransport,
        }),
      ),
    ),
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
    throw new ApiFailure("REF_STORAGE_UNAVAILABLE", 503, "参考图存储还没准备好，先配置存放目录。");
  };
  return { saveRef: fail, readRef: fail, removeRef: fail };
}
