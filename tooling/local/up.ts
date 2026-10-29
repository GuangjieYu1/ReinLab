import { randomBytes } from "node:crypto";
import { getuid } from "node:process";
import { mkdir, statfs, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  defaultModelEnvironment,
  parseSupabaseStatus,
  readPrivateEnv,
  writePrivateEnv,
} from "./config";
import { localPaths } from "./paths";
import { quietCommand } from "./process";
import { startLocalSupabase } from "./supabase-start";
import { setTimeout as delay } from "node:timers/promises";
import { acquireStartupLock } from "./startup-lock";
import { startControlProcess, stopOwnedControl } from "./control-process";
import { bootstrapLocalDatabase } from "../../services/control/src/db/bootstrap";
import { realModelMode } from "./real-models";
import { ensureNode22 } from "./runtime";

// 固定跑在项目工具链的 Node 22 上：Electron 直接报错，PATH 上的 node 不作为依据。
const scriptPath = resolve("tooling/local/up.ts");
const nodeBin = await ensureNode22(scriptPath);
const paths = localPaths(),
  credentialRoot = join(homedir(), ".local/state/reinlab/account-credentials");
const cliEnvironment = {
  HOME: homedir(),
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  DOCKER_HOST:
    process.env.DOCKER_HOST ??
    (process.platform === "darwin"
      ? `unix://${homedir()}/.colima/reinlab/docker.sock`
      : "unix:///var/run/docker.sock"),
  DOCKER_CONFIG: join(paths.state, "docker-client"),
  SUPABASE_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  // The local runner must never trigger an implicit dependency install.
  npm_config_verify_deps_before_run: "false",
};
const step = (code: string) => console.log(JSON.stringify({ code }));
let startupLock: Awaited<ReturnType<typeof acquireStartupLock>> | undefined;

