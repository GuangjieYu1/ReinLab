import { it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, chmod, symlink, link, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readRuntimeConfiguration, runtimeConfiguration } from "../src/configuration";

it("P1-12 credentials are read from private files into immutable memory without changing ENV", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reinlab-config-")));
  const secret = randomBytes(32).toString("base64url");
  try {
    const file = join(root, "runtime.env");
    await writeFile(file, `STORAGE_SERVICE_TOKEN='${secret}'\nPORT='3001'\n`, { mode: 0o600 });
    const before = JSON.stringify(process.env);
    const config = readRuntimeConfiguration(file);
    expect(config.STORAGE_SERVICE_TOKEN === secret).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.PORT).toBe("3001");
    expect(JSON.stringify(process.env) === before).toBe(true);
    expect(Object.values(process.env).some(v => v?.includes(secret))).toBe(false);
    expect(runtimeConfiguration({ PORT: "1234", STORAGE_SERVICE_TOKEN: secret }).STORAGE_SERVICE_TOKEN).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("P1-12 configuration rejects unsafe files and ancestors with fixed errors", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reinlab-config-")));
  try {
    const file = join(root, "runtime.env");
    await writeFile(file, "PORT=3001\n", { mode: 0o600 });
    const denied = (p: string) => expect(() => readRuntimeConfiguration(p)).toThrow("RUNTIME_CONFIG_UNSAFE");
    await chmod(file, 0o644); denied(file); await chmod(file, 0o600);
    await symlink(file, join(root, "linked")); denied(join(root, "linked"));
    await link(file, join(root, "hard")); denied(file); await rm(join(root, "hard"));
    await mkdir(join(root, "public"), { mode: 0o755 });
    await writeFile(join(root, "public", "config"), "PORT=3001\n", { mode: 0o600 }); denied(join(root, "public", "config"));
    await writeFile(file, "x".repeat(128 * 1024 + 1)); denied(file);
    denied(join(root, "missing")); denied("relative.env");
  } finally { await rm(root, { recursive: true, force: true }); }
});
