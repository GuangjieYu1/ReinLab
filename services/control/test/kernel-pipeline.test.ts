import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { executeRun } from "../src/kernel/dsh/pipeline";
import { launchPlan } from "../src/kernel/dsh/launch";
import type { HarnessLike } from "../src/kernel/dsh/session";

const bundler = {
  shimModule: "/app/shim.mjs",
  shimContainerModule: "/app/shim.mjs",
  dshModule: "/app/dsh.mjs",
  restrictPatch: "/opt/restrict.patch.yml",
  pluginEntry: "file:///opt/plugin/index.js",
};

function run(name: string) {
  const plan = launchPlan({
    account: "10000000-0000-4000-8000-000000000001",
    dossier: "20000000-0000-4000-8000-000000000002",
    run: "30000000-0000-4000-8000-000000000003",
    sessionId: "ds-" + name,
    controlUrl: "http://control:3001",
    model: "deepseek-v4-flash",
    maxTokens: 4096,
    home: "/tmp/unused",
    bundler,
  });
  return plan;
}

function harness(eventType: string, reason: string): HarnessLike {
  return {
    session: () => ({
      run: async (_text, options) => {
        options.onNotification?.({ method: "session.event", params: { event: { type: "turn/start" } } });
        if (eventType) options.onNotification?.({ method: "session.event", params: { event: { type: eventType, data: {} } } });
        return {
          sessionId: "ds",
          events: [{ type: "turn/end", data: { reason: { kind: reason } } }],
          finalResponse: "ok",
        };
      },
    }),
    resumeSession: async () => ({ run: async () => ({ sessionId: "ds", events: [], finalResponse: "" }) }),
    close: vi.fn(async () => {}),
  };
}

describe("run pipeline", () => {
  it("keeps the confirmed cancel state even though closing the runtime rejects the turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-cancel2-"));
    const plan = run("e");
    plan.paths.pidFile = join(directory, "dsh.pid");
    writeFileSync(plan.paths.pidFile, String(process.pid));
    const states: string[] = [];
    const handle = executeRun(
      {
        factory: () => ({
          session: () => ({
            run: () =>
              new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error("transport gone")), 10);
              }),
          }),
          resumeSession: async () => ({}),
          close: async () => {
            writeFileSync(plan.paths.pidFile, "999999");
          },
        }),
        onEvent: () => {},
        onState: (state) => void states.push(state),
        release: async () => {},
      },
      { plan, prompt: "hi", resume: false, token: "t" },
    );
    expect(await handle.cancel()).toBe("cancelled");
    await handle.done.catch(() => {});
    expect(states).toContain("cancelled");
    expect(states).not.toContain("failed");
  });

  it("forwards kernel events in order and records the completed state", async () => {
    const states: string[] = [];
    const events: string[] = [];
    const release = vi.fn(async () => {});
    const handle = executeRun(
      {
        factory: () => harness("tool/call", "completed"),
        onEvent: (event) => void events.push(event.type),
        onState: (state) => void states.push(state),
        release,
      },
      { plan: run("a"), prompt: "hi", resume: false, token: "t" },
    );
    const outcome = await handle.done;
    expect(outcome.state).toBe("completed");
    expect(events).toEqual(["turn/start", "tool/call"]);
    expect(states).toEqual(["completed"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("records failed and still releases when the kernel stops with an error", async () => {
    const states: string[] = [];
    const release = vi.fn(async () => {});
    const handle = executeRun(
      {
        factory: () => harness("", "error"),
        onEvent: () => {},
        onState: (state) => void states.push(state),
        release,
      },
      { plan: run("b"), prompt: "hi", resume: false, token: "t" },
    );
    const outcome = await handle.done;
    expect(outcome.state).toBe("failed");
    expect(states).toEqual(["failed"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("records failed and releases when the transport dies mid-run", async () => {
    const states: string[] = [];
    const release = vi.fn(async () => {});
    const broken: HarnessLike = {
      session: () => ({ run: async () => Promise.reject(new Error("transport gone")) }),
      resumeSession: async () => ({}),
      close: vi.fn(async () => {}),
    };
    const handle = executeRun(
      {
        factory: () => broken,
        onEvent: () => {},
        onState: (state) => void states.push(state),
        release,
      },
      { plan: run("c"), prompt: "hi", resume: false, token: "t" },
    );
    await expect(handle.done).rejects.toThrow(/transport gone/);
    expect(states).toEqual(["failed"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels only after the run's own process is confirmed gone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-cancel-"));
    const plan = run("d");
    plan.paths.pidFile = join(directory, "dsh.pid");
    writeFileSync(plan.paths.pidFile, String(process.pid));
    const close = vi.fn(async () => {
      // The child exits as a direct result of the close.
      writeFileSync(plan.paths.pidFile, "999999");
    });
    const status = await executeRun(
      {
        factory: () => ({ session: () => ({ run: async () => new Promise(() => {}) }), resumeSession: async () => ({}), close }),
        onEvent: () => {},
        onState: () => {},
        release: async () => {},
      },
      { plan, prompt: "hi", resume: false, token: "t" },
    ).cancel();
    expect(status).toBe("cancelled");
    expect(close).toHaveBeenCalled();
  });
});
