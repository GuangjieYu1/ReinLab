/**
 * 第 4 项档案接口（契约第 2～4 节）。
 *
 * 页面与侧边 Agent 走同一组服务函数；这里只负责解析入参、拿账户事务、把结果
 * 序列化回去。写请求都要求 Idempotency-Key（由 mutate/中间件保证）。
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database";
import type { ApiEnv } from "./context";
import { ApiFailure } from "./errors";
import {
  attachCourse,
  createDossier,
  detachArtifact,
  getDossier,
  listActivity,
  listArtifacts,
  listDossiers,
  openDossier,
  requestDelete,
  resumeBench,
  savePosition,
  setArchived,
  subscribe,
  updateDossier,
} from "../dossier/service";

const body = async (c: any): Promise<Record<string, unknown>> => {
  const raw = await c.req.json().catch(() => ({}));
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
};

const viaOf = (value: unknown): "page" | "agent" => (value === "agent" ? "agent" : "page");

export function registerDossierApi(app: Hono<ApiEnv>, database: Database) {
  app.get("/v1/dossiers", (c) =>
    database.withAccount(c.get("accountId"), (client) =>
      listDossiers(client, c.get("accountId"), {
        bench: c.req.query("bench"),
        q: c.req.query("q"),
        view: c.req.query("view"),
        via: c.req.query("via"),
        cursor: c.req.query("cursor"),
      }).then((r) => c.json(r)),
    ),
  );

  app.get("/v1/benches/:bench/resume", (c) =>
    database.withAccount(c.get("accountId"), async (client) =>
      c.json(await resumeBench(client, c.get("accountId"), c.req.param("bench"))),
    ),
  );

  app.post("/v1/dossiers", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const input = await body(c);
      const dossier = await createDossier(client, c.get("accountId"), input as any, viaOf(input.via));
      return c.json(dossier, 201);
    }),
  );

  app.get("/v1/dossiers/:id", (c) =>
    database.withAccount(c.get("accountId"), async (client) =>
      c.json(await getDossier(client, c.get("accountId"), c.req.param("id"))),
    ),
  );

  app.post("/v1/dossiers/:id/open", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const input = await body(c);
      return c.json(
        await openDossier(client, c.get("accountId"), c.req.param("id"), viaOf(input.via)),
      );
    }),
  );

  app.put("/v1/dossiers/:id/resume", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      await savePosition(client, c.get("accountId"), c.req.param("id"), await body(c));
      return c.body(null, 204);
    }),
  );

  app.patch("/v1/dossiers/:id", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const input = await body(c);
      return c.json(
        await updateDossier(client, c.get("accountId"), c.req.param("id"), input as any, viaOf(input.via)),
      );
    }),
  );

  app.post("/v1/dossiers/:id/archive", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const input = await body(c);
      const result = await setArchived(
        client,
        c.get("accountId"),
        c.req.param("id"),
        true,
        viaOf(input.via),
      );
      return "confirmation" in result
        ? c.json({ confirmation: result.confirmation }, 202)
        : c.json(result);
    }),
  );

  app.post("/v1/dossiers/:id/unarchive", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const input = await body(c);
      const result = await setArchived(
        client,
        c.get("accountId"),
        c.req.param("id"),
        false,
        viaOf(input.via),
      );
      return "confirmation" in result
        ? c.json({ confirmation: result.confirmation }, 202)
        : c.json(result);
    }),
  );

  app.post("/v1/dossiers/:id/delete", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const input = await body(c);
      return c.json(
        await requestDelete(client, c.get("accountId"), c.req.param("id"), viaOf(input.via)),
        202,
      );
    }),
  );

  app.get("/v1/dossiers/:id/artifacts", (c) =>
    database.withAccount(c.get("accountId"), async (client) =>
      c.json(
        await listArtifacts(client, c.get("accountId"), c.req.param("id"), c.req.query("kind")),
      ),
    ),
  );

  app.post("/v1/dossiers/:id/artifacts", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const input = await body(c);
      if (String(input.kind) !== "course")
        throw new ApiFailure("INVALID_INPUT", 400, "目前只支持把课程加进档案。");
      const courseId = String(input.courseId ?? "");
      if (!courseId) throw new ApiFailure("INVALID_INPUT", 400, "需要指定课程。");
      const catalog = await localCourses();
      const found = catalog.find((item) => item.courseId === courseId);
      if (!found)
        throw new ApiFailure("COURSE_UNAVAILABLE", 409, "课程文件不可访问，先确认本地课程库已就绪。");
      return c.json(
        await attachCourse(client, c.get("accountId"), c.req.param("id"), courseId, found.title),
        201,
      );
    }),
  );

  app.delete("/v1/dossiers/:id/artifacts/:artifactId", (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      await detachArtifact(
        client,
        c.get("accountId"),
        c.req.param("id"),
        c.req.param("artifactId"),
      );
      return c.body(null, 204);
    }),
  );

  app.get("/v1/dossiers/:id/activity", (c) =>
    database.withAccount(c.get("accountId"), async (client) =>
      c.json(
        await listActivity(
          client,
          c.get("accountId"),
          c.req.param("id"),
          c.req.query("after"),
        ),
      ),
    ),
  );

  app.get("/v1/courses", async (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const items = (await localCourses()).filter(
      (item) => !q || item.title.toLowerCase().includes(q) || item.courseId.includes(q),
    );
    return c.json({ items });
  });

  // 第 4 节：只发本账户、只带 id 和最小字段。
  app.get("/v1/stream", async (c) => {
    const account = c.get("accountId");
    const bench = c.req.query("bench") ?? "";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            /* 连接已断 */
          }
        };
        send({ type: "ready", bench });
        const unsubscribe = subscribe(account, bench, send);
        const beat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            /* ignore */
          }
        }, 15000);
        const close = () => {
          clearInterval(beat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        c.req.raw.signal.addEventListener("abort", close);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  });
}

/** 本地 OpenMAIC 的课程列表；读不到就返回空数组，让页面显示「没有课程」。 */
async function localCourses(): Promise<
  { courseId: string; title: string; source: "local-openmaic" | "native"; sceneCount: number; progress: number | null }[]
> {
  const origin = process.env.REINLAB_OPENMAIC_ORIGIN ?? "http://127.0.0.1:3000";
  try {
    const res = await fetch(origin.replace(/\/+$/, "") + "/api/courses", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const list = Array.isArray(json) ? json : (json?.items ?? json?.courses ?? []);
    return (Array.isArray(list) ? list : []).map((item: any) => ({
      courseId: String(item?.id ?? item?.courseId ?? randomUUID()),
      title: String(item?.title ?? item?.name ?? "未命名课程"),
      source: "local-openmaic" as const,
      sceneCount: Number(item?.sceneCount ?? item?.scenes?.length ?? 0),
      progress: typeof item?.progress === "number" ? item.progress : null,
    }));
  } catch {
    return [];
  }
}
