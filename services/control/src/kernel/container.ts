/**
 * 每账户执行容器的启动规格（PRD 3.2）。
 *
 * 这里是安全边界所在，所以单独成模块、可测：
 * - 只挂当前账户的目录；当前档案工作区可写，已批准材料快照只读。
 * - 正式记录数据库与权威产物目录不挂载为可写，不给数据库凭据。
 * - 宿主 home、项目工作树、SSH/Provider 凭据、Docker socket、其他账户卷都不出现。
 * - Provider key 绝不进入容器环境；容器只用限定身份的运行令牌调模型代理。
 */

export type AccountContainerSpec = {
  name: string;
  image: string;
  /** `docker run` 的参数（不含镜像与命令）。 */
  createArgs: string[];
  /** 授予容器的环境：只有运行本身需要的，没有宿主凭据。 */
  env: Record<string, string>;
  /** 供诊断：这次挂载了哪些宿主路径。 */
  mounts: Array<{ host: string; container: string; mode: "rw" | "ro" }>;
};

export type AccountContainerInput = {
  account: string;
  image: string;
  /** 该账户在宿主上的专属根目录（每账户一卷，账户之间不共享）。 */
  accountRoot: string;
  /** 容器内账户根。 */
  containerRoot?: string;
  /** 容器要访问的控制面地址。 */
  controlUrl: string;
  /** 运行时令牌文件在宿主上的路径（只读挂入）。 */
  tokenFile: string;
  /** 容器内令牌路径。 */
  containerTokenFile?: string;
  /** 网络名，容器只加入这一个。 */
  network?: string;
  /**
   * 该账户的 DSH 会话目录（宿主）。当前布局把它放在 kernelHome/dsh-home 下，
   * 与账户档案目录分开；单独挂这一块，既能看见会话，又不会把别的账户带进来。
   */
  dshHome?: string;
  /** 容器内 DSH 会话目录。 */
  containerDshHome?: string;
  /**
   * 以哪个 uid:gid 运行容器。账户卷由宿主进程创建，用宿主 uid 跑才不会
   * 出现「目录存在但容器里写不进去」。
   */
  user?: string;
};

/** 容器名按账户固定，同一账户复用同一个容器。 */
export const containerNameFor = (account: string) =>
  ("rl-" + account.replace(/[^0-9a-f]/gi, "")).toLowerCase();

/**
 * 不随容器下发的环境变量名：Provider/基础设施凭据一律不进容器。
 * 命中这些前缀或名字的变量即使误传也会被丢掉。
 */
const FORBIDDEN_ENV = [
  /^DEEPSEEK_/i,
  /_API_KEY$/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^AWS_/i,
  /^SUPABASE_.*KEY/i,
  /^DATABASE_URL/i,
  /^POSTGRES/i,
  /^DOCKER_/i,
  /^SSH_/i,
  /^GITHUB_TOKEN/i,
  /TOKEN$/i,
];

/** 只在容器内存在的路径，用来确认没有把宿主路径漏进去。 */
const HOST_ONLY = [/\/\.ssh\b/, /\/\.config\/reinlab\b/, /docker\.sock\b/, /\/\.codex\b/];

export function isForbiddenEnv(name: string): boolean {
  return FORBIDDEN_ENV.some((rule) => rule.test(name));
}

export function leaksHostPath(value: string): boolean {
  return HOST_ONLY.some((rule) => rule.test(value));
}

/**
 * 生成一次启动所需的规格。纯函数：不执行 docker，便于把边界测死。
 */
