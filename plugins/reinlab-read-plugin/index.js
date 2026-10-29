// ReinLab deep-reading tools for the headless DeepSeek Harness kernel.
//
// The plugin owns the reading behaviour only: it forwards each tool call to the
// control plane over HTTP with the run token, and waits there when the action
// needs the user's one-shot approval. It deliberately exposes no generic file
// writer, shell or subagent: those base tools are disabled by the profile patch.
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "reinlab-read";
export const inject = ["tools"];

const poll = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(config, key) {
  const value = config && config[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`reinlab-read-plugin: missing config ${key}`);
  return value;
}

/** Read the run token from the run-scoped file written by the control plane. */
async function readToken(config) {
  if (typeof config.token === "string" && config.token.trim() !== "")
    return config.token.trim();
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(required(config, "tokenFile"), "utf8");
  const token = text.trim();
  if (!token) throw new Error("reinlab-read-plugin: empty run token");
  return token;
}

export function createClient(config, fetchImpl = fetch) {
  const controlUrl = required(config, "controlUrl").replace(/\/+$/, "");
  return async function call(server, tool, args, extra = {}) {
    const token = await readToken(config);
    const response = await fetchImpl(`${controlUrl}/kernel/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify({ server, tool, args, ...extra }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && body.state === "pending")
      return { pending: true, approvalId: body.approvalId };
    if (!response.ok)
      // 错误码和原因原样交给模型：换源、改参数还是问用户，由它自己决定。
      return {
        pending: false,
        error: {
          code: String(body.code ?? body.error ?? `KERNEL_TOOL_HTTP_${response.status}`),
          message: String(body.message ?? body.error ?? `工具返回 ${response.status}`),
          status: response.status,
        },
      };
    return { pending: false, result: body.result };
  };
}

/** Tell the control plane the user never answered, so the card is marked expired. */
async function expireCard(config, approvalId) {
  const controlUrl = required(config, "controlUrl").replace(/\/+$/, "");
  const token = await readToken(config);
  await (config.fetch ?? fetch)(
    `${controlUrl}/kernel/approvals/${encodeURIComponent(approvalId)}/expire`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: "{}",
    },
  ).catch(() => {});
}

/** Wait for the single approval card until the run's turn is abandoned. */
async function awaitDecision(config, call, approvalId) {
  const fetchImpl = config.fetch ?? fetch;
  const controlUrl = required(config, "controlUrl").replace(/\/+$/, "");
  // 等人点卡是业务等待：默认十分钟，期间会话租约已由控制面放开。
  const deadline = Date.now() + Number(config.approvalTimeoutMs ?? 600_000);
  for (;;) {
    const token = await readToken(config);
    const response = await fetchImpl(
      `${controlUrl}/kernel/approvals/${encodeURIComponent(approvalId)}`,
      { headers: { "x-api-key": token }, signal: AbortSignal.timeout(30_000) },
    );
    const body = await response.json().catch(() => ({}));
    if (body.state === "approved") return { approved: true, approvalId };
    if (body.state === "rejected" || body.state === "expired")
      return { approved: false, approvalId };
    if (Date.now() > deadline) {
      await expireCard(config, approvalId);
      return { approved: false, approvalId, timedOut: true };
    }
    await poll(Number(config.approvalPollMs ?? 750));
  }
}

const text = (value) => [{ type: "text", text: JSON.stringify(value) }];

const output = { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) };
/** 工具失败就是返回值里的一段数据，不结束这一轮。 */
const unwrap = (outcome) => (outcome.error ? { error: outcome.error } : outcome.result);

export function apply(ctx, config) {
  const call = createClient(config, (config && config.fetch) || fetch);
  const register = (definition) => ctx.tools.register(definition);
  // 两个阶段给同一套能力：用什么、先用哪个、要不要再问用户，都由模型自己决定。

  register(
    defineTool({
      name: "papers_search",
      description:
        "按关键词检索真实论文。可用来源：arxiv（有全文）、openalex（元数据+开放全文）、crossref（书目元数据+DOI）。不指定来源时三家一起查；每家成功与否和失败原因都会在 sources 里返回。",
      parameters: {
        query: { type: "string", required: true, description: "检索词。" },
        source: { type: "string", description: "arxiv | openalex | crossref | auto（默认全部）。" },
        limit: { type: "integer", description: "最多返回几条，1-20。" },
      },
      output,
      async execute(args) {
        return unwrap(await call("papers", "search", args));
      },
    }),
  );

  // 澄清阶段还没有选定的论文，本来就不该下载：这个工具在那一阶段不存在。
  if (config.mode === "read")
    register(
      defineTool({
        name: "papers_fetch",
        description:
          "把一篇论文下载进当前档案并登记资产。paperId 支持 arxiv:、W（OpenAlex）、doi:。下载要用户批准一次；同一篇重复调用返回已有资产。",
        parameters: {
          paperId: { type: "string", required: true, description: "arxiv:2302.04761v1 / W123456 / doi:10.1000/xyz。" },
        },
        output,
        // Waiting for the user's decision is not a slow tool: keep the turn open.
        timeoutMs: 660_000,
        async execute(args) {
          const first = await call("papers", "fetch", args);
          if (first.error) return first.error;
          if (!first.pending) return first.result;
          const decision = await awaitDecision(config, call, first.approvalId);
          if (!decision.approved)
            return decision.timedOut
              ? { status: "stopped", reason: "expired", message: "审批已过期，可以重新开始" }
              : { status: "stopped", reason: "rejected", message: "已停止 · 没有下载" };
          const second = await call("papers", "fetch", args, {
            approvalId: decision.approvalId,
          });
          if (second.error) return second.error;
          if (second.pending) return { error: { code: "APPROVAL_NOT_CONSUMED", message: "审批没生效，请重试。" } };
          return second.result ?? {};
        },
      }),
    );


  register(
    defineTool({
      name: "papers_pages",
      description: "读取已下载论文的具体页码，返回该页原文。",
      parameters: {
        assetId: { type: "string", required: true, description: "档案里的论文资产 id。" },
        pages: { type: "array", required: true, items: { type: "integer" }, description: "页码，从 1 开始，最多 20 页。" },
      },
      output,
      async execute(args) {
        return unwrap(await call("papers", "pages", args));
      },
    }),
  );

  register(
    defineTool({
      name: "card_layer",
      description: "保存一层讲解卡。卡片里的说法都要有实际读到的页码依据。",
      parameters: {
        card: {
          type: "object",
          additionalProperties: true,
          required: true,
          description:
            "{\"paperId\":\"资产id\",\"no\":\"1\",\"title\":\"一句话\",\"en\":\"One-liner\",\"body\":[{\"text\":\"…\",\"refs\":[{\"paperId\":\"资产id\",\"page\":2,\"quote\":\"原文片段\"}]}]}",
        },
      },
      output,
      async execute(args) {
        return unwrap(await call("cards", "card.layer", { card: args.card ?? args }));
      },
    }),
  );

  register(
    defineTool({
      name: "card_finding",
      description: "保存一条发现卡，带上依据页码。",
      parameters: {
        text: { type: "string", required: true, description: "发现内容。" },
        evidence: { type: "array", required: true, items: { type: "object", additionalProperties: true }, description: "paperId/page/quote 依据。" },
        confidence: { type: "string", description: "low | mid | high。" },
        status: { type: "string", description: "hypothesis | supported | refuted。" },
      },
      output,
      async execute(args) {
        return unwrap(await call("cards", "card.finding", { card: args.card ?? args }));
      },
    }),
  );

  register(
    defineTool({
      name: "clarify_question",
      description:
        "在这一段对话里向用户提问；带 candidates 时用户会看到可选论文卡。不要替用户选。",
      parameters: {
        question: { type: "string", required: true, description: "要问的问题。" },
        kind: { type: "string", description: "text | paper_pick。" },
        candidates: { type: "array", items: { type: "object", additionalProperties: true }, description: "真实候选论文。" },
      },
      output,
      timeoutMs: 660_000,
      async execute(args) {
        const askArgs =
          Array.isArray(args.candidates) && args.candidates.length > 0
            ? { ...args, kind: "paper_pick" }
            : args;
        const first = await call("cards", "clarify.question", askArgs);
        if (first.error) return first.error;
        if (!first.pending) return first.result;
        const decision = await awaitDecision(config, call, first.approvalId);
        if (!decision.approved) return { state: "cancelled" };
        const answered = await call("cards", "clarify.question", args, {
          approvalId: decision.approvalId,
        });
        if (answered.error) return answered.error;
        return answered.pending
          ? { state: "answered", approvalId: decision.approvalId }
          : answered.result;
      },
    }),
  );
}
