import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELECTRON_RUNTIME_FORBIDDEN, NODE22_REQUIRED, isElectronRuntime } from "./runtime";

describe("local stack runtime pinning", () => {
  it("detects an Electron runtime instead of a real node", () => {
    const nodePath = "/usr/local/bin/node";
    expect(isElectronRuntime({ node: "22.23.3" }, nodePath, { name: "node" })).toBe(false);
    expect(isElectronRuntime({ node: "24.18.1", electron: "43.3.0" }, nodePath, { name: "node" })).toBe(true);
    expect(
      isElectronRuntime({ node: "24.18.1" }, "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop", { name: "node" }),
    ).toBe(true);
    // DSH 的 node 只是在路径里带 DSH Desktop，它本身仍是 node（内核不接受的是 Electron 进程）。
    expect(
      isElectronRuntime({ node: "24.18.1" }, "/Users/x/Library/Application Support/DSH Desktop/node-bin/node", { name: "node" }),
    ).toBe(false);
  });

  it("names the toolchain entry in both refusal messages", () => {
    expect(ELECTRON_RUNTIME_FORBIDDEN).toContain("LOCAL_ELECTRON_RUNTIME_FORBIDDEN");
    expect(ELECTRON_RUNTIME_FORBIDDEN).toContain("local:up22");
    expect(NODE22_REQUIRED).toContain("LOCAL_NODE22_REQUIRED");
  });
});
