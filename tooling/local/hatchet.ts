import { randomBytes } from "node:crypto";
import { privateHatchetDigest } from "./hatchet-integrity.mjs";
import { assertHatchetContainer } from "../../services/worker/src/hatchet-container";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { localPaths } from "./paths";
import { readPrivateEnv, writePrivateEnv } from "./config";
import { readRuntimeConfiguration } from "../../services/control/src/configuration";
import { bootstrapRecoveryDatabases } from "../../services/worker/src/local-bootstrap";
import { quietCommand } from "./process";
import { acquireStartupLock } from "./startup-lock";

const paths = localPaths(),
  directory = join(paths.state, "hatchet"),
  file = join(directory, "setup.env");
const volume = "reinlab-hatchet-" + paths.state.split("/").at(-1),
  container = volume;
const privatePath = "/run/reinlab-hatchet";
const env = {
  PATH: process.env.PATH,
  HOME: homedir(),
  DOCKER_HOST:
    process.env.DOCKER_HOST ??
    (process.platform === "darwin"
      ? `unix://${homedir()}/.colima/reinlab/docker.sock`
      : "unix:///var/run/docker.sock"),
  DOCKER_CONFIG: join(paths.state, "docker-client"),
};
const docker = (args: string[]) =>
  quietCommand("docker", args, { env, timeoutMs: 300_000 });
const step = (code: string) =>
  console.log(JSON.stringify({ code, modelRequests: 0 }));
