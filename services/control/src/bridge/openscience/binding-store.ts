import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { Database } from "../../db/database";
import { ApiFailure, denied } from "../../api/errors";
import { canonical } from "../../api/context";
import { RoleProjectRequest, versionRoleOptions } from "./role-project";
const Input = z
  .object({
    role: RoleProjectRequest,
    message: z.string().trim().min(1).max(1000000),
  })
  .strict();
const Receipt = z
  .object({
    runID: z.string().min(1).max(200),
    acceptedAt: z.number().finite().nonnegative(),
  })
  .strict();
export type Binding = {
  accountId: string;
  dossierId: string;
  runId: string;
  logicalRoleId: string;
  requestId: string;
  sessionId: string;
  role: z.infer<typeof RoleProjectRequest>;
  definitionHash: string;
  message: string;
  inputHash: string;
  phase: "planned" | "preparing" | "prepared" | "submitting" | "accepted";
  cursor: number;
  initialized: boolean;
  receipt: z.infer<typeof Receipt> | null;
  holdId: string | null;
};
const sha = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
function decode(row: Record<string, any>): Binding {
  const role = RoleProjectRequest.parse(row.role_options);
  if (
    sha(role) !== row.definition_hash ||
    sha({ role, message: row.message }) !== row.input_hash ||
    !Number.isSafeInteger(Number(row.cursor))
  )
    throw new ApiFailure("BINDING_CORRUPT", 503, "会话绑定校验失败。");
  return {
    accountId: row.account_id,
    dossierId: row.dossier_id,
    runId: row.run_id,
    logicalRoleId: row.logical_role_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    role,
    definitionHash: row.definition_hash,
    message: row.message,
    inputHash: row.input_hash,
    phase: row.phase,
    cursor: Number(row.cursor),
    initialized: row.initialized,
    receipt: row.receipt === null ? null : Receipt.parse(row.receipt),
    holdId: row.hold_id,
  };
}
export async function bindingRow(
  client: pg.PoolClient,
  runId: string,
  lock = false,
): Promise<Binding> {
  if (!z.string().uuid().safeParse(runId).success) throw denied();
  const found = await client.query(
    "select * from os_binding where run_id=$1" + (lock ? " for update" : ""),
    [runId],
  );
  if (!found.rowCount) throw denied();
  return decode(found.rows[0]);
}
export class BindingStore {
  constructor(readonly db: Database) {}
  get(accountId: string, runId: string) {
    return this.db.withAccount(accountId, (c) => bindingRow(c, runId));
  }
  async prepare(
    accountId: string,
    runId: string,
    raw: unknown,
  ): Promise<Binding> {
    const parsed = Input.safeParse(raw);
    if (!parsed.success) throw denied();
    const { role: original, message } = parsed.data;
    return this.db.withAccount(accountId, async (c) => {
      if (!z.string().uuid().safeParse(runId).success) throw denied();
      const run = (
        await c.query("select * from run where id=$1 for update", [runId])
      ).rows[0];
      if (
        !run ||
        run.dossier_id !== original.dossierId ||
        run.role_id !== original.role.id
      )
        throw denied();
      const role = versionRoleOptions({
        ...original,
        root: "/data",
        pluginUrl: "file:///opt/reinlab/plugin/index.js",
      });
      const requestRole = RoleProjectRequest.parse({
        dossierId: role.dossierId,
        role: role.role,
        model: role.model,
        memory: role.memory,
        ...(role.mcp ? { mcp: role.mcp } : {}),
      });
      const hash = sha({ role: requestRole, message });
      const old = await c.query("select * from os_binding where run_id=$1", [
        runId,
      ]);
      if (old.rowCount) {
        if (old.rows[0].input_hash !== hash)
          throw new ApiFailure(
            "IDEMPOTENCY_CONFLICT",
            409,
            "已保存的运行内容不同。",
          );
        return decode(old.rows[0]);
      }
      if (run.state !== "queued")
        throw new ApiFailure(
          "RUN_NOT_QUEUED",
          409,
          "该运行已不能创建新的执行绑定。",
        );
      const sessionId = "ses_rl" + randomUUID().replaceAll("-", "");
      const inserted = await c.query(
        `insert into os_binding(account_id,dossier_id,run_id,logical_role_id,request_id,session_id,role_options,definition_hash,message,input_hash) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) returning *`,
        [
          accountId,
          run.dossier_id,
          runId,
          run.role_id,
          run.request_id,
          sessionId,
          JSON.stringify(requestRole),
          sha(requestRole),
          message,
          hash,
        ],
      );
      await c.query("update run set os_session_id=$2 where id=$1", [
        runId,
        sessionId,
      ]);
      return decode(inserted.rows[0]);
    });
  }
  async claim(accountId: string, runId: string): Promise<string | null> {
    return this.db.withAccount(accountId, async (c) => {
      await bindingRow(c, runId);
      const token = randomUUID();
      const result = await c.query(
        "update os_binding set phase='preparing',lease_id=$2,lease_until=now()+interval '60 seconds' where run_id=$1 and phase in ('planned','preparing','prepared') and (lease_id is null or lease_until<now()) returning run_id",
        [runId, token],
      );
      return result.rowCount ? token : null;
    });
  }
  async baseline(
    accountId: string,
    runId: string,
    token: string,
    cursor: number,
  ) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw denied();
    return this.db.withAccount(accountId, async (c) => {
      await bindingRow(c, runId);
      const result = await c.query(
        "update os_binding set phase='prepared',cursor=$3,initialized=true where run_id=$1 and lease_id=$2 and lease_until>now() and phase in ('preparing','prepared')",
        [runId, token, cursor],
      );
      if (!result.rowCount)
        throw new ApiFailure(
          "BINDING_LEASE_LOST",
          409,
          "准备会话的租约已失效。",
        );
    });
  }
  async sendIntent(accountId: string, runId: string, token: string) {
    return this.db.withAccount(accountId, async (c) => {
      const row = await bindingRow(c, runId, true);
      if (!row.initialized)
        throw new ApiFailure("BINDING_NOT_PREPARED", 409, "尚未保存观察基线。");
      const result = await c.query(
        "update os_binding set phase='submitting',lease_id=null,lease_until=null where run_id=$1 and lease_id=$2 and lease_until>now() and phase='prepared'",
        [runId, token],
      );
      if (!result.rowCount)
        throw new ApiFailure(
          "BINDING_LEASE_LOST",
          409,
          "准备会话的租约已失效。",
        );
    });
  }
  async receipt(accountId: string, runId: string, raw: unknown) {
    const receipt = Receipt.parse(raw);
    return this.db.withAccount(accountId, async (c) => {
      const row = await bindingRow(c, runId, true);
      if (row.receipt) {
        if (canonical(row.receipt) !== canonical(receipt))
          throw new ApiFailure(
            "IDEMPOTENCY_CONFLICT",
            409,
            "执行收据内容不同。",
          );
        return row.receipt;
      }
      if (row.phase !== "submitting")
        throw new ApiFailure(
          "BINDING_NOT_SUBMITTED",
          409,
          "尚未持久化发送意图。",
        );
      await c.query(
        "update os_binding set phase='accepted',receipt=$2::jsonb where run_id=$1",
        [runId, JSON.stringify(receipt)],
      );
      await c.query("update run set os_run_id=$2 where id=$1", [
        runId,
        receipt.runID,
      ]);
      return receipt;
    });
  }
}
