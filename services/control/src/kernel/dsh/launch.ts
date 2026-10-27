import { z } from "zod";
import { ApiFailure } from "../../api/errors";

const uuid = z.string().uuid();
const containerName = (account: string) => "rl-" + account.replace(/-/g, "");

export type LaunchBundler = {
  /** Host path of the Node shim module the SDK client spawns as `dshBin`. */
  shimModule: string;
  /** In-container module path of the same shim. */
  shimContainerModule: string;
  /** In-container dsh executable module. */
  dshModule: string;
  restrictPatch: string;
  /** Package name or `file://` URL the profile loads as the reading plugin. */
  pluginEntry: string;
};

export type LaunchInput = {
  account: string;
  dossier: string;
  run: string;
  sessionId: string;
  controlUrl: string;
  model: string;
  maxTokens: number;
  bundler: LaunchBundler;
  /** Root of the per-account volume inside the account container. */
  home?: string;
};

export type LaunchPaths = {
  runDir: string;
  pidFile: string;
  tokenFile: string;
  credentialsFile: string;
  patchFile: string;
  sessionDir: string;
};

export type LaunchPlan = {
  bundler: LaunchBundler;
  account: string;
  dossier: string;
  run: string;
  sessionId: string;
  paths: LaunchPaths;
  options: {
    profile: string;
    dshBin: string;
    dshHome: string;
    cwd: string;
    patches: string[];
    provider: string;
    model: string;
    maxTokens: number;
    env: Record<string, string>;
  };
  release: () => Promise<void>;
};
export type LaunchIo = {
  mkdir: (path: string) => Promise<void>;
  write: (path: string, body: string, mode?: number) => Promise<void>;
  remove: (path: string) => Promise<void>;
};

const required = (value: string, code: string) => {
  if (typeof value !== "string" || value.trim() === "")
    throw new ApiFailure(code, 400, "运行参数不完整。");
  return value;
};

/**
 * Build one run's kernel launch: every run-owned file lives under that run's
 * directory so concurrent runs never overwrite each other's pid, token or patch.
 * The provider key never appears here; the model endpoint receives a run token.
 */
export function launchPlan(input: LaunchInput): LaunchPlan {
  const account = uuid.parse(input.account),
    dossier = uuid.parse(input.dossier),
    run = uuid.parse(input.run);
  const controlUrl = required(input.controlUrl, "KERNEL_CONTROL_URL_REQUIRED").replace(/\/+$/, "");
  const model = required(input.model, "KERNEL_MODEL_REQUIRED");
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0)
    throw new ApiFailure("KERNEL_MAX_TOKENS_INVALID", 400, "输出上限无效。");
  const home = (input.home ?? "/data").replace(/\/+$/, "");
  const runDir = `${home}/accounts/${account}/runs/${run}`;
  const paths: LaunchPaths = {
    runDir,
    pidFile: `${runDir}/dsh.pid`,
    tokenFile: `${runDir}/token`,
    credentialsFile: `${runDir}/.credentials.yaml`,
    patchFile: `${runDir}/run.patch.yml`,
    sessionDir: `${home}/dsh-home/accounts/${account}/sessions`,
  };
  const options = {
    profile: "sdk",
    dshBin: input.bundler.shimModule,
    dshHome: `${home}/dsh-home/accounts/${account}`,
    cwd: `${home}/accounts/${account}/dossiers/${dossier}`,
    patches: [input.bundler.restrictPatch, paths.patchFile],
    provider: "deepseek-official",
    model,
    maxTokens: input.maxTokens,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `${home}/accounts/${account}`,
      DEEPSEEK_BASE_URL: controlUrl + "/llm/anthropic",
      REINLAB_CONTROL_URL: controlUrl,
      SHIM_CONTAINER: containerName(account),
      SHIM_RUN_ID: run,
      SHIM_PID_FILE: paths.pidFile,
      SHIM_DSH_MODULE: input.bundler.dshModule,
      SHIM_TOKEN_FILE: paths.tokenFile,
    },
  };
  return {
    bundler: input.bundler,
    account,
    dossier,
    run,
    sessionId: input.sessionId,
    paths,
    options,
    release: async () => {},
  };
}

