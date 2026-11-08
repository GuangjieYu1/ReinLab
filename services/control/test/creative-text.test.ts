// 截断按字符来，不把一个汉字或表情切成两半（1A 遗留 2：依据里出现「O��M」）。
import { describe, expect, it } from "vitest";
import { clip } from "../src/creative/text";

describe("按字符截断", () => {
  it("汉字不会被切成半个", () => {
    const text = "从阊门往西上支硎山";
    const clipped = clip(text, 6);
    expect(clipped).toBe("从阊门往西上");
    expect([...clipped]).toHaveLength(6);
    expect(clipped).not.toContain("\uFFFD");
  });

  it("表情（代理对）不会被切开", () => {
    const clipped = clip("夜行🌙古道", 3);
    expect(clipped).toBe("夜行🌙");
    expect([...clipped]).toHaveLength(3);
    expect(clipped).not.toContain("\uFFFD");
    // 一个半代理对会被 JSON 写成乱码，这里按码点截就不会出现
    expect(() => JSON.stringify({ clipped })).not.toThrow();
  });

  it("不超长就原样返回；空值和 0 上限给空串", () => {
    expect(clip("短", 10)).toBe("短");
    expect(clip(null, 5)).toBe("");
    expect(clip("一二三", 0)).toBe("");
  });
});
