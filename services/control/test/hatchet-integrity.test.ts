import { getuid } from 'node:process';
import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, chmod, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateHatchetDigest } from "../../../tooling/local/hatchet-integrity.mjs";
it("private config manifest rejects extra files, symlinks, hardlinks, permissions and owner drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "hatchet-private-")),
    uid = getuid!();
  try {
    for (const name of ["database.yaml", "server.yaml", "pgpass"])
      await writeFile(join(root, name), "fixture " + name, { mode: 0o600 });
    const initial = await privateHatchetDigest(root, uid);
    expect(initial).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/);
    await expect(privateHatchetDigest(root, uid + 1)).rejects.toThrow();
    await writeFile(join(root, "extra.key"), "fixture");
    await expect(privateHatchetDigest(root, uid)).rejects.toThrow();
    await rm(join(root, "extra.key"));
    await chmod(join(root, "pgpass"), 0o644);
    await expect(privateHatchetDigest(root, uid)).rejects.toThrow();
    await chmod(join(root, "pgpass"), 0o600);
    await link(join(root, "pgpass"), root + "-link");
    await expect(privateHatchetDigest(root, uid)).rejects.toThrow();
    await rm(root + "-link");
    await rm(join(root, "pgpass"));
    await symlink(join(root, "server.yaml"), join(root, "pgpass"));
    await expect(privateHatchetDigest(root, uid)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(root + "-link", { force: true });
  }
});
