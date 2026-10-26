import path from "node:path";
import { configuration } from "./mcp-tools.js";
const mark = "x-reinlab-clarify-run";
let state;
const fail = () => {
  throw Error("CLARIFY_MODEL_STOPPED");
};
/** Project declares a non-resolving .invalid fallback and a public placeholder, never a model key.
 * If this interception is absent, inference cannot reach a real provider at all.
 */
export function clarificationHooks(policy, verify) {
  if (!policy.modelCap && !policy.modelGateway) return {};
  if (!policy.mcp || (policy.modelCap && policy.modelCap.cny !== 0.05)) fail();
  if (!state) {
    const base = globalThis.fetch;
    state = { base, runs: new Map() };
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ),
        run = headers.get(mark);
      if (!run) return base(input, init);
      const binding = state.runs.get(run);
      if (!binding) return base(input, init);
      await binding.verify();
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.origin !==
          (binding.policy.modelGateway
            ? "https://reinlab-model.invalid"
            : "https://reinlab-clarify.invalid") ||
        url.pathname !== "/v1/chat/completions" ||
        url.search ||
        init?.method !== "POST" ||
        typeof init.body !== "string"
      )
        fail();
      const config = await configuration(
        run,
        path.resolve(binding.policy.dossierDirectory, "../.."),
      );
      if (typeof config.modelToken !== "string") fail();
      const control = new URL(config.controlUrl);
      if (
        !["http:", "https:"].includes(control.protocol) ||
        control.username ||
        control.password ||
        control.pathname !== "/" ||
        control.search ||
        control.hash
      )
        fail();
      return base(
        control.origin +
          (binding.policy.modelGateway
            ? "/mcp/runtime-model"
            : "/mcp/clarify-model"),
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + config.modelToken,
            "Content-Type": "application/json",
            accept: "text/event-stream",
          },
          body: init.body,
          signal: init.signal,
          redirect: "error",
        },
      );
    };
  }
  state.runs.set(policy.mcp.runId, { policy, verify });
  return {
    "chat.headers": async (_input, output) => {
      await verify();
      output.headers[mark] = policy.mcp.runId;
    },
    "chat.params": async (_input, output) => {
      await verify();
      output.options.thinking = { type: "disabled" };
    },
  };
}
export async function humanQuestion(policy, verify, args) {
  if (!policy.modelCap) return;
  await verify();
  args.reason = "missing_authority";
  if (!Array.isArray(args.questions) || args.questions.length !== 1) fail();
  const q = args.questions[0];
  q.multiple = false;
  if (q.header === "REINLAB_PAPER_PICK") {
    const config = await configuration(
      policy.mcp.runId,
      path.resolve(policy.dossierDirectory, "../.."),
    );
    const proposed = Array.isArray(q.options) ? q.options.map(o=>o.label).filter(id=>id!=='都不是') : [];
    if (proposed.length > 5 || proposed.some(id=>typeof id!=='string'||!/^W[0-9]{1,30}$/.test(id)) || new Set(proposed).size!==proposed.length) fail();
    const suffix = proposed.length ? '?paperIds='+encodeURIComponent(proposed.join(',')) : '';
    const result = await fetch(
      config.controlUrl.replace(/\/$/, "") + "/mcp/clarify-candidates" + suffix,
      {
        headers: { authorization: "Bearer " + config.token },
        redirect: "error",
      },
    );
    if (!result.ok) fail();
    const body = await result.json();
    if (!Array.isArray(body.options) || !body.options.length) fail();
    q.options = body.options;
    q.custom = false;
    if (body.options.length === 1) {
      q.header = "REINLAB_CLARIFY";
      q.question = "没有找到可核对的论文，请补充标题、作者或研究方向。";
      q.options = [
        { label: "补充说明", description: "补充论文标题、作者或研究方向" },
      ];
      q.custom = true;
    }
  } else {
    q.header = "REINLAB_CLARIFY";
    q.options = [{ label: "补充说明", description: "填写你的补充要求" }];
    q.custom = true;
  }
}
