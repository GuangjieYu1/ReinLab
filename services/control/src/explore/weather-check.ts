/**
 * 待执行计划的一次天气检查（06 §5.2）。
 *
 * 取数 → 和上一次比对 → 没变就不打扰、不花钱 → 变了交模型判断 →
 * 有影响就生成一条「停留点前后对照」的调整建议进收件箱，没影响就安静记一笔。
 * 不修改计划的正式内容：改不改，由用户在卡上决定。
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { Stop, WeatherHour } from "@reinlab/contracts";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";
import { recordUsage } from "../run/usage";
import { currentSlot, nextCheckAt, type CheckReason, type CheckSlot } from "./schedule";
import { accountTimezone, loadPlan, weatherView } from "./service";
import type { WeatherTransport } from "./weather";
import { toStopPatch, type WeatherJudge } from "./weather-judge";

type Client = pg.PoolClient;

export type CheckState = "no_change" | "checked" | "suggested" | "failed" | "out_of_range" | "skipped";

export type WeatherCheckOutcome = {
  state: CheckState;
  summary: string;
  slot: CheckSlot;
  reason: CheckReason;
  checkedAt: string;
  suggestionId?: string;
  /** 推给页面的 explore.weather 载荷（事务提交后发）。 */
  event: {
    type: "explore.weather";
    dossierId: string;
    checkedAt: string;
    state: "ok" | "out_of_range" | "failed";
    suggestionId?: string;
  };
};

const CHECKABLE_FIELDS = [
  "cloud",
  "precipProb",
  "precipMm",
  "wind",
  "gust",
  "temp",
] as const;

/**
 * 两次检查之间哪几个整点真的变了：只比两次都有的整点。
 * 改了时段导致多出/少了几个小时不算「天气变了」，否则一改计划就会误报一次。
 */
export function changedHours(before: WeatherHour[], after: WeatherHour[]): WeatherHour[] {
  const previous = new Map(before.map((hour) => [hour.at, hour]));
  return after.filter((hour) => {
    const old = previous.get(hour.at);
    if (!old) return false;
    return CHECKABLE_FIELDS.some((field) => (old[field] ?? null) !== (hour[field] ?? null));
  });
}

const sha = (value: unknown) =>
  createHash("sha256").update(canonical(value as never)).digest("hex");

/** 给模型看的窗口：只带变化的那几个小时，避免把整天的数组塞进上下文。 */
const judgeSlice = (hours: WeatherHour[], day: string, window: { start: string; end: string } | null) => ({
  day,
  window,
  hours: hours.slice(0, 12),
});

/**
 * 跑一次检查。调用方负责事务；这里只读写本账户本档案的数据。
 * 返回的结果要由调用方在提交后推进事件（explore.weather）。
 */
