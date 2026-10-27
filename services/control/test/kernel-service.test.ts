import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { KernelAuth } from "../src/kernel/auth";
import { KernelService } from "../src/kernel/service";
import type { HarnessFactory } from "../src/kernel/dsh/session";

const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 4,
});
const db = new Database(pool);
const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
const account = randomUUID();
const dossier = randomUUID();
const HOME = mkdtempSync(join(tmpdir(), "kernel-service-"));

const io = {
  mkdir: async (path: string) => void (await mkdir(path, { recursive: true, mode: 0o700 })),
  write: async (path: string, body: string) => void (await writeFile(path, body, { mode: 0o600 })),
  remove: async (path: string) => void (await rm(path, { force: true })),
};

function service(factory: HarnessFactory) {
  process.env.REINLAB_CONTROL_URL = "http://control:3001";
  return new KernelService({
    db,
    auth,
    factory,
    model: "deepseek-v4-flash",
    maxTokens: 4096,
    layout: {
      home: HOME,
      shimModule: "/app/shim.mjs",
      shimContainerModule: "/app/shim.mjs",
      dshModule: "/app/dsh.mjs",
      restrictPatch: "/opt/restrict.patch.yml",
      pluginEntry: "file:///opt/plugin/index.js",
      shimMode: "docker",
      io,
    },
  });
}

function completing(events: string[]): HarnessFactory {
  return () => ({
    session: () => ({
      run: async (_text, options) => {
        for (const type of events)
          options.onNotification?.({ method: "session.event", params: { event: { type, data: { note: type } } } });
        writePid("999999");
        return {
          sessionId: "ds",
          events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
          finalResponse: "done",
        };
      },
    }),
    resumeSession: async () => ({
      run: async (_text, options) => {
        for (const type of events)
          options.onNotification?.({ method: "session.event", params: { event: { type, data: { note: type } } } });
        return {
          sessionId: "ds",
          events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
          finalResponse: "done",
        };
      },
    }),
    close: async () => {},
  });
}

let pidPath = "";
function writePid(pid: string) {
  void mkdir(join(pidPath, ".."), { recursive: true }).then(() => writeFile(pidPath, pid));
}

async function newRun(roleId = "research-read", query = "读 Toolformer") {
  const id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,$4,'read',$5,'queued',1,$6)",
    [id, account, dossier, roleId, randomUUID(), JSON.stringify({ query })],
  );
  return id;
}

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','dsh','/data/dossiers/'||$1::text)",
    [dossier, account],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("kernel run service", () => {
  it("starts a run, records kernel events and completes the run and its session", async () => {
    const runId = await newRun();
    pidPath = `${HOME}/accounts/${account}/runs/${runId}/dsh.pid`;
    const kernel = service(completing(["turn/start", "tool/call", "tool/result"]));
    const started = await kernel.submit(account, runId);
    expect(started.resume).toBe(false);
    expect(started.sessionId).toMatch(/^ds-/);

    for (let i = 0; i < 100; i += 1) {
      const state = (await admin.query("select state from run where id=$1", [runId])).rows[0].state;
      if (state === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const run = (await admin.query("select state,ended_at from run where id=$1", [runId])).rows[0];
    expect(run.state).toBe("completed");
    expect(run.ended_at).not.toBeNull();
    const events = await admin.query(
      "select action from event where run_id=$1 and kind='dsh' order by seq",
      [runId],
    );
    expect(events.rows.map((row) => row.action)).toEqual(["turn/start", "tool/call", "tool/result"]);
    const turn = (await admin.query("select state from dsh_turn where run_id=$1", [runId])).rows[0];
    expect(turn.state).toBe("completed");
    const session = (
      await admin.query("select lease_run_id,lease_state from dsh_session where dossier_id=$1", [dossier])
    ).rows[0];
    expect(session).toEqual({ lease_run_id: null, lease_state: "active" });
  });

  it("reuses the dossier session and resumes it on the next run", async () => {
    const first = await newRun();
    pidPath = `${HOME}/accounts/${account}/runs/${first}/dsh.pid`;
    const one = await service(completing(["turn/start"])).submit(account, first);
    await new Promise((r) => setTimeout(r, 200));
    const second = await newRun();
    pidPath = `${HOME}/accounts/${account}/runs/${second}/dsh.pid`;
    const two = await service(completing(["turn/start"])).submit(account, second);
    expect(two.sessionId).toBe(one.sessionId);
    expect(two.resume).toBe(true);
  });

  it("refuses to write a session that another run still holds", async () => {
    const holder = await newRun();
    await admin.query(
      `insert into dsh_session(account_id,dossier_id,session_id,home_path,lease_run_id,leased_until)
       values($1,$2,'ds-held','/data/dsh-home',$3,now()+interval '10 minutes')`,
      [account, dossier, holder],
    );
    const waiting = await newRun();
    pidPath = `${HOME}/accounts/${account}/runs/${waiting}/dsh.pid`;
    await expect(service(completing([])).submit(account, waiting)).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
    await admin.query("delete from dsh_session where session_id='ds-held'");
  });

  it("cancels only after the kernel process is confirmed gone", async () => {
    const runId = await newRun();
    pidPath = `${HOME}/accounts/${account}/runs/${runId}/dsh.pid`;
    const kernel = service(() => ({
      session: () => ({ run: () => new Promise(() => {}) }),
      resumeSession: async () => ({ run: () => new Promise(() => {}) }),
      close: async () => {},
    }));
    await kernel.submit(account, runId);
    // The kernel process is dead (pid 999999): confirmation must succeed.
    await mkdir(join(pidPath, ".."), { recursive: true });
    await writeFile(pidPath, "999999");
    const status = await kernel.cancel(account, runId);
    expect(status).toBe("cancelled");
    const run = (await admin.query("select state from run where id=$1", [runId])).rows[0];
    expect(run.state).toBe("cancelled");
  });
});
