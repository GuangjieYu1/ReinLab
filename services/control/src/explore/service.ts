/**
 * 探索台计划服务（design/prd/07-explore-contract.md 第 2～4 节）。
 *
 * 页面接口和 Agent 工具调同一组函数：一批 ops 在一个事务里原子生效，
 * 修订号批次内只 +1；Agent 要改已确认内容时先出一张计划修改卡，用户点了才生效。
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type {
  AppliedOp,
  CanvasObject,
  ExplorePlan,
  Op,
  PendingChange,
  RefImage,
} from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import { canonical } from "../api/context";
import { consumeApproval, effectKeyOf, requestApproval } from "../run/approval";
import {
  applyBatch,
  describeBatch,
  describeChanges,
  documentOf,
  needsAcceptance,
  planOf,
  type StoredPlan,
  type UndoCandidate,
} from "./plan";
import { consumeUserAuthorization, verifyUserAuthorization } from "./authorize";

type Client = pg.PoolClient;

export const CAPABILITY = "explore.ops";

export type PlanBundle = {
  plan: ExplorePlan;
  canvas: CanvasObject[];
  refs: RefImage[];
  lastViewport: StoredPlan["document"]["lastViewport"];
  basemap: StoredPlan["document"]["basemap"];
};

export type OpsRequest = {
  /** 页面必带；Agent 省略时用最新修订。 */
  baseRevision?: number;
  ops: Op[];
  actor: "page" | "agent";
  run?: string | null;
  authorization?: { messageId?: string };
  /** 用户刚在审批卡上点过「同意」：这就是授权本身。 */
  approved?: { approvalId: string };
};

export type OpsOutcome = {
  revision: number;
  applied: AppliedOp[];
  pending: PendingChange | null;
  plan: ExplorePlan;
  bench: string;
  dossierId: string;
};

/** 读一份计划（必要时新建默认草稿）；lock=true 时锁住行，供写批次串行化。 */
export async function loadPlan(
  client: Client,
  account: string,
  dossier: string,
  options: { lock?: boolean } = {},
): Promise<{ plan: StoredPlan; bench: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dossier))
    throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  const dossierRow = (
    await client.query("select id,bench from dossier where account_id=$1 and id=$2", [account, dossier])
  ).rows[0];
  if (!dossierRow) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  if (dossierRow.bench !== "exploration")
    throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有探索台档案有旅拍计划。");
  await client.query(
    "insert into explore_plan(account_id,dossier_id) values($1,$2) on conflict (account_id,dossier_id) do nothing",
    [account, dossier],
  );
  const row = (
    await client.query(
      `select revision,state,document,updated_at from explore_plan
        where account_id=$1 and dossier_id=$2 ${options.lock ? "for update" : ""}`,
      [account, dossier],
    )
  ).rows[0];
  return {
    plan: {
      revision: Number(row.revision),
      state: row.state,
      document: documentOf(row.document),
      updatedAt: new Date(row.updated_at).toISOString(),
    },
    bench: dossierRow.bench,
  };
}

export async function readPlan(client: Client, account: string, dossier: string): Promise<PlanBundle> {
  const { plan } = await loadPlan(client, account, dossier);
  return {
    plan: planOf(dossier, plan),
    canvas: plan.document.canvas,
    // 参考图在下一批接通；现在如实给空，不拿示例顶。
    refs: [],
    lastViewport: plan.document.lastViewport,
    basemap: plan.document.basemap,
  };
}

const opsHash = (ops: Op[]) => createHash("sha256").update(canonical({ ops })).digest("hex");

/** 可撤回的画布动作：最近的在前面。 */
async function undoCandidates(client: Client, account: string, dossier: string): Promise<UndoCandidate[]> {
  const rows = (
    await client.query(
      `select seq::text seq, actor, summary, inverse from explore_op
        where account_id=$1 and dossier_id=$2 and inverse is not null and undone_by is null
          and op in ('canvas.add','canvas.update','canvas.remove')
        order by seq desc limit 50`,
      [account, dossier],
    )
  ).rows;
  return rows.map((row) => ({
    seq: row.seq,
    actor: row.actor === "agent" ? "agent" : "page",
    inverse: row.inverse as Op,
    summary: String(row.summary ?? "画布改动"),
  }));
}

