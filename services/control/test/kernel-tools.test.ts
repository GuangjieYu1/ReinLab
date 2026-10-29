import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { KernelAuth } from "../src/kernel/auth";
import { registerKernelTools } from "../src/api/kernel-tools";
import { ApiFailure } from "../src/api/errors";

const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 3,
});
const db = new Database(pool);
const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
const now = 1_800_000_000;
const account = randomUUID();
const dossier = randomUUID();
const runId = randomUUID();
const token = auth.issue({ account, dossier, run: runId }, now);

function build(dispatch = vi.fn(async () => ({ ok: true, dispatched: true }))) {
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof ApiFailure
      ? c.json({ error: error.code }, error.status)
      : c.json({ error: "UNEXPECTED" }, 500),
  );
  registerKernelTools(app, { auth, db, now: () => now + 1, dispatch });
  return { app, dispatch };
}

const call = async (
  app: Hono,
  body: Record<string, unknown>,
  bearer: string | null = token,
) => {
  const response = await app.request("/kernel/tool", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { "x-api-key": bearer } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','dsh','/data/dossiers/'||$1::text)",
    [dossier, account],
  );
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'running',1,'{"chosenPaperId":"arxiv:2302.04761v1"}')`,
    [runId, account, dossier, randomUUID()],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const events = (run: string, action: string) =>
  admin.query("select payload from event where run_id=$1 and action=$2", [run, action]).then((r) => r.rows);

const downloadRun = (await import("node:crypto")).randomUUID();
describe("kernel tool gateway", () => {
  /** 一次下载走一个自己的 run：选定编号不同，审批与资产天然分开。 */
  const runFor = async (chosen: string) => {
    const id = randomUUID();
    await admin.query(
      `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'running',1,$5)`,
      [id, account, dossier, randomUUID(), JSON.stringify(chosen ? { chosenPaperId: chosen } : {})],
    );
    return { id, token: auth.issue({ account, dossier, run: id }, now) };
  };

  it("只读选定这一篇：别的论文、以及同一篇的另一种写法", async () => {
    const dispatch = vi.fn(async () => ({ assetId: "asset-chosen", status: "full_text" }));
    const { app } = build(dispatch);
    const chosenRun = await runFor("arxiv:2403.05521");
    const other = await call(
      app,
      { server: "papers", tool: "fetch", args: { paperId: "arxiv:2404.00001" } },
      chosenRun.token,
    );
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: "PAPER_NOT_CHOSEN" });
    expect(dispatch).not.toHaveBeenCalled();

    // 同一篇的带版本号写法不另开一张卡。
    const samePaper = await call(
      app,
      { server: "papers", tool: "fetch", args: { paperId: "arXiv:2403.05521v3" } },
      chosenRun.token,
    );
    expect(samePaper.status).toBe(409);
    expect(samePaper.body).toMatchObject({ state: "pending" });
  });

  it("用户没选定论文时拒绝下载，先把候选交出去", async () => {
    const dispatch = vi.fn(async () => ({ assetId: "asset-x", status: "full_text" }));
    const { app } = build(dispatch);
    const clarify = await runFor("");
    const refused = await call(
      app,
      { server: "papers", tool: "fetch", args: { paperId: "arxiv:2404.00001" } },
      clarify.token,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "PAPER_NOT_CHOSEN" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a foreign token and tools outside the reading surface", async () => {
    const { app, dispatch } = build();
    expect((await call(app, { server: "papers", tool: "search", args: {} }, null)).status).toBe(401);
    expect((await call(app, { server: "papers", tool: "search", args: {} }, "nope")).status).toBe(401);
    expect((await call(app, { server: "files", tool: "write", args: {} })).status).toBe(403);
    expect((await call(app, { server: "papers", tool: "delete", args: {} })).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("forwards an in-scope read tool and reports the dispatch result", async () => {
    const { app, dispatch } = build(vi.fn(async () => ({ papers: [{ paperId: "W1" }] })));
    const result = await call(app, { server: "papers", tool: "search", args: { query: "toolformer" } });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ result: { papers: [{ paperId: "W1" }] } });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ account, dossier, run: runId, server: "papers", tool: "search" }),
    );
  });

  it("shows exactly one download card and only downloads after it is approved", async () => {
    const dispatch = vi.fn(async () => ({ assetId: "asset-1", status: "full_text" }));
    const { app } = build(dispatch);
    const own = await runFor("arxiv:2302.04771");
    const first = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04771" } }, own.token);
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ state: "pending" });
    const approvalId = (first.body as { approvalId: string }).approvalId;
    expect(dispatch).not.toHaveBeenCalled();

    // The same concrete action asks again but still yields that one card.
    const repeat = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04771" } }, own.token);
    expect((repeat.body as { approvalId: string }).approvalId).toBe(approvalId);
    const cards = await admin.query(
      "select count(*)::int n from approval where account_id=$1 and run_id=$2 and effect_key is not null",
      [account, own.id],
    );
    expect(cards.rows[0].n).toBe(1);

    // Not approved yet: passing the id still cannot execute.
    const premature = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "arxiv:2302.04771" },
      approvalId,
    }, own.token);
    expect(premature.status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();

    const decided = await app.request(`/kernel/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": own.token },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect((await decided.json()) as { state: string }).toEqual({ state: "approved" });

    const approved = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "arxiv:2302.04771" },
      approvalId,
    }, own.token);
    expect(approved.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never downloads twice for one approved action", async () => {
    const dispatch = vi.fn(async () => ({ assetId: "asset-2", status: "full_text" }));
    const { app } = build(dispatch);
    const own = await runFor("arxiv:2302.04772");
    const first = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04772" } }, own.token);
    const approvalId = (first.body as { approvalId: string }).approvalId;
    await app.request(`/kernel/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": own.token },
      body: JSON.stringify({ decision: "approve" }),
    });
    await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04772" }, approvalId }, own.token);
    const again = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "arxiv:2302.04772" },
      approvalId,
    }, own.token);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ result: { assetId: expect.any(String), reused: true } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("把工具失败报成错误码加一句原因，而不是只有 KERNEL_TOOL_HTTP_500", async () => {
    const known = build(
      vi.fn(async () => {
        throw new ApiFailure("PAPERS_UPSTREAM_STATUS", 503, "检索来源返回 429，暂不可用。");
      }),
    );
    const upstream = await call(known.app, { server: "papers", tool: "search", args: { query: "x" } });
    expect(upstream.status).toBe(503);
    expect(upstream.body).toMatchObject({
      code: "PAPERS_UPSTREAM_STATUS",
      message: "检索来源返回 429，暂不可用。",
    });

    const silent = vi.spyOn(console, "error").mockImplementation(() => {});
    const unexpected = build(
      vi.fn(async () => {
        throw new Error("boom: unexpected");
      }),
    );
    const crashed = await call(unexpected.app, { server: "papers", tool: "search", args: { query: "x" } });
    expect(crashed.status).toBe(500);
    expect(crashed.body).toMatchObject({ code: "KERNEL_TOOL_FAILED" });
    expect(String((crashed.body as { message: string }).message)).toContain("boom");
    silent.mockRestore();
  });

  it("stops without dispatching when the user rejects the download", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { app } = build(dispatch);
    const own = await runFor("arxiv:2302.04773");
    const first = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04773" } }, own.token);
    const approvalId = (first.body as { approvalId: string }).approvalId;
    await app.request(`/kernel/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": own.token },
      body: JSON.stringify({ decision: "reject" }),
    });
    const rejected = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "arxiv:2302.04773" },
      approvalId,
    }, own.token);
    expect(rejected.status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
    const poll = await app.request(`/kernel/approvals/${approvalId}`, {
      headers: { "x-api-key": own.token },
    });
    expect((await poll.json()) as { state: string }).toEqual({ state: "rejected" });
  });

  it("课程计划：一次批准既确认计划又入档，不重复索要", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { app } = build(dispatch);
    const own = await runFor("");
    const plan = { goal: "两周内理解注意力机制", steps: [{ title: "读原文" }, { title: "手推公式" }] };

    // 未批准：交出确认卡，不写入档案。
    const first = await call(app, { server: "courses", tool: "plan", args: plan }, own.token);
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ state: "pending" });
    const approvalId = (first.body as { approvalId: string }).approvalId;
    expect(await events(own.id, "course_plan_created")).toHaveLength(0);

    // 同一份计划重复提交仍返回同一张卡。
    const again = await call(app, { server: "courses", tool: "plan", args: plan }, own.token);
    expect((again.body as { approvalId: string }).approvalId).toBe(approvalId);

    // 批准后同一次动作入档，且只写一次。
    await app.request(`/kernel/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": own.token },
      body: JSON.stringify({ decision: "approve" }),
    });
    const archived = await call(app, { server: "courses", tool: "plan", args: plan }, own.token);
    expect(archived.status).toBe(200);
    expect((archived.body as { result?: { state?: string } }).result).toMatchObject({ state: "archived" });
    expect(await events(own.id, "course_plan_created")).toHaveLength(1);

    // 重试不再写入第二份。
    await call(app, { server: "courses", tool: "plan", args: plan }, own.token);
    expect(await events(own.id, "course_plan_created")).toHaveLength(1);
  });

  it("一个 run 的等待超时不会过期另一个 run 的审批", async () => {
    const dispatch = vi.fn(async () => ({ assetId: "asset-scope", status: "full_text" }));
    const { app } = build(dispatch);
    // 两段运行各有一张待批卡：上一段（比如被取消的澄清）等待超时，不能碰这一张。
    const older = await runFor("arxiv:2302.04791");
    const current = await runFor("arxiv:2302.04792");
    const olderCard = (await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04791" } }, older.token)).body as { approvalId: string };
    const currentCard = (await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04792" } }, current.token)).body as { approvalId: string };

    // 旧 run 的等待者超时，只能过期自己那张。
    await app.request(`/kernel/approvals/${currentCard.approvalId}/expire`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": older.token },
      body: "{}",
    });

    const stillPending = await admin.query(
      "select id,state from approval where id=$1",
      [currentCard.approvalId],
    );
    expect(stillPending.rows[0]).toMatchObject({ state: "pending" });
    const olderState = await admin.query("select state from approval where id=$1", [olderCard.approvalId]);
    expect(olderState.rows[0]).toMatchObject({ state: "pending" });
  });

  it("审批过期后再次请求同一动作，新建一张卡而不是回 409", async () => {
    const dispatch = vi.fn(async () => ({ assetId: "asset-reask", status: "full_text" }));
    const { app } = build(dispatch);
    const own = await runFor("arxiv:2302.04781");
    const first = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04781" } }, own.token);
    const staleId = (first.body as { approvalId: string }).approvalId;
    expect(first.status).toBe(409);

    // 人一直没点：插件把这张卡标成过期。
    await app.request(`/kernel/approvals/${staleId}/expire`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": own.token },
      body: "{}",
    });

    // 同一动作再来一次：必须是新的一张待批卡，让人还能批下来。
    const again = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04781" } }, own.token);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ state: "pending" });
    const freshId = (again.body as { approvalId: string }).approvalId;
    expect(freshId).not.toBe(staleId);

    // 但任何时候只留一张有效卡：旧的过期卡不再算有效。
    const live = await admin.query(
      "select id from approval where account_id=$1 and run_id=$2 and state='pending'",
      [account, own.id],
    );
    expect(live.rows.map((r) => r.id)).toEqual([freshId]);

    // 新卡批下来就能下载。
    await app.request(`/kernel/approvals/${freshId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": own.token },
      body: JSON.stringify({ decision: "approve" }),
    });
    const approved = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "arxiv:2302.04781" },
      approvalId: freshId,
    }, own.token);
    expect(approved.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("已过期的卡不会被当成有效卡：同一动作拿到的永远是当前那张", async () => {
    const dispatch = vi.fn(async () => ({ assetId: "asset-one-live", status: "full_text" }));
    const { app } = build(dispatch);
    const own = await runFor("arxiv:2302.04782");
    const first = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04782" } }, own.token);
    const staleId = (first.body as { approvalId: string }).approvalId;
    await app.request(`/kernel/approvals/${staleId}/expire`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": own.token },
      body: "{}",
    });
    const second = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04782" } }, own.token);
    const freshId = (second.body as { approvalId: string }).approvalId;
    // 再来一次仍返回新卡，不会退回那张过期卡。
    const third = await call(app, { server: "papers", tool: "fetch", args: { paperId: "arxiv:2302.04782" } }, own.token);
    expect((third.body as { approvalId: string }).approvalId).toBe(freshId);
    // 用过期卡的 id 批不动这一轮。
    const withStale = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "arxiv:2302.04782" },
      approvalId: staleId,
    }, own.token);
    expect(withStale.status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
