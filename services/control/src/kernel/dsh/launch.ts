import { z } from "zod";
import { ApiFailure } from "../../api/errors";
import { containerTokenPath } from "../container";

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
  /** Which tool surface this turn gets: clarify only searches/asks, read only reads. */
  mode?: "clarify" | "read";
  /**
   * 容器模式：给了这套路径，就让 dsh 跑在账户容器里，plan 里所有交给 dsh 的
   * 路径都换成容器内路径；`paths` 仍是宿主路径，控制面照旧在宿主读写。
   */
  container?: {
    /** 容器内账户根（宿主 accounts/<account> 的挂载点）。 */
    home: string;
    /** 容器内 DSH 会话目录。 */
    dshHome: string;
    /** 容器内档案工作区根（dossiers 的父目录）。 */
    workspace: string;
    /** 容器内 dsh 可执行模块。 */
    dshModule: string;
    /** 容器内插件入口（package 名或 file:// URL）。 */
    pluginEntry: string;
    /** 容器内 restrict 补丁路径。 */
    restrictPatch: string;
  };
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
  mode: "clarify" | "read";
  account: string;
  dossier: string;
  run: string;
  sessionId: string;
  paths: LaunchPaths;
  /** 容器模式下交给 dsh 的路径；宿主模式下为空。 */
  containerPaths?: LaunchPaths;
  /** materialize 在宿主上要建的目录（容器模式下与 options 里的容器路径不同）。 */
  hostDirs: { dshHome: string; cwd: string; sessionDir: string };
  container?: LaunchInput["container"];
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
  const inContainer = input.container;
  // 容器内 run 目录：账户根被挂到 container.home，runs 相对位置不变。
  const containerPaths: LaunchPaths | undefined = inContainer
    ? {
        runDir: `${inContainer.home}/runs/${run}`,
        pidFile: paths.pidFile,
        tokenFile: `${inContainer.home}/runs/${run}/token`,
        credentialsFile: `${inContainer.home}/runs/${run}/.credentials.yaml`,
        patchFile: `${inContainer.home}/runs/${run}/run.patch.yml`,
        sessionDir: inContainer.dshHome + "/sessions",
      }
    : undefined;
  const options = {
    profile: "sdk",
    dshBin: input.bundler.shimModule,
    dshHome: inContainer ? inContainer.dshHome : `${home}/dsh-home/accounts/${account}`,
    cwd: inContainer
      ? `${inContainer.workspace}/${dossier}`
      : `${home}/accounts/${account}/dossiers/${dossier}`,
    patches: [inContainer ? inContainer.restrictPatch : input.bundler.restrictPatch, (containerPaths ?? paths).patchFile],
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
      SHIM_DSH_MODULE: inContainer ? inContainer.dshModule : input.bundler.dshModule,
      // shim 在宿主上跑，参数里的宿主路径要换成容器内的同一份。
      ...(inContainer
        ? { SHIM_HOST_ROOT: `${home}/accounts/${account}`, SHIM_CONTAINER_ROOT: inContainer.home }
        : {}),
      SHIM_TOKEN_FILE: paths.tokenFile,
      // 内核子进程必须用控制面同一个 Node 22：shim 会把它当作 dsh 的解释器。
      SHIM_NODE: process.execPath,
    },
  };
  return {
    bundler: input.bundler,
    mode: input.mode === "read" ? "read" : "clarify",
    account,
    dossier,
    run,
    sessionId: input.sessionId,
    paths,
    containerPaths,
    hostDirs: {
      dshHome: `${home}/dsh-home/accounts/${account}`,
      cwd: `${home}/accounts/${account}/dossiers/${dossier}`,
      sessionDir: `${home}/dsh-home/accounts/${account}/sessions`,
    },
    container: input.container,
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
  // 容器模式下 options 里是容器路径，宿主上要建的是映射回来的目录；
  // 宿主模式仍按 options 建（调用方可能覆盖过 cwd）。
  const dirs = plan.containerPaths ? plan.hostDirs : {
    dshHome: plan.options.dshHome,
    cwd: plan.options.cwd,
    sessionDir: plan.paths.sessionDir,
  };
  await io.mkdir(dirs.dshHome);
  await io.mkdir(dirs.cwd);
  await io.mkdir(dirs.sessionDir);
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
      "      底线：1) 下载全文、写文件，要先得到用户批准；",
      "      2) 不编造论文、作者和页码；",
      "      3) 候选论文由用户来选，不替用户选。",
      "- id: web",
      "  config:",
      "    searchProvider: deepseek-search-api",
      "    fetchProvider: deepseek-fetch-api",
      "- id: web-deepseek-api",
      "  config:",
      "    baseURL: " + JSON.stringify(plan.options.env.REINLAB_CONTROL_URL + "/llm/deepseek/v1/tools"),
      "- id: credentials",
      "  config:",
      "    path: " + JSON.stringify((plan.containerPaths ?? plan.paths).credentialsFile),
      "- insert:",
      "    - id: reinlab-read",
      "      name: " +
        JSON.stringify(plan.container?.pluginEntry ?? plan.bundler.pluginEntry),
      "      config:",
      "        runId: " + JSON.stringify(plan.run),
      "        pidFile: " + JSON.stringify(plan.paths.pidFile),
      // 插件跑在容器里：令牌路径必须是容器内的那个只读挂载点。
      "        tokenFile: " +
        JSON.stringify(plan.container ? containerTokenPath(plan.run) : plan.paths.tokenFile),
      "        controlUrl: " + JSON.stringify(plan.options.env.REINLAB_CONTROL_URL),
      "        mode: " + JSON.stringify(plan.mode),
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
