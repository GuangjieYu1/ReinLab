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
  kind?: "permission" | "question";
};

export type ApprovalCard = {
  id: string;
  state: "pending" | "approved" | "rejected" | "expired" | "indeterminate";
  decision: "approve" | "reject" | null;
  consumed: boolean;
};

/**
 * One live card per concrete action.
 *
 * "Live" covers two states, because waiting no longer holds the execution
 * segment: a `pending` card is the one the user still has to answer, and an
 * `approved` card that has not been consumed yet is the one the resumed turn
 * must execute. Expired, rejected and already-consumed cards hold no slot, so
 * the same action can be asked again and gets a fresh card.
 */
export async function requestApproval(
  client: pg.PoolClient,
  request: ApprovalRequest,
): Promise<ApprovalCard> {
  const key = request.capability + ":" + request.argsHash;
  const live = async () =>
    (
      await client.query(
        `select id,state,consumed_at from approval
          where account_id=$1 and run_id=$2 and effect_key=$3
            and (state='pending' or (state='approved' and consumed_at is null))
          order by (state='pending') desc, id desc limit 1`,
        [request.account, request.run, key],
      )
    ).rows[0];
  const found = await live();
  if (found) return card(found);
  // 同一份档案里已经有同样内容的待批卡：直接用它，别再出一张。
  // （驳回后助手会在新的一轮里重提同一批改动，run_id 变了但内容一样——
  //  验收时就因此出过两张一模一样的卡。）
  const sameDossier = (
    await client.query(
      `select a.id,a.state,a.consumed_at
         from approval a
         left join run r on r.account_id=a.account_id and r.id=a.run_id
        where a.account_id=$1 and a.state='pending' and a.effect_key=$2
          and coalesce(a.dossier_id,r.dossier_id)=$3
        order by a.id desc limit 1`,
      [request.account, key, request.dossier],
    )
  ).rows[0];
  if (sameDossier) return card(sameDossier);
  const inserted = await client.query(
    `insert into approval(id,account_id,run_id,kind,title,effects,risk,state,effect_key)
     values(gen_random_uuid(),$1,$2,$7,$3,$4,$5,'pending',$6)
     on conflict (account_id,run_id,effect_key) where effect_key is not null and state = 'pending' do nothing
     returning id,state,consumed_at`,
    [
      request.account,
      request.run,
      request.title,
      JSON.stringify(request.effects),
      request.risk,
      key,
      request.kind ?? "permission",
    ],
  );
  // 并发下另一个请求可能刚好插入，重新读一次有效卡即可。
  const row = inserted.rows[0] ?? (await live());
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
  const exact = await client.query(
    `update approval set consumed_at=now()
     where id=$1 and state='approved' and consumed_at is null and effect_key=$2
     returning id`,
    [options.approvalId, options.effectKey],
  );
  if (exact.rowCount) return true;
  // The model may re-send the same action with a drifted argument spelling.
  // The user approved this exact card for this capability: consume it once
  // instead of failing the download, keeping the one-shot guarantee.
  const capability = options.effectKey.split(":")[0];
  const sameCard = await client.query(
    `update approval set consumed_at=now()
     where id=$1 and state='approved' and consumed_at is null
       and split_part(effect_key, ':', 1) = $2
     returning id`,
    [options.approvalId, capability],
  );
  return (sameCard.rowCount ?? 0) > 0;
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
