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
    // 非研究台的最小侧边会话：只带档案工具，不读论文。
    mode: z.enum(["assist"]).optional(),
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
    let lastInput: { newSession?: boolean; mode?: "assist" } | undefined;
    const response = await mutate(c, dependencies.db, Create, async (client, input) => {
      const dossier = (
        await client.query(
          "select id,bench from dossier where id=$1 and account_id=$2",
          [input.dossierId, account],
        )
      ).rows[0];
      if (!dossier) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "档案不存在。");
      // 研究台跑精读；其它台的最小侧边会话（assist）只做档案操作。
      if (dossier.bench !== "research" && input.mode !== "assist")
        throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有研究档案可以精读。");
      lastInput = input;
      const runId = randomUUID();
      await client.query(
        `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
         values($1,$2,$3,$4,$5,$6,'queued',1,$7)`,
        [
          runId,
          account,
          input.dossierId,
          input.mode === "assist" ? "bench-assist" : "research-read",
          input.mode === "assist" ? "assist" : "read",
          randomUUID(),
          JSON.stringify({
            query: input.query,
            ...(input.chosenPaperId ? { chosenPaperId: input.chosenPaperId } : {}),
          }),
        ],
      );
      created = runId;
      return { status: 201, body: { id: runId } };
    });
    // The kernel starts after the run row commits; it opens its own transaction.
    if (!created) return response;
    const started = await dependencies.kernel.submit(account, created, {
      ...(lastInput?.mode === "assist" ? { mode: "assist" as const } : {}),
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
