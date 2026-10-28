import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveReadAdapter } from "../../../src/data/read-live";

/** 精读适配器现在只说 /v1/kernel/*。这组用例守的是「说一句 → 出候选 → 选定 → 开始」这条主路。 */
const routes = (
  handler: (path: string, body?: any, key?: string) => unknown,
) => {
  const api = vi.fn(async (path: string, body?: unknown, key?: string) =>
    handler(path, body as any, key as string | undefined),
  );
  return { api, decide: vi.fn(async () => ({})), generation: () => 1 };
};

const clarifyEvent = {
  seq: 1,
  action: "tool/call",
  payload: {
    name: "clarify_question",
    callId: "call-pick",
    arguments: JSON.stringify({
      kind: "paper_pick",
      question: "你想读哪一篇？",
      candidates: [
        { paperId: "arxiv:2302.04761v1", title: "Toolformer: Language Models Can Teach Themselves to Use Tools" },
        { paperId: "arxiv:2210.03629v3", title: "ReAct: Synergizing Reasoning and Acting in Language Models" },
      ],
    }),
  },
};

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
});

describe("精读适配器（kernel 协议）", () => {
  it("说一句就在新档案里开一轮澄清，候选以选择题出现在对话里", async () => {
    const calls: string[] = [];
    const ports = routes((path, body) => {
      calls.push(path);
      if (path === "/v1/dossiers?view=read") return { items: [] };
      if (path === "/v1/dossiers") return { id: "dossier-1", title: "新的精读" };
      if (path === "/v1/kernel/runs") {
        expect(body).toMatchObject({ dossierId: "dossier-1", query: "我想读 Toolformer" });
        return { id: "run-1", sessionId: "ds-1" };
      }
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events")) return { events: [clarifyEvent] };
      if (path === "/v1/kernel/runs/run-1") return { state: "running", usage: { known: false } };
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter(undefined, ports as never);
    off = adapter.subscribe(() => {});
    await adapter.clarify("我想读 Toolformer");
    const snapshot = await adapter.load();
    const pick = snapshot.history.find((event) => event.type === "pick");
    expect(pick).toMatchObject({ type: "pick", query: "你想读哪一篇？" });
    expect(pick && pick.type === "pick" ? pick.candidates : []).toEqual([
      {
        id: "arxiv:2302.04761v1",
        title: "Toolformer: Language Models Can Teach Themselves to Use Tools",
        authors: "检索结果",
        venue: "arXiv",
        access: "full",
      },
      {
        id: "arxiv:2210.03629v3",
        title: "ReAct: Synergizing Reasoning and Acting in Language Models",
        authors: "检索结果",
        venue: "arXiv",
        access: "full",
      },
    ]);
    expect(calls).toContain("/v1/kernel/runs");
  });

  it("选定后回答落到这一轮的提问卡上，并记住人选", async () => {
    const answers: Array<{ path: string; body: any }> = [];
    const ports = routes((path, body) => {
      if (path === "/v1/dossiers?view=read") return { items: [{ id: "dossier-1", title: "精读档案" }] };
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events")) return { events: [clarifyEvent] };
      if (path.startsWith("/v1/kernel/approvals/")) {
        answers.push({ path, body });
        return { state: "answered" };
      }
      if (path === "/v1/kernel/runs/run-1") return { state: "running", usage: { known: false } };
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter(undefined, ports as never);
    const events: any[] = [];
    off = adapter.subscribe((event) => events.push(event));
    await adapter.load();
    await adapter.pick("call-pick", "arxiv:2210.03629v3");
    expect(answers).toHaveLength(1);
    expect(answers[0].path).toContain("/answer");
    expect(answers[0].body).toEqual({ candidateId: "arxiv:2210.03629v3" });
    const run = events.filter((event) => event.type === "run").at(-1);
    expect(run?.run.chosen?.id).toBe("arxiv:2210.03629v3");
  });

  it("开始精读带着选定编号开新一轮", async () => {
    const started: any[] = [];
    const ports = routes((path, body) => {
      if (path === "/v1/dossiers?view=read") return { items: [{ id: "dossier-1", title: "精读档案" }] };
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "completed" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events")) return { events: [clarifyEvent] };
      if (path === "/v1/kernel/runs/run-1") return { state: "completed", usage: { known: false } };
      if (path === "/v1/kernel/runs") {
        started.push(body);
        return { id: "run-2", sessionId: "ds-1" };
      }
      if (path.startsWith("/v1/kernel/approvals/")) return { state: "answered" };
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter(undefined, ports as never);
    off = adapter.subscribe(() => {});
    await adapter.load();
    await adapter.pick("call-pick", "arxiv:2302.04761v1");
    await adapter.start("kernel-estimate", 2.5);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ dossierId: "dossier-1", chosenPaperId: "arxiv:2302.04761v1" });
    expect(String(started[0].query)).toContain("paperId=arxiv:2302.04761v1");
  });
});
