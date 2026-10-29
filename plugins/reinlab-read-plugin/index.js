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
    // 工具调用必须有有限时限：控制面万一卡住，不能把这一轮无限挂在这里。
    const response = await fetchImpl(`${controlUrl}/kernel/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify({ server, tool, args, ...extra }),
      signal: AbortSignal.timeout(Number(config.toolTimeoutMs ?? 120_000)),
    }).catch((error) => ({
      ok: false,
      status: 0,
      json: async () => ({
        code: error?.name === "TimeoutError" ? "KERNEL_TOOL_TIMEOUT" : "KERNEL_TOOL_UNREACHABLE",
        message: "这次工具调用没有拿到控制面的响应，请重试或换一种做法。",
      }),
    }));
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

/** 需要用户决定时，把请求交给控制面，然后如实告诉模型「在等用户」。 */
const waiting = (what, approvalId) => ({
  status: "waiting_for_user",
  approvalId,
  message:
    `已把「${what}」的请求交给用户（审批 ${approvalId}），等用户处理后会从这一段继续。` +
    "这不代表已批准，也不代表失败：不要反复重试同一个请求。",
});

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
        // 已批准（续接那一轮）再调到这里时，控制面会直接执行并返回结果；
        // 还没批准就返回「在等用户」，这一轮到此结束，不占着执行段轮询。
        const first = await call("papers", "fetch", args);
        if (first.error) return first.error;
        if (!first.pending) return first.result;
        return waiting("下载论文全文", first.approvalId);
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

  // 第 7 节：档案工具。七个台的最小侧边会话都靠这组工具；和页面调同一组服务函数。
  const dossierTool = (name, description, parameters) =>
    register(
      defineTool({
        name,
        description,
        parameters,
        output,
        async execute(args) {
          const out = await call("dossiers", name.replace(/^dossier_/, "").replace(/_/g, "_"), args);
          return out.error ?? out.result;
        },
      }),
    );

  dossierTool("dossier_list", "列出/搜索这个账户的档案。", {
    bench: { type: "string", description: "只看某个台：research/curriculum/…；不传就是全部。" },
    q: { type: "string", description: "按标题或目标搜索。" },
    view: { type: "string", description: "active | archived。" },
  });
  dossierTool("dossier_get", "读取一份档案的概况、最近运行和成果。", {
    dossierId: { type: "string", description: "档案 id；不传就是当前这份。" },
  });
  dossierTool("dossier_create", "新建一份档案。", {
    bench: { type: "string", required: true, description: "工作台 id。" },
    kind: { type: "string", description: "reading | topic | workspace | learning。" },
    title: { type: "string", description: "用户明确给了标题才传。" },
    intent: { type: "string", description: "用户想做什么。" },
  });
  dossierTool("dossier_update", "改档案标题、目标或标记完成。", {
    dossierId: { type: "string" },
    baseVersion: { type: "number", description: "必填：读到的最新版本号。" },
    title: { type: "string" },
    intent: { type: "string" },
    lifecycle: { type: "string", description: "active | completed。" },
  });
  dossierTool("dossier_archive", "归档一份档案；有活跃工作时会返回确认卡。", { dossierId: { type: "string" } });
  dossierTool("dossier_unarchive", "取消归档。", { dossierId: { type: "string" } });
  dossierTool("dossier_delete", "请求删除一份档案，只返回确认卡，不直接删。", { dossierId: { type: "string" } });
  dossierTool("dossier_attach_course", "把一门已有课程加进学习档案。", {
    dossierId: { type: "string" },
    courseId: { type: "string", required: true },
    title: { type: "string" },
  });
  dossierTool("dossier_detach", "把一项成果从档案里解除关联（不删原件）。", {
    dossierId: { type: "string" },
    artifactId: { type: "string", required: true },
  });

  // 课程台最小能力：把一份简短学习计划交给用户确认并同时入档。
  // 计划确认就是入档批准，不额外再要一次。
  register(
    defineTool({
      name: "course_plan",
      description:
        "提交一份简短学习计划（目标 + 少量阶段）给用户确认；用户同意后这份计划即写入课程档案，并回报已入档。计划确认与入档是同一次批准。",
      parameters: {
        goal: { type: "string", required: true, description: "这次要达成的学习目标，一两句话。" },
        steps: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "计划阶段，每项含 title 与可选 detail；保持简短。",
        },
        note: { type: "string", description: "可选的补充说明。" },
      },
      output,
      async execute(args) {
        const first = await call("courses", "plan", args);
        if (first.error) return first.error;
        if (!first.pending) return first.result;
        return waiting("这份学习计划并入档", first.approvalId);
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
        // 用户已经回答过（续接那一轮）会直接拿到答案；还没回答就交出去等待。
        const first = await call("cards", "clarify.question", askArgs);
        if (first.error) return first.error;
        if (!first.pending) return first.result;
        return waiting("需要你确认的信息", first.approvalId);
      },
    }),
  );
}
