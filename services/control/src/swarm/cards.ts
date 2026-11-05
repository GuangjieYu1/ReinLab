import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { ApiFailure } from "../api/errors";

/**
 * 收件箱四种群研卡（契约 §5）。都走 approval 表：kind 是卡的种类，
 * 卡面字段按契约放在 effects[0]，同一份内容只留一张待处理卡。
 */
export type SwarmCardKind =
  | "swarm_add_member"
  | "swarm_extend"
  | "swarm_scope"
  | "swarm_divergence";

export const SWARM_CARD_KINDS: SwarmCardKind[] = [
  "swarm_add_member",
  "swarm_extend",
  "swarm_scope",
  "swarm_divergence",
];

export const isSwarmCardKind = (kind: unknown): kind is SwarmCardKind =>
  typeof kind === "string" && (SWARM_CARD_KINDS as string[]).includes(kind);

/** 同一张卡的内容指纹：内容一样就不重复出卡（驳回后再提也一样）。 */
const cardKey = (kind: SwarmCardKind, payload: unknown) =>
  `swarm.${kind}:${createHash("sha256")
    .update(JSON.stringify(payload ?? {}))
    .digest("hex")
    .slice(0, 32)}`;

export async function createSwarmCard(
  client: pg.PoolClient,
  input: {
    account: string;
    runId: string;
    dossierId: string;
    kind: SwarmCardKind;
    title: string;
    payload: Record<string, unknown>;
  },
): Promise<{ id: string; created: boolean }> {
  const key = cardKey(input.kind, input.payload);
  // 加人 / 追加额度：同一个运行同时只留一张待处理卡（卡上的数字会随时间变，
  // 按内容去重会越点越多）；范围与分歧按内容去重，不同内容各是一张卡。
  const byKind = input.kind === "swarm_add_member" || input.kind === "swarm_extend";
  const live = (
    await client.query(
      byKind
        ? `select id from approval
            where account_id=$1 and run_id=$2 and kind=$3 and state='pending' order by created_at limit 1`
        : `select id from approval
            where account_id=$1 and run_id=$2 and effect_key=$3 and state='pending' limit 1`,
      [input.account, input.runId, byKind ? input.kind : key],
    )
  ).rows[0];
  if (live) return { id: String(live.id), created: false };
  const id = randomUUID();
  await client.query(
    `insert into approval(id,account_id,run_id,dossier_id,kind,title,effects,risk,state,effect_key)
     values($1,$2,$3,$4,$5,$6,$7,'read','pending',$8)`,
    [
      id,
      input.account,
      input.runId,
      input.dossierId,
      input.kind,
      input.title,
      JSON.stringify([{ kind: input.kind, ...input.payload }]),
      key,
    ],
  );
  return { id, created: true };
}

/** 读一张待处理（或已处理）的群研卡；不是群研卡就返回 null。 */
export async function readSwarmCard(
  client: pg.PoolClient,
  account: string,
  approvalId: string,
): Promise<
  | {
      id: string;
      runId: string;
      dossierId: string;
      kind: SwarmCardKind;
      state: string;
      payload: Record<string, unknown>;
    }
  | null
> {
  const row = (
    await client.query(
      `select a.id,a.run_id,coalesce(a.dossier_id,r.dossier_id) dossier_id,a.kind,a.state,a.effects
         from approval a left join run r on r.account_id=a.account_id and r.id=a.run_id
        where a.account_id=$1 and a.id=$2`,
      [account, approvalId],
    )
  ).rows[0];
  if (!row || !isSwarmCardKind(row.kind)) return null;
  const first = Array.isArray(row.effects) ? row.effects[0] : row.effects;
  return {
    id: String(row.id),
    runId: row.run_id ? String(row.run_id) : "",
    dossierId: String(row.dossier_id ?? ""),
    kind: row.kind as SwarmCardKind,
    state: String(row.state),
    payload: (first ?? {}) as Record<string, unknown>,
  };
}

export function requireLiveCard(state: string, kind: SwarmCardKind): void {
  if (state !== "pending")
    throw new ApiFailure(
      "APPROVAL_CONFLICT",
      409,
      `这张${cardLabel(kind)}已经处理过了，请刷新。`,
    );
}

export function cardLabel(kind: SwarmCardKind): string {
  return (
    {
      swarm_add_member: "加人卡",
      swarm_extend: "追加额度卡",
      swarm_scope: "扩大范围卡",
      swarm_divergence: "分歧卡",
    } as const
  )[kind];
}
