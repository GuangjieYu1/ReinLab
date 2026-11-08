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
import {
  ERA_TABLE,
  LUNAR_MONTH_NAMES,
  eraByName,
  ganzhiOfYear,
  lunarDayName,
  lunarMonthsOfYear,
  lunarToCivil,
  monthStartCandidates,
} from './chinese-calendar';

export const MINUTES_PER_DAY = 1440;
const MINUTES_PER_HOUR = 60;

/** 公历 0001-01-01 距 1970-01-01 的天数（days_from_civil 的口径）。 */
const DAYS_TO_EPOCH = -719162;

export type StoryTimeInput = { input: string; calendar?: string };

export type ParseFailure = {
  code: 'TIME_UNPARSED';
  message: string;
  /** 有把握的候选（年号不确定、闰月不对时给出），页面让作者挑。 */
  candidates: { t: number; label: string; why: string }[];
};
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

/**
 * 年号历的写法（1B）：`康熙二十三年三月初七`、`康熙二十三年三月`、`闰二月初一`、
 * `甲子年三月初七`（干支年要配合年号）。日期前面可以带「约」「时为」之类的字，剥掉。
 */
const GANZHI_CHARS = /^([甲乙丙丁戊己庚辛壬癸])([子丑寅卯辰巳午未申酉戌亥])年/;
const ERA_RE = /^([\u4e00-\u9fa5]{2})(元|[0-9]+|[零一二三四五六七八九十百]+)年/;
const LEAP_RE = /^闰/;
const MONTH_RE = /^(十一|十二|十|一|二|三|四|五|六|七|八|九|正|冬|腊)月/;
const DAY_RE = /^(初[一二三四五六七八九十]|十[一二三四五六七八九]|二十|廿[一二三四五六七八九]|三十)(?:日)?/;

const monthNumberOf = (name: string): number => {
  const map: Record<string, number> = {
    正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 冬: 11, 腊: 12,
  };
  return map[name] ?? 0;
};

const dayNumberOf = (name: string | undefined): number | null => {
  if (!name) return null;
  if (name === '二十') return 20;
  if (name === '三十') return 30;
  if (name.startsWith('初')) return chineseNumber(name.slice(1));
  if (name.startsWith('廿')) return 20 + (chineseNumber(name.slice(1)) ?? 0);
  return chineseNumber(name);
};

export type ChineseEraParse =
  | { ok: true; value: StoryTime }
  | { ok: false; message: string; candidates: { t: number; label: string; why: string }[] };

