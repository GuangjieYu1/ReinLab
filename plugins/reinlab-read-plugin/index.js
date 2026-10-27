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
  const deadline = Date.now() + Number(config.approvalTimeoutMs ?? 1_800_000);
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

  const register = (definition) => ctx.tools.register(definition);

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
      timeoutMs: 1_800_000,
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
        return second.result;
      },
    }),
  );

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

  register(
    defineTool({
      name: "card_layer",
      description: "Save one layered explanation card. Every claim must cite pages actually read in this run.",
      parameters: {
        paperId: { type: "string", required: true, description: "Dossier paper asset id." },
        layer: { type: "string", required: true, description: "Layer label, e.g. 'L1 动机'." },
        items: { type: "array", required: true, items: { type: "object", additionalProperties: true }, description: "Claims with citations." },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) },
      async execute(args) {
        const result = await call("cards", "card.layer", args);
        if (result.pending) throw new Error("APPROVAL_NOT_SUPPORTED_FOR_CARDS");
        return result.result;
      },
    }),
  );

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
        const result = await call("cards", "card.finding", args);
        if (result.pending) throw new Error("APPROVAL_NOT_SUPPORTED_FOR_FINDINGS");
        return result.result;
      },
    }),
  );

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
      timeoutMs: 1_800_000,
      async execute(args) {
        const first = await call("cards", "clarify.question", args);
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
