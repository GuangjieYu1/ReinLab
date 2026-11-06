/**
 * 故事时间（design/prd/19-creative.md §2、20-creative-contract.md §1「故事时间」）。
 *
 * 服务端把原文写法解析成 StoryTime，前端只显示 label。1A 支持两种历法：
 * - gregorian：公历，按年月日时分写（`1684-04-21 08:00`）；
 * - custom：自定义纪元，从「纪元第 1 日」起算（`第 3 日 08:00` 或 `D3 08:00`）。
 * 年号历法（康熙二十三年三月初七）是 1B 的事：这里明确回 422，不猜。
 *
 * t 是世界纪元起的分钟数，公历纪元固定为 0001-01-01T00:00（proleptic Gregorian，
 * 没有时区概念：架空世界的时间不跟机器时区走）。
 */

import type { Calendar, StoryTime } from '@reinlab/contracts';

export const MINUTES_PER_DAY = 1440;
const MINUTES_PER_HOUR = 60;

/** 公历 0001-01-01 距 1970-01-01 的天数（days_from_civil 的口径）。 */
const DAYS_TO_EPOCH = -719162;

export type StoryTimeInput = { input: string; calendar?: string };

export type ParseFailure = { code: 'TIME_UNPARSED'; message: string; candidates: [] };
export type ParseResult = { ok: true; value: StoryTime } | { ok: false; failure: ParseFailure };

// ── 公历换算（Howard Hinnant 的 days_from_civil / civil_from_days）────
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/** 公历分钟数 → 世界纪元分钟数。 */
export function gregorianToT(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return (daysFromCivil(year, month, day) - DAYS_TO_EPOCH) * MINUTES_PER_DAY + hour * 60 + minute;
}

