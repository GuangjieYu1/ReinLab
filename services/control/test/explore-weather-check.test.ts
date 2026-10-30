import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { Database } from "../src/db/database";
import { subscribe } from "../src/dossier/service";
import { createWeatherScheduler } from "../src/explore/schedule";
import { runWeatherCheck } from "../src/explore/weather-check";
import { localDayOf, shiftDay, type WeatherTransport } from "../src/explore/weather";
import type { WeatherJudge } from "../src/explore/weather-judge";
import { KernelAuth } from "../src/kernel/auth";

/**
 * 用「今天 +2 天」当拍摄日：预报窗口是按真实今天算的，写死日期迟早会掉出窗口。
 */
const DAY = shiftDay(localDayOf(new Date(), "Asia/Tokyo"), 2);
const WINDOW = { start: `${DAY}T16:10:00+09:00`, end: `${DAY}T17:40:00+09:00` };
import type { AppliedOp } from "@reinlab/contracts";

const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 4,
});
const database = new Database(pool);
const A = randomUUID();
const B = randomUUID();
const dossier = randomUUID();
const draftDossier = randomUUID();
const kernelAuth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
/** 读待办不需要真实运行记录，但令牌里要有合法的 run 标识。 */
const toolRun = randomUUID();
let app: Awaited<ReturnType<typeof createApp>>;
/** 走真实的 /kernel/tool 网关（助手看到的和页面同一组服务函数）。 */
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await app.request("/kernel/tool", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": kernelAuth.issue({ account: A, dossier, run: toolRun }, Math.floor(Date.now() / 1000)),
    },
    body: JSON.stringify({ server: "explore", tool: name, args }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
let cookieA = "";
let cookieB = "";

/** 可变的「预报」：测试中途能改成下雨或改成取不到。 */
let weather = { cloud: 10, precipProb: 5, precipMm: 0 };
let offline = false;
let transportCalls = 0;
const weatherTransport: WeatherTransport = async () => {
  transportCalls += 1;
  if (offline) throw new Error("ENOTFOUND api.open-meteo.com");
  // 从「今天（UTC）前一天」起给 20 天，足够覆盖 +2 天的拍摄日。
  const todayUtc = localDayOf(new Date(), "UTC");
  const [y, m, d] = shiftDay(todayUtc, -1).split("-").map(Number);
  const start = Date.UTC(y, m - 1, d, 0, 0, 0);
  const time = Array.from({ length: 20 * 24 }, (_, i) => Math.floor((start + i * 3600_000) / 1000));
  return {
    ok: true,
    status: 200,
    json: async () => ({
      hourly: {
        time,
        cloud_cover: time.map(() => weather.cloud),
        precipitation_probability: time.map(() => weather.precipProb),
        precipitation: time.map(() => weather.precipMm),
        wind_speed_10m: time.map(() => 2),
        wind_gusts_10m: time.map(() => 4),
        temperature_2m: time.map(() => 12),
      },
    }),
  };
};

/** 假的判断通道：只回固定的两种结论，用来验证「有影响才出卡、没影响就安静」。 */
let judgeCalls = 0;
let judgeSaysMaterial = true;
const judge: WeatherJudge = async (input) => {
  judgeCalls += 1;
  return {
    judgement: judgeSaysMaterial
      ? {
          material: true,
          summary: "傍晚降水概率升到 80%，建议把这一场改到上午",
          changes: [
            {
              stopId: input.stops[0].stopId,
              // 判断通道用 fallback 这个简称，落库要变成 detail.fallback。
              patch: {
                window: { start: `${DAY}T08:00:00+09:00`, end: `${DAY}T09:30:00+09:00` },
                fallback: "改拍廊下遮蔽机位，雨大就顺延",
              },
              why: "傍晚降水概率高",
            },
          ],
        }
      : { material: false, summary: "变化不影响这次安排", changes: [] },
    usage: {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      known: true,
      inputTokens: 1200,
      outputTokens: 180,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    },
  };
};

const headers = (cookie = cookieA, key?: string) => ({
  Cookie: cookie,
  Origin: "http://localhost",
  "X-ReinLab-CSRF": "1",
  "Content-Type": "application/json",
  ...(key ? { "Idempotency-Key": key } : {}),
});

async function issueSession(account: string) {
  const token = randomBytes(32).toString("base64url");
  await admin.query("select reinlab_session_open($1,$2)", [
    account,
    createHash("sha256").update(token).digest("hex"),
  ]);
  return "rl_session=" + token;
}

const ops = async (id: string, body: unknown, cookie = cookieA) =>
  app.request(`/v1/explore/plans/${id}/ops`, {
    method: "POST",
    headers: headers(cookie, randomUUID()),
    body: JSON.stringify(body),
  });

const planOf = async (id = dossier) =>
  (await app.request(`/v1/explore/plans/${id}`, { headers: headers() })).json();

const check = async (id = dossier) =>
  app.request(`/v1/explore/plans/${id}/weather/check`, {
    method: "POST",
    headers: headers(cookieA, randomUUID()),
    body: "{}",
  });

const suggestionsOf = async (id = dossier) =>
  (await app.request(`/v1/explore/plans/${id}/suggestions`, { headers: headers() })).json();

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name) values($1,'A'),($2,'B')", [A, B]);
  for (const [id, title] of [
    [dossier, "京都秋日旅拍"],
    [draftDossier, "还在排的计划"],
  ] as const)
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration',$3,$4)",
      [id, A, title, "/data/dossiers/" + id],
    );
  cookieA = await issueSession(A);
  cookieB = await issueSession(B);
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    kernelTools: { auth: kernelAuth, dispatch: async () => ({}) },
    weatherTransport,
    weatherJudge: judge,
  });
}, 40_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("待执行计划的天气监测", () => {
  it("排一份待执行的计划：确认后按账户时区排好下一次检查", async () => {
    const settings = await app.request("/v1/account/settings", {
      method: "PUT",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ timezone: "Asia/Tokyo" }),
    });
    expect(settings.status).toBe(200);
    const plan = await planOf();
    const added = await ops(dossier, {
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "plan.set",
          patch: {
            destination: { name: "京都 · 东山", center: [135.7681, 35.0116], timezone: "Asia/Tokyo" },
            days: [DAY],
          },
        },
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "水路阁",
            geometry: { type: "Point", coordinates: [135.7944, 35.0111] },
            day: DAY,
            window: WINDOW,
            state: "confirmed",
          },
        },
      ],
    });
    expect(added.status).toBe(200);
    const current = await planOf();
    const confirmed = await ops(dossier, {
      baseRevision: current.plan.revision,
      ops: [{ op: "plan.confirm" }],
    });
    expect(confirmed.status).toBe(200);
    const scheduled = (
      await admin.query("select next_check_at from explore_plan where account_id=$1 and dossier_id=$2", [A, dossier])
    ).rows[0].next_check_at;
    expect(scheduled).toBeTruthy();
    // 落在账户时区的 08/16/23 整点，且在将来。
    const local = new Date(scheduled).toLocaleTimeString("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
    expect(["08:00", "16:00", "23:00"]).toContain(local);
    expect(new Date(scheduled).getTime()).toBeGreaterThan(Date.now());
  });

  it("第一次拿到预报只存基线：不问模型、不出卡", async () => {
    const body = await (await check()).json();
    expect(body.state).toBe("no_change");
    expect(body.summary).toContain("基线");
    expect(judgeCalls).toBe(0);
    expect((await suggestionsOf()).items).toEqual([]);
  });

  it("预报变化交给判断：有影响就出一条前后对照的建议并计 token", async () => {
    weather = { cloud: 85, precipProb: 80, precipMm: 2.4 };
    const seen: any[] = [];
    const stop = subscribe(A, "exploration", (event) => seen.push(event));
    try {
      const response = await check();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.state).toBe("suggested");
      expect(body.suggestionId).toBeTruthy();
      expect(judgeCalls).toBe(1);
      const event = seen.find((entry) => entry.type === "explore.weather");
      expect(event?.suggestionId).toBe(body.suggestionId);
    } finally {
      stop();
    }

    const items = (await suggestionsOf()).items;
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("pending");
    expect(items[0].changes[0].why).toContain("降");

    // 用量记在这份计划上，用途是天气判断，不是 0。
    const usage = (
      await admin.query(
        "select provider,model,known,input_tokens,output_tokens,run_id,purpose from usage_record where account_id=$1 and dossier_id=$2 order by recorded_at desc limit 1",
        [A, dossier],
      )
    ).rows[0];
    expect(usage).toMatchObject({ known: true, input_tokens: 1200, output_tokens: 180, purpose: "weather_judge" });
    expect(usage.model).toBe("deepseek-v4-flash");
    // 后台判断没有运行记录。
    expect(usage.run_id).toBeNull();
  });

  it("收件箱能看到这张卡，并且指回这份档案（没有 run 的卡也要带 dossierId）", async () => {
    const inbox = await (await app.request("/v1/approvals?state=pending", { headers: headers() })).json();
    const card = (inbox.items as any[]).find((item) => item.source?.dossierId === dossier);
    expect(card).toBeTruthy();
    expect(card.capability).toBe("explore.weatherSuggestion");
    expect(card.title).toContain("降水");
    // 卡片说明要写清会改哪几处、不批准就不动计划。
    const lines = card.effects as string[];
    expect(lines.join(" ")).toContain("不批准就不改计划");
    // 卡片用停留点名字，不是 id 前缀。
    expect(lines.join(" ")).toContain("水路阁");
  });

  it("助手能读到待办并说清是哪条", async () => {
    const { status, body } = await tool("pending");
    expect(status).toBe(200);
    const items = body.result.items as any[];
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("weather_suggestion");
    expect(items[0].forRevision).toBeGreaterThan(0);
    expect(items[0].title).toContain("降水");
    expect(Array.isArray(items[0].changes)).toBe(true);
  });

  it("应用建议：批准才改计划，改完状态变已应用", async () => {
    const items = (await suggestionsOf()).items;
    const id = items[0].id;
    const before = await planOf();
    const decided = await app.request(`/v1/approvals/${id}/decide`, {
      method: "POST",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ decision: "approve", scope: "once" }),
    });
    expect(decided.status).toBe(200);
    expect((await decided.json()).state).toBe("approved");
    const after = await planOf();
    expect(after.plan.revision).toBe(before.plan.revision + 1);
    expect(after.plan.stops[0].window.start).toBe(`${DAY}T08:00:00+09:00`);
    // 备选落在 detail 里，不会变成停留点的野字段。
    expect(after.plan.stops[0].detail?.fallback).toBe("改拍廊下遮蔽机位，雨大就顺延");
    expect((after.plan.stops[0] as Record<string, unknown>).fallback).toBeUndefined();
    expect((await suggestionsOf()).items[0].state).toBe("applied");
  });

  it("预报没再变就不再打扰，也不重复花钱问模型", async () => {
    const calls = judgeCalls;
    const response = await check();
    const body = await response.json();
    expect(body.state).toBe("no_change");
    expect(judgeCalls).toBe(calls);
    expect((await suggestionsOf()).items).toHaveLength(1);
  });

  it("预报变了但判断说没影响：安静记一笔，不出卡", async () => {
    weather = { cloud: 20, precipProb: 15, precipMm: 0 };
    judgeSaysMaterial = false;
    const body = await (await check()).json();
    expect(body.state).toBe("checked");
    expect(body.summary).toContain("不影响");
    expect((await suggestionsOf()).items).toHaveLength(1);
  });

  it("检查时点按账户时区算，不跟着行程时区走", async () => {
    // 账户在纽约、行程在京都：下一次检查必须落在纽约的 08/16/23。
    const settings = await app.request("/v1/account/settings", {
      method: "PUT",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ timezone: "America/New_York" }),
    });
    expect(settings.status).toBe(200);
    // 手动触发不改日程，这里用「到点检查」那条路径看下一次排在哪（先把上次的安排挪到过去）。
    await admin.query(
      "update explore_plan set next_check_at=now() - interval '5 minutes' where account_id=$1 and dossier_id=$2",
      [A, dossier],
    );
    await database.withAccount(A, (client) =>
      runWeatherCheck(client, A, dossier, { judge, transport: weatherTransport, reason: "schedule" }),
    );
    const next = (
      await admin.query("select next_check_at from explore_plan where account_id=$1 and dossier_id=$2", [A, dossier])
    ).rows[0].next_check_at;
    const inNewYork = new Date(next).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
    const inTokyo = new Date(next).toLocaleTimeString("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
    expect(["08:00", "16:00", "23:00"]).toContain(inNewYork);
    expect(["08:00", "16:00", "23:00"]).not.toContain(inTokyo);
  });

  it("取不到天气就记失败，不当成没变化，也不问模型", async () => {
    offline = true;
    const calls = judgeCalls;
    try {
      const body = await (await check()).json();
      expect(body.state).toBe("failed");
      expect(body.summary).toContain("ENOTFOUND");
      expect(judgeCalls).toBe(calls);
      const row = (
        await admin.query(
          "select state,summary from explore_weather_check where account_id=$1 and dossier_id=$2 order by checked_at desc limit 1",
          [A, dossier],
        )
      ).rows[0];
      expect(row.state).toBe("failed");
    } finally {
      offline = false;
    }
  });

  it("日期还没进预报范围：记等待，不画假数据", async () => {
    const plan = await planOf();
    const stopId = plan.plan.stops[0].id;
    await ops(dossier, {
      baseRevision: plan.plan.revision,
      ops: [{ op: "stop.update", id: stopId, patch: { day: shiftDay(DAY, 120), window: null } }],
    });
    const body = await (await check()).json();
    expect(body.state).toBe("out_of_range");
  });

  it("计划不在待执行就不监测；调度只领到点的待执行计划", async () => {
    const draftPlan = await planOf(draftDossier);
    expect(draftPlan.plan.state).toBe("draft");
    // 草稿计划：手动检查也只会标 skipped，不会去取数。
    const skipped = await check(draftDossier);
    expect((await skipped.json()).state).toBe("skipped");
    const row = (
      await admin.query("select next_check_at from explore_plan where account_id=$1 and dossier_id=$2", [A, draftDossier])
    ).rows[0];
    expect(row.next_check_at).toBeNull();

    // 把待执行计划的下次检查时间挪到过去：调度应该领到它并跑一次。
    // 这个库是多个测试文件共用的：先把别的遗留计划排到明天，只留这一份到点。
    await admin.query(
      "update explore_plan set next_check_at=now() + interval '1 day' where dossier_id<>$1",
      [dossier],
    );
    await admin.query("update explore_plan set next_check_at=now() - interval '1 hour' where account_id=$1 and dossier_id=$2", [A, dossier]);
    const runs: string[] = [];
    const scheduler = createWeatherScheduler({
      db: database,
      limit: 10,
      runCheck: async (account, id, when) => {
        runs.push(id);
        const outcome = await database.withAccount(account, (client) =>
          runWeatherCheck(client, account, id, { judge, transport: weatherTransport, now: when }),
        );
        expect(outcome.reason).toBe("catchup");
      },
    });
    const handled = await scheduler.tick();
    scheduler.stop();
    expect(handled).toBeGreaterThanOrEqual(1);
    expect(runs).toContain(dossier);
    // 跑完就把下一次排到将来，不会连续补跑。
    const next = (
      await admin.query("select next_check_at from explore_plan where account_id=$1 and dossier_id=$2", [A, dossier])
    ).rows[0].next_check_at;
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
    const second = await scheduler.tick();
    expect(second).toBe(0);
  });

  it("计划结束后真的停掉监测：下次检查清空", async () => {
    const plan = await planOf();
    const finished = await ops(dossier, { baseRevision: plan.plan.revision, ops: [{ op: "plan.finish" }] });
    expect(finished.status).toBe(200);
    const row = (
      await admin.query("select state, next_check_at from explore_plan where account_id=$1 and dossier_id=$2", [A, dossier])
    ).rows[0];
    expect(row.state).toBe("finished");
    expect(row.next_check_at).toBeNull();
    // 结束之后调度也不会再领到它。
    const due = await admin.query("select count(*)::int n from reinlab_explore_due_plans(50) where dossier_id=$1", [dossier]);
    expect(due.rows[0].n).toBe(0);
  });

  it("建议只给本账户看", async () => {
    const denied = await app.request(`/v1/explore/plans/${dossier}/suggestions`, {
      headers: headers(cookieB),
    });
    expect([403, 404]).toContain(denied.status);
    expect(JSON.stringify(await denied.json())).not.toContain("降水");
  });
});
