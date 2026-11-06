// 故事时间：公历、自定义纪元、相对参照、区间、未定；年号历法明确拒绝（1B 才有）。
import { describe, expect, it } from "vitest";
import {
  boundsOf,
  chineseNumber,
  civilFromT,
  customLabel,
  gregorianLabel,
  gregorianToT,
  inputForT,
  parseStoryTime,
} from "../src/creative/story-time";
import { CHINESE_ERA, CUSTOM_ERA, GREGORIAN } from "../src/creative/world";
import { lunarToCivil } from "../src/creative/chinese-calendar";

const context = {
  calendars: [GREGORIAN, CHINESE_ERA, CUSTOM_ERA],
  events: [
    {
      id: "ev-leave",
      title: "出城",
      start: { t: gregorianToT(1684, 4, 21, 6, 0), label: "", certainty: "exact", calendar: "gregorian", relative: null },
    },
  ],
};

describe("故事时间换算", () => {
  it("公历按原文写法解析，标签能读，t 能换回来", () => {
    const parsed = parseStoryTime("1684-04-21 08:00", context);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.certainty).toBe("exact");
    expect(parsed.value.original).toBe("1684-04-21 08:00");
    expect(parsed.value.label).toBe("1684-04-21 08:00");
    const roundTrip = civilFromT(parsed.value.t!);
    expect([roundTrip.year, roundTrip.month, roundTrip.day, roundTrip.hour, roundTrip.minute]).toEqual([1684, 4, 21, 8, 0]);
    expect(inputForT(parsed.value.t!, "gregorian", context.calendars)).toBe("1684-04-21 08:00");
  });

  it("自定义纪元从天算起，第 1 日就是第一天", () => {
    const day1 = parseStoryTime("第 1 日 00:00", context);
    const day3 = parseStoryTime("D3 08:00", context);
    expect(day1.ok && day3.ok).toBe(true);
    if (!day1.ok || !day3.ok) return;
    expect(day1.value.t).toBe(0);
    expect(day3.value.t).toBe(2 * 1440 + 8 * 60);
    expect(day3.value.label).toContain("第 3 日");
    expect(customLabel(2 * 1440 + 8 * 60)).toBe("第 3 日 08:00");
  });

  it("相对时间按参照事件解析；参照在就换算成绝对时间，不在就保留相对", () => {
    const found = parseStoryTime("出城后三天", context);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.certainty).toBe("relative");
    expect(found.value.t).toBe(gregorianToT(1684, 4, 24, 6, 0));
    expect(found.value.relative?.to).toBe("ev-leave");
    expect(found.value.label).toContain("参照：出城");

    const missing = parseStoryTime("进城后两天", context);
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.t).toBeNull();
    expect(missing.value.label).toContain("未定");
  });

  it("时间段给 range；未定就是 unknown，不按 0 算", () => {
    const range = parseStoryTime("1684-04-21 至 1684-04-25", context);
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    expect(range.value.certainty).toBe("range");
    expect(range.value.range).toEqual([gregorianToT(1684, 4, 21), gregorianToT(1684, 4, 25)]);
    expect(boundsOf(range.value)).toEqual({ start: gregorianToT(1684, 4, 21), end: gregorianToT(1684, 4, 25) });

    const unknown = parseStoryTime("未定", context);
    expect(unknown.ok && unknown.value.certainty === "unknown" && unknown.value.t === null).toBe(true);
    expect(boundsOf(unknown.ok ? unknown.value : { t: null })).toEqual({ start: null, end: null });
  });

  it("年号历：康熙二十三年三月初七 → 1684-04-21，标签同时给原文和公历", () => {
    const era = parseStoryTime("康熙二十三年三月初七", context);
    expect(era.ok).toBe(true);
    if (!era.ok) return;
    expect(era.value.certainty).toBe("exact");
    expect(era.value.calendar).toBe("chinese_era");
    expect(era.value.label).toContain("康熙二十三年三月初七");
    expect(era.value.label).toContain("1684-04-21");
    expect(era.value.original).toBe("康熙二十三年三月初七");
    expect(civilFromT(era.value.t!)).toMatchObject({ year: 1684, month: 4, day: 21 });
  });

  it("只知道月份时给一个范围；闰月不存在就明确说没有", () => {
    const monthOnly = parseStoryTime("康熙二十三年三月", context);
    expect(monthOnly.ok && monthOnly.value.certainty === "range").toBe(true);
    if (monthOnly.ok) {
      expect(monthOnly.value.range![1]).toBeGreaterThan(monthOnly.value.range![0]);
      expect(monthOnly.value.label).toContain("–");
    }
    const wrongLeap = parseStoryTime("康熙二十三年闰三月", context);
    expect(wrongLeap.ok).toBe(false);
    if (wrongLeap.ok) return;
    expect(wrongLeap.failure.message).toContain("没有闰三月");
  });

  it("年号表里没有、干支对不上，都明确拒绝（顺带给能用的候选）", () => {
    const unknown = parseStoryTime("天宝十三年三月初七", context);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.failure.message).toContain("不在本地年号表里");

    const mismatch = parseStoryTime("康熙二十三年丙子年三月初七", context);
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.failure.message).toContain("对不上");

    const ganzhiOnly = parseStoryTime("甲子年三月初七", context);
    expect(ganzhiOnly.ok).toBe(false);
    if (ganzhiOnly.ok) return;
    expect(ganzhiOnly.failure.message).toContain("六十年一轮");
    expect(ganzhiOnly.failure.candidates.length).toBeGreaterThan(0);
    for (const candidate of ganzhiOnly.failure.candidates) {
      expect(candidate.label).toContain("甲子");
      expect(candidate.why).toContain("六十年一轮");
    }
  });

  it("农历闰月与春节对着真实历表都对（2023 闰二月初一、2020 闰四月初一、2024 正月初一）", () => {
    expect(lunarToCivil(2023, 2, 1, true)).toMatchObject({ year: 2023, month: 3, day: 22 });
    expect(lunarToCivil(2020, 4, 1, true)).toMatchObject({ year: 2020, month: 5, day: 23 });
    expect(lunarToCivil(2024, 1, 1)).toMatchObject({ year: 2024, month: 2, day: 10 });
    expect(lunarToCivil(2025, 1, 1)).toMatchObject({ year: 2025, month: 1, day: 29 });
    // 当年没有的闰月给 null，不编一个日期
    expect(lunarToCivil(2024, 2, 1, true)).toBeNull();
  });

  it("中文数字只认得出就认，认不出不猜", () => {
    expect(chineseNumber("三")).toBe(3);
    expect(chineseNumber("十二")).toBe(12);
    expect(chineseNumber("两")).toBe(2);
    expect(chineseNumber("三十五")).toBe(35);
    expect(chineseNumber("很多")).toBeNull();
  });

  it("标签能按公历格式化", () => {
    expect(gregorianLabel(gregorianToT(1684, 4, 21))).toBe("1684-04-21");
    expect(gregorianLabel(gregorianToT(1684, 4, 21, 8, 5))).toBe("1684-04-21 08:05");
  });
});
