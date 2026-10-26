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
import { accountImageTag, ensureLocalAccountImage } from "./image";
import { acquireStartupLock } from "./startup-lock";
import { startControlProcess, stopOwnedControl } from "./control-process";
import { bootstrapLocalDatabase } from "../../services/control/src/provisioner/local-bootstrap";
import { realModelMode } from "./real-models";
import { upgradeLocalRealAccounts } from "../../services/control/scripts/local-real-upgrade";

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
  await startLocalSupabase(async () => {
    await quietCommand(
      "pnpm",
      ["exec", "supabase", "start", "--workdir", "infra"],
      { env: cliEnvironment },
    );
  }, delay);
  const status = parseSupabaseStatus(
    await quietCommand(
      "pnpm",
      ["exec", "supabase", "status", "--workdir", "infra", "-o", "json"],
      { env: cliEnvironment, timeoutMs: 30000 },
    ),
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
  step("LOCAL_ACCOUNT_IMAGE_BUILDING");
  const image = await accountImageTag();
  await ensureLocalAccountImage({
    image,
    pinFile: join(paths.state, "account-image-" + image.split(":")[1] + ".env"),
    run: (args, timeoutMs) =>
      quietCommand("docker", args, { env: cliEnvironment, timeoutMs }),
  });
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
    ACCOUNT_IMAGE: image,
    REINLAB_CONTROL_URL: "http://host.docker.internal:3001/",
    PORT: "3001",
    INTERNAL_SIGNING_KEY: signingKey,
    REINLAB_REAL_MODELS_ENABLED: realModels ? "1" : "0",
  });
  await stopOwnedControl(paths.process, resolve("tooling/local/control.ts"));
  if (realModels) {
    step("LOCAL_REAL_ACCOUNT_IMAGES_UPGRADING");
    const upgrade = await upgradeLocalRealAccounts(paths.runtime, paths.setup);
    console.log(
      JSON.stringify({
        code: "LOCAL_REAL_ACCOUNT_IMAGES",
        ...upgrade,
        message: upgrade.deferred
          ? "部分账户仍有未结束运行，已保留原机器；结束旧运行后重新执行启动命令。"
          : "空闲账户已使用当前镜像，保留原卷与凭据。",
      }),
    );
  }
  step("LOCAL_CONTROL_STARTING");
  await startControlProcess({
    script: resolve("tooling/local/control.ts"),
    cwd: paths.root,
    env: { ...cliEnvironment },
    recordFile: paths.process,
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
      ...(realModels
        ? { frontend: "http://127.0.0.1:5183" }
        : {}),
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