/**
 * Write the run-scoped credential and patch files, then bind `release` to remove
 * them plus any pid file. Two runs never share a path, so a concurrent launch
 * cannot clobber another run's credentials.
 */
export async function materializeLaunch(
  plan: LaunchPlan,
  token: string,
  io: LaunchIo,
): Promise<LaunchPlan> {
  if (typeof token !== "string" || token.trim() === "")
    throw new ApiFailure("KERNEL_TOKEN_REQUIRED", 400, "运行令牌为空。");
  await io.mkdir(plan.paths.runDir);
  await io.mkdir(plan.options.dshHome);
  await io.mkdir(plan.options.cwd);
  await io.mkdir(plan.paths.sessionDir);
  await io.write(plan.paths.tokenFile, token + "\n", 0o600);
  await io.write(
    plan.paths.credentialsFile,
    "version: 1\nrefs:\n  DEEPSEEK_API_KEY: " + JSON.stringify(token) + "\n",
    0o600,
  );
  await io.write(
    plan.paths.patchFile,
    [
      "# Generated per run; never shared between runs.",
      "# The credential document is overridden to this run's file so concurrent",
      "# runs never overwrite each other's token.",
      "- id: system-prompt",
      "  config:",
      "    personaPrefix: >-",
      "      你是 ReinLab 的研究精读助手，用中文说人话，不要把内部工具名丢给用户。",
      "      流程规则：1) 用户说想读某篇论文，先用 papers_search 找真实候选，不要凭记忆编造论文；",
      "      2) 检索到候选后必须立刻调用 clarify_question(kind=paper_pick) 把候选交给用户自己选；",
      "         不要用纯文字问「你要哪一篇」，也不要把候选只写在回答里——用户需要可点的候选卡；绝不替用户决定；",
      "      3) 用户选定后立刻结束这一轮，只回一句确认（例如「好，读《标题》。可以按这篇的长度预估费用了。」），",
      "         这一轮不要再调用任何工具；真正开始精读由用户点「确认开始」触发的下一轮再做；",
      "      3b) 开始精读那一轮才调用 papers_fetch（会触发一次下载审批）；被拒绝就停下并回复「已停止 · 没有下载」；",
      "      3c) 这一轮的输入里如果已经写了 paperId=…，说明用户已选定：直接 papers_fetch 这个 paperId，",
      "         不要检索、不要再提问；批准后读第 1-3 页，至少写一条 card_finding，再给总结；",
      "      4) 讲解与发现必须基于 papers_pages 实际读到的页码并写出页码，不得编造全文或页码；",
      "      5) 检索不必反复尝试同一查询：拿到候选就交给用户，找不到就说明没找到并请用户补充线索；",
      "      6) 读完关键页后至少调用一次 card_finding，把有页码依据的发现保存下来，再给用户总结。",
      "- id: credentials",
      "  config:",
      "    path: " + JSON.stringify(plan.paths.credentialsFile),
      "- insert:",
      "    - id: reinlab-read",
      "      name: " + JSON.stringify(plan.bundler.pluginEntry),
      "      config:",
      "        runId: " + JSON.stringify(plan.run),
      "        pidFile: " + JSON.stringify(plan.paths.pidFile),
      "        tokenFile: " + JSON.stringify(plan.paths.tokenFile),
      "        controlUrl: " + JSON.stringify(plan.options.env.REINLAB_CONTROL_URL),
      "",
    ].join("\n"),
    0o600,
  );
  plan.release = async () => {
    for (const file of [
      plan.paths.credentialsFile,
      plan.paths.tokenFile,
      plan.paths.patchFile,
      plan.paths.pidFile,
    ])
      await io.remove(file).catch(() => {});
  };
  return plan;
}
