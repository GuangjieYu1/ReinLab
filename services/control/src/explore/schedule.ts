/**
 * 待执行计划的天气检查时点与调度（06 §5.2、07 契约第 2、4 节）。
 *
 * 时点按**账户时区**每天 08:00 / 16:00 / 23:00（与行程时区分开）。
 * 控制面是单进程：一个定时器每分钟看一次「到点的计划」，
 * 服务停过就补一次（只补一次，不补跑所有历史时点）。
 */
import type { Database } from "../db/database";
import { instantOfLocal } from "./sun";
import { localDayOf } from "./weather";

export const CHECK_HOURS = [8, 16, 23] as const;
export type CheckSlot = "08" | "16" | "23";
export type CheckReason = "schedule" | "catchup" | "manual";

const pad = (value: number) => String(value).padStart(2, "0");

/** 当地日期加减天数（只做日期字符串运算）。 */
export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

/**
 * 账户时区里的下一个检查时点（严格晚于现在）。
 * 用当地钟点换算成真正的时间点，夏令时切换当天也不会偏一小时。
 */
export function nextCheckAt(timezone: string, now: Date): Date {
  const today = localDayOf(now, timezone);
  for (const offset of [0, 1]) {
    const day = shiftDay(today, offset);
    for (const hour of CHECK_HOURS) {
      const at = instantOfLocal(day, pad(hour) + ":00", timezone);
      if (at.getTime() > now.getTime()) return at;
    }
  }
  return instantOfLocal(shiftDay(today, 1), pad(CHECK_HOURS[0]) + ":00", timezone);
}

/** 最近一个已经过去的检查时点（迟到补查时用它标是哪一次）。 */
export function currentSlot(timezone: string, now: Date): CheckSlot {
  const today = localDayOf(now, timezone);
  let slot: CheckSlot = pad(CHECK_HOURS[CHECK_HOURS.length - 1]) as CheckSlot;
  for (const hour of CHECK_HOURS)
    if (instantOfLocal(today, pad(hour) + ":00", timezone).getTime() <= now.getTime())
      slot = pad(hour) as CheckSlot;
  return slot;
}

export type WeatherSchedulerDependencies = {
  db: Database;
  /** 对一份计划跑一次检查（自己开事务、自己推事件）。 */
  runCheck: (account: string, dossier: string, now: Date) => Promise<void>;
  everyMs?: number;
  limit?: number;
  log?: (event: Record<string, unknown>) => void;
};

export type WeatherScheduler = {
  /** 手动跑一轮（测试与「立刻查一次」共用同一条路径）。 */
  tick: (now?: Date) => Promise<number>;
  stop: () => void;
};

export function createWeatherScheduler(dependencies: WeatherSchedulerDependencies): WeatherScheduler {
  const log = dependencies.log ?? (() => {});
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  const tick = async (now: Date = new Date()): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      // definer 函数只回「到点的计划 id 与时间」，不含计划内容；
      // 真正的读写仍然走各账户自己的事务。
      const due = await dependencies.db.withSystem(async (client) =>
        (await client.query("select account_id, dossier_id, timezone, next_check_at, plan_revision from reinlab_explore_due_plans($1)", [
          dependencies.limit ?? 5,
        ])).rows,
      );
      for (const row of due) {
        try {
          await dependencies.runCheck(row.account_id, row.dossier_id, now);
        } catch (error) {
          log({
            code: "EXPLORE_WEATHER_CHECK_FAILED",
            dossier: row.dossier_id,
            detail: String((error as Error)?.message ?? error).slice(0, 200),
          });
        }
      }
      return due.length;
    } finally {
      busy = false;
    }
  };

  const every = setInterval(() => {
    void tick().catch((error) =>
      log({ code: "EXPLORE_WEATHER_TICK_FAILED", detail: String((error as Error)?.message ?? error).slice(0, 200) }),
    );
  }, dependencies.everyMs ?? 60_000);
  // 定时器不该拖住进程退出。
  if (typeof every.unref === "function") every.unref();
  timer = every;

  return {
    tick,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
