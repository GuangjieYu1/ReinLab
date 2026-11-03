import { z } from "zod";
import type { Hono } from "hono";
import { ApiFailure } from "./errors";
import { mutate, type ApiEnv } from "./context";
import type { Database } from "../db/database";
import type { SwarmService } from "../swarm/service";

const uuid = z.string().uuid();

const Confirm = z
  .object({
    planVersion: z.number().int().positive(),
    limits: z
      .object({
        rounds: z.number().int().positive().optional(),
        minutes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const Post = z
  .object({
    col: z.enum(["question", "finding", "help", "decision"]),
    text: z.string().min(1).max(8000),
    to: z.string().min(1).max(120).optional(),
    replyTo: z.string().uuid().optional(),
  })
  .strict();

const Intervene = z
  .object({
    kind: z.enum([
      "mention",
      "redirect",
      "add_member",
      "stop_route",
      "pause",
      "resume",
      "finish",
      "extend",
    ]),
    text: z.string().max(8000).optional(),
    /** 加人时可以指定角色 / 模型。 */
    role: z.enum(["researcher", "critic", "verifier"]).optional(),
    target: z
      .object({
        memberId: z.string().min(1).max(120).optional(),
        routeId: z.string().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        rounds: z.number().int().positive().optional(),
        minutes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SwarmApiDependencies = {
  db: Database;
  swarm: SwarmService;
};

/**
 * 研究台「群研」的读写面（13-swarm-contract.md §2、§3 里标阶段 1 的部分）。
 *
 * 服务端算好一切：状态、阻塞原因、计时、费用估算。页面只读投影，不自己推断。
 * 事件流按 seq 递增给出，前端按 seq 去重；断线重连带最后一条 seq 回来即可。
 */
export function registerSwarmApi(app: Hono<ApiEnv>, dependencies: SwarmApiDependencies) {
  const { db, swarm } = dependencies;

  const runIdOf = (c: { req: { param: (key: string) => string } }) => {
    const runId = c.req.param("id");
    if (!uuid.safeParse(runId).success) throw new ApiFailure("RUN_NOT_FOUND", 404, "这次群研不存在。");
    return runId;
  };

  app.get("/v1/swarm/dossiers/:id/runs", async (c) => {
    const dossierId = c.req.param("id");
    if (!uuid.safeParse(dossierId).success)
      throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "档案不存在。");
    return c.json(await swarm.list(c.get("accountId"), dossierId));
  });

  app.get("/v1/swarm/runs/:id", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    // 快照：打开、刷新、重连都先取它，cursor 之后从 stream 补。
    return c.json(await swarm.snapshot(account, runId));
  });

  app.post("/v1/swarm/runs/:id/plan/confirm", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    const response = await mutate(c, db, Confirm, async (_client, input) => {
      const outcome = await swarm.confirmPlan(account, runId, input);
      return { status: 200 as const, body: JSON.parse(JSON.stringify(outcome)) };
    });
    return response;
  });

  app.get("/v1/swarm/runs/:id/timeline", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    const after = Number(c.req.query("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new ApiFailure("INVALID_CURSOR", 400, "游标无效。");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200), 1), 500);
    return c.json(await swarm.timeline(account, runId, after, limit));
  });

  // 结论详情：从结论一路追到证据、任务和队员（契约 §2 阶段 2）。
  app.get("/v1/swarm/runs/:id/claims/:claimId", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    const claimId = c.req.param("claimId");
    if (!uuid.safeParse(claimId).success)
      throw new ApiFailure("CLAIM_NOT_FOUND", 404, "这条结论不存在。");
    const versionRaw = c.req.query("version");
    const version = versionRaw ? Number(versionRaw) : undefined;
    if (versionRaw && (!Number.isSafeInteger(version) || Number(version) < 1))
      throw new ApiFailure("INVALID_INPUT", 400, "版本号无效。");
    return c.json(await swarm.claimDetail(account, runId, claimId, version));
  });

  // 证据详情：这条证据被哪几条结论引用。
  app.get("/v1/swarm/runs/:id/evidence/:evidenceId", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    const evidenceId = c.req.param("evidenceId");
    if (!uuid.safeParse(evidenceId).success)
      throw new ApiFailure("EVIDENCE_NOT_FOUND", 404, "这条证据不存在。");
    return c.json(await swarm.evidenceDetail(account, runId, evidenceId));
  });

  // 阶段结果：核实没接通，verified 为空，候选放 unverified。
  app.get("/v1/swarm/runs/:id/report", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    return c.json(await swarm.report(account, runId));
  });

  app.get("/v1/swarm/runs/:id/members/:memberId/log", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    const memberId = c.req.param("memberId");
    if (!memberId || memberId.length > 120)
      throw new ApiFailure("MEMBER_NOT_FOUND", 404, "这名队员不存在。");
    const after = Number(c.req.query("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new ApiFailure("INVALID_CURSOR", 400, "游标无效。");
    return c.json(await swarm.memberLog(account, runId, memberId, after));
  });

  app.post("/v1/swarm/runs/:id/posts", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    return mutate(c, db, Post, async (_client, input) => {
      // 契约里「留言」只写了一种对象：存下来的那条留言。@队员 生成的 mention
      // 干预跟随事件流下发，不和留言挤在同一个响应形状里。
      const outcome = await swarm.createPost(account, runId, input);
      return { status: 201 as const, body: JSON.parse(JSON.stringify(outcome.post)) };
    });
  });

  app.post("/v1/swarm/runs/:id/interventions", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    return mutate(c, db, Intervene, async (_client, input) => {
      // 契约 §2：干预返回一个 Intervention；立即是 received，后续状态走事件。
      const outcome = await swarm.createIntervention(account, runId, input);
      return { status: 201 as const, body: JSON.parse(JSON.stringify(outcome.intervention)) };
    });
  });

  /**
   * 事件流：每帧 `data: {seq,at,runId,dossierId,type,data}`，心跳 `: ping`。
   * 断线重连带最后一条 seq 回来，服务端只补之后的事件。
   */
  app.get("/v1/swarm/runs/:id/stream", async (c) => {
    const account = c.get("accountId");
    const runId = runIdOf(c);
    let cursor = Number(c.req.query("after") ?? 0);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
    // 先确认这次运行属于这个账户：不然 SSE 会一直挂着一条不存在的流。
    await swarm.run(account, runId);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const push = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
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
        const startedAt = Date.now();
        const MAX_MS = 30 * 60_000;
        const tick = setInterval(() => {
          void (async () => {
            if (closed) return;
            try {
              let events: Awaited<ReturnType<typeof swarm.events>> = [];
              // 一次一拍可能装不下（回放时常见）：一拍里一直取到取完，
              // 这样从头回放与分页时间线的条数才一致（验收里 47 对 26）。
              for (let round = 0; round < 20; round += 1) {
                const batch = await swarm.events(account, runId, cursor, 500);
                events = events.concat(batch);
                if (batch.length < 500) break;
                cursor = batch[batch.length - 1].seq;
              }
              for (const event of events) {
                cursor = event.seq;
                push(`data: ${JSON.stringify(event)}\n\n`);
              }
              const run = await swarm.run(account, runId);
              if (["done", "partial", "unresolved", "cancelled", "failed"].includes(run.state) && !events.length) {
                push(`data: ${JSON.stringify({ done: true, state: run.state })}\n\n`);
                finish();
                return;
              }
              if (Date.now() - startedAt > MAX_MS) {
                push(`data: ${JSON.stringify({ done: true, state: "timeout" })}\n\n`);
                finish();
              }
            } catch {
              /* 下一拍再试 */
            }
          })();
        }, 500);
        const beat = setInterval(() => push(": ping\n\n"), 15000);
        c.req.raw.signal.addEventListener("abort", finish);
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
