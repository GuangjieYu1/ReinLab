import { describe, expect, it, vi } from "vitest";
import { cancelRun } from "../src/kernel/dsh/cancel";

const deps = (alive: boolean[], onState = vi.fn(async () => {})) => ({
  close: vi.fn(async () => {}),
  pidAlive: vi.fn(async () => alive.shift() ?? false),
  onState,
  pollMs: 1,
  timeoutMs: 50,
});

describe("run cancel", () => {
  it("only reports cancelled after the kernel process is confirmed gone", async () => {
    const onState = vi.fn(async () => {});
    const d = deps([true, true, false], onState);
    const receipt = await cancelRun(d);
    expect(d.close).toHaveBeenCalledTimes(1);
    expect(receipt.status).toBe("cancelled");
    expect(onState).toHaveBeenCalledWith("cancelled");
  });

  it("records cancel_unconfirmed instead of cancelled while the process is still alive", async () => {
    const onState = vi.fn(async () => {});
    const d = { ...deps(new Array(100).fill(true), onState), pidAlive: vi.fn(async () => true) };
    const receipt = await cancelRun(d);
    expect(receipt.status).toBe("cancel_unconfirmed");
    expect(onState).toHaveBeenCalledWith("cancel_unconfirmed");
    expect(onState).not.toHaveBeenCalledWith("cancelled");
  });

  it("still accepts a confirmed stop when closing the transport throws", async () => {
    const onState = vi.fn(async () => {});
    const d = deps([false], onState);
    d.close.mockRejectedValueOnce(new Error("transport already gone"));
    const receipt = await cancelRun(d);
    expect(receipt.status).toBe("cancelled");
  });

  it("treats an unconfirmed stop after a close failure as unconfirmed", async () => {
    const onState = vi.fn(async () => {});
    const d = { ...deps([], onState), pidAlive: vi.fn(async () => true) };
    d.close.mockRejectedValueOnce(new Error("close failed"));
    const receipt = await cancelRun(d);
    expect(receipt.status).toBe("cancel_unconfirmed");
    expect(onState).not.toHaveBeenCalledWith("cancelled");
  });
});
