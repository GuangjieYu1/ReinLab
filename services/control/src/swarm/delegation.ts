import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ApiFailure } from "../api/errors";
import type { Database } from "../db/database";

/**
 * 跨台委托（契约 §6）。首个源台选**探索台**（`exploration`）：
 * 它在本仓已经有完整的档案与活动流（旅拍路线、看过的材料），
 * 「探索时冒出一个要查清的问题 → 交给群研」是最自然的一条路；
 * 精读在本仓是 `bench='research'` 的 reading 档案，跨台委托不适用。
 */
export type DelegationRow = {
  id: string;
  from_bench: string;
  from_dossier: string;
  to_bench: string;
  to_dossier: string | null;
  to_run: string | null;
  request: Record<string, unknown>;
  state: string;
  result_version: number;
  adopted: boolean;
  decided_at: Date | null;
  created_at: Date;
};

export type DelegationView = {
  id: string;
  state: "awaiting_confirm" | "running" | "done";
  fromBench: string;
  fromDossierId: string;
  toBench: string;
  researchDossierId: string | null;
  runId: string | null;
  resultVersion: number;
  adopted: boolean;
  request: Record<string, unknown>;
  createdAt: string;
};

const view = (row: DelegationRow): DelegationView => ({
  id: String(row.id),
  state:
    row.state === "awaiting_confirm"
      ? "awaiting_confirm"
      : row.result_version > 0
        ? "done"
        : "running",
  fromBench: String(row.from_bench),
  fromDossierId: String(row.from_dossier),
  toBench: String(row.to_bench),
  researchDossierId: row.to_dossier ? String(row.to_dossier) : null,
  runId: row.to_run ? String(row.to_run) : null,
  resultVersion: Number(row.result_version ?? 0),
  adopted: Boolean(row.adopted),
  request: (row.request ?? {}) as Record<string, unknown>,
  createdAt: new Date(row.created_at).toISOString(),
});

export async function createDelegation(
  db: Database,
  account: string,
  input: {
    fromBench: string;
    fromDossierId: string;
    question: string;
    background?: string;
    materials?: { ref: string; version?: string }[];
    expected?: string;
    constraints?: string;
  },
  idempotencyKey: string,
): Promise<DelegationView> {
  return db.withAccount(account, async (client) => {
    // 按 Idempotency-Key 幂等：同一份委托重复提交返回同一个 id。
    const existing = (
      await client.query(
        `select * from delegation
          where account_id=$1 and request->>'idempotencyKey'=$2 limit 1`,
        [account, idempotencyKey],
      )
    ).rows[0] as DelegationRow | undefined;
    if (existing) return view(existing);
    const source = (
      await client.query(
        "select id, bench from dossier where account_id=$1 and id=$2",
        [account, input.fromDossierId],
      )
    ).rows[0];
    if (!source) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份源档案。");
    if (String(source.bench) !== input.fromBench)
      throw new ApiFailure("DELEGATION_BENCH_MISMATCH", 400, "源档案和源台对不上。");
    const id = randomUUID();
    const request = {
      question: input.question,
      background: input.background ?? null,
      materials: input.materials ?? [],
      expected: input.expected ?? null,
      constraints: input.constraints ?? null,
      mode: "swarm",
      idempotencyKey,
    };
    await client.query(
      `insert into delegation(id,account_id,from_dossier,to_bench,request,budget_cny,state)
       values($1,$2,$3,'research',$4,8,'awaiting_confirm')`,
      [id, account, input.fromDossierId, JSON.stringify(request)],
    );
    return view(
      (
        await client.query("select * from delegation where account_id=$1 and id=$2", [
          account,
          id,
        ])
      ).rows[0] as DelegationRow,
    );
  });
}

export async function getDelegation(
  db: Database,
  account: string,
  id: string,
): Promise<DelegationView> {
  return db.withAccount(account, async (client) => {
    const row = (
      await client.query("select * from delegation where account_id=$1 and id=$2", [account, id])
    ).rows[0] as DelegationRow | undefined;
    if (!row) throw new ApiFailure("DELEGATION_NOT_FOUND", 404, "找不到这份委托。");
    return view(row);
  });
}

