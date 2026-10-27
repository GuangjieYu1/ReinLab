import { describe, expect, it, vi } from "vitest";
import { createLiveReadAdapter } from "../../../src/data/read-live";

type Call = { path: string; body?: unknown };

function adapter(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const api = vi.fn(async (path: string, body?: unknown) => {
    calls.push({ path, body });
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!key) throw Error("unexpected " + path);
    return routes[key]({ path, body });
  });
  const decide = vi.fn(async () => ({}));
  const instance = createLiveReadAdapter(undefined, { api: api as never, decide: decide as never, generation: () => 1 });
  return { instance, calls, decide };
}

const event = (seq: number, action: string, payload: Record<string, unknown>) => ({ seq, action, payload });

describe("live read adapter over the DSH kernel", () => {
  it("adopts the archive, replays the latest run and maps kernel events", async () => {
    const { instance } = adapter({
      "/v1/dossiers": () => ({ items: [{ id: "d-1", title: "真实档案" }] }),
      "/v1/kernel/dossiers/d-1/runs": () => ({ runs: [{ id: "r-1", state: "running" }] }),
      "/v1/kernel/runs/r-1/events": () => ({
        events: [
          event(1, "user/message", { id: "u1", content: [{ type: "text", text: "想读 Toolformer" }] }),
          event(2, "assistant/message", { message: { id: "a1", content: [{ type: "text", text: "我先检索" }] } }),
          event(3, "tool/call", { name: "papers_search", callId: "c1", arguments: "{\"query\":\"toolformer\"}" }),
          event(4, "tool/result", { callId: "c1", message: { content: [{ type: "text", text: "找到 1 篇" }] } }),
        ],
      }),
      "/v1/kernel/runs/r-1": () => ({ state: "running", usage: { known: false } }),
    });
    const snapshot = await instance.load();
    expect(snapshot.dossier).toEqual({ id: "d-1", title: "真实档案" });
    expect(snapshot.run.state).toBe("running");
    expect(snapshot.run.unknownCost).toBe(true);
    const kinds = snapshot.history.map((entry) => entry.type);
    expect(kinds).toContain("user");
    expect(kinds).toContain("agent");
    expect(kinds.filter((kind) => kind === "tool").length).toBeGreaterThan(0);
  });

  it("rejects load with a readable reason when the kernel is unreachable", async () => {
    const { instance } = adapter({
      "/v1/dossiers": () => {
        throw Error("内核连接失败");
      },
    });
    await expect(instance.load()).rejects.toThrow(/内核连接失败/);
  });

  it("starts a run from the first sentence and answers a pick on its card", async () => {
    const { instance, calls } = adapter({
      "/v1/dossiers": () => ({ items: [{ id: "d-1", title: "档案" }] }),
      "/v1/kernel/dossiers/d-1/runs": () => ({ runs: [] }),
      "/v1/kernel/runs": () => ({ id: "r-new" }),
      "/v1/kernel/runs/r-new/events": () => ({
        events: [
          event(1, "tool/call", {
            name: "clarify_question",
            callId: "pick-1",
            arguments: JSON.stringify({ kind: "paper_pick", question: "哪一篇？", candidates: [{ paperId: "W1", title: "Toolformer" }] }),
          }),
        ],
      }),
      "/v1/kernel/runs/r-new": () => ({ state: "running", usage: { known: true } }),
      "/v1/kernel/approvals/pick-1/answer": () => ({ state: "approved" }),
    });
    await instance.load();
    await instance.clarify("我想读 Toolformer");
    const created = calls.find((call) => call.path === "/v1/kernel/runs");
    expect(created?.body).toMatchObject({ dossierId: "d-1", query: "我想读 Toolformer" });

    const seen: string[] = [];
    instance.subscribe((entry) => void seen.push(entry.type));
    await new Promise((r) => setTimeout(r, 1600));
    await instance.pick("pick-1", "W1");
    expect(calls.some((call) => call.path === "/v1/kernel/approvals/pick-1/answer" && (call.body as any)?.candidateId === "W1")).toBe(true);
  });

  it("reports an unconfirmed stop instead of pretending the run stopped", async () => {
    const { instance } = adapter({
      "/v1/dossiers": () => ({ items: [{ id: "d-1", title: "档案" }] }),
      "/v1/kernel/dossiers/d-1/runs": () => ({ runs: [{ id: "r-1", state: "running" }] }),
      "/v1/kernel/runs/r-1/events": () => ({ events: [] }),
      "/v1/kernel/runs/r-1/cancel": () => ({ state: "cancel_unconfirmed" }),
      "/v1/kernel/runs/r-1": () => ({ state: "running", usage: { known: false } }),
    });
    await instance.load();
    const runs: Array<Record<string, unknown>> = [];
    instance.subscribe((entry) => {
      if (entry.type === "run") runs.push(entry.run as Record<string, unknown>);
    });
    await instance.cancel();
    const last = runs[runs.length - 1] ?? {};
    expect(String(last.message ?? "")).toContain("停止未确认");
  });
});
