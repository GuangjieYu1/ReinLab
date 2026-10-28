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
      throw new Error(body.error || `KERNEL_TOOL_HTTP_${response.status}`);
    return { pending: false, result: body.result };
  };
}

/** Wait for the single approval card until the run's turn is abandoned. */
async function awaitDecision(config, call, approvalId) {
  const fetchImpl = config.fetch ?? fetch;
  const controlUrl = required(config, "controlUrl").replace(/\/+$/, "");
  // 最多等一分钟：本地走查里没人点就该收尾，不能把这一轮挂住（也就不会长期占着会话）。
  const deadline = Date.now() + Number(config.approvalTimeoutMs ?? 60_000);
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
    if (Date.now() > deadline) return { approved: false, approvalId, timedOut: true };
    await poll(Number(config.approvalPollMs ?? 750));
  }
}

const text = (value) => [{ type: "text", text: JSON.stringify(value) }];

export function apply(ctx, config) {
  const call = createClient(config, (config && config.fetch) || fetch);
  const mode = config && config.mode === "read" ? "read" : "clarify";
  const register = (definition) => ctx.tools.register(definition);
  // A reading turn must not search or ask again: its tool surface is download,
  // page reading and cards only. The clarification turn keeps search + asking.
  const clarifyTurn = mode === "clarify";
  const readTurn = mode === "read";

  if (readTurn) {
    // A reading turn cannot search or ask again. Registering instructive stubs
    // (instead of leaving the names missing) steers the model straight back to
    // the download instead of ending the turn on an unknown-tool error.
    const redirect = (name) =>
      defineTool({
        name,
        description: "这一轮不要检索、不要提问；用户已经选定论文。",
        parameters: {},
        output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) },
        async execute() {
          return {
            error: "这一轮不要检索、不要提问。请直接调用 papers_fetch，参数用本轮输入里的 paperId。",
          };
        },
      });
    register(redirect("papers_search"));
    register(redirect("clarify_question"));
  }
  if (clarifyTurn)
    register(
      defineTool({
        name: "papers_search",
      description:
        "Search real papers by free-text query. Returns candidates from the literature index; you do not choose for the user.",
      parameters: {
        query: { type: "string", required: true, description: "Search query." },
        limit: { type: "integer", description: "Max results, 1-20." },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) },
      async execute(args) {
        const result = await call("papers", "search", args);
        if (result.pending) throw new Error("APPROVAL_NOT_SUPPORTED_FOR_SEARCH");
        return result.result;
      },
    }),
  );

  if (readTurn)
    register(
      defineTool({
        name: "papers_fetch",
      description:
        "Download one chosen paper into the dossier. Requires the user's single approval; a repeat call for the same paper returns the existing asset instead of downloading again.",
      parameters: {
        paperId: { type: "string", required: true, description: "Provider paper id (e.g. arXiv/OpenAlex id)." },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) },
      // Waiting for the user's decision is not a slow tool: keep the turn open.
      timeoutMs: 60_000,
      async execute(args) {
        const first = await call("papers", "fetch", args);
        if (!first.pending) return first.result;
        const decision = await awaitDecision(config, call, first.approvalId);
        if (!decision.approved)
          return { status: "stopped", reason: "rejected", message: "已停止 · 没有下载" };
        const second = await call("papers", "fetch", args, {
          approvalId: decision.approvalId,
        });
        if (second.pending) throw new Error("APPROVAL_NOT_CONSUMED");
        const saved = second.result ?? {};
        return {
          ...saved,
          next:
            "下一步必须调用 papers_pages(" +
            String(saved.assetId ?? "") +
            ', [1,2,3]) 读取实际页码，然后至少调用一次 card_finding。',
        };
      },
    }),
  );

  if (readTurn)
    register(
      defineTool({
        name: "papers_pages",
      description: "Read specific pages of an already downloaded paper and return their text.",
      parameters: {
        assetId: { type: "string", required: true, description: "Dossier paper asset id." },
        pages: { type: "array", required: true, items: { type: "integer" }, description: "Page numbers, 1-based, at most 20." },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) },
      async execute(args) {
        const result = await call("papers", "pages", args);
        if (result.pending) throw new Error("APPROVAL_NOT_SUPPORTED_FOR_PAGES");
        return result.result;
      },
    }),
  );

  if (readTurn)
    register(
      defineTool({
        name: "card_layer",
      description: "Save one layered explanation card. Every claim must cite pages actually read in this run.",
      parameters: {
        card: {
          type: "object",
          additionalProperties: true,
          required: true,
          description:
            "{\"paperId\":\"资产id\",\"no\":\"1\",\"title\":\"一句话\",\"en\":\"One-liner\",\"body\":[{\"text\":\"…\",\"refs\":[{\"paperId\":\"资产id\",\"page\":2,\"quote\":\"原文片段\"}]}]}",
        },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) },
      async execute(args) {
        const result = await call("cards", "card.layer", { card: args.card ?? args });
        if (result.pending) throw new Error("APPROVAL_NOT_SUPPORTED_FOR_CARDS");
        return result.result;
      },
    }),
  );

  if (readTurn)
    register(
      defineTool({
        name: "card_finding",
      description: "Save one discovery card with its evidence pages for the current dossier.",
      parameters: {
        text: { type: "string", required: true, description: "The finding." },
        evidence: { type: "array", required: true, items: { type: "object", additionalProperties: true }, description: "paperId/page/quote evidence." },
        confidence: { type: "string", description: "low | mid | high." },
        status: { type: "string", description: "hypothesis | supported | refuted." },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) },
      async execute(args) {
        const result = await call("cards", "card.finding", { card: args.card ?? args });
        if (result.pending) throw new Error("APPROVAL_NOT_SUPPORTED_FOR_FINDINGS");
        return result.result;
      },
    }),
  );

  if (clarifyTurn)
    register(
      defineTool({
        name: "clarify_question",
      description:
        "Ask the user a question inside this dossier's conversation, optionally with candidate papers to choose from. Never pick for the user.",
      parameters: {
        question: { type: "string", required: true, description: "What to ask." },
        kind: { type: "string", description: "text | paper_pick." },
        candidates: { type: "array", items: { type: "object", additionalProperties: true }, description: "Real candidates for paper_pick." },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) },
      timeoutMs: 60_000,
      async execute(args) {
        const askArgs =
          Array.isArray(args.candidates) && args.candidates.length > 0
            ? { ...args, kind: "paper_pick" }
            : args;
        const first = await call("cards", "clarify.question", askArgs);
        if (!first.pending) return first.result;
        const decision = await awaitDecision(config, call, first.approvalId);
        if (!decision.approved) return { state: "cancelled" };
        const answered = await call("cards", "clarify.question", args, {
          approvalId: decision.approvalId,
        });
        return answered.pending
          ? { state: "answered", approvalId: decision.approvalId }
          : answered.result;
      },
    }),
  );
}
