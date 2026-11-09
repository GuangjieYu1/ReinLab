// MVP-2：出图描述拼装 + 开发占位图是合法 PNG（页面在没 key 时也能走通四格流程）。
import { describe, expect, it } from "vitest";
import { solidPng } from "../src/creative/image/dev-placeholder";
import { promptOf } from "../src/creative/asset-service";

describe("人物形象的出图描述", () => {
  it("按 artStyle + look + note + 写死的视图要求拼", () => {
    const prompt = promptOf({ artStyle: "明清工笔淡彩", look: "青衫，左眉有疤", note: "清瘦", view: "side" });
    expect(prompt).toContain("明清工笔淡彩");
    expect(prompt).toContain("青衫，左眉有疤");
    expect(prompt).toContain("清瘦");
    expect(prompt).toContain("正侧面");
    // 视图要求写死在服务端，不靠模型发挥
    expect(prompt).toContain("白底");
  });
});

describe("开发占位图", () => {
  it("是合法 PNG，宽高写在 IHDR 里", () => {
    const png = solidPng(8, 6, [10, 20, 30]);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(8);
    expect(view.getUint32(20)).toBe(6);
    expect(png.length).toBeGreaterThan(50);
  });
});
