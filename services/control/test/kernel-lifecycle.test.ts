import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { reconcileAccount, reconcileOnStartup, DEFAULT_ANSWER_TTL_MS } from "../src/kernel/lifecycle";

const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 3,
});
const db = new Database(pool);
const account = randomUUID();
const dossier = randomUUID();

/** 造一个自己的任务 + 一段会话，互不干扰。 */
async function runWith(state: string, sessionLease = true) {
  const run = randomUUID();
  const session = "ds-" + randomUUID();
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,'research-read','read',$4,$5,1,'{}')`,
    [run, account, dossier, randomUUID(), state],
  );
  await admin.query(
    `insert into dsh_session(account_id,dossier_id,session_id,home_path,lease_run_id,lease_state)
     values($1,$2,$3,'/tmp/dsh',$4,'active')`,
    [account, dossier, session, sessionLease ? run : null],
  );
  return { run, session };
}

async function pendingCard(run: string, ageMs: number, effectKey: string) {
  const id = randomUUID();
  await admin.query(
    `insert into approval(id,account_id,run_id,kind,title,effects,risk,state,effect_key,created_at)
     values($1,$2,$3,'permission','下载论文全文','[]'::jsonb,'write','pending',$4,$5)`,
    [id, account, run, effectKey, new Date(Date.now() - ageMs).toISOString()],
  );
  return id;
}

const state = (run: string) =>
  admin.query("select state from run where id=$1", [run]).then((r) => r.rows[0]?.state);
const card = (id: string) =>
  admin.query("select state from approval where id=$1", [id]).then((r) => r.rows[0]?.state);
const events = (run: string, action: string) =>
  admin.query("select payload from event where run_id=$1 and action=$2", [run, action]).then((r) => r.rows);

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','lifecycle','/data/dossiers/'||$1::text)",
    [dossier, account],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("运行生命周期收尾", () => {
  it("等待超过 24 小时的请求被关闭，任务按中断收尾并说明原因", async () => {
    const own = await runWith("waiting");
    const stale = await pendingCard(own.run, DEFAULT_ANSWER_TTL_MS + 60_000, "papers.fetch:stale");

    await reconcileAccount(db, account);

    expect(await card(stale)).toBe("expired");
    expect(await state(own.run)).toBe("interrupted");
    const expired = await events(own.run, "approval.expired");
    expect(expired[0]?.payload).toMatchObject({ approvalId: stale, reason: "timeout" });
    const interrupted = await events(own.run, "run.interrupted");
    expect(interrupted[0]?.payload).toMatchObject({ reason: "answer_timeout" });
  });

  it("只等了一小时的请求不动：等待本身不是残留", async () => {
    const own = await runWith("waiting");
    const fresh = await pendingCard(own.run, 60 * 60_000, "papers.fetch:fresh");

    await reconcileAccount(db, account);

    expect(await card(fresh)).toBe("pending");
    expect(await state(own.run)).toBe("waiting");
  });

  it("刚批准的等待不算残留：续接中的任务不会被误标成中断", async () => {
    const own = await runWith("waiting");
    const id = randomUUID();
    await admin.query(
      `insert into approval(id,account_id,run_id,kind,title,effects,risk,state,effect_key,created_at,decided_at)
       values($1,$2,$3,'permission','把《示例》正式入档','[]'::jsonb,'write','approved',$4,now(),now())`,
      [id, account, own.run, "papers.register:fresh"],
    );
    await reconcileAccount(db, account);
    // 批准刚发生，续接可能还在路上：这一轮必须保持 waiting，不能当成残留收尾。
    expect(await state(own.run)).toBe("waiting");
  });

  it("群研在等确认计划、刚答完提问时不算残留：收件箱刷新不能把它标成中断", async () => {
    const own = await runWith("waiting");
    await admin.query("update run set mode='swarm', role_id='bench-swarm' where id=$1", [own.run]);
    await reconcileAccount(db, account);
    expect(await state(own.run)).toBe("waiting");
    expect(await events(own.run, "run.interrupted")).toHaveLength(0);
  });

  it("进程已经不在了、状态还停在执行中的任务，补成中断并释放占用", async () => {
    const own = await runWith("running");
    const card1 = await pendingCard(own.run, 1_000, "papers.fetch:orphan");

    // 收尾只看「执行是否还活着」这个判据，不猜；这里如实说它不在了。
    await reconcileAccount(db, account, { isLive: () => false, graceMs: 0 });

    expect(await state(own.run)).toBe("interrupted");
    expect(await card(card1)).toBe("expired");
    const released = await admin.query("select lease_run_id from dsh_session where session_id=$1", [own.session]);
    expect(released.rows[0]?.lease_run_id).toBe(null);
    const interrupted = await events(own.run, "run.interrupted");
    expect(interrupted[0]?.payload).toMatchObject({ reason: "execution_lost" });
  });

  it("还在等待、且请求有效的任务不会被当成残留", async () => {
    const own = await runWith("waiting");
    const keep = await pendingCard(own.run, 5 * 60_000, "papers.fetch:keep");

    await reconcileAccount(db, account, { isLive: () => false });

    expect(await state(own.run)).toBe("waiting");
    expect(await card(keep)).toBe("pending");
  });

  it("服务启动时把上一轮残留的执行补成中断", async () => {
    const own = await runWith("running");
    const leftover = await pendingCard(own.run, 1_000, "papers.fetch:startup");

    const swept = await reconcileOnStartup(admin);

    expect(swept.interruptedRuns).toBeGreaterThanOrEqual(1);
    expect(await state(own.run)).toBe("interrupted");
    expect(await card(leftover)).toBe("expired");
    const released = await admin.query("select lease_run_id from dsh_session where session_id=$1", [own.session]);
    expect(released.rows[0]?.lease_run_id).toBe(null);
    const interrupted = await events(own.run, "run.interrupted");
    expect(interrupted[0]?.payload).toMatchObject({ reason: "execution_lost" });
  });

  it("服务启动时保留还在等人回答的有效请求", async () => {
    const own = await runWith("waiting");
    const keep = await pendingCard(own.run, 5 * 60_000, "papers.fetch:startup-keep");

    await reconcileOnStartup(admin);

    expect(await state(own.run)).toBe("waiting");
    expect(await card(keep)).toBe("pending");
  });


  it("群研的卡不因为底层那一回合结束就被顺手作废", async () => {
    // 一个已经收尾的底层 run + 一张待处理的群研卡：非群研的卡会被清，
    // 群研的要留给人处理（否则加人 / 追加额度一出现就没了）。
    const account = randomUUID();
    const dossier = randomUUID();
    await admin.query("insert into account(id) values($1)", [account]);
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','card','/data/dossiers/'||$1::text)",
      [dossier, account],
    );
    const runId = randomUUID();
    await admin.query(
      `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
       values($1,$2,$3,'bench-swarm','swarm',$4,'completed',1,'{}')`,
      [runId, account, dossier, randomUUID()],
    );
    const cardId = randomUUID();
    await admin.query(
      `insert into approval(id,account_id,run_id,kind,title,effects,risk,state,effect_key)
       values($1,$2,$3,'swarm_extend','追加额度','[]'::jsonb,'read','pending',$4)`,
      [cardId, account, runId, "swarm.swarm_extend:" + cardId],
    );
    const otherId = randomUUID();
    const otherRun = randomUUID();
    await admin.query(
      `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
       values($1,$2,$3,'research-read','read',$4,'completed',1,'{}')`,
      [otherRun, account, dossier, randomUUID()],
    );
    await admin.query(
      `insert into approval(id,account_id,run_id,kind,title,effects,risk,state,effect_key)
       values($1,$2,$3,'question','普通提问','[]'::jsonb,'read','pending',$4)`,
      [otherId, account, otherRun, "q:" + otherId],
    );
    await reconcileAccount(db, account);
    const rows = await admin.query(
      "select id,state from approval where account_id=$1 order by id",
      [account],
    );
    const byId = new Map(rows.rows.map((row) => [String(row.id), String(row.state)]));
    expect(byId.get(cardId)).toBe("pending");
    expect(byId.get(otherId)).toBe("expired");
  });
});

it("群研的卡不会被任何清扫作废（超时也不行），普通卡照旧", async () => {
  const account = randomUUID();
  const dossier = randomUUID();
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','cards','/data/dossiers/'||$1::text)",
    [dossier, account],
  );
  const swarmRun = randomUUID();
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,'bench-swarm','swarm',$4,'completed',1,'{}')`,
    [swarmRun, account, dossier, randomUUID()],
  );
  const readRun = randomUUID();
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,'research-read','read',$4,'completed',1,'{}')`,
    [readRun, account, dossier, randomUUID()],
  );
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  const ids: Record<string, string> = {};
  for (const [label, kind, run] of [
    ["scope", "swarm_scope", swarmRun],
    ["divergence", "swarm_divergence", swarmRun],
    ["result", "delegation_result", swarmRun],
    ["plain", "question", readRun],
  ] as const) {
    const id = randomUUID();
    ids[label] = id;
    await admin.query(
      `insert into approval(id,account_id,run_id,kind,title,effects,risk,state,effect_key,created_at)
       values($1,$2,$3,$4,'t','[]'::jsonb,'read','pending',$5,$6)`,
      [id, account, run, kind, `${kind}:${id}`, old],
    );
  }
  // 48 小时前的待处理：普通卡按超时作废，群研卡与委托结果卡必须留着等人决定。
  await reconcileAccount(db, account);
  const rows = await admin.query(
    "select id, state from approval where account_id=$1",
    [account],
  );
  const byId = new Map(rows.rows.map((row) => [String(row.id), String(row.state)]));
  expect(byId.get(ids.scope)).toBe("pending");
  expect(byId.get(ids.divergence)).toBe("pending");
  expect(byId.get(ids.result)).toBe("pending");
  expect(byId.get(ids.plain)).toBe("expired");
});
