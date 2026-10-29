import { beforeEach, describe, expect, it, vi } from "vitest";
import { apply } from "../../../plugins/reinlab-read-plugin/index.js";

type Registered = {
  name: string;
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
};

function mount(
  fetchImpl: ReturnType<typeof vi.fn>,
  mode: "clarify" | "read" = "clarify",
  extra: Record<string, unknown> = {},
) {
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
    ...extra,
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
    const surface = ["card_finding", "card_layer", "clarify_question", "course_plan", "dossier_archive", "dossier_attach_course", "dossier_create", "dossier_delete", "dossier_detach", "dossier_get", "dossier_list", "dossier_unarchive", "dossier_update", "papers_fetch", "papers_pages", "papers_search"].sort();
    expect(mount(vi.fn(), "read").registered.map((d) => d.name).sort()).toEqual(surface);
    for (const name of ["files.write", "bash", "web_search"]) {
      expect(mount(vi.fn(), "read").registered.map((d) => d.name)).not.toContain(name);
    }
  });

  it("澄清阶段没有下载工具：还没选定论文，本来就不该有这张审批卡", () => {
    // 这一步不是限制模型怎么做，而是这个阶段不该存在下载能力。
    const clarify = mount(vi.fn(), "clarify").registered.map((d) => d.name);
    expect(clarify).not.toContain("papers_fetch");
    // 检索、提问、读页仍在：靠它们拿到真实候选并让用户选定。
    for (const name of ["papers_search", "clarify_question", "papers_pages", "card_layer", "card_finding", "course_plan"]) {
      expect(clarify).toContain(name);
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

  it("需要批准时把请求交给用户就走，不在插件里轮询等人", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/kernel/tool"))
        return json({ state: "pending", approvalId: "ap-1" }, 409);
      throw Error("插件不该再去轮询审批：" + url);
    });
    const { tool } = mount(fetchImpl, "read");
    const first = (await tool("papers_fetch").execute({ paperId: "W1" })) as Record<string, unknown>;
    // 交出去就算这一轮结束：告诉模型在等用户，没有第二次工具调用，也没有轮询。
    expect(first).toMatchObject({ status: "waiting_for_user", approvalId: "ap-1" });
    const toolCalls = requests.filter((r) => r.url.endsWith("/kernel/tool"));
    expect(toolCalls).toHaveLength(1);
    expect(requests.some((r) => r.url.includes("/kernel/approvals/"))).toBe(false);
  });

  it("续接那一轮再调同一动作时，控制面直接执行并返回结果", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      // 已批准未执行：控制面这次不给 pending，直接给结果。
      return json({ result: { assetId: "asset-1", status: "full_text" } });
    });
    const { tool } = mount(fetchImpl, "read");
    const resumed = (await tool("papers_fetch").execute({ paperId: "W1" })) as Record<string, unknown>;
    expect(resumed).toMatchObject({ assetId: "asset-1", status: "full_text" });
    expect(requests.filter((r) => r.url.endsWith("/kernel/tool"))).toHaveLength(1);
  });

  it("用户驳回后由控制面把真实原因交回来，插件不自己判过期", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      // 控制面的失败形状是顶层 code/message（与 kernel-tools 的错误出口一致）。
      return json({ code: "APPROVAL_REJECTED", message: "用户没有批准这次下载。" }, 409);
    });
    const { tool } = mount(fetchImpl, "read");
    const result = (await tool("papers_fetch").execute({ paperId: "W2" })) as Record<string, unknown>;
    expect(result).toMatchObject({ code: "APPROVAL_REJECTED", message: "用户没有批准这次下载。" });
    expect(requests.some((r) => r.url.endsWith("/expire"))).toBe(false);
  });

  it("一直没人点也不会在插件侧过期：请求留在控制面等回答", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return json({ state: "pending", approvalId: "ap-exp" }, 409);
    });
    // 即使把等待窗口压到很短，插件也不再自己判过期、不再调 /expire。
    const { tool } = mount(fetchImpl, "read", { approvalTimeoutMs: 50, approvalPollMs: 10 });
    const result = (await tool("papers_fetch").execute({ paperId: "W-exp" })) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "waiting_for_user", approvalId: "ap-exp" });
    expect(requests.some((r) => r.url.endsWith("/expire"))).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(requests.filter((r) => r.url.endsWith("/kernel/tool"))).toHaveLength(1);
  });

  it("提问同样交出去等待，回答后由续接那一轮拿到结果", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/kernel/tool"))
        return json({ state: "pending", approvalId: "ap-pick" }, 409);
      throw Error("插件不该轮询：" + url);
    });
    const { tool } = mount(fetchImpl, "clarify");
    const first = (await tool("clarify_question").execute({
      question: "这两篇哪一篇？",
      kind: "paper_pick",
      candidates: [{ paperId: "W1" }, { paperId: "W2" }],
    })) as Record<string, unknown>;
    expect(first).toMatchObject({ status: "waiting_for_user", approvalId: "ap-pick" });

    const resumedImpl = vi.fn(async () => json({ result: { state: "answered", candidateId: "W2" } }));
    const resumed = (await mount(resumedImpl, "clarify").tool("clarify_question").execute({
      question: "这两篇哪一篇？",
    })) as Record<string, unknown>;
    expect(resumed).toMatchObject({ state: "answered", candidateId: "W2" });
  });
});
