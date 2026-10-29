import { it, expect } from "vitest";
import { mkdtemp, realpath, writeFile, mkdir, symlink, rm, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readRuntimeConfiguration, runtimeConfiguration } from "../src/configuration";

// Independent security review: fixtures are synthetic; failed assertions never print credentials.
it("private configuration rejects special files and unsafe paths without disclosing input", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reinlab-config-security-")));
  const marker = randomBytes(24).toString("hex");
  const socket = createServer();
  const denied = (file: string) => {
    let error: unknown;
    try { readRuntimeConfiguration(file); } catch (caught) { error = caught; }
    expect(error instanceof Error && error.message === "RUNTIME_CONFIG_UNSAFE").toBe(true);
    expect(error instanceof Error && error.message.includes(marker)).toBe(false);
  };
  try {
    const file = join(root, "runtime.env");
    await writeFile(file, "PORT=3001\n", { mode: 0o600 });
    denied(root);
    denied(join(root, marker));
    denied(`${root}/./runtime.env`);
    const fifo = join(root, "fifo");
    execFileSync("/usr/bin/mkfifo", [fifo]); await chmod(fifo, 0o600); denied(fifo);
    const socketPath = join(root, "socket");
    await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600); denied(socketPath);
    await mkdir(join(root, "private"), { mode: 0o700 });
    await writeFile(join(root, "private", "runtime.env"), "PORT=3001\n", { mode: 0o600 });
    await symlink(join(root, "private"), join(root, "linked-parent"));
    denied(join(root, "linked-parent", "runtime.env"));
    await writeFile(file, "PORT=3001\u0000\n"); denied(file);
  } finally {
    if (socket.listening) await new Promise<void>(resolve => socket.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("secret ENV never supplies a legacy fallback, including a broken explicit file path", () => {
  const secret = randomBytes(24).toString("hex");
  const secretNames = ["DATABASE_URL", "DATABASE_URL_APP", "DATABASE_URL_PROVISIONER", "SUPABASE_JWT_SECRET", "STORAGE_SERVICE_TOKEN", "FLY_API_TOKEN", "INTERNAL_SIGNING_KEY", "DEEPSEEK_API_KEY"];
  const env = Object.fromEntries(secretNames.map(name => [name, secret]));
  const before = JSON.stringify(process.env);
  const config = runtimeConfiguration({ ...env, PORT: "1234" });
  expect(secretNames.every(name => config[name] === undefined)).toBe(true);
  expect(config.PORT === "1234").toBe(true);
  let error: unknown;
  try { runtimeConfiguration({ ...env, REINLAB_RUNTIME_CONFIG_FILE: "missing-relative-config" }); } catch (caught) { error = caught; }
  expect(error instanceof Error && error.message === "RUNTIME_CONFIG_UNSAFE").toBe(true);
  expect(JSON.stringify(process.env) === before).toBe(true);
});
