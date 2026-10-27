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
