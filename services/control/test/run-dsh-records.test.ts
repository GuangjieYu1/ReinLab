import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { recordUsage, runUsage } from "../src/run/usage";
import {
  confirmRelease,
  ensureSession,
  leaseSession,
  markReleaseUnconfirmed,
} from "../src/run/session";
import {
  consumeApproval,
  decideApproval,
  effectKeyOf,
  requestApproval,
} from "../src/run/approval";

const admin = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 3,
});
const db = new Database(pool);
const account = randomUUID(),
  dossier = randomUUID(),
  otherDossier = randomUUID();
const sessionId = "ds-" + randomUUID();

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
  for (const id of [dossier, otherDossier])
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','dsh','/data/dossiers/'||$1::text)",
      [id, account],
    );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function run(): Promise<string> {
  const id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'running',1,'{}')",
    [id, account, dossier, randomUUID()],
  );
  return id;
}

describe("usage recording", () => {
  it("records known usage and reports it separately from completion", async () => {
    const runId = await run();
    await db.withAccount(account, async (client) => {
      await recordUsage(client, {
        account,
        dossier,
        run: runId,
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        known: true,
        inputTokens: 120,
        outputTokens: 45,
        cacheReadTokens: 30,
        cacheWriteTokens: null,
        costCny: "0.004200",
      });
      expect(await runUsage(client, runId)).toMatchObject({ known: true, requests: 1, unknownRequests: 0, knownCny: "0.004200" });
      const row = (
        await client.query("select known,input_tokens,output_tokens,cache_read_tokens,cost_cny::text from usage_record where run_id=$1", [runId])
      ).rows[0];
      expect(row).toMatchObject({ known: true, input_tokens: 120, output_tokens: 45, cache_read_tokens: 30 });
    });
    // The run keeps running: usage never gates completion.
    expect((await admin.query("select state from run where id=$1", [runId])).rows[0].state).toBe("running");
  });

  it("stores missing provider usage as unknown, never as zero", async () => {
    const runId = await run();
    await db.withAccount(account, async (client) => {
      await recordUsage(client, {
        account,
        dossier,
        run: runId,
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        known: false,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costCny: null,
      });
      const state = await runUsage(client, runId);
      expect(state).toMatchObject({ known: false, requests: 1, unknownRequests: 1, knownCny: null });
      const row = (
        await client.query("select input_tokens,output_tokens,cost_cny from usage_record where run_id=$1", [runId])
      ).rows[0];
      expect(row).toEqual({ input_tokens: null, output_tokens: null, cost_cny: null });
    });
    await expect(
      db.withAccount(account, (client) =>
        recordUsage(client, {
          account,
          dossier,
          run: runId,
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
          known: true,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "USAGE_INCOMPLETE" });
  });
});

describe("session write lease", () => {
  it("keeps one writer per session and leaves other dossiers free", async () => {
    const sessionId = "ds-" + randomUUID();
    const first = await run(), second = await run();
    await db.withAccount(account, async (client) => {
      await ensureSession(client, { account, dossier, sessionId, homePath: "/data/dsh-home/accounts/x" });
      expect(await leaseSession(client, { account, dossier, sessionId, run: first })).toBe(true);
      expect(await leaseSession(client, { account, dossier, sessionId, run: second })).toBe(false);
      await ensureSession(client, { account, dossier: otherDossier, sessionId, homePath: "/data/dsh-home/accounts/x" });
      expect(await leaseSession(client, { account, dossier: otherDossier, sessionId, run: second })).toBe(true);
      expect(await confirmRelease(client, { account, dossier, sessionId, run: first })).toBe(true);
      expect(await leaseSession(client, { account, dossier, sessionId, run: second })).toBe(true);
    });
  });

  it("an unconfirmed stop keeps the session closed instead of expiring into a takeover", async () => {
    const sessionId = "ds-" + randomUUID();
    const runId = await run();
    await db.withAccount(account, (client) =>
      ensureSession(client, { account, dossier: otherDossier, sessionId, homePath: "/data/dsh-home/accounts/y" }),
    );
    await db.withAccount(account, async (client) => {
      expect(await leaseSession(client, { account, dossier: otherDossier, sessionId, run: runId })).toBe(true);
      await markReleaseUnconfirmed(client, { account, dossier: otherDossier, sessionId, run: runId });
    });
    // Even with an expired heartbeat, the unconfirmed lease blocks another writer.
    await admin.query(
      "update dsh_session set leased_until=now()-interval '1 hour' where dossier_id=$1 and session_id=$2",
      [otherDossier, sessionId],
    );
    const other = await run();
    await db.withAccount(account, async (client) => {
      expect(await leaseSession(client, { account, dossier: otherDossier, sessionId, run: other })).toBe(false);
    });
  });
});

describe("single approval", () => {
  it("binds one card per concrete action and consumes it exactly once", async () => {
    const runId = await run();
    const argsHash = "a".repeat(64);
    const key = effectKeyOf("papers.fetch", argsHash);
    await db.withAccount(account, async (client) => {
      const first = await requestApproval(client, {
        account,
        dossier,
        run: runId,
        capability: "papers.fetch",
        argsHash,
        title: "下载论文全文",
        effects: [{ capability: "papers.fetch", argsHash }],
        risk: "write",
      });
      const again = await requestApproval(client, {
        account,
        dossier,
        run: runId,
        capability: "papers.fetch",
        argsHash,
        title: "下载论文全文",
        effects: [{ capability: "papers.fetch", argsHash }],
        risk: "write",
      });
      expect(again.id).toBe(first.id);
      expect(first.state).toBe("pending");
      expect(await consumeApproval(client, { approvalId: first.id, effectKey: key })).toBe(false);
      const decided = await decideApproval(client, { approvalId: first.id, decision: "approve" });
      expect(decided).toMatchObject({ state: "approved", decision: "approve", consumed: false });
      expect(await consumeApproval(client, { approvalId: first.id, effectKey: key })).toBe(true);
      // A repeat submission of the same action must not execute a second time.
      expect(await consumeApproval(client, { approvalId: first.id, effectKey: key })).toBe(false);
      const cards = (
        await client.query("select count(*)::int n from approval where account_id=$1 and run_id=$2", [account, runId])
      ).rows[0].n;
      expect(cards).toBe(1);
    });
  });

  it("asks again when the arguments change and never consumes a rejection", async () => {
    const runId = await run();
    const firstHash = "b".repeat(64),
      secondHash = "c".repeat(64);
    await db.withAccount(account, async (client) => {
      const one = await requestApproval(client, {
        account, dossier, run: runId, capability: "papers.fetch", argsHash: firstHash,
        title: "下载论文全文", effects: [], risk: "write",
      });
      const two = await requestApproval(client, {
        account, dossier, run: runId, capability: "papers.fetch", argsHash: secondHash,
        title: "下载论文全文", effects: [], risk: "write",
      });
      expect(two.id).not.toBe(one.id);
      await decideApproval(client, { approvalId: two.id, decision: "reject" });
      expect(await consumeApproval(client, { approvalId: two.id, effectKey: effectKeyOf("papers.fetch", secondHash) })).toBe(false);
    });
  });
});
