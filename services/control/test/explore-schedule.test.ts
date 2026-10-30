import { describe, expect, it } from "vitest";
import { currentSlot, nextCheckAt, shiftDay } from "../src/explore/schedule";
import { instantOfLocal, isoAt } from "../src/explore/sun";

const tokyo = (day: string, clock: string) => instantOfLocal(day, clock, "Asia/Tokyo");

describe("天气检查时点（账户时区 08/16/23）", () => {
  it("早上七点排到当天八点，中午排到下午四点，深夜排到次日八点", () => {
    expect(isoAt("Asia/Tokyo", nextCheckAt("Asia/Tokyo", tokyo("2026-11-15", "07:00")))).toBe(
      "2026-11-15T08:00:00+09:00",
    );
    expect(isoAt("Asia/Tokyo", nextCheckAt("Asia/Tokyo", tokyo("2026-11-15", "12:00")))).toBe(
      "2026-11-15T16:00:00+09:00",
    );
    expect(isoAt("Asia/Tokyo", nextCheckAt("Asia/Tokyo", tokyo("2026-11-15", "23:30")))).toBe(
      "2026-11-16T08:00:00+09:00",
    );
    // 刚好到点也要往后排，不能原地重复触发。
    expect(isoAt("Asia/Tokyo", nextCheckAt("Asia/Tokyo", tokyo("2026-11-15", "16:00")))).toBe(
      "2026-11-15T23:00:00+09:00",
    );
  });

  it("用的是账户时区，不是服务器时区：纽约账户在纽约的八点检查", () => {
    const now = instantOfLocal("2026-11-15", "07:00", "America/New_York");
    const next = nextCheckAt("America/New_York", now);
    expect(isoAt("America/New_York", next)).toBe("2026-11-15T08:00:00-05:00");
  });

  it("夏令时切换当天也落在当地八点，不是偏移一小时", () => {
    const now = instantOfLocal("2027-03-14", "07:00", "America/New_York");
    const next = nextCheckAt("America/New_York", now);
    expect(isoAt("America/New_York", next)).toBe("2027-03-14T08:00:00-04:00");
  });

  it("迟到补查时标出是哪一个时点", () => {
    expect(currentSlot("Asia/Tokyo", tokyo("2026-11-15", "09:30"))).toBe("08");
    expect(currentSlot("Asia/Tokyo", tokyo("2026-11-15", "16:05"))).toBe("16");
    expect(currentSlot("Asia/Tokyo", tokyo("2026-11-15", "23:59"))).toBe("23");
    // 凌晨还没到今天的第一个时点：算前一天 23 点之后的那次。
    expect(currentSlot("Asia/Tokyo", tokyo("2026-11-15", "03:00"))).toBe("23");
  });

  it("日期加减按日历算，跨月跨年都对", () => {
    expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2026-11-15", -15)).toBe("2026-10-31");
  });
});
