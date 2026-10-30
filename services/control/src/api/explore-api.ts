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
import { OpsBody, SettingsBody, isIanaTimezone } from "../explore/schema";
import { applyOps, accountTimezone, readPlan, saveTimezone, type OpsOutcome } from "../explore/service";
import { mapConfigFrom, type MapConfig } from "../explore/map-config";
import { publishAccountEvent } from "../dossier/service";

export type ExploreApiOptions = {
  /** 地图公开配置来源；缺省时按空配置（页面显示底图未配置）。 */
  mapConfig?: () => MapConfig;
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
