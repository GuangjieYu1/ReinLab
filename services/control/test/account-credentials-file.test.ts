import { it, expect } from "vitest";
import {
  mkdtemp,
  realpath,
  writeFile,
  chmod,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { readAccountCredentials } from "../../account-runtime/credentials.mjs";

it("account deployment credentials are private-file only, account-bound and absent from ENV", async () => {
  const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "reinlab-account-secret-")),
    ),
    id = randomUUID();
  const bundle = {
    schema: "account_credentials@1",
    accountId: id,
    auth: randomBytes(32).toString("base64url"),
    container: randomBytes(32).toString("base64url"),
  };
  const file = path.join(root, "account.json");
  try {
    await writeFile(file, JSON.stringify(bundle), { mode: 0o600 });
    const got = readAccountCredentials(file, { accountId: id });
    expect(got.auth === bundle.auth && got.container === bundle.container).toBe(
      true,
    );
    expect(Object.isFrozen(got)).toBe(true);
    expect(
      Object.values(process.env).some(
        (value) =>
          value?.includes(bundle.auth) || value?.includes(bundle.container),
      ),
    ).toBe(false);
    expect(() =>
      readAccountCredentials(file, { accountId: randomUUID() }),
    ).toThrow("ACCOUNT_CREDENTIALS_INVALID");
    await chmod(file, 0o644);
    expect(() => readAccountCredentials(file, { accountId: id })).toThrow(
      "ACCOUNT_CREDENTIALS_INVALID",
    );
    await chmod(file, 0o600);
    await symlink(file, path.join(root, "linked"));
    expect(() =>
      readAccountCredentials(path.join(root, "linked"), { accountId: id }),
    ).toThrow("ACCOUNT_CREDENTIALS_INVALID");
    await link(file, path.join(root, "hard"));
    expect(() => readAccountCredentials(file, { accountId: id })).toThrow(
      "ACCOUNT_CREDENTIALS_INVALID",
    );
    await rm(path.join(root, "hard"));
    await writeFile(file, JSON.stringify({ ...bundle, extra: "no" }));
    expect(() => readAccountCredentials(file, { accountId: id })).toThrow(
      "ACCOUNT_CREDENTIALS_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