function input(args: string[], bytes: string) {
  return new Promise<void>((done, fail) => {
    const child = spawn("docker", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      fail(Error("HATCHET_PRIVATE_WRITE_FAILED"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? done() : fail(Error("HATCHET_PRIVATE_WRITE_FAILED"));
    });
    child.stdin.end(bytes);
  });
}
let lock: Awaited<ReturnType<typeof acquireStartupLock>> | undefined;
let operation = "lock";
try {
  lock = await acquireStartupLock(3003);
  operation = "configuration";
  const runtime = readRuntimeConfiguration(paths.runtime),
    setup = await readPrivateEnv(paths.setup);
  const versions = JSON.parse(
    await readFile("infra/hatchet/versions.json", "utf8")
  );
  if (
    !/^ghcr\.io\/hatchet-dev\/hatchet\/hatchet-lite@sha256:[a-f0-9]{64}$/.test(
      versions.image
    )
  )
    throw Error();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let saved: Record<string, string>;
  try {
    saved = await readPrivateEnv(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    saved = {
      PHASE: "new",
      DATABASE_PASSWORD: randomBytes(32).toString("base64url"),
      DISCOVERY_PASSWORD: randomBytes(32).toString("base64url"),
    };
    await writePrivateEnv(file, saved);
  }
  const phase = async (p: string) => {
    saved.PHASE = p;
    await writePrivateEnv(file, saved);
  };
  if (saved.PHASE === "issuing") throw Error("HATCHET_TOKEN_INDETERMINATE");
  operation = "database_bootstrap";
  const { discoveryUrl } = await bootstrapRecoveryDatabases(
    setup.DATABASE_URL,
    saved.DATABASE_PASSWORD,
    saved.DISCOVERY_PASSWORD
  );
  operation = "volume_list";
  const existing = (
    await docker([
      "volume",
      "ls",
      "--filter",
      "name=^" + volume + "$",
      "--format",
      "{{.Name}}",
    ])
  ).trim();
  if (!existing) {
    if (saved.PHASE !== "new") throw Error("HATCHET_PRIVATE_STATE_MISSING");
    operation = "volume_create";
    await docker([
      "volume",
      "create",
      "--label",
      "io.reinlab.hatchet=" + volume,
      volume,
    ]);
  }
  operation = "volume_label";
  const label = (
    await docker([
      "volume",
      "inspect",
      "--format",
      '{{index .Labels "io.reinlab.hatchet"}}',
      volume,
    ])
  ).trim();
  if (label !== volume) throw Error();
  const image = versions.image,
    mount = ["--mount", `type=volume,source=${volume},target=${privatePath}`];
  const network = "supabase_network_reinlab-research-local",
    host = "supabase_db_reinlab-research-local";
  const publicDsn = `postgresql://reinlab_hatchet@${host}:5432/reinlab_hatchet?sslmode=disable&passfile=${privatePath}/pgpass`;
  if (new URL(publicDsn).password) throw Error("HATCHET_CONFIGURATION_INVALID");
  const run = (args: string[], extra: string[] = []) =>
    docker([
      "run",
      "--rm",
      "--log-driver",
      "none",
      "--network",
      network,
      ...mount,
      ...extra,
      "-e",
      "DATABASE_URL=" + publicDsn,
      image,
      ...args,
    ]);
  if (saved.PHASE === "new") {
    step("HATCHET_PRIVATE_CONFIGURATION");
    const database = {
      host,
      port: 5432,
      username: "reinlab_hatchet",
      dbName: "reinlab_hatchet",
      sslMode: "disable",
      maxConns: 12,
      minConns: 1,
      ddlPoolMaxConns: 2,
      seed: {
        adminEmail: "operator@reinlab.invalid",
        adminPassword: randomBytes(32).toString("base64url"),
        defaultTenantID: "707d0855-80ab-4e1f-a156-f1c4546cbf52",
      },
      logger: { level: "error" },
    };
    const server = {
      runtime: {
        url: "http://127.0.0.1:58888",
        port: 8080,
        grpcBindAddress: "0.0.0.0",
        grpcBroadcastAddress: "127.0.0.1:57070",
        grpcPort: 7070,
        grpcInsecure: true,
      },
      tls: { tlsStrategy: "tls" },
      auth: { cookie: { domain: "127.0.0.1", insecure: true } },
      analytics: { enabled: false },
      logger: { level: "error" },
      msgQueue: { kind: "postgres" },
    };
    for (const [name, bytes] of [
      ["database.yaml", JSON.stringify(database)],
      ["server.yaml", JSON.stringify(server)],
      [
        "pgpass",
        `${host}:5432:reinlab_hatchet:reinlab_hatchet:${saved.DATABASE_PASSWORD}\n`,
      ],
    ]) {
      await input(
        [
          "run",
          "--rm",
          "--log-driver",
          "none",
          "-i",
          "--network",
          "none",
          ...mount,
          "--entrypoint",
          "/bin/sh",
          image,
          "-c",
          `umask 077; mkdir -p ${privatePath}; chmod 700 ${privatePath}; cat > ${privatePath}/${name}; chmod 600 ${privatePath}/${name}`,
        ],
        bytes
      );
    }
    await run([
      "./hatchet-admin",
      "quickstart",
      "--config",
      privatePath,
      "--generated-config-dir",
      privatePath,
      "--skip",
      "certs",
      "--skip",
      "seed",
      "--overwrite=false",
    ]);
    await phase("keys");
  }
  operation = "configuration_integrity";
  // Hashes are compared in memory and stored only beside the private setup state.
  const helperPin = await readPrivateEnv(
    join(
      paths.state,
      "account-image-" + runtime.ACCOUNT_IMAGE.split(":")[1] + ".env"
    )
  );
  if (
    helperPin.IMAGE_REFERENCE !== runtime.ACCOUNT_IMAGE ||
    !/^sha256:[a-f0-9]{64}$/.test(helperPin.IMAGE_ID)
  )
    throw Error("HATCHET_CONFIGURATION_HELPER_INVALID");
  const digest = async () => {
    const script =
      "(" +
      privateHatchetDigest.toString() +
      ")(" +
      JSON.stringify(privatePath) +
      ").then(console.log).catch(()=>process.exit(1))";
    const value = (
      await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        `type=volume,source=${volume},target=${privatePath},readonly`,
        "--entrypoint",
        "node",
        helperPin.IMAGE_ID,
        "--input-type=module",
        "-e",
        script,
      ])
    ).trim();
    if (!/^[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/.test(value))
      throw Error("HATCHET_CONFIGURATION_DRIFT");
    return value;
  };
  const observedDigest = await digest();
  if (
    saved.CONFIGURATION_DIGEST &&
    observedDigest !== saved.CONFIGURATION_DIGEST
  )
    throw Error("HATCHET_CONFIGURATION_DRIFT");
  if (!saved.CONFIGURATION_DIGEST) {
    if (saved.PHASE === "ready") throw Error("HATCHET_CONFIGURATION_UNPINNED");
    saved.CONFIGURATION_DIGEST = observedDigest;
    await writePrivateEnv(file, saved);
  }
  if (saved.PHASE === "keys") {
    operation = "migrations";
    step("HATCHET_MIGRATIONS");
    // Fixed pgx supports passfile. This public DSN contains no password or token.
    const dsn = `postgresql://reinlab_hatchet@${host}:5432/reinlab_hatchet?sslmode=disable&passfile=${privatePath}/pgpass`;
    if (new URL(dsn).password) throw Error();
    if (dsn !== publicDsn) throw Error("HATCHET_CONFIGURATION_INVALID");
    await run(["./hatchet-migrate"]);
    await phase("migrated");
  }
  if (saved.PHASE === "migrated") {
    operation = "seed";
    await run(["./hatchet-admin", "seed", "--config", privatePath]);
    await phase("issuing");
    operation = "token_issue";
    const token = (
      await run([
        "./hatchet-admin",
        "token",
        "create",
        "--config",
        privatePath,
        "--name",
        volume,
      ])
    ).trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      throw Error();
    saved.TOKEN = token;
    await phase("ready");
  }
  if (saved.PHASE !== "ready" || !saved.TOKEN) throw Error();
  await writePrivateEnv(join(directory, "worker.env"), {
    RUNTIME_CONFIG_FILE: paths.runtime,
    DATABASE_URL_DISCOVERY: discoveryUrl,
    HATCHET_TOKEN: saved.TOKEN,
    HATCHET_TENANT_ID: "707d0855-80ab-4e1f-a156-f1c4546cbf52",
    HATCHET_API_URL: "http://127.0.0.1:58888",
    HATCHET_HOST_PORT: "127.0.0.1:57070",
  });
  operation = "server_inspect";
  const imageMetadata = JSON.parse(
    await docker(["image", "inspect", image])
  )[0];
  const check = async (id: string) =>
    assertHatchetContainer(JSON.parse(await docker(["inspect", id]))[0], {
      imageId: imageMetadata.Id,
      imageEnv: [
        ...(imageMetadata.Config.Env ?? []).filter(
          (value: string) => !value.startsWith("DATABASE_URL=")
        ),
        "DATABASE_URL=" + publicDsn,
      ],
      volume,
      network,
    });
  const ids = (
    await docker([
      "container",
      "ls",
      "--all",
      "--filter",
      "name=^/" + container + "$",
      "--format",
      "{{.ID}}",
    ])
  ).trim();
  if (ids) await docker(["start", await check(ids)]);
  else {
    const id = (
      await docker([
        "create",
        "--name",
        container,
        "--label",
        "io.reinlab.hatchet=" + volume,
        "--restart",
        "unless-stopped",
        "--memory",
        "768m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--network",
        network,
        "--publish",
        "127.0.0.1:58888:8888",
        "--publish",
        "127.0.0.1:57070:7070",
        "--mount",
        `type=volume,source=${volume},target=${privatePath},readonly`,
        "-e",
        "DATABASE_URL=" + publicDsn,
        image,
        "./hatchet-lite",
        "--config",
        privatePath,
      ])
    ).trim();
    await docker(["start", await check(id)]);
  }
  step("HATCHET_SERVER_STARTED");
} catch (e) {
  const code = (e as { message?: string }).message;
  console.log(
    JSON.stringify({
      code:
        code && /^(HATCHET|LOCAL)_[A-Z_]+$/.test(code)
          ? code
          : "HATCHET_SETUP_FAILED",
      operation,
      modelRequests: 0,
    })
  );
  process.exitCode = 1;
} finally {
  await lock?.release();
}
