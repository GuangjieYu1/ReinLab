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
import { CUSTOM_ERA, GREGORIAN } from "../src/creative/world";

const context = {
  calendars: [GREGORIAN, CUSTOM_ERA],
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

  it("年号历法（1B）明确回 422，不猜日期", () => {
    const era = parseStoryTime("康熙二十三年三月初七", context);
    expect(era.ok).toBe(false);
    if (era.ok) return;
    expect(era.failure.code).toBe("TIME_UNPARSED");
    expect(era.failure.message).toContain("1B");
    expect(era.failure.candidates).toEqual([]);
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
