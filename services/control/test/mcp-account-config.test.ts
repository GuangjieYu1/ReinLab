import { it, expect } from "vitest";
import { mkdtemp, realpath, readFile, stat, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomUUID, createHash } from "node:crypto";
import { CapabilitySigner, hash } from "../src/mcp/token";
import {
  bootstrapMcp,
  removeMcp,
  accountFiles,
} from "../../account-runtime/mcp/store.mjs";
it("T-MCP-9 account capability configs are private, outside role projects and cleaned after run; no secret environment", async () => {
  const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "reinlab-mcp-config-")),
    ),
    runId = randomUUID();
  try {
    const signer = new CapabilitySigner(
      generateKeyPairSync("ed25519").privateKey,
    );
    const identity = {
      account: randomUUID(),
      dossier: randomUUID(),
      run: runId,
      role: "research-read",
      bench: "research",
      version: "1.0.0",
      effectiveDigest: hash("effective"),
      catalogDigest: hash("catalog"),
      scopeDigest: hash("scope"),
      hold: randomUUID(),
    };
    const issued = signer.issue(identity, Math.floor(Date.now() / 1000)),
      controlUrl = "http://host.docker.internal:3001/";
    await bootstrapMcp(
      root,
      { runId, token: issued.token, controlUrl },
      controlUrl,
    );
    const file = path.join(root, "mcp-clients", runId + ".json"),
      config = JSON.parse(await readFile(file, "utf8"));
    expect(hash(config.token) === hash(issued.token)).toBe(true);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect((await stat(path.dirname(file))).mode & 0o077).toBe(0);
    expect(
      Object.values(process.env).some((value) => value?.includes(issued.token)),
    ).toBe(false);
    await removeMcp(root, runId);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const dossier = identity.dossier;
    await mkdir(path.join(root, "dossiers", dossier), { recursive: true });
    await expect(
      accountFiles(root, {
        root: "/outside",
        dossier,
        operation: "write",
        args: { path: "findings/a", content: "bad" },
        writeTargets: ["findings/"],
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
