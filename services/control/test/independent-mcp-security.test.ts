import { expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CapabilitySigner, hash, verifyCapabilityToken } from "../src/mcp/token";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilityEngine } from "../src/mcp/engine";
import { implementedCatalog, mcpFixture } from "./mcp-fixture";

function authority(f: Awaited<ReturnType<typeof mcpFixture>>) {
  const signer = new CapabilitySigner(generateKeyPairSync("ed25519").privateKey);
  return { signer, a: new CapabilityAuthority(f.db, signer) };
}

it("independent: signed but unregistered identities and claims objects cannot authorize", async () => {
  const f = await mcpFixture();
  try {
    const { a, signer } = authority(f), token = await a.issue(f.account, f.run);
    const claims = verifyCapabilityToken(token, signer.publicKey, Math.floor(Date.now() / 1000));
    const changed = signer.issue({ ...claims, dossier: randomUUID() }, Math.floor(Date.now() / 1000)).token;
    await expect(a.validate(changed)).rejects.toMatchObject({ code: "CAPABILITY_TOKEN_INVALID" });
    await expect(f.db.withAccount(f.account, c => a.validateClient(c, claims))).rejects.toMatchObject({ code: "CAPABILITY_TOKEN_INVALID" });
    await expect(f.db.withAccount(randomUUID(), c => a.validateClient(c, token))).rejects.toMatchObject({ code: "RLS_DENIED", status: 404 });
    expect((await a.validate(token)).claims.run).toBe(f.run);
  } finally { await f.close(); }
});

it("independent: revoke fences overlapping issuance and prohibits all later minting", async () => {
  const f = await mcpFixture();
  try {
    const { a } = authority(f), first = await a.issue(f.account, f.run);
    const minted = await Promise.allSettled([a.issue(f.account, f.run), a.revoke(f.account, f.run), a.issue(f.account, f.run)]);
    await expect(a.validate(first)).rejects.toMatchObject({ code: "CAPABILITY_TOKEN_INVALID" });
    for (const item of minted) if (item.status === "fulfilled" && typeof item.value === "string")
      await expect(a.validate(item.value)).rejects.toMatchObject({ code: "CAPABILITY_TOKEN_INVALID" });
    await expect(a.issue(f.account, f.run)).rejects.toMatchObject({ code: "CAPABILITY_TOKEN_INVALID" });
  } finally { await f.close(); }
});

