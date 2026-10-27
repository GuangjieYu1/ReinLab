import type pg from "pg";
import { ApiFailure } from "../api/errors";

export type ApprovalRequest = {
  account: string;
  dossier: string;
  run: string;
  capability: string;
  /** Binds the approval to one concrete action; a different argument set re-asks. */
  argsHash: string;
  title: string;
  effects: unknown;
  risk: "read" | "write" | "danger";
};

export type ApprovalCard = {
  id: string;
  state: "pending" | "approved" | "rejected" | "expired" | "indeterminate";
  decision: "approve" | "reject" | null;
  consumed: boolean;
};

/**
 * One card per concrete action. Requesting the same action twice returns the
 * existing card instead of opening a second one; the unique effect key makes
 * that a database guarantee rather than a caller convention.
 */
export async function requestApproval(
  client: pg.PoolClient,
  request: ApprovalRequest,
): Promise<ApprovalCard> {
  const key = request.capability + ":" + request.argsHash;
  const inserted = await client.query(
    `insert into approval(id,account_id,run_id,kind,title,effects,risk,state,effect_key)
     values(gen_random_uuid(),$1,$2,'permission',$3,$4,$5,'pending',$6)
     on conflict (account_id,run_id,effect_key) where effect_key is not null do nothing
     returning id,state,consumed_at`,
    [request.account, request.run, request.title, JSON.stringify(request.effects), request.risk, key],
  );
  const row =
    inserted.rows[0] ??
    (
      await client.query(
        `select id,state,consumed_at from approval where account_id=$1 and run_id=$2 and effect_key=$3`,
        [request.account, request.run, key],
      )
    ).rows[0];
  if (!row) throw new ApiFailure("APPROVAL_REQUIRED", 409, "需要一次审批。");
  return card(row);
}

export async function decideApproval(
  client: pg.PoolClient,
  options: { approvalId: string; decision: "approve" | "reject" },
): Promise<ApprovalCard> {
  const result = await client.query(
    `update approval
       set state=$2, decided_at=now(), decided_scope='once'
     where id=$1 and state='pending'
     returning id,state,consumed_at`,
    [options.approvalId, options.decision === "approve" ? "approved" : "rejected"],
  );
  const row =
    result.rows[0] ??
    (await client.query(`select id,state,consumed_at from approval where id=$1`, [options.approvalId])).rows[0];
  if (!row) throw new ApiFailure("APPROVAL_NOT_FOUND", 404, "审批不存在。");
  return card(row);
}

/**
 * Consume the exact approved action once. A repeat submission (same run and
 * argument hash) does not execute again: it reports `consumed:false` so the
 * caller returns the existing result instead of downloading twice.
 */
export async function consumeApproval(
  client: pg.PoolClient,
  options: { approvalId: string; effectKey: string },
): Promise<boolean> {
  const result = await client.query(
    `update approval set consumed_at=now()
     where id=$1 and state='approved' and consumed_at is null and effect_key=$2
     returning id`,
    [options.approvalId, options.effectKey],
  );
  return (result.rowCount ?? 0) > 0;
}

export function effectKeyOf(capability: string, argsHash: string) {
  return capability + ":" + argsHash;
}

function card(row: {
  id: string;
  state: ApprovalCard["state"];
  consumed_at: Date | null;
}): ApprovalCard {
  return {
    id: row.id,
    state: row.state,
    decision: row.state === "approved" ? "approve" : row.state === "rejected" ? "reject" : null,
    consumed: row.consumed_at !== null,
  };
}