/** 年号 + 农历日期 → StoryTime。不确定就带候选，不硬填。 */
export function parseChineseEraDate(text: string, calendars: Calendar[]): ChineseEraParse {
  const trimmed = text.replace(/^[约时于於是\s]+/, '').trim();
  let rest = trimmed;
  let ganzhi: string | null = null;
  const ganzhiMatch = GANZHI_CHARS.exec(rest);
  if (ganzhiMatch) {
    ganzhi = ganzhiMatch[1] + ganzhiMatch[2];
    rest = rest.slice(ganzhiMatch[0].length);
  }
  const eraMatch = ERA_RE.exec(rest);
  let eraYear: number | null = null;
  let eraName: string | null = null;
  if (eraMatch) {
    const era = eraByName(eraMatch[1]);
    if (!era)
      return {
        ok: false,
        message: `年号「${eraMatch[1]}」不在本地年号表里（明洪武到清宣统）。请改成公历，或换一个表里的年号。`,
        candidates: [],
      };
    const nth = eraMatch[2] === '元' ? 1 : chineseNumber(eraMatch[2]);
    if (nth === null || nth < 1) return { ok: false, message: '年号后面的年数认不出来。', candidates: [] };
    const year = era.start + nth - 1;
    if (year > era.end)
      return {
        ok: false,
        message: `${era.name}只有 ${era.end - era.start + 1} 年，${nth} 年超出了。`,
        candidates: [],
      };
    eraName = era.name;
    eraYear = year;
    rest = rest.slice(eraMatch[0].length);
  }
  // 干支也可能写在年号后面（「康熙二十三年丙子年三月初七」），两处都收。
  const trailingGanzhi = GANZHI_CHARS.exec(rest);
  if (trailingGanzhi) {
    if (ganzhi && ganzhi !== trailingGanzhi[1] + trailingGanzhi[2])
      return { ok: false, message: '干支写了两个不一样的，请核对原文。', candidates: [] };
    ganzhi = trailingGanzhi[1] + trailingGanzhi[2];
    rest = rest.slice(trailingGanzhi[0].length);
  }
  const leap = LEAP_RE.test(rest);
  if (leap) rest = rest.slice(1);
  const monthMatch = MONTH_RE.exec(rest);
  if (!monthMatch) {
    // 只写年份（「康熙十七年」）：给这一农历年的范围，不硬填到某一天。
    if (eraYear !== null && !rest.trim()) {
      const calendarId = calendars.find((item) => item.kind === 'chinese_era')?.id ?? 'chinese_era';
      const months = lunarMonthsOfYear(eraYear);
      const first = months[0];
      const last = months[months.length - 1];
      if (!first || !last)
        return { ok: false, message: `算不出 ${eraYear} 年的农历月表。`, candidates: [] };
      const start = gregorianToT(first.start.year, first.start.month, first.start.day);
      const end = gregorianToT(last.start.year, last.start.month, last.start.day + last.days - 1);
      const nth = eraYear - (eraByName(eraName!)?.start ?? eraYear) + 1;
      return {
        ok: true,
        value: {
          t: start,
          range: [start, end],
          label: `${text.trim()}（${gregorianLabel(start)} – ${gregorianLabel(end)}）`,
          original: text.trim(),
          calendar: calendarId,
          relative: null,
          certainty: 'range',
        },
      };
    }
    return { ok: false, message: '缺农历月份（正月、二月……十二月）。', candidates: [] };
  }
  const month = monthNumberOf(monthMatch[1]);
  rest = rest.slice(monthMatch[0].length);
  const dayMatch = DAY_RE.exec(rest);
  const day = dayMatch ? dayNumberOf(dayMatch[1]) : null;
  if (dayMatch) rest = rest.slice(dayMatch[0].length);
  if (rest.trim())
    return { ok: false, message: `「${rest.trim()}」这段认不出来，只认年号 + 农历月日。`, candidates: [] };

  if (eraYear === null && ganzhi) {
    // 干支 60 年一轮，没有参照不能定年份：给最近两个候选让作者挑，不硬填。
    const near = 1700;
    const matches: number[] = [];
    for (let year = near - 70; year <= near + 70; year += 1)
      if (ganzhiOfYear(year) === ganzhi) matches.push(year);
    const candidates: { t: number; label: string; why: string }[] = [];
    for (const year of matches) {
      const civil = month ? lunarToCivil(year, month, day ?? 1, leap) : null;
      if (!civil) continue;
      candidates.push({
        t: gregorianToT(civil.year, civil.month, civil.day),
        label: `${ganzhi}年${monthMatch[1]}月${day ? lunarDayName(day) : ''} · ${gregorianLabel(gregorianToT(civil.year, civil.month, civil.day))}`,
        why: '干支纪年六十年一轮，这里按常见年代附近取一个；要准确请补年号或公历。',
      });
    }
    return {
      ok: false,
      message: '只有干支年定不了年份（六十年一轮）：请补年号，或直接写公历。',
      candidates,
    };
  }
  if (eraYear === null)
    return { ok: false, message: '农历日期要有年号，例如「康熙二十三年三月初七」。', candidates: [] };
  if (ganzhi && ganzhiOfYear(eraYear) !== ganzhi)
    return {
      ok: false,
      message: `${eraName}${eraYear - (eraByName(eraName!)?.start ?? eraYear) + 1}年是 ${ganzhiOfYear(eraYear)} 年，不是${ganzhi}年：年号和干支对不上，请核对原文。`,
      candidates: [],
    };

  const months = lunarMonthsOfYear(eraYear);
  const target = months.find((item) => item.month === month && item.leap === leap);
  if (!target)
    return {
      ok: false,
      message: `${eraYear} 年没有${leap ? '闰' : ''}${monthMatch[1]}月。`,
      candidates: months
        .filter((item) => item.leap)
        .map((item) => ({
          t: gregorianToT(item.start.year, item.start.month, item.start.day),
          label: `${eraName}${eraYear - (eraByName(eraName!)?.start ?? eraYear) + 1}年闰${LUNAR_MONTH_NAMES[item.month - 1] ?? item.month}月（${gregorianLabel(gregorianToT(item.start.year, item.start.month, item.start.day))}）`,
          why: '这年有闰月，但不是你写的那个月。',
        })),
    };

  const starts = monthStartCandidates(target);
  const base = starts[0];
  const calendarId = calendars.find((item) => item.kind === 'chinese_era')?.id ?? 'chinese_era';
  const eraNth = eraYear - (eraByName(eraName!)?.start ?? eraYear) + 1;
  const original = text.trim();
  // 标签直接用原文写法（保住「二十三」这种写法），后面补公历。
  const head = original;

  if (starts.length > 1) {
    // 朔落在两种历法标准的日界之间：同一个日子差一天，给候选。
    const candidates = starts.map((item) => {
      const civil = lunarToCivil(eraYear!, month, day ?? 1, leap) ?? item;
      const offset = day ? day - 1 : 0;
      const t = gregorianToT(item.year, item.month, item.day + offset);
      void civil;
      return { t, label: `${head} · ${gregorianLabel(t)}`, why: '这一天正好在两种历法标准（北京地方时 / 东八区）的日界上。' };
    });
    const [first, second] = candidates.map((item) => item.t);
    return {
      ok: true,
      value: {
        t: Math.min(first, second),
        range: [Math.min(first, second), Math.max(first, second)],
        label: `${head} · 约 ${candidates.map((item) => gregorianLabel(item.t)).join(' 或 ')}`,
        original,
        calendar: calendarId,
        relative: null,
        certainty: 'range',
        candidates,
      },
    };
  }

  if (!day) {
    const endOffset = target.days - 1;
    const start = gregorianToT(base.year, base.month, base.day);
    const end = gregorianToT(base.year, base.month, base.day + endOffset);
    return {
      ok: true,
      value: {
        t: start,
        range: [start, end],
        label: `${head}（${gregorianLabel(start)} – ${gregorianLabel(end)}）`,
        original,
        calendar: calendarId,
        relative: null,
        certainty: 'range',
      },
    };
  }
  const t = gregorianToT(base.year, base.month, base.day + day - 1);
  return {
    ok: true,
    value: {
      t,
      label: `${head} · ${gregorianLabel(t)}`,
      original,
      calendar: calendarId,
      relative: null,
      certainty: 'exact',
    },
  };
}

const looksChineseEra = (text: string): boolean =>
  /年/.test(text) && (ERA_RE.test(text) || GANZHI_CHARS.test(text) || /闰/.test(text) || /[月]/.test(text));

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

  // 1B：年号 + 农历（康熙二十三年三月初七 / 闰二月初一 / 甲子年三月初七）
  if (calendar?.kind === 'chinese_era' || looksChineseEra(text)) {
    const era = parseChineseEraDate(text, context.calendars);
    if (era.ok) return { ok: true, value: era.value };
    return {
      ok: false,
      failure: { code: 'TIME_UNPARSED', message: era.message, candidates: era.candidates },
    };
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