export function civilFromT(t: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const dayIndex = Math.floor(t / MINUTES_PER_DAY);
  const rest = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const civil = civilFromDays(dayIndex + DAYS_TO_EPOCH);
  return { ...civil, hour: Math.floor(rest / 60), minute: rest % 60 };
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** 自定义纪元：t=0 是「纪元第 1 日 00:00」。 */
export function customLabel(t: number): string {
  const day = Math.floor(t / MINUTES_PER_DAY) + 1;
  const rest = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(rest / 60);
  const minute = rest % 60;
  const clock = hour === 0 && minute === 0 ? '' : ` ${pad(hour)}:${pad(minute)}`;
  return `第 ${day} 日${clock}`;
}

export function gregorianLabel(t: number): string {
  const c = civilFromT(t);
  const clock = c.hour === 0 && c.minute === 0 ? '' : ` ${pad(c.hour)}:${pad(c.minute)}`;
  return `${String(c.year).padStart(4, '0')}-${pad(c.month)}-${pad(c.day)}${clock}`;
}

export function labelFor(t: number, calendar: string | undefined, calendars: Calendar[]): string {
  const found = calendars.find((item) => item.id === calendar);
  if (found?.kind === 'custom') return customLabel(t);
  return gregorianLabel(t);
}

/** 公历 iso-ish：`1684-04-21`、`1684-4-21 8:05`、`1684/04/21 08:00`。 */
const ABSOLUTE = /^(\d{1,6})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?$/;
/** 自定义纪元日：`第 3 日 08:00` / `D3 08:00` / `D3 8:05`。 */
const CUSTOM_DAY = /^(?:第\s*(\d{1,6})\s*日|D\s*(\d{1,6}))(?:\s*(\d{1,2}):(\d{1,2}))?$/;
const UNKNOWN = /^(未定|未知|待定|unknown|\?|—|-)$/i;
const RANGE = /^(.+?)\s*(?:至|到|~|—|\.\.)\s*(.+)$/;

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「三天」「十二」「两」这类中文数字；认不出就 null（不猜）。 */
export function chineseNumber(text: string): number | null {
  const clean = text.trim();
  if (/^\d+$/.test(clean)) return Number(clean);
  if (!clean) return null;
  let section = 0;
  let digit = 0;
  for (const char of clean) {
    if (char in CN_DIGITS) digit = CN_DIGITS[char];
    else if (char === '十' || char === '百') {
      section += (digit || 1) * (char === '十' ? 10 : 100);
      digit = 0;
    } else return null;
  }
  return section + digit;
}

const UNIT_MINUTES: Record<string, number> = {
  分钟: 1, 分: 1, 刻: 15, 小时: MINUTES_PER_HOUR, 时辰: 120, 天: MINUTES_PER_DAY, 日: MINUTES_PER_DAY, 年: 365 * MINUTES_PER_DAY,
};

/** 「出城后三天」「出城前两个时辰」：参照事件按标题（或 id）现找。 */
const RELATIVE = /^(.+?)\s*(之后|以后|后|之前|以前|前)\s*([0-9零一二两三四五六七八九十百]+)\s*(分钟|分|刻|小时|时辰|天|日|年)$/;

export type StoryTimeContext = {
  calendars: Calendar[];
  /** 已有事件：按标题或 id 找参照。 */
  events: { id: string; title: string; start: StoryTime }[];
  defaultCalendar?: string;
};

/** 原文写法 → StoryTime。解析不了就明确失败（调用方回 422 TIME_UNPARSED）。 */
export function parseStoryTime(input: string, context: StoryTimeContext): ParseResult {
  const text = (input ?? '').trim();
  const calendarId = context.defaultCalendar ?? context.calendars[0]?.id ?? 'gregorian';
  const calendar = context.calendars.find((item) => item.id === calendarId) ?? context.calendars[0];
  const unknown: StoryTime = {
    t: null, label: '未定', original: text, calendar: calendarId,
    relative: null, certainty: 'unknown',
  };
  if (UNKNOWN.test(text)) return { ok: true, value: unknown };
  if (!text)
    return { ok: false, failure: { code: 'TIME_UNPARSED', message: '这个时间还没写：可以写公历（1684-04-21 08:00）、自定义纪元（第 3 日 08:00），或相对参照（出城后三天）。', candidates: [] } };

  const absolute = (
    raw: string,
  ): { t: number; calendar: string } | { error: string } => {
    const custom = CUSTOM_DAY.exec(raw);
    if (custom) {
      const day = Number(custom[1] ?? custom[2]);
      const hour = Number(custom[3] ?? 0);
      const minute = Number(custom[4] ?? 0);
      if (!Number.isFinite(day) || day < 1) return { error: '自定义纪元从天算起，第 1 日就是第一天。' };
      if (hour > 23 || minute > 59) return { error: '自定义纪元的时间要在 00:00–23:59 之间。' };
      // 写的是「第 N 日」，标签就按自定义纪元显示，不换成公历（换了多半是错的）。
      const customId = context.calendars.find((item) => item.kind === 'custom')?.id ?? calendarId;
      return { t: (day - 1) * MINUTES_PER_DAY + hour * 60 + minute, calendar: customId };
    }
    const gregorian = ABSOLUTE.exec(raw);
    if (gregorian) {
      const year = Number(gregorian[1]);
      const month = Number(gregorian[2]);
      const day = Number(gregorian[3]);
      const hour = Number(gregorian[4] ?? 0);
      const minute = Number(gregorian[5] ?? 0);
      if (month < 1 || month > 12 || day < 1 || day > 31) return { error: '日期不成立，请按 1684-04-21 写。' };
      if (hour > 23 || minute > 59) return { error: '时间要在 00:00–23:59 之间。' };
      const gregorianId = context.calendars.find((item) => item.kind === 'gregorian')?.id ?? calendarId;
      return { t: gregorianToT(year, month, day, hour, minute), calendar: gregorianId };
    }
    return { error: '认不出这个时间写法。' };
  };

  const range = RANGE.exec(text);
  if (range) {
    const from = absolute(range[1].trim());
    const to = absolute(range[2].trim());
    if ('error' in from || 'error' in to)
      return { ok: false, failure: { code: 'TIME_UNPARSED', message: '这个时间段里有一段认不出来。', candidates: [] } };
    const [t0, t1] = from.t <= to.t ? [from.t, to.t] : [to.t, from.t];
    const rangeCalendar = from.calendar;
    return {
      ok: true,
      value: {
        t: t0, range: [t0, t1], label: `${labelFor(t0, rangeCalendar, context.calendars)} – ${labelFor(t1, rangeCalendar, context.calendars)}`,
        original: text, calendar: rangeCalendar, relative: null, certainty: 'range',
      },
    };
  }

  const relative = RELATIVE.exec(text);
  if (relative) {
    const reference = relative[1].trim();
    const direction = relative[2];
    const amount = chineseNumber(relative[3]);
    const unit = UNIT_MINUTES[relative[4]];
    if (amount === null || !unit)
      return { ok: false, failure: { code: 'TIME_UNPARSED', message: '相对时间的数量认不出来。', candidates: [] } };
    const offset = amount * unit;
    const target = context.events.find((item) => item.title === reference || item.id === reference);
    const before = direction === '前' || direction.endsWith('前');
    const sign = before ? -1 : 1;
    const base = target?.start.t ?? null;
    const value: StoryTime = {
      t: base === null ? null : base + sign * offset,
      range: null,
      label:
        base === null
          ? `${relative[3]}${relative[4]}${before ? '前' : '后'}（参照：${reference} · 未定）`
          : `${relative[3]}${relative[4]}${before ? '前' : '后'}（参照：${reference}）`,
      original: text,
      calendar: calendarId,
      relative: {
        to: target?.id ?? reference,
        rel: before ? 'before' : 'after',
        offsetMin: [offset, offset],
      },
      certainty: 'relative',
    };
    return { ok: true, value };
  }

  if (/[年月正冬腊]|廿|初[一二三四五六七八九十]/.test(text) && /[年月日]/.test(text))
    return {
      ok: false,
      failure: {
        code: 'TIME_UNPARSED',
        message: '年号、干支、农历日期要 1B 才有（康熙二十三年三月初七这种）。1A 请先写公历或自定义纪元。',
        candidates: [],
      },
    };

  const parsed = absolute(text);
  if ('error' in parsed)
    return {
      ok: false,
      failure: {
        code: 'TIME_UNPARSED',
        message: `${parsed.error}可以写 1684-04-21 08:00、第 3 日 08:00，或「出城后三天」。`,
        candidates: [],
      },
    };

  return {
    ok: true,
    value: {
      t: parsed.t, label: labelFor(parsed.t, parsed.calendar, context.calendars), original: text,
      calendar: parsed.calendar, relative: null, certainty: 'exact',
    },
  };
}

/** 服务端生成的修法要把时间写回原文写法：从 t 生成作者能看懂、也能再解析的写法。 */
export function inputForT(t: number, calendar: string | undefined, calendars: Calendar[]): string {
  const found = calendars.find((item) => item.id === calendar);
  if (found?.kind === 'custom') {
    const day = Math.floor(t / MINUTES_PER_DAY) + 1;
    const rest = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return `第 ${day} 日 ${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`;
  }
  const c = civilFromT(t);
  return `${String(c.year).padStart(4, '0')}-${pad(c.month)}-${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)}`;
}

/** 事件用的时间上下界：未知就是 null，绝不按 0 算。 */
export function boundsOf(time: { t: number | null; range?: [number, number] | null }): {
  start: number | null;
  end: number | null;
} {
  if (time.range && time.range.length === 2) return { start: time.range[0], end: time.range[1] };
  return { start: time.t ?? null, end: time.t ?? null };
}
