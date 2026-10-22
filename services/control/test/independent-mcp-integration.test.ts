import { expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilityEngine } from "../src/mcp/engine";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { createHarnessRunDefinitionLoader } from "../src/bridge/openscience/run-definition";
import { DecisionService } from "../src/bridge/openscience/decisions";
import { implementedCatalog, mcpFixture } from "./mcp-fixture";
import pg from "pg";
import { Hono } from "hono";
import { Database } from "../src/db/database";
import { registerMcp } from "../src/mcp/protocol";

it("independent integration: frozen MCP configuration survives immutable execution binding", async () => {
  const f = await mcpFixture(await implementedCatalog());
  try {
    const definition = await createHarnessRunDefinitionLoader(f.db)(
      f.account,
      f.run,
    );
    expect(definition.role.mcp?.runId).toBe(f.run);
    await f.admin.query("update run set state='queued' where id=$1", [f.run]);
    const binding = await new BindingStore(f.db).prepare(
      f.account,
      f.run,
      definition,
    );
    expect(binding.role.mcp).toEqual(definition.role.mcp);
    expect(JSON.stringify(binding.role)).not.toContain('"token"');
  } finally {
    await f.close();
  }
});

it("independent integration: genuine user once decision validates and bridges the exact MCP approval", async () => {
  const f = await mcpFixture(await implementedCatalog());
  try {
    const authority = new CapabilityAuthority(
      f.db,
      new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
    );
    const token = await authority.issue(f.account, f.run),
      engine = new CapabilityEngine(authority, {});
    const requestId = randomUUID(),
      args = { path: "findings/once.md", content: "fixture" };
    const required = await engine
      .call("files", token, { capability: "files.write", args, requestId })
      .catch((error) => error);
    expect(required.code).toBe("APPROVAL_REQUIRED");
    const mcpRow = (
      await f.admin.query("select * from mcp_approval where id=$1", [
        required.approvalId,
      ])
    ).rows[0];
    const definition = await createHarnessRunDefinitionLoader(f.db)(
      f.account,
      f.run,
    );
    await f.admin.query("update run set state='queued' where id=$1", [f.run]);
    const binding = await new BindingStore(f.db).prepare(
      f.account,
      f.run,
      definition,
    );
    const osApproval = randomUUID(),
      osRequest = "permission_" + randomUUID();
    await f.admin.query(
      "update os_binding set phase='accepted',receipt=$2 where run_id=$1",
      [f.run, { runID: "runtime_" + f.run, acceptedAt: 1 }],
    );
    await f.admin.query("update run set state='running' where id=$1", [f.run]);
    const pending = {
      id: osRequest,
      sessionID: binding.sessionId,
      permission: "reinlab_mcp_approval",
      patterns: [required.approvalId],
      always: [],
      metadata: {
        reinlabMcp: {
          approvalId: required.approvalId,
          capability: "files.write",
          requestId,
          argsHash: mcpRow.args_hash,
        },
      },
    };
    await f.admin.query(
      "insert into approval(id,account_id,run_id,os_request_id,os_session_id,kind,title,effects,risk) values($1,$2,$3,$4,$5,'permission','fixture',$6::jsonb,'write')",
      [
        osApproval,
        f.account,
        f.run,
        osRequest,
        binding.sessionId,
        JSON.stringify([{ properties: pending }]),
      ],
    );
    const snapshot = {
      sessionID: binding.sessionId,
      runs: [
        {
          runID: "runtime_" + f.run,
          sessionID: binding.sessionId,
          requestID: binding.requestId,
          state: "running",
        },
      ],
      permissions: [pending],
      questions: [],
    };
    const service = new DecisionService(f.db, {
      runtime: async () => ({ snapshot: async () => snapshot }) as any,
    });
    await expect(
      service.validate(f.account, osApproval, {
        decision: "approve",
        scope: "session",
      }),
    ).rejects.toBeDefined();
    expect(
      (
        await f.admin.query("select decision from mcp_approval where id=$1", [
          required.approvalId,
        ])
      ).rows[0].decision,
    ).toBeNull();
    const originalHash = pending.metadata.reinlabMcp.argsHash;
    pending.metadata.reinlabMcp.argsHash = "0".repeat(64);
    await expect(
      service.validate(f.account, osApproval, {
        decision: "approve",
        scope: "once",
      }),
    ).rejects.toMatchObject({ code: "MCP_APPROVAL_INVALID" });
    expect(
      (
        await f.admin.query("select decision from mcp_approval where id=$1", [
          required.approvalId,
        ])
      ).rows[0].decision,
    ).toBeNull();
    pending.metadata.reinlabMcp.argsHash = originalHash;
    await service.validate(f.account, osApproval, {
      decision: "approve",
      scope: "once",
    });
    await f.db.withAccount(f.account, (c) =>
      service.prepare(c, f.account, osApproval, {
        decision: "approve",
        scope: "once",
      }),
    );
    expect(
      (
        await f.admin.query(
          "select decision,consumed from mcp_approval where id=$1",
          [required.approvalId],
        )
      ).rows[0],
    ).toEqual({ decision: "approve", consumed: false });
  } finally {
    await f.close();
  }
});

it("independent integration: HTTP revocation and idempotency receipt share one pool connection and transaction", async () => {
  const f = await mcpFixture(await implementedCatalog());
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test", max: 1, connectionTimeoutMillis: 250 });
  try {
    const db = new Database(pool), signer = new CapabilitySigner(generateKeyPairSync("ed25519").privateKey);
    const engine = new CapabilityEngine(new CapabilityAuthority(db, signer), {}), app = new Hono();
    app.onError((_error, c) => c.json({ code: "FIXTURE_FAILURE" }, 500));
    app.use("/v1/*", async (c, next) => { c.set("accountId" as never, f.account as never); await next(); });
    registerMcp(app as any, engine);
    const key = randomUUID(), send = () => app.request(`/v1/runs/${f.run}/capabilities/revoke`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: "{}" });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await f.admin.query("select count(*)::int n from mcp_run_revocation where run_id=$1", [f.run])).rows[0].n).toBe(1);
    expect((await f.admin.query("select count(*)::int n from http_request where account_id=$1", [f.account])).rows[0].n).toBe(1);
  } finally { await pool.end(); await f.close(); }
});
