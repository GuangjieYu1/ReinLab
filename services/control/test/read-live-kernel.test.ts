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

  it("shows a replayed user message as its text, not as [object Object]", async () => {
    // 刷新后从事件回填历史：content 是 [{type:'text',text:'…'}] 时不能直接转字符串。
    const { instance } = adapter({
      "/v1/dossiers": () => ({ items: [{ id: "d-1", title: "档案" }] }),
      "/v1/kernel/dossiers/d-1/runs": () => ({ runs: [{ id: "r-1", state: "running" }] }),
      "/v1/kernel/runs/r-1/events": () => ({
        events: [
          event(1, "user/message", { id: "u1", content: [{ type: "text", text: "我想读提出 Transformer 的那篇原始论文" }] }),
          // 运行时上下文不是用户说的话，回填时也不该出现。
          event(2, "user/message", { id: "u2", source: { kind: "runtime-context" }, content: [{ type: "text", text: "/private/path" }] }),
        ],
      }),
      "/v1/kernel/runs/r-1": () => ({ state: "running", usage: { known: false } }),
    });
    const snapshot = await instance.load();
    const users = snapshot.history.filter((entry) => entry.type === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "我想读提出 Transformer 的那篇原始论文" });
    expect(JSON.stringify(snapshot.history)).not.toContain("[object Object]");
  });

  it("does not show step/turn boundaries as tool calls", async () => {
    // step/end、turn/end 是运行时内部事件，不是给用户的工具调用。
    const { instance } = adapter({
      "/v1/dossiers": () => ({ items: [{ id: "d-1", title: "档案" }] }),
      "/v1/kernel/dossiers/d-1/runs": () => ({ runs: [{ id: "r-1", state: "running" }] }),
      "/v1/kernel/runs/r-1/events": () => ({
        events: [
          event(1, "step/start", { step: 1, turn: 1 }),
          event(2, "tool/call", { name: "papers_search", callId: "c1", arguments: "{}" }),
          event(3, "step/end", { step: 1, turn: 1 }),
          event(4, "turn/end", { reason: { kind: "completed" } }),
          event(5, "system/message", { text: "系统提示" }),
          event(6, "request/context", { tools: [] }),
          event(7, "session/title", { title: "标题" }),
        ],
      }),
      "/v1/kernel/runs/r-1": () => ({ state: "done", usage: { known: false } }),
    });
    const snapshot = await instance.load();
    const actions = snapshot.history
      .filter((entry) => entry.type === "tool")
      .map((entry) => (entry as { action?: string }).action);
    expect(actions).not.toContain("step/start");
    expect(actions).not.toContain("step/end");
    expect(actions).not.toContain("turn/end");
    expect(actions).not.toContain("system/message");
    expect(actions).not.toContain("request/context");
    expect(actions).not.toContain("session/title");
    expect(actions).toContain("papers.search");
  });

  it("重新加载时从已落库的卡片事件还原讲解层与发现卡", async () => {
    // 之前只从进行中的工具调用生成卡片，刷新或续接后数据库里的成果在页面上全丢。
    const { instance } = adapter({
      "/v1/dossiers": () => ({ items: [{ id: "d-1", title: "档案" }] }),
      "/v1/kernel/dossiers/d-1/runs": () => ({ runs: [{ id: "r-1", state: "completed" }] }),
      "/v1/kernel/runs/r-1/events": () => ({
        events: [
          event(1, "card_created", {
            cardId: "c-1",
            cardType: "layer",
            card: { paperId: "p", no: "1", title: "提出问题", en: "Problem", body: [{ text: "这一层讲问题。", refs: [{ page: 2 }] }] },
          }),
          event(2, "card_created", {
            cardId: "c-2",
            cardType: "layer",
            card: { paperId: "p", no: "2", title: "方法", en: "Method", body: [{ text: "这一层讲方法。" }] },
          }),
          event(3, "card_created", {
            cardId: "c-3",
            cardType: "finding",
            card: { text: "核心发现", evidence: [{ page: 3 }], confidence: "high", status: "supported" },
          }),
        ],
      }),
      "/v1/kernel/runs/r-1": () => ({ state: "completed", usage: { known: false } }),
    });
    const snapshot = await instance.load();
    expect(snapshot.layers.map((l) => l.no)).toEqual(["1", "2"]);
    expect(snapshot.findings).toHaveLength(1);
    expect(snapshot.findings[0]).toMatchObject({ text: "核心发现", confidence: "high" });
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
      "/v1/dossiers": (call) =>
        call.body === undefined ? { items: [{ id: "d-1", title: "档案" }] } : { id: "d-new" },
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
    // 每段新对话都开新档案：旧档案里已下载的论文会让下载审批直接消失。
    expect(created?.body).toMatchObject({ dossierId: "d-new", query: "我想读 Toolformer" });

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