try {
  const realModels = realModelMode(process.argv.slice(2), process.env);
  if (
    process.versions.node.split(".")[0] !== "22" &&
    process.versions.node.split(".")[0] !== "24"
  )
    throw Error("LOCAL_NODE_VERSION_UNSUPPORTED");
  if (!/^unix:\/\/\//.test(cliEnvironment.DOCKER_HOST))
    throw Error("LOCAL_DOCKER_SOCKET_REQUIRED");
  startupLock = await acquireStartupLock();
  await mkdir(cliEnvironment.DOCKER_CONFIG, { recursive: true, mode: 0o700 });
  const disk = await statfs(paths.root);
  if (disk.bavail * disk.bsize < 5 * 1024 ** 3)
    throw Error("LOCAL_DISK_SPACE_REQUIRED");
  await mkdir(credentialRoot, { recursive: true, mode: 0o700 });
  const credentialStat = await lstat(credentialRoot);
  if (
    (await realpath(credentialRoot)) !== credentialRoot ||
    !credentialStat.isDirectory() ||
    credentialStat.uid !== getuid?.() ||
    (credentialStat.mode & 0o777) !== 0o700
  )
    throw Error("LOCAL_CREDENTIAL_ROOT_UNSAFE");
  if (process.platform === "darwin" && !process.env.DOCKER_HOST) {
    step("LOCAL_DOCKER_PROFILE_STARTING");
    await quietCommand(
      "colima",
      [
        "start",
        "--profile",
        "reinlab",
        "--activate=false",
        "--cpus",
        "4",
        "--memory",
        "6",
        "--disk",
        "20",
        "--vm-type",
        "vz",
        "--mount",
        paths.root,
        "--mount",
        credentialRoot,
        "--mount-type",
        "virtiofs",
        "--ssh-config=false",
      ],
      { env: cliEnvironment, timeoutMs: 300000 },
    );
  }
  step("LOCAL_SUPABASE_STARTING");
  // The CLI is invoked directly: routing it through pnpm would also run the
  // package manager's dependency check, whose failure tore the stack down.
  const supabaseBin = resolve("node_modules/.bin/supabase");
  await startLocalSupabase(async () => {
    await quietCommand(supabaseBin, ["start", "--workdir", "infra"], {
      env: cliEnvironment,
    });
  }, delay);
  const status = parseSupabaseStatus(
    await quietCommand(supabaseBin, ["status", "--workdir", "infra", "-o", "json"], {
      env: cliEnvironment,
      timeoutMs: 30000,
    }),
  );
  let saved: Record<string, string> = {};
  try {
    saved = await readPrivateEnv(paths.setup);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const passwords = {
    app: saved.APP_PASSWORD ?? randomBytes(32).toString("base64url"),
    provisioner:
      saved.PROVISIONER_PASSWORD ?? randomBytes(32).toString("base64url"),
  };
  step("LOCAL_BUSINESS_MIGRATIONS");
  const database = await bootstrapLocalDatabase(status, passwords);
  const signingKey =
    saved.INTERNAL_SIGNING_KEY ?? randomBytes(32).toString("base64url");
  await writePrivateEnv(paths.setup, {
    DATABASE_URL: status.databaseUrl,
    APP_PASSWORD: passwords.app,
    PROVISIONER_PASSWORD: passwords.provisioner,
    SUPABASE_ANON_KEY: status.anonKey,
    INTERNAL_SIGNING_KEY: signingKey,
  });
  // 只有新内核：本机不再构建、也不再升级账户镜像。
  // 容器模式：dsh 跑在每账户容器里。默认保持宿主，验证通过后再改默认。
  const kernelTransport =
    process.env.REINLAB_KERNEL_TRANSPORT === "container" ? "container" : "host";
  const accountImage = "reinlab-account:local";
  if (kernelTransport === "container") {
    step("LOCAL_ACCOUNT_IMAGE_CHECKING");
    const exists = await quietCommand("docker", ["image", "inspect", accountImage], {
      env: cliEnvironment,
      timeoutMs: 20000,
    })
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      step("LOCAL_ACCOUNT_IMAGE_BUILDING");
      await quietCommand(
        "docker",
        ["build", "-f", "infra/account/Dockerfile", "-t", accountImage, "."],
        { env: cliEnvironment, timeoutMs: 900000 },
      );
    }
  }
  const image = "host";
  if (realModels) {
    const keyFile = join(homedir(), ".config/reinlab/local.env"),
      info = await lstat(keyFile),
      parent = await lstat(join(homedir(), ".config/reinlab"));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      !parent.isDirectory() ||
      (parent.mode & 0o777) !== 0o700 ||
      (await realpath(keyFile)) !== keyFile
    )
      throw Error("LOCAL_MODEL_KEY_FILE_UNSAFE");
  }
  await writePrivateEnv(paths.runtime, {
    ...defaultModelEnvironment(),
    DATABASE_URL_APP: database.databaseApp,
    DATABASE_URL_PROVISIONER: database.databaseProvisioner,
    SUPABASE_URL: status.apiUrl,
    SUPABASE_ANON_KEY: status.anonKey,
    STORAGE_SERVICE_TOKEN: database.storageToken,
    STORAGE_BUCKET: "reinlab",
    PROVISIONER_DRIVER: "docker",
    REINLAB_DOCKER_CREDENTIAL_DIR: join(
      credentialRoot,
      paths.state.split("/").at(-1)!,
    ),
    DOCKER_HOST: cliEnvironment.DOCKER_HOST,
    ACCOUNT_IMAGE: accountImage,
    REINLAB_ACCOUNT_IMAGE: accountImage,
    REINLAB_CONTROL_URL: "http://host.docker.internal:3001/",
    PORT: "3001",
    INTERNAL_SIGNING_KEY: signingKey,
    REINLAB_REAL_MODELS_ENABLED: realModels ? "1" : "0",
    REINLAB_KERNEL_HOME: join(paths.state, "kernel"),
    // Local runs use the host transport; the account-image path stays the
    // 默认仍是宿主；容器模式用 REINLAB_KERNEL_TRANSPORT=container 打开，
    // 打开时要求账户镜像已就绪（见下方 ensureAccountImage）。
    REINLAB_KERNEL_TRANSPORT: kernelTransport,
    // 内核拉起的 dsh 子进程也用同一个 Node 22。
    SHIM_NODE: nodeBin,
    REINLAB_KERNEL_MODEL: "deepseek-v4-flash",
    REINLAB_KERNEL_MAX_TOKENS: "32768",
  });
  await stopOwnedControl(paths.process, resolve("tooling/local/control.ts"));
  step("LOCAL_CONTROL_STARTING");
  await startControlProcess({
    script: resolve("tooling/local/control.ts"),
    cwd: paths.root,
    env: { ...cliEnvironment, SHIM_NODE: nodeBin },
    recordFile: paths.process,
    node: nodeBin,
  });
  await stopOwnedControl(
    join(paths.state, "frontend.json"),
    resolve("tooling/local/live-frontend.ts"),
  );
  if (realModels)
    await startControlProcess({
      script: resolve("tooling/local/live-frontend.ts"),
      cwd: paths.root,
      env: { ...cliEnvironment },
      recordFile: join(paths.state, "frontend.json"),
      port: 5183,
      node: nodeBin,
    });
  console.log(
    JSON.stringify({
      code: "LOCAL_STACK_READY",
      control: "http://127.0.0.1:3001",
      supabase: status.apiUrl,
      studio: "http://127.0.0.1:54323",
      image,
      appliedMigrations: database.applied.length,
      credentials: "本机受保护状态目录；未输出任何值",
      stateDirectory: paths.state,
      realModels,
      ...(realModels ? { frontend: "http://127.0.0.1:5183" } : {}),
    }),
  );
} catch (error) {
  const message = (error as Error)?.message;
  const failureCode = (error as { code?: unknown })?.code;
  console.error(
    JSON.stringify({
      code:
        typeof message === "string" && /^LOCAL_[A-Z_]+$/.test(message)
          ? message
          : typeof failureCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(failureCode)
            ? failureCode
            : "LOCAL_UP_FAILED",
      message: "本地环境尚未就绪；不会用fixture替代。",
    }),
  );
  process.exitCode = 1;
} finally {
  await startupLock?.release();
}
