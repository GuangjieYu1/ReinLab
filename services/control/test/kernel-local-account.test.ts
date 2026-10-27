import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAccountPort } from "../src/kernel/local-account";
import type { AuthorizedCapability } from "../src/mcp/authority";
import type { TokenClaims } from "../src/mcp/token";

const account = "10000000-0000-4000-8000-000000000001";
const dossier = "20000000-0000-4000-8000-000000000002";
const context = {
  claims: { account, dossier, run: "30000000-0000-4000-8000-000000000003" } as unknown as TokenClaims,
  scope: { grants: [{ name: "papers.fetch", permission: "ask", writeTargets: ["papers/"] }], memory: { layers: [], refs: null, assignedCitations: false } },
  catalog: {},
} as unknown as AuthorizedCapability;

describe("local account file port", () => {
  it("stores the paper asset where the read-back expects it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "local-account-")));
    const port = localAccountPort(root);
    await port.deposit(context, "asset-1", Buffer.from("%PDF-1.4 body"), { status: "full_text", pages: 3 });
    const directory = join(root, "dossiers", dossier, "papers");
    expect(JSON.parse(readFileSync(join(directory, "asset-1.json"), "utf8"))).toMatchObject({ pages: 3 });
    expect(readFileSync(join(directory, "asset-1.pdf"), "utf8")).toBe("%PDF-1.4 body");
  });

  it("refuses a world-readable or symlinked root instead of writing anywhere", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "local-account-bad-")));
    const target = mkdtempSync(join(tmpdir(), "local-account-target-"));
    const link = join(root, "linked");
    symlinkSync(target, link);
    await expect(localAccountPort(link).deposit(context, "asset-2", null, {})).rejects.toMatchObject({
      code: "ACCOUNT_PATH_UNSAFE",
    });
    const loose = realpathSync(mkdtempSync(join(tmpdir(), "local-account-loose-")));
    mkdirSync(join(loose, "dossiers"), { recursive: true, mode: 0o755 });
    writeFileSync(join(loose, "marker"), "");
    const { chmod } = await import("node:fs/promises");
    await chmod(loose, 0o755);
    await expect(localAccountPort(loose).deposit(context, "asset-3", null, {})).rejects.toMatchObject({
      code: "ACCOUNT_PATH_UNSAFE",
    });
  });
});
