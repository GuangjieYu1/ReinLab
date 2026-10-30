import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 插件是模型看到的工具清单：漏一个，助手就用不了那条能力；多删一段代码更是静默少能力。
 * 这里做一次静态体检——工具名齐全、每个都有说明、后端也有同名能力。
 */
const PLUGIN = resolve("plugins/reinlab-read-plugin/index.js");

/** 助手应该拿到的探索台工具（和 kernel-tools 的 KERNEL_TOOLS.explore 对齐）。 */
const EXPECTED_EXPLORE_TOOLS = [
  "explore_get",
  "explore_ops",
  "explore_view",
  "explore_undo",
  "explore_weather",
  "explore_sun",
  "explore_light",
  "explore_pending",
  "explore_profiles",
  "explore_profile_write",
  "explore_refs",
  "explore_ref_add",
  "explore_usage",
  "explore_book",
  "explore_places",
  "explore_route",
];

describe("探索台插件工具清单", () => {
  it("工具名齐全，且 node 能解析这个文件", async () => {
    const source = await readFile(PLUGIN, "utf8");
    for (const tool of EXPECTED_EXPLORE_TOOLS)
      expect(source, `缺少工具 ${tool}`).toContain(`name: "${tool}"`);
    // 每个探索台工具都带说明（模型靠说明决定用哪个）。
    const blocks = source.split('defineTool({').slice(1);
    for (const block of blocks) {
      const name = /name: "([a-z_]+)"/.exec(block)?.[1] ?? "";
      if (!name.startsWith("explore_")) continue;
      expect(block, `${name} 缺 description`).toContain("description:");
    }
  });

  it("后端也真的开放了这些工具", async () => {
    const kernel = await readFile(resolve("services/control/src/api/kernel-tools.ts"), "utf8");
    const listed = /explore: \[([\s\S]*?)\]/.exec(kernel)?.[1] ?? "";
    for (const tool of EXPECTED_EXPLORE_TOOLS)
      expect(listed, `kernel-tools 没开放 ${tool.replace("explore_", "")}`).toContain(
        `"${tool.replace("explore_", "")}"`,
      );
  });

  it("探索台工具只在 explore 模式注册，不会串到精读", async () => {
    const source = await readFile(PLUGIN, "utf8");
    expect(source).toContain('if (config.mode === "explore")');
    // 精读模式不该拿到改计划的工具。
    const readOnlySide = source.slice(0, source.indexOf('if (config.mode === "explore")'));
    expect(readOnlySide).not.toContain('name: "explore_ops"');
  });
});
