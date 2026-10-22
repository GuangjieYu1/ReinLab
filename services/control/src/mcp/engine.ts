import { lockBudget } from "../budget";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import Ajv from "ajv";
import { z } from "zod";
import { ApiFailure } from "../api/errors";
import { appendEvent, scrub } from "../ledger";
import type { JsonValue, Capability } from "@reinlab/contracts";
import { CapabilityAuthority, type AuthorizedCapability } from "./authority";
import { requireImplemented } from "./registry";
import { hash } from "./token";
const Request = z
  .object({
    capability: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]+$/)
      .max(160),
    args: z.record(z.unknown()),
    requestId: z
      .string()
      .regex(/^[-A-Za-z0-9_.:]{1,200}$/)
      .optional(),
    approvalId: z.string().uuid().optional(),
  })
  .strict();
export type CapabilityRequest = z.infer<typeof Request>;
export type CapabilityHandler = (
  context: AuthorizedCapability,
  args: Record<string, unknown>,
  requestId: string,
) => Promise<Record<string, unknown>>;
const fail = (code: string, status: 400 | 403 | 409 | 503 = 403) =>
  new ApiFailure(code, status, "能力请求被拒绝。");
const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: true });
ajv.addFormat(
  "uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
function conforms(schema: Record<string, unknown>, value: unknown) {
  try {
    return ajv.compile(schema)(value);
  } catch {
    throw fail("CAPABILITY_SCHEMA_INVALID", 503);
  }
}
function approvalSummary(request: CapabilityRequest): JsonValue {
  const args = request.args;
  const changes = Array.isArray(args.changes) ? args.changes : [args];
  if (request.capability.startsWith("files."))
    return scrub({
      operation: request.capability,
      files: changes.slice(0, 32).map((v) => ({
        path: typeof v.path === "string" ? v.path : null,
        bytes:
          typeof v.content === "string" ? Buffer.byteLength(v.content) : null,
      })),
    });
  return {
    operation: request.capability,
    argumentNames: Object.keys(args).sort(),
    argsHash: hash(args),
  };
}
/** A server uses this same boundary for both kernel and external MCP clients. */
export class CapabilityEngine {
  constructor(
    readonly authority: CapabilityAuthority,
    private readonly handlers: Readonly<Record<string, CapabilityHandler>>,
  ) {}
  private async event(
    auth: AuthorizedCapability,
    capability: string,
    argsHash: string,
    action: "capability.call" | "capability.denied",
    payload: Record<string, JsonValue>,
  ) {
    await this.authority.db.withAccount(auth.claims.account, async (client) => {
      await lockBudget(client, auth.claims.account);
      return appendEvent(client, auth.claims.account, {
        dossierId: auth.claims.dossier,
        runId: auth.claims.run,
        roleId: auth.claims.role,
        kind: "tool",
        action,
        risk: auth.catalog.capabilities[capability]?.risk ?? "read",
        payload: {
          server: capability.split(".")[0],
          capability,
          argsHash,
          ...payload,
        },
        dedupeKey: "mcp:" + randomUUID(),
      });
    });
  }
  private async anonymous(server: string) {
    // A valid UUID is only a transaction namespace; invalid signatures never choose a victim tenant.
    await this.authority.db.withAccount(randomUUID(), (c) =>
      c.query(
        "insert into mcp_anonymous_denial(id,action,reason,server) values($1,'capability.denied','CAPABILITY_TOKEN_INVALID',$2)",
        [randomUUID(), server],
      ),
    );
  }
  async call(
    server: "files" | "memory" | "cards" | "papers",
    rawToken: unknown,
    raw: unknown,
  ) {
    let auth: AuthorizedCapability;
    try {
      auth = await this.authority.validate(rawToken);
    } catch (error) {
      await this.anonymous(server);
      throw error;
    }
    const started = Date.now();
    let request: CapabilityRequest | undefined;
    try {
      const parsed = Request.safeParse(raw);
      if (!parsed.success) throw fail("INVALID_INPUT", 400);
      request = parsed.data;
      if (Buffer.byteLength(JSON.stringify(request.args)) > 4 * 1024 * 1024)
        throw new ApiFailure(
          "CAPABILITY_TOO_LARGE",
          413,
          "能力参数超过大小限制。",
        );
      if (!request.capability.startsWith(server + "."))
        throw fail("CAPABILITY_DENIED");
      const grant = auth.scope.grants.find(
        (g) => g.name === request!.capability,
      );
      if (!grant) throw fail("CAPABILITY_DENIED");
      const capability = requireImplemented(auth.catalog, request.capability);
      if (!conforms(capability.input, request.args))
        throw fail("CAPABILITY_INPUT_INVALID", 400);
      if (
        (capability.idempotent ||
          grant.permission === "ask" ||
          capability.risk === "danger") &&
        !request.requestId
      )
        throw fail("REQUEST_ID_REQUIRED", 400);
      const requestId = request.requestId ?? randomUUID(),
        argsHash = hash({ capability: request.capability, args: request.args });
      const admission = await this.authority.db.withAccount(
        auth.claims.account,
        async (client) => {
          await lockBudget(client, auth.claims.account);
          await this.authority.validateClient(client, rawToken);
          await client.query(
            "select pg_advisory_xact_lock(hashtextextended($1,0))",
            ["mcp-invocation:" + auth.claims.run + ":" + requestId],
          );
          if (capability.idempotent) {
            const old = (
              await client.query(
                "select * from mcp_invocation where run_id=$1 and request_id=$2",
                [auth.claims.run, requestId],
              )
            ).rows[0];
            if (old) {
              if (
                old.args_hash !== argsHash ||
                old.capability !== request!.capability
              )
                throw fail("IDEMPOTENCY_CONFLICT", 409);
              if (old.state !== "succeeded")
                throw fail("CAPABILITY_OUTCOME_UNKNOWN", 409);
              return { replay: old.result as Record<string, unknown> };
            }
          }
          if (grant.permission === "ask" || capability.risk === "danger") {
            const approval = await this.approval(
              client,
              auth,
              request!,
              requestId,
              argsHash,
              capability,
            );
            if (approval.required) return { approvalId: approval.id };
          }
          if (capability.idempotent)
            await client.query(
              "insert into mcp_invocation(account_id,dossier_id,run_id,request_id,capability,args_hash,approval_id,state) values($1,$2,$3,$4,$5,$6,$7,'executing')",
              [
                auth.claims.account,
                auth.claims.dossier,
                auth.claims.run,
                requestId,
                request!.capability,
                argsHash,
                request!.approvalId ?? null,
              ],
            );
          return {};
        },
      );
      if ("approvalId" in admission) {
        throw Object.assign(fail("APPROVAL_REQUIRED", 409), {
          approvalId: admission.approvalId,
        });
      }
      let result: Record<string, unknown>;
      if ("replay" in admission) result = admission.replay!;
      else {
        try {
          const handler = Object.hasOwn(this.handlers, request.capability)
            ? this.handlers[request.capability]
            : undefined;
          if (!handler) throw fail("CAPABILITY_HANDLER_MISSING", 503);
          result = await handler(auth, request.args, requestId);
          if (
            Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024 ||
            !conforms(capability.output, result)
          )
            throw fail("CAPABILITY_OUTPUT_INVALID", 503);
          if (capability.idempotent)
            await this.finish(auth, requestId, "succeeded", result);
        } catch (error) {
          // Once admitted, a lost reply or effect is never automatically re-executed.
          if (capability.idempotent)
            await this.finish(auth, requestId, "indeterminate", null);
          throw error;
        }
      }
      await this.event(auth, request.capability, argsHash, "capability.call", {
        resultHash: hash(result),
        approvalId: request.approvalId ?? null,
        durationMs: Date.now() - started,
        success: true,
        replay: "replay" in admission,
      });
      return result;
    } catch (error) {
      const code =
        error instanceof ApiFailure ? error.code : "CAPABILITY_FAILED";
      await this.event(
        auth,
        request?.capability ?? server + ".unknown",
        hash({
          capability: request?.capability ?? server + ".unknown",
          args: request?.args ?? {},
        }),
        "capability.call",
        {
          resultHash: null,
          approvalId: request?.approvalId ?? null,
          durationMs: Date.now() - started,
          success: false,
          reason: code,
        },
      );
      await this.event(
        auth,
        request?.capability ?? server + ".unknown",
        hash({
          capability: request?.capability ?? server + ".unknown",
          args: request?.args ?? {},
        }),
        "capability.denied",
        {
          reason: code,
          approvalId: request?.approvalId ?? null,
          durationMs: Date.now() - started,
          success: false,
        },
      );
      if (error instanceof ApiFailure) throw error;
      throw fail("CAPABILITY_FAILED", 503);
    }
  }
  private async finish(
    auth: AuthorizedCapability,
    requestId: string,
    state: "succeeded" | "indeterminate",
    result: Record<string, unknown> | null,
  ) {
    await this.authority.db.withAccount(auth.claims.account, (c) =>
      c.query(
        "update mcp_invocation set state=$3,result=$4::jsonb where run_id=$1 and request_id=$2 and state='executing'",
        [
          auth.claims.run,
          requestId,
          state,
          result === null ? null : JSON.stringify(result),
        ],
      ),
    );
  }
  private async approval(
    client: pg.PoolClient,
    auth: AuthorizedCapability,
    request: CapabilityRequest,
    requestId: string,
    argsHash: string,
    capability: Capability,
  ) {
    let row = (
      await client.query(
        "select * from mcp_approval where run_id=$1 and request_id=$2 for update",
        [auth.claims.run, requestId],
      )
    ).rows[0];
    if (!row) {
      if (request.approvalId) throw fail("APPROVAL_INVALID");
      const id = randomUUID();
      await client.query(
        "insert into approval(id,account_id,run_id,kind,title,effects,risk) values($1,$2,$3,'permission',$4,$5::jsonb,$6)",
        [
          id,
          auth.claims.account,
          auth.claims.run,
          "批准能力调用 " + request.capability,
          JSON.stringify({
            capability: request.capability,
            argsHash,
            requestId,
            effectiveDigest: auth.claims.effectiveDigest,
            effects: capability.effects,
            summary: approvalSummary(request),
          }),
          capability.risk,
        ],
      );
      await client.query(
        "insert into mcp_approval(id,account_id,dossier_id,run_id,capability,request_id,args_hash,scope_digest) values($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          auth.claims.account,
          auth.claims.dossier,
          auth.claims.run,
          request.capability,
          requestId,
          argsHash,
          auth.claims.scopeDigest,
        ],
      );
      await appendEvent(client, auth.claims.account, {
        dossierId: auth.claims.dossier,
        runId: auth.claims.run,
        kind: "card",
        action: "approval.request",
        payload: {
          kind: "approval",
          approvalId: id,
          capability: request.capability,
          argsHash,
          risk: capability.risk,
          effects: capability.effects,
        },
        dedupeKey: "mcp-approval:" + id,
      });
      return { required: true, id };
    }
    if (
      row.args_hash !== argsHash ||
      row.capability !== request.capability ||
      row.scope_digest !== auth.claims.scopeDigest
    )
      throw fail("APPROVAL_PARAMETERS_CHANGED", 409);
    if (!request.approvalId) return { required: true, id: row.id };
    if (
      row.id !== request.approvalId ||
      row.decision !== "approve" ||
      row.consumed
    )
      throw fail("APPROVAL_INVALID");
    await client.query("update mcp_approval set consumed=true where id=$1", [
      row.id,
    ]);
    return { required: false, id: row.id };
  }
  /** Only authenticated user routes call this; no MCP capability grants approval. */
  async decide(
    account: string,
    approvalId: string,
    decision: "approve" | "reject",
  ) {
    return this.authority.db.withAccount(account, (client) =>
      this.decideClient(client, account, approvalId, decision),
    );
  }
  async decideClient(
    client: pg.PoolClient,
    account: string,
    approvalId: string,
    decision: "approve" | "reject",
  ) {
    await lockBudget(client, account);
    const row = (
      await client.query("select * from mcp_approval where id=$1 for update", [
        approvalId,
      ])
    ).rows[0];
    if (!row) throw fail("APPROVAL_INVALID");
    const run = (
      await client.query(
        "select state,ended_at from run where id=$1 for share",
        [row.run_id],
      )
    ).rows[0];
    if (!run || !["running", "waiting"].includes(run.state) || run.ended_at)
      throw fail("APPROVAL_EXPIRED", 409);
    if (row.decision && row.decision !== decision)
      throw fail("IDEMPOTENCY_CONFLICT", 409);
    await client.query("update mcp_approval set decision=$2 where id=$1", [
      approvalId,
      decision,
    ]);
    await client.query(
      "update approval set state=$2,decided_scope='once',decided_at=coalesce(decided_at,now()) where id=$1",
      [approvalId, decision === "approve" ? "approved" : "rejected"],
    );
    return { approvalId, decision, scope: "once" };
  }
}
