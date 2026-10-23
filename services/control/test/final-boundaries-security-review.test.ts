import { it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, realpath, mkdir, writeFile, readFile, stat, rm, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SignJWT } from "jose";
import { mcpFixture } from "./mcp-fixture";
import { appendEvent } from "../src/ledger";
import { createApp } from "../src/api/app";
import { accountFiles } from "../src/mcp/files";

it("all memory-writing decisions require canonical source event references and roll back invalid item evidence", async () => {
  const f = await mcpFixture(), secret = randomBytes(48), issuer = "https://final-review.invalid/auth/v1";
  try {
    const app = await createApp({ pool: f.pool, auth: { issuer, secret } });
    const token = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience("authenticated").setSubject(f.account).setIssuedAt().setExpirationTime("1h").sign(secret);
    const event = await f.db.withAccount(f.account, c => appendEvent(c, f.account, { dossierId: f.dossier, runId: f.run, kind: "message", payload: { text: "Synthetic original source" }, dedupeKey: randomUUID() }));
    const validRef = "event:" + event.seq;
    const request = (path: string, body?: unknown) => app.request(path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + token, "content-type": "application/json", "Idempotency-Key": randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const decision of ["approve", "edit", "keep_local"]) {
      for (const ref of ["run:" + f.run, "event:0", "event:01", "event:+1", "event:1e0", "event:9007199254740992"]) {
        const id = randomUUID(), items = [{ key: "first", value: "valid", evidence: [validRef] }, { key: "second", value: "invalid", evidence: [ref] }];
        await f.admin.query("insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at) values($1,$2,$3,'L4.knowledge',$4,'fixture',now()+interval '1 day')", [id, f.account, f.run, JSON.stringify(items)]);
        const response = await request("/v1/promotions/" + id + "/decide", { decision, ...(decision === "edit" ? { items } : {}) });
        expect(response.status).toBe(409);
        expect((await f.admin.query("select status from promotion where id=$1", [id])).rows[0].status === "pending").toBe(true);
        expect((await f.admin.query("select 1 from memory_item where account_id=$1", [f.account])).rowCount).toBe(0);
        expect((await request("/v1/promotions/" + id + "/evidence/" + ref.slice(6))).status).toBe(404);
      }
    }
  } finally { await f.close(); }
});

it("concurrent file helpers retain one permanent lock inode and reject linked lock files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reinlab-final-lock-review-"))), dossier = randomUUID();
  const directory = join(root, "dossiers", dossier), lock = join(root, "mcp-state", dossier, "lock"), outside = join(root, "outside-sentinel");
  await mkdir(join(directory, "findings"), { recursive: true });
  const call = (n: number) => accountFiles(root, dossier, "write", { path: "findings/" + n + ".txt", content: String(n) }, ["findings/"]);
  try {
    await Promise.all(Array.from({ length: 16 }, (_, n) => call(n)));
    const original = await stat(lock);
    await Promise.all(Array.from({ length: 16 }, (_, n) => call(n + 16)));
    const after = await stat(lock);
    expect(original.dev === after.dev && original.ino === after.ino && after.nlink === 1).toBe(true);
    for (let n = 0; n < 32; n++) expect((await readFile(join(directory, "findings", n + ".txt"), "utf8")) === String(n)).toBe(true);
    await writeFile(outside, "unchanged synthetic sentinel", { mode: 0o600 });
    await rm(lock); await symlink(outside, lock);
    await expect(call(100)).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
    await rm(lock); await link(outside, lock);
    await expect(call(101)).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
    expect((await readFile(outside, "utf8")) === "unchanged synthetic sentinel").toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