/**
 * 一个批次的 ops。
 *
 * Agent 的受保护动作先核对授权：用户这句话明确要求了就执行；否则出计划修改卡，
 * 整批不执行、修订不变、不推 explore.op。
 */
export async function applyOps(
  client: Client,
  account: string,
  dossier: string,
  request: OpsRequest,
): Promise<OpsOutcome> {
  const { plan, bench } = await loadPlan(client, account, dossier, { lock: true });
  const ops = request.ops as Op[];

  // 负数 = 页面表示「不关心修订」（只存视野时）；其余按乐观并发校验。
  const declaredRevision =
    request.baseRevision !== undefined && request.baseRevision >= 0 ? request.baseRevision : undefined;
  if (declaredRevision !== undefined && declaredRevision !== plan.revision)
    throw new ApiFailure(
      "REVISION_CONFLICT",
      409,
      "计划刚被改过，请按最新状态再来一次。",
      { revision: plan.revision, current: planOf(dossier, plan) },
    );

  if (request.actor === "agent" && !request.approved) {
    const guarded = ops.filter((op) => needsAcceptance(plan, op));
    if (guarded.length) {
      const verdict = await verifyUserAuthorization(client, {
        account,
        dossier,
        run: request.run ?? null,
        messageId: request.authorization?.messageId,
        ops: guarded,
        plan,
      });
      if (verdict.ok) {
        // 一句话只用一次：用掉就记账，之后再拿同一句当授权会被拦下。
        await consumeUserAuthorization(client, { account, dossier, messageId: verdict.messageId });
        return commitBatch(client, account, dossier, bench, request, plan);
      }
      return pendingCard(client, account, dossier, bench, request, plan, guarded);
    }
  }

  if (request.approved) {
    // 审批卡批准的是当时那个修订：计划已经变了就不套用，免得覆盖用户后来的修改。
    const card = (
      await client.query(
        "select effects,consumed_at,state from approval where id=$1 and account_id=$2",
        [request.approved.approvalId, account],
      )
    ).rows[0];
    if (!card) throw new ApiFailure("APPROVAL_NOT_FOUND", 404, "这张审批卡不存在了。");
    // kernel 卡的 effects 是数组（[{kind, forRevision, ops…}]）。
    const effectsOf = Array.isArray(card.effects) ? card.effects[0] : card.effects;
    const forRevision = Number((effectsOf as any)?.forRevision ?? 0);
    if (forRevision !== plan.revision)
      throw new ApiFailure("PLAN_STALE", 409, "计划在这张卡之后改过了，这次修改不再适用。");
    const consumed = await consumeApproval(client, {
      approvalId: request.approved.approvalId,
      effectKey: effectKeyOf(CAPABILITY, opsHash(ops)),
    });
    if (!consumed)
      throw new ApiFailure("APPROVAL_NOT_CONSUMABLE", 409, "这张卡已经用过了，重新发起一次。");
  }

  return commitBatch(client, account, dossier, bench, request, plan);
}

async function pendingCard(
  client: Client,
  account: string,
  dossier: string,
  bench: string,
  request: OpsRequest,
  plan: StoredPlan,
  guarded: Op[],
): Promise<OpsOutcome> {
  if (!request.run) throw new ApiFailure("RUN_REQUIRED", 400, "助手的动作要挂在一次对话上。");
  const summary = describeBatch(plan, guarded);
  const changes = describeChanges(plan, guarded);
  const card = await requestApproval(client, {
    account,
    dossier,
    run: request.run,
    capability: CAPABILITY,
    argsHash: opsHash(request.ops as Op[]),
    title: summary,
    effects: [
      {
        kind: "explore.planChange",
        dossierId: dossier,
        forRevision: plan.revision,
        ops: request.ops,
        summary,
        changes,
      },
    ],
    risk: "write",
  });
  return {
    revision: plan.revision,
    applied: [],
    pending: {
      approvalId: card.id,
      ops: request.ops as Op[],
      summary,
      changes,
      forRevision: plan.revision,
    },
    plan: planOf(dossier, plan),
    bench,
    dossierId: dossier,
  };
}

