import { afterAll, beforeAll, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { allocateBudget, increaseRunBudget, lockBudget } from "../src/budget";
import {
  RunBridge,
  type RunDefinition,
} from "../src/bridge/openscience/run-bridge";
import type { RoleRuntime } from "../src/bridge/openscience/role-runtime";
const admin = new pg.Pool({
  connectionString: "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const app = "run_bridge_review_" + randomUUID().replaceAll("-", "");
const pool = new pg.Pool({
  connectionString: "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  application_name: app,
  max: 3,
});
const actorPool = new pg.Pool({
  connectionString: "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const db = new Database(pool),
  actor = new Database(actorPool),
  account = randomUUID();
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
});
afterAll(async () => {
  await pool.end();
  await actorPool.end();
  await admin.end();
});
async function fixture(amount = "1") {
  const dossier = randomUUID(),
    run = randomUUID(),
    request = randomUUID();
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','review',$3)",
    [dossier, account, "/data/dossiers/" + dossier],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'queued',1,'{}')",
    [run, account, dossier, request],
  );
  await db.withAccount(account, async (c) => {
    const parent = await allocateBudget(c, account, {
      dossierId: dossier,
      amountCny: amount,
    });
    await allocateBudget(c, account, {
      dossierId: dossier,
      runId: run,
      parentId: parent.id,
      amountCny: amount,
    });
  });
  const definition: RunDefinition = {
    role: {
      dossierId: dossier,
      role: {
        id: "research-read",
        prompt: "fixture",
        toolGrants: {},
        writeTargets: [],
        steps: 1,
      },
      model: "fixture/model",
      memory: "",
    },
    message: "fixture",
  };
  let prompts = 0;
  let snapshotRuns: any[] = [];
  const runtime = {
    async capabilities() {
      return {
        protocolVersion: "1.0",
        serverVersion: "2.0.150",
        idempotentPrompts: true,
        runSnapshots: true,
        crashRecovery: "interrupt",
      };
    },
    async createSession() {},
    async restoreSession() {},
    async snapshot() {
      return { runs: snapshotRuns, latestSequence: 0 };
    },
    async prompt(input: any) {
      prompts++;
      const held = await admin.query(
        "select b.phase,b.request_id,b.hold_id,h.state from os_binding b left join budget_hold h on h.id=b.hold_id where b.run_id=$1",
        [run],
      );
      expect(held.rows[0]).toMatchObject({
        phase: "submitting",
        request_id: request,
        state: "reserved",
      });
      expect(held.rows[0].hold_id).toBeTruthy();
      expect(input.requestID).toBe(request);
      snapshotRuns = [
        {
          runID: "run_review",
          requestID: request,
          sessionID: input.sessionID,
          acceptedAt: 1,
          state: "running",
        },
      ];
      return { runID: "run_review", acceptedAt: 1 };
    },
  };
  return {
    run,
    request,
    definition,
    runtime,
    get prompts() {
      return prompts;
    },
    setRuns: (runs: any[]) => {
      snapshotRuns = runs;
    },
    bridge: () =>
      new RunBridge(db, async () => runtime as unknown as RoleRuntime),
  };
}
it("budget denial persists its pause and approval while admitting zero prompts", async () => {
  const f = await fixture("0.5");
  await expect(
    f.bridge().submit(account, f.run, f.definition),
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  expect(f.prompts).toBe(0);
  expect(
    (await admin.query("select state from run where id=$1", [f.run])).rows[0]
      .state,
  ).toBe("paused_budget");
  expect(
    (
      await admin.query(
        "select count(*)::int n from approval where run_id=$1 and kind='budget' and state='pending'",
        [f.run],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("concurrent budget append and admission use the same lock order", async () => {
  const f = await fixture();
  let ready!: () => void, proceed!: () => void;
  const held = new Promise<void>((done) => {
      ready = done;
    }),
    gate = new Promise<void>((done) => {
      proceed = done;
    });
  const appending = actor.withAccount(account, async (c) => {
    await lockBudget(c, account);
    ready();
    await gate;
    return increaseRunBudget(c, account, f.run, "0.1");
  });
  await held;
  const submitting = f.bridge().submit(account, f.run, f.definition);
  try {
    await expect
      .poll(
        async () =>
          Number(
            (
              await admin.query(
                "select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and wait_event='advisory'",
                [app],
              )
            ).rows[0].n,
          ),
        { timeout: 5000 },
      )
      .toBe(1);
  } finally {
    proceed();
  }
  const results = await Promise.allSettled([appending, submitting]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(f.prompts).toBe(1);
}, 15000);
it("lost acknowledgement recovers only the persisted snapshot receipt and never prompts twice", async () => {
  const f = await fixture(),
    bridge = f.bridge();
  const prompt = f.runtime.prompt.bind(f.runtime);
  f.runtime.prompt = async (input) => {
    await prompt(input);
    throw Object.assign(Error("fixture acknowledgement lost"), {
      code: "OS_UNAVAILABLE",
    });
  };
  expect((await bridge.submit(account, f.run, f.definition)).status).toBe(
    "indeterminate",
  );
  expect(f.prompts).toBe(1);
  expect(await f.bridge().submit(account, f.run, f.definition)).toEqual({
    status: "accepted",
    receipt: { runID: "run_review", acceptedAt: 1 },
  });
  expect(f.prompts).toBe(1);
});
it("a persisted intent with no upstream receipt stays unknown without a second prompt", async () => {
  const f = await fixture();
  let attempts = 0;
  f.runtime.prompt = async () => {
    attempts++;
    throw Object.assign(Error("fixture admission unknown"), {
      code: "OS_UNAVAILABLE",
    });
  };
  expect((await f.bridge().submit(account, f.run, f.definition)).status).toBe(
    "indeterminate",
  );
  for (let i = 0; i < 2; i++)
    expect((await f.bridge().submit(account, f.run, f.definition)).status).toBe(
      "indeterminate",
    );
  expect(attempts).toBe(1);
  expect(f.prompts).toBe(0);
  expect((await f.bridge().store.get(account, f.run)).phase).toBe("submitting");
});