export async function confirmDelegation(
  db: Database,
  account: string,
  id: string,
  start: (researchDossierId: string, question: string) => Promise<{ runId: string }>,
  createDossier: (
    client: pg.PoolClient,
    account: string,
    input: { bench: string; title: string; intent: string },
  ) => Promise<{ id: string }>,
): Promise<{ researchDossierId: string; runId: string }> {
  const prepared = await db.withAccount(account, async (client) => {
    const row = (
      await client.query("select * from delegation where account_id=$1 and id=$2 for update", [
        account,
        id,
      ])
    ).rows[0] as DelegationRow | undefined;
    if (!row) throw new ApiFailure("DELEGATION_NOT_FOUND", 404, "找不到这份委托。");
    // 已经确认过：返回同一份档案与运行（幂等）。
    if (row.to_dossier && row.to_run)
      return { researchDossierId: String(row.to_dossier), runId: String(row.to_run) };
    const request = (row.request ?? {}) as { question?: string; background?: string };
    const dossier = await createDossier(client, account, {
      bench: "research",
      title: `委托：${String(request.question ?? "研究问题").slice(0, 40)}`,
      intent: String(request.question ?? ""),
    });
    await client.query(
      "update delegation set to_dossier=$3, state='running' where account_id=$1 and id=$2",
      [account, id, dossier.id],
    );
    return { researchDossierId: dossier.id, runId: "", question: String(request.question ?? "") };
  });
  if (prepared.runId) return prepared;
  const started = await start(prepared.researchDossierId, prepared.question as string);
  await db.withAccount(account, (client) =>
    client.query(
      "update delegation set to_run=$3, state='running' where account_id=$1 and id=$2",
      [account, id, started.runId],
    ),
  );
  return { researchDossierId: prepared.researchDossierId, runId: started.runId };
}

/** 采用/不采用：只记一笔、挂引用，不改源档案内容。 */
export async function decideDelegation(
  db: Database,
  account: string,
  id: string,
  input: { decision: "adopt" | "dismiss"; resultVersion?: number },
  note: (client: pg.PoolClient, account: string, dossier: string, text: string) => Promise<void>,
): Promise<{ state: string; adopted: boolean }> {
  return db.withAccount(account, async (client) => {
    const row = (
      await client.query("select * from delegation where account_id=$1 and id=$2 for update", [
        account,
        id,
      ])
    ).rows[0] as DelegationRow | undefined;
    if (!row) throw new ApiFailure("DELEGATION_NOT_FOUND", 404, "找不到这份委托。");
    if (input.resultVersion && Number(input.resultVersion) !== Number(row.result_version))
      throw new ApiFailure(
        "DELEGATION_RESULT_STALE",
        409,
        `结果卡已经更新到第 ${row.result_version} 版，请刷新后再决定。`,
      );
    const adopted = input.decision === "adopt";
    await client.query(
      "update delegation set adopted=$3, decided_at=now() where account_id=$1 and id=$2",
      [account, id, adopted],
    );
    const question = String((row.request as { question?: string })?.question ?? "研究问题");
    await note(
      client,
      account,
      String(row.from_dossier),
      adopted
        ? `采用了群研对「${question}」的结果（委托 ${String(id).slice(0, 8)}）`
        : `没有采用群研对「${question}」的结果（委托 ${String(id).slice(0, 8)}）`,
    );
    return { state: adopted ? "adopted" : "dismissed", adopted };
  });
}

/** 结果卡内容（契约 §6 的 DelegationResult）：重复回调更新同一张卡、版本递增。 */
export async function buildDelegationResult(
  client: pg.PoolClient,
  account: string,
  row: DelegationRow,
  report: {
    state: string;
    claims: { id: string; text: string; status: string }[];
    evidence: { id: string; title: string; locator: string }[];
    limits: string[];
    gaps: string[];
  },
): Promise<Record<string, unknown>> {
  const version = Number(row.result_version ?? 0) + 1;
  const researchDossierId = row.to_dossier ? String(row.to_dossier) : "";
  const runId = row.to_run ? String(row.to_run) : "";
  return {
    delegationId: String(row.id),
    version,
    researchDossierId,
    runId,
    outcome:
      report.state === "final"
        ? "done"
        : report.state === "unresolved"
          ? "unresolved"
          : "partial",
    claims: report.claims.slice(0, 10),
    evidence: report.evidence.slice(0, 10),
    artifacts: [],
    limits: report.limits.slice(0, 6),
    openQuestions: report.gaps.slice(0, 6),
    href: `/research/swarm/${runId}`,
    account,
  };
}
