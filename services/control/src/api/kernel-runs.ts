import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Hono } from "hono";
import { ApiFailure } from "./errors";
import { mutate, type ApiEnv } from "./context";
import type { Database } from "../db/database";
import type { KernelService } from "../kernel/service";
import { runUsage } from "../run/usage";

const Create = z
  .object({
    dossierId: z.string().uuid(),
    query: z.string().min(1).max(4000),
    chosenPaperId: z.string().max(200).optional(),
    newSession: z.boolean().optional(),
    // assist = 非研究台的最小侧边会话；explore = 探索台的旅拍规划会话。
    mode: z.enum(["assist", "explore"]).optional(),
    /** 这一轮随消息带上的参考图（探索台）。 */
    refIds: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();

export type KernelRunApiDependencies = {
  db: Database;
  kernel: KernelService;
};

/**
 * Kernel run surface: create a read run, read its state and usage, cancel it.
 * The run's events are the dossier's existing event ledger, so the read view
 * and inbox keep reading the same records.
 */
export function registerKernelRuns(
  app: Hono<ApiEnv>,
  dependencies: KernelRunApiDependencies,
) {
  app.post("/v1/kernel/runs", async (c) => {
    const account = c.get("accountId");
    let created: string | undefined;
    let lastInput:
      | { newSession?: boolean; mode?: "assist" | "explore" }
      | undefined;
    const response = await mutate(c, dependencies.db, Create, async (client, input) => {
      const dossier = (
        await client.query(
          "select id,bench from dossier where id=$1 and account_id=$2",
          [input.dossierId, account],
        )
      ).rows[0];
      if (!dossier) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "档案不存在。");
      // 研究台跑精读；探索台跑旅拍规划；其它台的最小侧边会话（assist）只做档案操作。
      const mode = input.mode === "explore" ? "explore" : input.mode === "assist" ? "assist" : "read";
      if (mode === "read" && dossier.bench !== "research")
        throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有研究档案可以精读。");
      if (mode === "explore" && dossier.bench !== "exploration")
        throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有探索档案能开旅拍规划会话。");
      lastInput = input;
      const runId = randomUUID();
      await client.query(
        `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
         values($1,$2,$3,$4,$5,$6,'queued',1,$7)`,
        [
          runId,
          account,
          input.dossierId,
          input.mode === "assist" ? "bench-assist" : input.mode === "explore" ? "bench-explore" : "research-read",
          mode,
          randomUUID(),
          JSON.stringify({
            query: input.query,
            ...(input.chosenPaperId ? { chosenPaperId: input.chosenPaperId } : {}),
            ...(input.refIds ? { refIds: input.refIds } : {}),
          }),
        ],
      );
      created = runId;
      return { status: 201, body: { id: runId } };
    });
    // The kernel starts after the run row commits; it opens its own transaction.
    if (!created) return response;
    const started = await dependencies.kernel.submit(account, created, {
      ...(lastInput?.mode === "assist"
        ? { mode: "assist" as const }
        : lastInput?.mode === "explore"
          ? { mode: "explore" as const }
          : {}),
      newSession: lastInput?.newSession === true,
    });
    return c.json({ id: created, sessionId: started.sessionId, resume: started.resume }, 201);
  });

  app.get("/v1/kernel/dossiers/:id/runs", (c) =>
    dependencies.db.withAccountSnapshot(c.get("accountId"), async (client) => {
      const id = c.req.param("id");
      if (!z.string().uuid().safeParse(id).success)
        throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "档案不存在。");
      const rows = (
        await client.query(
          `select id,mode,state,created_at,ended_at from run
           where dossier_id=$1 and account_id=$2 and role_id<>'research-clarify'
           order by created_at desc limit 20`,
          [id, c.get("accountId")],
        )
      ).rows;
      return c.json({
        runs: rows.map((row) => ({
          id: row.id,
          mode: row.mode,
          state: row.state,
          createdAt: row.created_at,
          endedAt: row.ended_at,
        })),
      });
    }),
  );

  /**
   * 运行事件的 SSE：页面订阅它代替 1 秒轮询。
   *
   * 为什么要它：DSH 内核是整步落盘（没有 token 增量），一轮常有 10–20 秒的静默；
   * 页面靠轮询既慢又看不出"还在跑"。这里把落盘的每一步事件即刻推过去，
   * 连 `step/start`、`assistant/attempt` 这类活性事件一起给，页面据此显示"正在想/正在调工具"。
   *
   * 帧格式：`data: {"seq":n,"action":"…","payload":{…}}`；
   * 另有 `{"state":"running"|"completed"|…}` 状态帧与 `{"done":true}` 收尾帧。
   */
  app.get("/v1/kernel/runs/:id/stream", (c) => {
    const account = c.get("accountId");
    const runId = c.req.param("id");
    if (!z.string().uuid().safeParse(runId).success)
      throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
    let cursor = Number(c.req.query("after") ?? 0);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const push = (event: Record<string, unknown>) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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
            /* already closed */
          }
        };
        let state = "";
        let lastStateSent = "";
        const tick = setInterval(() => {
          void (async () => {
            if (closed) return;
            try {
              const { events, current } = await dependencies.db.withAccountSnapshot(account, async (client) => {
                const rows = (
                  await client.query(
                    `select seq,action,payload from event
                      where account_id=$1 and run_id=$2 and seq>$3 order by seq limit 200`,
                    [account, runId, cursor],
                  )
                ).rows;
                const run = (
                  await client.query("select state from run where account_id=$1 and id=$2", [account, runId])
                ).rows[0];
                return { events: rows, current: run ? String(run.state) : "" };
              });
              for (const row of events) {
                cursor = Number(row.seq);
                push({ seq: cursor, action: row.action, payload: row.payload });
              }
              if (current && current !== lastStateSent) {
                lastStateSent = current;
                state = current;
                push({ state: current });
              }
              const done = ["completed", "failed", "cancelled", "interrupted"].includes(state);
              if (done && !events.length) {
                push({ done: true, state });
                finish();
              }
            } catch {
              /* 下一拍再试 */
            }
          })();
        }, 300);
        const beat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            closed = true;
          }
        }, 15000);
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

  app.post("/v1/kernel/approvals/:id/answer", async (c) => {
    const account = c.get("accountId");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success)
      throw new ApiFailure("APPROVAL_NOT_FOUND", 404, "审批不存在。");
    const body = (await c.req.json().catch(() => ({}))) as {
      candidateId?: unknown;
      text?: unknown;
    };
    const candidateId =
      typeof body.candidateId === "string" && body.candidateId !== ""
        ? body.candidateId.slice(0, 200)
        : null;
    const text =
      typeof body.text === "string" && body.text.trim() !== ""
        ? body.text.trim().slice(0, 4000)
        : null;
    return dependencies.db.withAccount(account, async (client) => {
      const row = (
        await client.query(
          `select a.id,a.kind,a.state,a.effects,a.run_id,r.state run_state
             from approval a join run r on r.account_id=a.account_id and r.id=a.run_id
            where a.id=$1 and a.account_id=$2`,
          [id, account],
        )
      ).rows[0];
      if (!row) throw new ApiFailure("APPROVAL_NOT_FOUND", 404, "审批不存在。");
      if (row.state !== "pending")
        return c.json({ id, state: row.state, repeated: true });
      await client.query(
        "update approval set effects=$2 where id=$1",
        [id, JSON.stringify({ ...(row.effects ?? {}), answer: { candidateId, text } })],
      );
      await client.query(
        "update approval set state='approved', decided_at=now(), decided_scope='once' where id=$1",
        [id],
      );
      // 用户答完就按同一会话续上，把回答作为这一轮的输入送回原任务。
      if (row.run_state === "waiting") {
        const chosen = candidateId ? `用户选择了 ${candidateId}。` : "";
        void dependencies.kernel
          ?.resumeAfterAnswer(
            account,
            row.run_id,
            `用户已回答这次提问（审批 ${id}）。${chosen}${text ? "补充：" + text : ""} 继续原来的任务。`,
          )
          .catch(() => {});
      }
      return c.json({ id, state: "approved", answer: { candidateId, text } });
    });
  });

  app.get("/v1/kernel/runs/:id", (c) =>
    dependencies.db.withAccountSnapshot(c.get("accountId"), async (client) => {
      const id = c.req.param("id");
      if (!z.string().uuid().safeParse(id).success)
        throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
      const run = (
        await client.query(
          "select id,state,input,created_at,ended_at from run where id=$1 and account_id=$2",
          [id, c.get("accountId")],
        )
      ).rows[0];
      if (!run) throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
      const turn = (
        await client.query(
          "select session_id,state,error_code,started_at,ended_at from dsh_turn where run_id=$1 order by started_at desc limit 1",
          [id],
        )
      ).rows[0];
      const usage = await runUsage(client, id);
      return c.json({
        id: run.id,
        state: run.state,
        query: (run.input as { query?: string })?.query ?? null,
        createdAt: run.created_at,
        endedAt: run.ended_at,
        session: turn
          ? {
              sessionId: turn.session_id,
              state: turn.state,
              errorCode: turn.error_code,
              startedAt: turn.started_at,
              endedAt: turn.ended_at,
            }
          : null,
        usage: {
          known: usage.known,
          requests: usage.requests,
          unknownRequests: usage.unknownRequests,
          knownCny: usage.knownCny,
        },
      });
    }),
  );

  app.post("/v1/kernel/runs/:id/cancel", async (c) => {
    const account = c.get("accountId");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success)
      throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
    const state = await dependencies.kernel.cancel(account, id);
    return c.json({ id, state });
  });

  app.get("/v1/kernel/runs/:id/events", (c) =>
    dependencies.db.withAccountSnapshot(c.get("accountId"), async (client) => {
      const id = c.req.param("id");
      if (!z.string().uuid().safeParse(id).success)
        throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
      const after = Number(c.req.query("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new ApiFailure("INVALID_CURSOR", 400, "游标无效。");
      const rows = (
        await client.query(
          `select seq,kind,action,payload,at from event
           where run_id=$1 and account_id=$2 and seq>$3 order by seq limit 1001`,
          [id, c.get("accountId"), after],
        )
      ).rows;
      return c.json({
        cursor: rows.length ? Number(rows[rows.length - 1].seq) : after,
        events: rows.slice(0, 1000).map((row) => ({
          seq: Number(row.seq),
          kind: row.kind,
          action: row.action,
          payload: row.payload,
          at: row.at,
        })),
      });
    }),
  );
}