async function commitBatch(
  client: Client,
  account: string,
  dossier: string,
  bench: string,
  request: OpsRequest,
  plan: StoredPlan,
): Promise<OpsOutcome> {
  // 第一次确认整份计划：账户时区没设就请用户先给一个（确认卡里默认浏览器时区）。
  const confirmOp = (request.ops as (Op & { timezone?: string })[]).find((op) => op.op === "plan.confirm");
  if (confirmOp) await requireTimezone(client, account, confirmOp.timezone);
  const needsUndo = (request.ops as Op[]).some((op) => op.op === "canvas.undo");
  const batch = applyBatch({
    plan,
    ops: request.ops as Op[],
    actor: request.actor,
    undoCandidates: needsUndo ? await undoCandidates(client, account, dossier) : [],
  });

  if (batch.business) {
    await client.query(
      `update explore_plan set revision=$3, state=$4, document=$5::jsonb, updated_at=now()
        where account_id=$1 and dossier_id=$2`,
      [
        account,
        dossier,
        batch.plan.revision,
        batch.plan.state,
        JSON.stringify(batch.plan.document),
      ],
    );
    const seqs: string[] = [];
    for (const [index, applied] of batch.applied.entries()) {
      const inserted = (
        await client.query(
          `insert into explore_op(account_id,dossier_id,revision,actor,op,summary,detail,inverse)
           values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) returning seq::text seq`,
          [
            account,
            dossier,
            batch.plan.revision,
            request.actor,
            applied.op,
            applied.summary,
            JSON.stringify(applied),
            batch.inverses[index] ? JSON.stringify(batch.inverses[index]) : null,
          ],
        )
      ).rows[0];
      seqs.push(inserted.seq);
    }
    if (batch.undone.length && seqs.length) {
      await client.query(
        `update explore_op set undone_by=$3
          where account_id=$1 and dossier_id=$2 and seq = any($4::bigint[])`,
        [account, dossier, seqs[seqs.length - 1], batch.undone],
      );
    }
    await client.query(
      "update dossier set last_activity_at=now() where account_id=$1 and id=$2 and lifecycle='active'",
      [account, dossier],
    );
  } else if (batch.plan.document.lastViewport) {
    await client.query(
      `update explore_plan set document=$3::jsonb where account_id=$1 and dossier_id=$2`,
      [account, dossier, JSON.stringify(batch.plan.document)],
    );
  }

  return {
    revision: batch.plan.revision,
    applied: batch.applied,
    pending: null,
    plan: planOf(dossier, batch.plan),
    bench,
    dossierId: dossier,
  };
}

/** 账户时区（天气检查按它每天 08/16/23 跑）。 */
export async function accountTimezone(client: Client, account: string): Promise<string | null> {
  const row = (await client.query("select timezone from account where id=$1", [account])).rows[0];
  return (row?.timezone as string | null) ?? null;
}

export async function saveTimezone(client: Client, account: string, timezone: string) {
  await client.query("update account set timezone=$2 where id=$1", [account, timezone]);
}

/** 计划确认前要有时区：没有就请用户在确认卡里给一个（默认浏览器时区）。 */
export async function requireTimezone(client: Client, account: string, provided?: string) {
  if (provided) {
    await saveTimezone(client, account, provided);
    return provided;
  }
  const existing = await accountTimezone(client, account);
  if (existing) return existing;
  throw new ApiFailure("TIMEZONE_REQUIRED", 409, "天气检查要用账户时区，先确认一个时区（默认取浏览器时区）。");
}
