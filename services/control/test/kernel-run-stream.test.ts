import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";

/**
 * 运行事件流（SSE）：页面用它代替 1 秒轮询，所以帧序、活性事件和收尾都必须稳。
 */
const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 3,
});
const A = randomUUID();
const dossier = randomUUID();
const run = randomUUID();
let app: Awaited<ReturnType<typeof createApp>>;
let cookie = "";

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name,timezone) values($1,'A','Asia/Shanghai')", [A]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','流',$3)",
    [dossier, A, "/data/dossiers/" + dossier],
  );
  const token = randomBytes(32).toString("base64url");
  await admin.query("select reinlab_session_open($1,$2)", [
    A,
    createHash("sha256").update(token).digest("hex"),
  ]);
  cookie = "rl_session=" + token;
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'bench-explore','explore',$4,'running',1)",
    [run, A, dossier, "req-" + run.slice(0, 8)],
  );
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    kernelTools: { auth: { verify: () => ({}) } as never, dispatch: async () => ({}) },
    // 只用到 isLive / resumeAfterAnswer 这些外壳；这一份测试只关心事件流本身。
    kernel: {
      isLive: () => false,
      submit: async () => ({ runId: run, sessionId: randomUUID(), resume: false }),
      resumeAfterAnswer: async () => {},
      cancel: async () => ({ status: "cancelled" }),
      state: async () => ({ state: "running" }),
      usage: async () => null,
    } as never,
  });
}, 40_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
});

/** 读到收尾帧或超时就停，返回收到的所有帧。 */
async function readFrames(runId: string, after = 0): Promise<Record<string, unknown>[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await app.request(`/v1/kernel/runs/${runId}/stream?after=${after}`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Record<string, unknown>[] = [];
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data) continue;
        frames.push(JSON.parse(data) as Record<string, unknown>);
        if ((JSON.parse(data) as { done?: boolean }).done) return frames;
      }
    }
    return frames;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

describe("运行事件流", () => {
  it("按 seq 推事件、带状态帧，运行结束后给 done 收尾", async () => {
    await admin.query(
      `insert into event(account_id,dossier_id,run_id,kind,action,payload)
       values($1,$2,$3,'run','step/start',$4::jsonb),($1,$2,$3,'run','tool/call',$5::jsonb)`,
      [A, dossier, run, JSON.stringify({ step: 1 }), JSON.stringify({ name: "explore_get" })],
    );
    await admin.query("update run set state='completed', ended_at=now() where id=$1", [run]);
    const frames = await readFrames(run);
    const events = frames.filter((frame) => typeof frame.seq === "number");
    expect(events.map((frame) => frame.action)).toEqual(["step/start", "tool/call"]);
    expect(frames.some((frame) => frame.state === "completed")).toBe(true);
    expect(frames[frames.length - 1]).toMatchObject({ done: true, state: "completed" });
  });

  it("带 after 游标只推它之后的事件（页面断线重连就是靠它的）", async () => {
    const first = await readFrames(run);
    const firstSeq = Number((first.find((frame) => typeof frame.seq === "number") ?? {}).seq ?? 0);
    const fromSecond = await readFrames(run, firstSeq);
    expect(fromSecond.filter((frame) => typeof frame.seq === "number")).toHaveLength(1);
  });
});
