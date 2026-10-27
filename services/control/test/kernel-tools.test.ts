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
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'running',1,'{}')",
    [runId, account, dossier, randomUUID()],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("kernel tool gateway", () => {
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
    const first = await call(app, { server: "papers", tool: "fetch", args: { paperId: "W-fetch-1" } });
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ state: "pending" });
    const approvalId = (first.body as { approvalId: string }).approvalId;
    expect(dispatch).not.toHaveBeenCalled();

    // The same concrete action asks again but still yields that one card.
    const repeat = await call(app, { server: "papers", tool: "fetch", args: { paperId: "W-fetch-1" } });
    expect((repeat.body as { approvalId: string }).approvalId).toBe(approvalId);
    const cards = await admin.query(
      "select count(*)::int n from approval where account_id=$1 and run_id=$2 and effect_key is not null",
      [account, runId],
    );
    expect(cards.rows[0].n).toBe(1);

    // Not approved yet: passing the id still cannot execute.
    const premature = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "W-fetch-1" },
      approvalId,
    });
    expect(premature.status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();

    const decided = await app.request(`/kernel/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect((await decided.json()) as { state: string }).toEqual({ state: "approved" });

    const approved = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "W-fetch-1" },
      approvalId,
    });
    expect(approved.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never downloads twice for one approved action", async () => {
    const dispatch = vi.fn(async () => ({ assetId: "asset-2", status: "full_text" }));
    const { app } = build(dispatch);
    const first = await call(app, { server: "papers", tool: "fetch", args: { paperId: "W-fetch-2" } });
    const approvalId = (first.body as { approvalId: string }).approvalId;
    await app.request(`/kernel/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify({ decision: "approve" }),
    });
    await call(app, { server: "papers", tool: "fetch", args: { paperId: "W-fetch-2" }, approvalId });
    const again = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "W-fetch-2" },
      approvalId,
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ result: { assetId: expect.any(String), reused: true } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("stops without dispatching when the user rejects the download", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { app } = build(dispatch);
    const first = await call(app, { server: "papers", tool: "fetch", args: { paperId: "W-fetch-3" } });
    const approvalId = (first.body as { approvalId: string }).approvalId;
    await app.request(`/kernel/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify({ decision: "reject" }),
    });
    const rejected = await call(app, {
      server: "papers",
      tool: "fetch",
      args: { paperId: "W-fetch-3" },
      approvalId,
    });
    expect(rejected.status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
    const poll = await app.request(`/kernel/approvals/${approvalId}`, {
      headers: { "x-api-key": token },
    });
    expect((await poll.json()) as { state: string }).toEqual({ state: "rejected" });
  });
});