it("independent: direct callers cannot cross servers, skip schema, or approve another tenant", async () => {
  const f = await mcpFixture(await implementedCatalog());
  try {
    const { a } = authority(f), token = await a.issue(f.account, f.run);
    let effects = 0;
    const e = new CapabilityEngine(a, { "files.write": async (_context, args) => { effects++; return { versionId: randomUUID(), paths: [args.path] }; } });
    const req = { capability: "files.write", args: { path: "findings/check.md", content: "fixture" }, requestId: randomUUID() };
    await expect(e.call("memory", token, req)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(e.call("files", token, { ...req, args: { ...req.args, arbitrary: true } })).rejects.toMatchObject({ code: "CAPABILITY_INPUT_INVALID" });
    const pending = await e.call("files", token, req).catch(error => error);
    await expect(e.decide(randomUUID(), pending.approvalId, "approve")).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(e.call("files", token, { ...req, approvalId: pending.approvalId })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(effects).toBe(0);
  } finally { await f.close(); }
});

it("independent: concurrent approved request cannot execute again while original handler is pending", async () => {
  const f = await mcpFixture(await implementedCatalog());
  let release!: () => void;
  try {
    const { a } = authority(f), token = await a.issue(f.account, f.run);
    let effects = 0, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const e = new CapabilityEngine(a, { "files.write": async (_context, args) => { effects++; entered(); await gate; return { versionId: randomUUID(), paths: [args.path] }; } });
    const req = { capability: "files.write", args: { path: "findings/concurrent.md", content: "fixture" }, requestId: randomUUID() };
    const pending = await e.call("files", token, req).catch(error => error);
    await e.decide(f.account, pending.approvalId, "approve");
    const accepted = { ...req, approvalId: pending.approvalId };
    const first = e.call("files", token, accepted);
    await started;
    await expect(e.call("files", token, accepted)).rejects.toMatchObject({ code: "CAPABILITY_OUTCOME_UNKNOWN" });
    expect(effects).toBe(1);
    release();
    const result = await first;
    expect(await e.call("files", token, accepted)).toEqual(result);
    expect(effects).toBe(1);
    await expect(f.db.withAccount(f.account, c => c.query("update mcp_approval set consumed=false where id=$1", [pending.approvalId]))).rejects.toMatchObject({ code: "23514" });
    await expect(f.db.withAccount(f.account, c => c.query("update mcp_invocation set result='{}'::jsonb where run_id=$1 and request_id=$2", [f.run, req.requestId]))).rejects.toMatchObject({ code: "23514" });
  } finally { release?.(); await f.close(); }
});

it("independent: unknown handler outcome consumes approval and cannot be retried as a new effect", async () => {
  const f = await mcpFixture(await implementedCatalog());
  try {
    const { a } = authority(f), token = await a.issue(f.account, f.run);
    let effects = 0;
    const e = new CapabilityEngine(a, { "files.write": async () => { effects++; throw new Error("fixture lost result"); } });
    const req = { capability: "files.write", args: { path: "findings/unknown.md", content: "fixture" }, requestId: randomUUID() };
    const pending = await e.call("files", token, req).catch(error => error);
    await e.decide(f.account, pending.approvalId, "approve");
    const accepted = { ...req, approvalId: pending.approvalId };
    await expect(e.call("files", token, accepted)).rejects.toMatchObject({ code: "CAPABILITY_FAILED" });
    await expect(e.call("files", token, accepted)).rejects.toMatchObject({ code: "CAPABILITY_OUTCOME_UNKNOWN" });
    await expect(e.call("files", token, { ...accepted, requestId: randomUUID() })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(effects).toBe(1);
    expect((await f.admin.query("select state from mcp_invocation where run_id=$1", [f.run])).rows[0].state).toBe("indeterminate");
  } finally { await f.close(); }
});

it("independent: ask read calls require a stable request id before creating approval", async () => {
  const catalog = await implementedCatalog();
  catalog.aliases.memory_read = [{ capability: "memory.read", minimumPermission: "ask" }];
  catalog.digest = hash({ revision: catalog.revision, capabilities: catalog.capabilities, aliases: catalog.aliases });
  const f = await mcpFixture(catalog);
  try {
    const { a } = authority(f), token = await a.issue(f.account, f.run);
    const e = new CapabilityEngine(a, { "memory.read": async () => ({ items: [] }) });
    await expect(e.call("memory", token, { capability: "memory.read", args: { layers: ["L2"], refs: [] } })).rejects.toMatchObject({ code: "REQUEST_ID_REQUIRED" });
    expect((await f.admin.query("select count(*)::int n from mcp_approval where run_id=$1", [f.run])).rows[0].n).toBe(0);
  } finally { await f.close(); }
});

it("independent: database rejects null-decision consumption, mismatched dossier FK and anonymous audit reads", async () => {
  const f = await mcpFixture(await implementedCatalog());
  try {
    const { a } = authority(f), token = await a.issue(f.account, f.run);
    const e = new CapabilityEngine(a, {});
    const pending = await e.call("files", token, { capability: "files.write", args: { path: "findings/approval.md", content: "fixture" }, requestId: randomUUID() }).catch(error => error);
    await expect(f.db.withAccount(f.account, c => c.query("update mcp_approval set consumed=true where id=$1", [pending.approvalId]))).rejects.toMatchObject({ code: "23514" });
    await expect(f.db.withAccount(f.account, c => c.query("insert into mcp_credential(jti,account_id,dossier_id,run_id,hold_id,claims_hash,issued_at,expires_at) values($1,$2,$3,$4,$5,$6,now(),now()+interval '1 hour')", [randomUUID(), f.account, randomUUID(), f.run, f.hold, "0".repeat(64)]))).rejects.toMatchObject({ code: "23503" });
    await expect(f.db.withAccount(f.account, c => c.query("select * from mcp_anonymous_denial"))).rejects.toMatchObject({ code: "42501" });
    await expect(f.db.withAccount(f.account, c => c.query("delete from mcp_run_revocation"))).rejects.toMatchObject({ code: "42501" });
  } finally { await f.close(); }
});
