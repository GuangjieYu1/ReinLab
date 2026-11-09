import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "@reinlab/contracts";
import type { Hono } from "hono";
import { ApiFailure } from "./errors";
import { mutate, type ApiEnv } from "./context";
import type { Database } from "../db/database";
import type { KernelService } from "../kernel/service";
import { runUsage } from "../run/usage";
import { createCreativeRun, runCreativeSession } from "../creative/assistant-run";
import { runTurn } from "../creative/assistant-session";

const MessageBody = z.object({ query: z.string().min(1).max(4000) }).strict();

const Create = z
  .object({
    dossierId: z.string().uuid(),
    query: z.string().min(1).max(4000),
    chosenPaperId: z.string().max(200).optional(),
    newSession: z.boolean().optional(),
    // assist = 非研究台的最小侧边会话；explore = 探索台的旅拍规划会话；
    // swarm = 研究台群研的负责人会话（澄清阶段）。
    // creative_advisor / creative_writer：创作台的设定顾问与写作助手（1B 契约 §5.2）。
    mode: z.enum(["assist", "explore", "swarm", "creative_advisor", "creative_writer"]).optional(),
    /** 写作助手要指定作品与场景。 */
    workId: z.string().uuid().optional(),
    sceneId: z.string().min(1).max(64).optional(),
    /** 这一轮随消息带上的参考图（探索台）。 */
    refIds: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();

export type KernelRunApiDependencies = {
  db: Database;
  /** 内核服务；只挂创作台助手时可以不传（其余模式会明确说内核没就绪）。 */
  kernel?: KernelService;
  /** 创作台的顾问 / 写作助手：跑在控制面，但沿用 run 与事件流。 */
  creative?: {
    advisor?: import("../creative/advisor").AdvisorDeps;
    writer?: import("../creative/writer").WriterDeps;
    /** 29 号：多轮会话的模型通道（带工具）。 */
    chat?: import("../creative/assistant-session").ChatDeps;
  };
  /** 群研的发起走这一档：建 swarm_run 而不是普通精读运行。 */
  swarm?: import("../swarm/service").SwarmService;
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
    let creativeMode: "creative_advisor" | "creative_writer" | undefined;
    let lastInput:
      | { newSession?: boolean; mode?: "assist" | "explore" | "swarm" | "creative_advisor" | "creative_writer" }
      | undefined;
    const response = await mutate(c, dependencies.db, Create, async (client, input) => {
      const dossier = (
        await client.query(
          "select id,bench from dossier where id=$1 and account_id=$2",
          [input.dossierId, account],
        )
      ).rows[0];
      if (!dossier) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "档案不存在。");
      // 创作台的会话：建 run 行，真正回答在事务外跑（页面按 runId 订阅同一条事件流）。
      if (input.mode === "creative_advisor" || input.mode === "creative_writer") {
        if (!dependencies.creative)
          throw new ApiFailure("CREATIVE_ASSISTANT_UNAVAILABLE", 503, "创作台助手尚未就绪。");
        const runId = await createCreativeRun(client, account, {
          dossierId: input.dossierId,
          mode: input.mode,
          query: input.query,
          ...(input.workId ? { workId: input.workId } : {}),
          ...(input.sceneId ? { sceneId: input.sceneId } : {}),
        });
        created = runId;
        creativeMode = input.mode;
        // 形状和精读/探索那一档一致（sessionId/resume 这里没有：会话跑在控制面，不是内核子进程）
        const body = { id: runId, sessionId: null, resume: null } as unknown as JsonValue;
        return { status: 201 as const, body };
      }
      // 群研：同一个档案上只留一个没结束的运行，重连/重复点开的还是它。
      if (input.mode === "swarm") {
        if (dossier.bench !== "research")
          throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有研究档案能开群研。");
        if (!dependencies.swarm)
          throw new ApiFailure("SWARM_UNAVAILABLE", 503, "群研服务尚未就绪。");
        lastInput = input;
        const record = await dependencies.swarm.createRun(
          client,
          account,
          input.dossierId,
          input.query,
        );
        created = record.runId;
        return { status: 201, body: { id: record.runId } };
      }
      // 研究台跑精读；探索台跑旅拍规划；其它台的最小侧边会话（assist）只做档案操作。
      const mode = input.mode === "explore" ? "explore" : input.mode === "assist" ? "assist" : "read";
      if (mode === "read" && dossier.bench !== "research")
        throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有研究档案可以精读。");
      if (mode === "explore" && dossier.bench !== "exploration")
        throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有探索档案能开旅拍规划会话。");
      if (!dependencies.kernel)
        throw new ApiFailure("KERNEL_UNAVAILABLE", 503, "内核尚未就绪，这一档先用不了。");
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
    if (creativeMode) {
      // 创作台会话跑在控制面里：一条消息一条事件，页面照常订阅 /v1/kernel/runs/:id/stream。
      void runCreativeSession(
        {
          db: dependencies.db,
          ...(dependencies.creative?.advisor ? { advisor: dependencies.creative.advisor } : {}),
          ...(dependencies.creative?.writer ? { writer: dependencies.creative.writer } : {}),
          ...(dependencies.creative?.chat ? { chat: dependencies.creative.chat } : {}),
        },
        account,
        created,
      ).catch((error) => {
        console.error(
          JSON.stringify({ code: "CREATIVE_SESSION_FAILED", message: String((error as Error)?.message ?? error).slice(0, 200) }),
        );
      });
      return response;
    }
    if (lastInput?.mode === "swarm") {
      // 返回形状和精读那一档一致（`id` 是运行 id），前端不用分叉。
      const started = await dependencies.swarm!.begin(
        account,
        created,
        (lastInput as { query: string }).query,
      );
      return c.json(
        { id: created, sessionId: started.sessionId, resume: started.resume },
        201,
      );
    }
    const started = await dependencies.kernel!.submit(account, created, {
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
        const startedAt = Date.now();
        const MAX_MS = 30 * 60_000;
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
                // 运行行不见了（被清理）：没有更多事件，直接收尾。
                return { events: rows, current: run ? String(run.state) : "missing" };
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
              const done = ["completed", "failed", "cancelled", "interrupted", "missing"].includes(state);
              if (done && !events.length) {
                push({ done: true, state });
                finish();
                return;
              }
              // 兜底：极长的一轮（或页面早走没断干净）不要一直占着连接。
              if (Date.now() - startedAt > MAX_MS) {
                push({ done: true, state: state || "timeout" });
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
      candidateIds?: unknown;
      text?: unknown;
    };
    const one = typeof body.candidateId === "string" && body.candidateId !== "" ? body.candidateId : null;
    // 多选和单选同一套：多选传 candidateIds，单选传 candidateId；两个都给时都算上。
    const many = Array.isArray(body.candidateIds)
      ? body.candidateIds
          .filter((value): value is string => typeof value === "string" && value !== "")
          .map((value) => value.slice(0, 200))
          .slice(0, 20)
      : [];
    const candidateIds = [...new Set([...(one ? [one] : []), ...many])];
    const candidateId = candidateIds[0] ?? null;
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
        [id, JSON.stringify({ ...(row.effects ?? {}), answer: { candidateId, candidateIds, text } })],
      );
      await client.query(
        "update approval set state='approved', decided_at=now(), decided_scope='once' where id=$1",
        [id],
      );
      // 一回合里问了好几个问题：都答完才续上，一次把这一批回答交回去（和 DSH 里的体验一样）。
      // 只算这一回合提的卡（最近一回合开始之后建的），已经交回去过的不再算。
      const sinceTurn = `coalesce((select max(t.started_at) from dsh_turn t where t.run_id=$2), '-infinity'::timestamptz)`;
      const waiting = Number(
        (
          await client.query(
            `select count(*)::int n from approval
              where account_id=$1 and run_id=$2 and kind='question' and state='pending'
                and created_at >= ${sinceTurn}`,
            [account, row.run_id],
          )
        ).rows[0]?.n ?? 0,
      );
      if (waiting > 0)
        return c.json({ id, state: "approved", answer: { candidateId, candidateIds, text }, waitingFor: waiting });
      // 用户答完就按同一会话续上，把回答作为这一轮的输入送回原任务。
      if (row.run_state === "waiting") {
        const batch = (
          await client.query(
            `select id,title,effects->'answer' as answer from approval
              where account_id=$1 and run_id=$2 and kind='question' and state='approved'
                and consumed_at is null and created_at >= ${sinceTurn}
              order by created_at`,
            [account, row.run_id],
          )
        ).rows as Array<{ id: string; title: string; answer: { candidateIds?: string[]; text?: string | null } | null }>;
        const said = (answer: { candidateIds?: string[]; text?: string | null } | null) =>
          `${answer?.candidateIds?.length ? `用户选择了 ${answer.candidateIds.join("、")}。` : ""}${answer?.text ? "补充：" + answer.text : ""}`;
        const prompt =
          batch.length > 1
            ? `用户依次回答了这 ${batch.length} 个提问：\n${batch
                .map((card, index) => `${index + 1}.「${String(card.title).slice(0, 120)}」（审批 ${card.id}）${said(card.answer)}`)
                .join("\n")}\n继续原来的任务。`
            : `用户已回答这次提问（审批 ${id}）。${said({ candidateIds, text })} 继续原来的任务。`;
        await client.query("update approval set consumed_at=now() where id = any($1::uuid[])", [
          batch.length ? batch.map((card) => card.id) : [id],
        ]);
        void dependencies.kernel?.resumeAfterAnswer(account, row.run_id, prompt).catch(() => {});
      }
      return c.json({ id, state: "approved", answer: { candidateId, candidateIds, text } });
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
        // 精读运行选好的材料：页面据此认「已经选好这篇」，不再问「想读哪篇」。
        chosenPaperId: (run.input as { chosenPaperId?: string })?.chosenPaperId ?? null,
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

  /** 29 号：续一句——同一会话追加一轮（多轮上下文），回复走同一条事件流。 */
  app.post("/v1/kernel/runs/:id/messages", async (c) => {
    const account = c.get("accountId");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
    const parsed = MessageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new ApiFailure("INVALID_INPUT", 400, "请求字段不符合要求，请检查输入。");
    const row = await dependencies.db.withAccount(account, async (client) => {
      const run = (
        await client.query<{ mode: string; state: string }>(
          "select mode, state from run where account_id=$1 and id=$2",
          [account, id],
        )
      ).rows[0];
      return run ?? null;
    });
    if (!row || row.mode !== "creative")
      throw new ApiFailure("RUN_NOT_FOUND", 404, "这不是创作台会话。");
    void runTurn(
      { db: dependencies.db, ...(dependencies.creative?.chat ? { chat: dependencies.creative.chat } : {}) },
      account,
      id,
      parsed.data.query,
    ).catch((error) => {
      console.error(
        JSON.stringify({ code: "CREATIVE_TURN_FAILED", message: String((error as Error)?.message ?? error).slice(0, 200) }),
      );
    });
    return c.json({ id, state: "running" }, 202);
  });

  app.post("/v1/kernel/runs/:id/cancel", async (c) => {
    const account = c.get("accountId");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success)
      throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
    if (!dependencies.kernel) {
      // 创作台会话没有内核子进程：直接把运行标成 cancelled。
      await dependencies.db.withAccount(account, async (client) => {
        await client.query(
          "update run set state='cancelled', ended_at=now() where account_id=$1 and id=$2 and state in ('queued','running')",
          [account, id],
        );
      });
      return c.json({ id, state: "cancelled" });
    }
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
      // D6：这一条一次能回 0.8MB，前端 2.5 秒拉一次会把连接耗光。
      // 现在支持按 action 过滤 + 限制条数（默认 200，最多 1000），并且只回最必要的字段。
      const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200) || 200, 1), 1000);
      const actions = String(c.req.query("actions") ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20);
      const rows = (
        await client.query(
          `select seq,kind,action,payload,at from event
           where run_id=$1 and account_id=$2 and seq>$3
             and ($4::text[] is null or action = any($4::text[]))
           order by seq limit $5`,
          [id, c.get("accountId"), after, actions.length ? actions : null, limit + 1],
        )
      ).rows;
      return c.json({
        cursor: rows.length ? Number(rows[Math.min(rows.length, limit) - 1].seq) : after,
        hasMore: rows.length > limit,
        events: rows.slice(0, limit).map((row) => ({
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