export async function runWeatherCheck(
  client: Client,
  account: string,
  dossier: string,
  options: {
    judge?: WeatherJudge;
    transport?: WeatherTransport;
    now?: Date;
    reason?: CheckReason;
  } = {},
): Promise<WeatherCheckOutcome> {
  const now = options.now ?? new Date();
  const { plan } = await loadPlan(client, account, dossier, { lock: true });
  const checkedAt = now.toISOString();
  // 行程时区给天气用；检查时点按**账户时区**的 08/16/23（06 §5.2）。
  const timezone = plan.document.destination?.timezone ?? null;
  const accountZone = await accountTimezone(client, account);

  const skip = async (summary: string): Promise<WeatherCheckOutcome> => {
    await client.query(
      "update explore_plan set next_check_at=null where account_id=$1 and dossier_id=$2",
      [account, dossier],
    );
    return {
      state: "skipped",
      summary,
      slot: accountZone ? currentSlot(accountZone, now) : timezone ? currentSlot(timezone, now) : "08",
      reason: options.reason ?? "schedule",
      checkedAt,
      event: { type: "explore.weather", dossierId: dossier, checkedAt, state: "ok" },
    };
  };

  if (plan.state !== "ready")
    return skip("计划不在待执行，停止天气监测。");
  if (!timezone) return skip("还没有地点时区，先确定拍摄地点再监测天气。");

  const scheduleZone = accountZone ?? timezone;
  const slot = currentSlot(scheduleZone, now);
  const dueAt = (
    await client.query("select next_check_at from explore_plan where account_id=$1 and dossier_id=$2", [
      account,
      dossier,
    ])
  ).rows[0]?.next_check_at;
  const dueTime = dueAt ? new Date(dueAt).getTime() : null;
  // 另一个进程刚好查过：这一轮不重复取数、不重复花钱。
  if (options.reason !== "manual" && dueTime !== null && dueTime > now.getTime() + 60_000)
    return skip("这一轮已经查过了。");
  const late = dueTime !== null && now.getTime() - dueTime > 90_000;
  const reason: CheckReason = options.reason ?? (late ? "catchup" : "schedule");

  // 上一次的快照（本次取数会把它覆盖掉，所以先留一份当基线）。
  const previous = new Map<string, WeatherHour[]>(
    (
      await client.query(
        "select key, hours from explore_weather where account_id=$1 and dossier_id=$2",
        [account, dossier],
      )
    ).rows.map((row) => [row.key, (row.hours ?? []) as WeatherHour[]]),
  );

  const view = await weatherView(client, account, dossier, {
    refresh: true,
    transport: options.transport,
  });

  const finish = async (
    state: CheckState,
    summary: string,
    extra: { suggestionId?: string; detail?: Record<string, unknown>; judgeUsage?: { model: string; known: boolean } } = {},
  ): Promise<WeatherCheckOutcome> => {
    await client.query(
      `insert into explore_weather_check(account_id,dossier_id,slot,reason,plan_revision,state,summary,detail,suggestion_id,judge_model,judge_known)
       values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
      [
        account,
        dossier,
        slot,
        reason,
        plan.revision,
        state,
        summary.slice(0, 300),
        JSON.stringify(extra.detail ?? {}),
        extra.suggestionId ?? null,
        extra.judgeUsage?.model ?? null,
        extra.judgeUsage?.known ?? null,
      ],
    );
    // 到点检查才推进下一次；手动触发不改日程。
    if (reason !== "manual")
      await client.query(
        "update explore_plan set next_check_at=$3 where account_id=$1 and dossier_id=$2",
        [account, dossier, nextCheckAt(scheduleZone, now)],
      );
    return {
      state,
      summary,
      slot,
      reason,
      checkedAt,
      ...(extra.suggestionId ? { suggestionId: extra.suggestionId } : {}),
      event: {
        type: "explore.weather",
        dossierId: dossier,
        checkedAt,
        state: state === "failed" ? "failed" : state === "out_of_range" ? "out_of_range" : "ok",
        ...(extra.suggestionId ? { suggestionId: extra.suggestionId } : {}),
      },
    };
  };

  if (view.state === "failed")
    return finish("failed", view.reason ?? "没取到这次预报，记失败，不当成没变化。", {
      detail: { stops: view.byStop.length },
    });
  if (view.state === "out_of_range")
    return finish("out_of_range", "日期还没进预报范围，等进入范围再查。", {
      detail: { fromDate: view.fromDate ?? null },
    });
  if (!view.byStop.length && !view.destination)
    return finish("failed", "这次没拿到任何停留点的天气。");

  // 和上一次比对：没变就不花钱问模型。第一次拿到预报只存基线，不问。
  const rows = view.byStop.map((entry) => {
    const before = previous.get(entry.stopId);
    return {
      entry,
      baseline: !before,
      changed: before ? changedHours(before, entry.hours) : [],
    };
  });
  const diffs = rows.filter((row) => row.changed.length > 0);
  if (!diffs.length) {
    const firstTime = rows.some((row) => row.baseline);
    return finish(
      "no_change",
      firstTime ? "第一次拿到这份计划的预报，先存基线，有变化再提醒。" : "预报没有变化，安静记一笔。",
      { detail: { stops: view.byStop.length, baseline: firstTime } },
    );
  }

  const stops = new Map(plan.document.stops.map((stop) => [stop.id, stop]));
  const judgeInput = {
    timezone,
    destination: plan.document.destination?.name ?? "",
    revision: plan.revision,
    stops: diffs.flatMap((row) => {
      const stop = stops.get(row.entry.stopId);
      if (!stop) return [];
      return [
        {
          stopId: stop.id,
          name: stop.name,
          day: stop.day,
          window: stop.window ?? null,
          before: judgeSlice(previous.get(stop.id) ?? [], stop.day, stop.window ?? null),
          after: judgeSlice(row.entry.hours, stop.day, stop.window ?? null),
        },
      ];
    }),
  };

  if (!judgeInput.stops.length)
    return finish("failed", "拿到的预报对不上任何停留点，这次不下结论。");

  if (!options.judge)
    return finish("checked", "预报有变化；本机没有判断通道，记下来但没下结论。", {
      detail: { changed: judgeInput.stops.map((stop) => stop.stopId) },
    });

  let judged: Awaited<ReturnType<WeatherJudge>>;
  try {
    judged = await options.judge(judgeInput);
  } catch (error) {
    // 判断失败照实记；用量拿得到就记，拿不到记未知。
    const usage = (error as { usage?: any })?.usage;
    if (usage)
      await recordUsage(client, {
        account,
        dossier,
        run: null,
        purpose: "weather_judge",
        provider: usage.provider,
        model: usage.model,
        known: usage.known === true,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cacheReadTokens: usage.cacheReadTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        costCny: null,
      });
    return finish("failed", `天气判断没成功：${String((error as Error)?.message ?? error).slice(0, 160)}`, {
      detail: { changed: judgeInput.stops.map((stop) => stop.stopId) },
      ...(usage ? { judgeUsage: { model: usage.model, known: usage.known === true } } : {}),
    });
  }

  await recordUsage(client, {
    account,
    dossier,
    run: null,
    purpose: "weather_judge",
    provider: judged.usage.provider,
    model: judged.usage.model,
    known: judged.usage.known,
    inputTokens: judged.usage.inputTokens,
    outputTokens: judged.usage.outputTokens,
    cacheReadTokens: judged.usage.cacheReadTokens,
    cacheWriteTokens: judged.usage.cacheWriteTokens,
    costCny: null,
  });

  if (!judged.judgement.material)
    return finish("checked", judged.judgement.summary, {
      detail: { changed: judgeInput.stops.map((stop) => stop.stopId) },
      judgeUsage: { model: judged.usage.model, known: judged.usage.known },
    });

  const created = await createSuggestion(client, {
    account,
    dossier,
    revision: plan.revision,
    summary: judged.judgement.summary,
    changes: judged.judgement.changes,
    stops,
  });
  return finish(
    "suggested",
    created.reused
      ? `同样的变化已经提醒过：${judged.judgement.summary}`
      : judged.judgement.summary,
    {
      suggestionId: created.id,
      detail: { changed: judgeInput.stops.map((stop) => stop.stopId) },
      judgeUsage: { model: judged.usage.model, known: judged.usage.known },
    },
  );
}

/** 建议卡：复用 approval（收件箱与对话同一张），一个变化只提醒一次。 */
async function createSuggestion(
  client: Client,
  input: {
    account: string;
    dossier: string;
    revision: number;
    summary: string;
    changes: { stopId: string; patch: Record<string, unknown>; why: string }[];
    stops: Map<string, Stop>;
  },
): Promise<{ id: string; reused: boolean }> {
  const changes = input.changes.flatMap((change) => {
    const stop = input.stops.get(change.stopId);
    if (!stop) return [];
    // 判断通道可能给简称（fallback）：落库前一律收成契约里的形状。
    const after = toStopPatch(change.patch);
    if (!Object.keys(after).length) return [];
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(after))
      before[key] =
        key === "detail"
          ? ((stop.detail as Record<string, unknown> | undefined) ?? null)
          : ((stop as Record<string, unknown>)[key] ?? null);
    return [{ stopId: change.stopId, before, after, why: change.why }];
  });
  if (!changes.length) throw new ApiFailure("INVALID_INPUT", 400, "建议里没有能对上的停留点。");
  const ops = changes.map((change) => ({ op: "stop.update", id: change.stopId, patch: change.after }));
  const signature = sha({ forRevision: input.revision, changes });

  const existing = (
    await client.query(
      `select id from approval
        where account_id=$1 and dossier_id=$2 and state='pending'
          and effects->0->>'kind'='explore.weatherSuggestion'
          and effects->0->>'signature'=$3
        order by created_at desc limit 1`,
      [input.account, input.dossier, signature],
    )
  ).rows[0];
  if (existing) return { id: existing.id, reused: true };

  const created = (
    await client.query(
      `insert into approval(account_id,dossier_id,kind,title,effects,risk,state)
       values($1,$2,'permission',$3,$4::jsonb,'write','pending') returning id`,
      [
        input.account,
        input.dossier,
        input.summary.slice(0, 300),
        JSON.stringify([
          {
            kind: "explore.weatherSuggestion",
            dossierId: input.dossier,
            forRevision: input.revision,
            summary: input.summary,
            changes,
            ops,
            signature,
          },
        ]),
      ],
    )
  ).rows[0];
  return { id: created.id, reused: false };
}
