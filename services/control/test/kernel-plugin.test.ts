import { beforeEach, describe, expect, it, vi } from "vitest";
import { apply } from "../../../plugins/reinlab-read-plugin/index.js";

type Registered = {
  name: string;
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
};

function mount(fetchImpl: ReturnType<typeof vi.fn>, mode: "clarify" | "read" = "clarify") {
  const registered: Registered[] = [];
  const ctx = {
    tools: { register: (definition: Registered) => registered.push(definition) },
  };
  apply(ctx, {
    controlUrl: "http://control:3001",
    mode,
    token: "run-token",
    fetch: fetchImpl,
    approvalPollMs: 1,
    approvalTimeoutMs: 2000,
  });
  return { registered, tool: (name: string) => registered.find((d) => d.name === name)! };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("reading plugin", () => {
  let requests: Array<{ url: string; init: RequestInit }>;
  beforeEach(() => {
    requests = [];
  });

  it("exposes only reading tools, with no general writer, shell or subagent", () => {
    // 每轮都拿到同一套能力：用什么、先用哪个由模型决定，工具集不再按阶段裁剪。
    const surface = ["card_finding", "card_layer", "clarify_question", "papers_fetch", "papers_pages", "papers_search"].sort();
    expect(mount(vi.fn()).registered.map((d) => d.name).sort()).toEqual(surface);
    expect(mount(vi.fn(), "read").registered.map((d) => d.name).sort()).toEqual(surface);
    for (const name of ["files.write", "bash", "web_search"]) {
      expect(mount(vi.fn()).registered.map((d) => d.name)).not.toContain(name);
    }
  });

  it("工具失败把错误码和原因交回模型，不结束这一轮", async () => {
    const { tool } = mount(
      vi.fn(async () =>
        json({ code: "PAPERS_UPSTREAM_STATUS", message: "OpenAlex 返回 429（共享额度用尽）", error: "PAPERS_UPSTREAM_STATUS" }, 503),
      ),
    );
    const result = (await tool("papers_search").execute({ query: "x" })) as any;
    expect(result).toEqual({
      error: { code: "PAPERS_UPSTREAM_STATUS", message: "OpenAlex 返回 429（共享额度用尽）", status: 503 },
    });
  });

  it("forwards a search to the control plane with the run token", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return json({ result: { papers: [{ paperId: "W1", title: "真实论文" }] } });
    });
    const { tool } = mount(fetchImpl);
    const result = (await tool("papers_search").execute({ query: "toolformer" })) as {
      papers: unknown[];
    };
    expect(result.papers).toHaveLength(1);
    expect(requests[0].url).toBe("http://control:3001/kernel/tool");
    expect((requests[0].init.headers as Record<string, string>)["x-api-key"]).toBe("run-token");
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      server: "papers",
      tool: "search",
      args: { query: "toolformer" },
    });
  });

  it("downloads once after a single approval and never re-downloads on a repeat call", async () => {
    let decisionPolls = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/kernel/tool")) {
        const body = JSON.parse(String(init.body));
        if (body.approvalId) return json({ result: { assetId: "asset-1", status: "full_text" } });
        return json({ state: "pending", approvalId: "ap-1" }, 409);
      }
      decisionPolls += 1;
      return json({ state: decisionPolls >= 2 ? "approved" : "pending" });
    });
    const { tool } = mount(fetchImpl, "read");
    const first = (await tool("papers_fetch").execute({ paperId: "W1" })) as Record<string, unknown>;
    expect(first).toMatchObject({ assetId: "asset-1", status: "full_text" });
    const fetchCalls = requests.filter((r) => r.url.endsWith("/kernel/tool"));
    expect(fetchCalls).toHaveLength(2);
    expect(JSON.parse(String(fetchCalls[1].init.body)).approvalId).toBe("ap-1");

    // A second identical call re-enters with the same action; the control plane
    // answers from the existing asset, so no extra download is triggered here.
    fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/kernel/tool")) return json({ result: { assetId: "asset-1", status: "full_text", reused: true } });
      return json({ state: "approved" });
    });
    const again = (await tool("papers_fetch").execute({ paperId: "W1" })) as Record<string, unknown>;
    expect(again).toMatchObject({ assetId: "asset-1", reused: true });
  });

  it("stops without downloading when the user rejects", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/kernel/tool")) return json({ state: "pending", approvalId: "ap-2" }, 409);
      return json({ state: "rejected" });
    });
    const { tool } = mount(fetchImpl, "read");
    const result = (await tool("papers_fetch").execute({ paperId: "W2" })) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "stopped", reason: "rejected", message: "已停止 · 没有下载" });
    expect(requests.filter((r) => r.url.endsWith("/kernel/tool"))).toHaveLength(1);
  });

  it("asks the user in-conversation for a paper pick and reports the answer", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/kernel/tool"))
        return json({ state: "pending", approvalId: "ap-pick" }, 409);
      return json({ state: "approved" });
    });
    const { tool } = mount(fetchImpl, "clarify");
    const result = (await tool("clarify_question").execute({
      question: "这两篇哪一篇？",
      kind: "paper_pick",
      candidates: [{ paperId: "W1" }, { paperId: "W2" }],
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ state: "answered", approvalId: "ap-pick" });
  });
});
