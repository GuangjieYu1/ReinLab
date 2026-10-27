import { describe, expect, it, vi } from "vitest";
import { runTurn, type HarnessLike } from "../src/kernel/dsh/session";
import { launchPlan } from "../src/kernel/dsh/launch";

const bundler = {
  shimModule: "/app/shim.mjs",
  shimContainerModule: "/app/shim.mjs",
  dshModule: "/app/dsh.mjs",
  restrictPatch: "/opt/read.patch.yml",
  pluginPatch: "/opt/plugin.patch.yml",
};
const plan = launchPlan({
  account: "10000000-0000-4000-8000-000000000001",
  dossier: "20000000-0000-4000-8000-000000000002",
  run: "30000000-0000-4000-8000-000000000003",
  sessionId: "ds-1",
  controlUrl: "http://control:3001",
  model: "deepseek-v4-flash",
  maxTokens: 32768,
  bundler,
});

function fake(events: Array<{ type: string; data?: Record<string, unknown> }>) {
  const close = vi.fn(async () => {});
  const sessionRun = vi.fn(async (_text: string, options: { onNotification?: (n: unknown) => void }) => {
    for (const event of events) options.onNotification?.({ method: "session.event", params: { event } });
    return { sessionId: plan.sessionId, events, finalResponse: "done" };
  });
  const harness: HarnessLike = {
    session: vi.fn(() => ({ run: sessionRun })),
    resumeSession: vi.fn(async () => ({ run: sessionRun })),
    close,
  };
  return { harness, sessionRun, close, factory: () => harness };
}

describe("dsh turn driver", () => {
  it("opens a fresh session or resumes the saved one, then closes the runtime", async () => {
    const fresh = fake([{ type: "turn/end", data: { reason: { kind: "completed" } } }]);
    await runTurn({ plan, prompt: "hi", resume: false, factory: fresh.factory, onEvent: () => {} });
    expect(fresh.harness.session).toHaveBeenCalledWith(plan.sessionId);
    expect(fresh.harness.resumeSession).not.toHaveBeenCalled();
    expect(fresh.close).toHaveBeenCalledTimes(1);

    const resumed = fake([{ type: "turn/end", data: { reason: { kind: "completed" } } }]);
    await runTurn({ plan, prompt: "hi", resume: true, factory: resumed.factory, onEvent: () => {} });
    expect(resumed.harness.resumeSession).toHaveBeenCalledWith(plan.sessionId);
    expect(resumed.harness.session).not.toHaveBeenCalled();
    expect(resumed.close).toHaveBeenCalledTimes(1);
  });

  it("streams events in wire order to the caller", async () => {
    const seen: string[] = [];
    const events = [
      { type: "turn/start" },
      { type: "assistant/message", data: { usage: { inputTokens: 1, outputTokens: 2 } } },
      { type: "tool/call", data: { name: "papers.search" } },
      { type: "turn/end", data: { reason: { kind: "completed" } } },
    ];
    const f = fake(events);
    await runTurn({ plan, prompt: "hi", resume: false, factory: f.factory, onEvent: (event) => void seen.push(event.type) });
    expect(seen).toEqual(["turn/start", "assistant/message", "tool/call", "turn/end"]);
  });

  it("reports failure with the kernel's own stop reason and still closes", async () => {
    const f = fake([{ type: "turn/end", data: { reason: { kind: "error" } } }]);
    const outcome = await runTurn({ plan, prompt: "hi", resume: false, factory: f.factory, onEvent: () => {} });
    expect(outcome.state).toBe("failed");
    expect(outcome.errorCode).toBeTruthy();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("closes the runtime even when the run rejects", async () => {
    const close = vi.fn(async () => {});
    const harness: HarnessLike = {
      session: () => ({ run: async () => Promise.reject(new Error("transport gone")) }),
      resumeSession: async () => ({}),
      close,
    };
    await expect(
      runTurn({ plan, prompt: "hi", resume: false, factory: () => harness, onEvent: () => {} }),
    ).rejects.toThrow(/transport gone/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