export function accountContainerSpec(
  input: AccountContainerInput,
  extraEnv: Record<string, string> = {},
): AccountContainerSpec {
  const containerRoot = input.containerRoot ?? "/opt/reinlab-account";
  const containerToken = input.containerTokenFile ?? containerRoot + "/token";
  const mounts = [
    // 每账户一卷：账户根以内可写（工作区、草稿、下载都落在这里）。
    { host: input.accountRoot, container: containerRoot, mode: "rw" as const },
    // 运行令牌只读挂入，容器不能改写自己的身份。
    { host: input.tokenFile, container: containerToken, mode: "ro" as const },
    // DSH 会话目录单独一块，仍是这个账户自己的。
    ...(input.dshHome
      ? [{
          host: input.dshHome,
          container: input.containerDshHome ?? containerRoot + "/dsh-home",
          mode: "rw" as const,
        }]
      : []),
  ];

  const env: Record<string, string> = {
    // 容器内跑 dsh 需要的解释器与路径。
    // dsh 会在 HOME 下建 profile，而容器根是只读的：HOME 指到账户卷里。
    HOME: containerRoot + "/home",
    // 原生加载器默认把 .node 复制到 /tmp 再 require；容器里 /tmp 是 noexec，
    // 映射会失败（failed to map segment）。直接从包内预编译产物加载。
    NARB_DISABLE_NATIVE_CACHE: "1",
    SHIM_MODE: "host",
    REINLAB_ACCOUNT_ROOT: containerRoot,
    REINLAB_CONTROL_URL: input.controlUrl,
    REINLAB_RUN_TOKEN_FILE: containerToken,
    ...extraEnv,
  };
  // 误传的宿主凭据一律丢掉，不靠调用方自觉。
  for (const name of Object.keys(env)) if (isForbiddenEnv(name)) delete env[name];

  // 每块挂载都必须是这个账户自己的路径：别的账户的目录不能借 dshHome 混进来。
  const accountRoots = [input.accountRoot, ...(input.dshHome ? [input.dshHome] : [])];
  if (new Set(accountRoots).size !== accountRoots.length)
    throw new Error("CONTAINER_SPEC_DUPLICATE_MOUNT");

  const containerSpec: AccountContainerSpec = {
    name: containerNameFor(input.account),
    image: input.image,
    createArgs: [],
    env,
    mounts,
  };
  const createArgs = [
    "run",
    "-d",
    "--name",
    containerNameFor(input.account),
    // 账户之间不共享可写卷：只挂自己的账户根。
    ...mounts.flatMap((m) => ["-v", `${m.host}:${m.container}:${m.mode}`]),
    // 容器需要的变量显式传进去（已剔掉凭据，不用宿主环境继承）。
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    // dsh 与工具会写临时文件：给一块可写的 /tmp，根仍只读。
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=512m",
    ...(input.user ? ["--user", input.user] : []),
    // Linux 容器里没有 host.docker.internal：显式映射到宿主机网关，
    // 模型代理与工具回调用它访问控制面。
    "--add-host",
    "host.docker.internal:host-gateway",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...(input.network ? ["--network", input.network] : []),
    // 镜像与常驻命令：容器起来后由 shim 通过 docker exec 驱动 dsh。
    containerSpec.image,
    "sleep",
    "infinity",
  ];

  containerSpec.createArgs = createArgs;
  return containerSpec;
}

/** 规格自检：任何宿主专用路径或凭据出现都算不合格。 */
export function assertSpecSafe(spec: AccountContainerSpec): void {
  const blob = JSON.stringify({ args: spec.createArgs, env: spec.env });
  if (leaksHostPath(blob)) throw new Error("CONTAINER_SPEC_LEAKS_HOST_PATH");
  for (const name of Object.keys(spec.env))
    if (isForbiddenEnv(name)) throw new Error("CONTAINER_SPEC_LEAKS_SECRET:" + name);
  if (!spec.mounts.some((m) => m.mode === "rw")) throw new Error("CONTAINER_SPEC_NO_WORKSPACE");
  if (spec.mounts.some((m) => m.host.includes("docker.sock"))) throw new Error("CONTAINER_SPEC_DOCKER_SOCKET");
  // 每块可写挂载必须落在账户自己的根里，不能顺手把公共目录挂进来。
  const roots = spec.mounts.filter((m) => m.mode === "rw").map((m) => m.host);
  if (new Set(roots).size !== roots.length) throw new Error("CONTAINER_SPEC_DUPLICATE_MOUNT");
}
