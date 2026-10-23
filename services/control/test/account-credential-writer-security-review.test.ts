import { it, expect } from "vitest";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  symlink,
  link,
  rm,
  stat,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAccountCredentials,
  writeRuntimeAccountCredentials,
} from "../../account-runtime/credentials.mjs";

it("runtime credential writer rejects symlinks and hardlinks before truncation, with fixed errors", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-credential-writer-review-")),
  );
  const accountId = randomUUID(),
    file = join(root, "account.json"),
    target = join(root, "target.json");
  const credentials = {
    schema: "account_credentials@1" as const,
    accountId,
    auth: randomBytes(32).toString("base64url"),
    container: randomBytes(32).toString("base64url"),
  };
  const unchanged = "synthetic sentinel";
  const denied = () => {
    let caught: unknown;
    try {
      writeRuntimeAccountCredentials(file, credentials);
    } catch (error) {
      caught = error;
    }
    expect(
      caught instanceof Error &&
        caught.message === "ACCOUNT_CREDENTIALS_INVALID",
    ).toBe(true);
  };
  try {
    await writeFile(target, unchanged, { mode: 0o600 });
    await symlink(target, file);
    denied();
    expect((await readFile(target, "utf8")) === unchanged).toBe(true);
    await rm(file);
    await link(target, file);
    denied();
    expect((await readFile(target, "utf8")) === unchanged).toBe(true);
    await rm(file);
    writeRuntimeAccountCredentials(file, credentials);
    writeRuntimeAccountCredentials(file, credentials);
    expect(
      readAccountCredentials(file, { accountId }).auth === credentials.auth,
    ).toBe(true);
    expect(((await stat(file)).mode & 0o777) === 0o600).toBe(true);
    expect(
      Object.values(process.env).some(
        (value) =>
          value?.includes(credentials.auth) ||
          value?.includes(credentials.container),
      ),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
