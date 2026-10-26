import type pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  CredentialKind,
  MonthlyBudget,
  BudgetAppend,
  Budget,
} from "@reinlab/contracts";
import { ApiFailure, denied } from "../api/errors";
import { canonical } from "../api/context";
import { appendEvent, requireDossier } from "../ledger";
import {
  micros as inputMicros,
  totalMicros as micros,
  decimal,
  cny,
} from "./money";
import {
  quantityColumns,
  quantity,
  dimensions,
  unallocatedQuantity,
  fitsQuantities,
  growQuantity,
  limit,
} from "./quantities";

const uuid = z.string().uuid(),
  counter = z.number().int().nonnegative().max(2147483647);
export const currentPeriod = () =>
  new Date(Date.now()).toISOString().slice(0, 7) + "-01";
export async function monthlyBudgetSnapshot(client: pg.PoolClient) {
  const period = currentPeriod(),
    result = await client.query(
      `select monthly_budget_cny::text cap,
    (select coalesce(sum(amount_cny),0)::text from budget_allocation where parent_id is null and period=$1) allocated,
    (select coalesce(sum(spent_cny),0)::text from budget_allocation where parent_id is null and period=$1) spent,
    (select coalesce(sum(greatest(amount_cny,spent_cny)),0)::text from budget_allocation where parent_id is null and period=$1) occupied,
    (select count(*)::int from budget_hold where state='unpriced' and period=$1) unknown,
    (select coalesce(sum(actual_quota),0)::text from budget_hold where period=$1) quota,
    (select coalesce(sum(actual_gpu_seconds),0)::text from budget_hold where period=$1) gpu
    from account where id=nullif(current_setting('app.account_id',true),'')::uuid`,
      [period],
    );
  if (!result.rowCount) throw denied();
  const row = result.rows[0],
    available = micros(row.cap) - micros(row.occupied);
  return MonthlyBudget.parse({
    period,
    monthlyLimitCny: cny(row.cap),
    allocatedCny: cny(row.allocated),
    spentKnownCny: cny(row.spent),
    availableCny: decimal(available > 0n ? available : 0n),
    unpricedCount: row.unknown,
    quotaRuns: Number(row.quota),
    gpuSeconds: Number(row.gpu),
  });
}
const allocationColumns =
  "id,account_id,dossier_id,parent_id,run_id,delegation_id,period::text,amount_cny::text,spent_cny::text," +
  quantityColumns;
export async function lockBudget(client: pg.PoolClient, accountId: string) {
  const context = await client.query(
    "select current_setting('app.account_id',true) id",
  );
  if (context.rows[0].id !== accountId) throw denied();
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    "ledger:" + accountId,
  ]);
}
async function monthlyRemaining(
  client: pg.PoolClient,
  period: string,
): Promise<bigint> {
  const budget = await client.query(
    "select monthly_budget_cny::text budget from account where id=nullif(current_setting('app.account_id',true),'')::uuid",
  );
  if (!budget.rowCount) throw denied();
  const used = await client.query(
    "select coalesce(sum(greatest(amount_cny,spent_cny)),0)::text used from budget_allocation where parent_id is null and period=$1",
    [period],
  );
  return micros(budget.rows[0].budget) - micros(used.rows[0].used);
}
async function allocation(client: pg.PoolClient, id: string) {
  const rows = await client.query(
    `select ${allocationColumns} from budget_allocation where id=$1`,
    [id],
  );
  if (!rows.rowCount) throw denied();
  return rows.rows[0];
}
async function unallocated(
  client: pg.PoolClient,
  node: Record<string, any>,
): Promise<bigint> {
  const result = await client.query(
    `select
    (select coalesce(sum(greatest(amount_cny-spent_cny,0)),0)::text from budget_allocation where parent_id=$1) children,
    (select coalesce(sum(maximum_cny),0)::text from budget_hold where allocation_id=$1 and state in ('reserved','unpriced')) direct`,
    [node.id],
  );
  return (
    micros(node.amount_cny) -
    micros(node.spent_cny) -
    micros(result.rows[0].children) -
    micros(result.rows[0].direct)
  );
}
async function ancestors(client: pg.PoolClient, id: string) {
  return (
    await client.query(
      `with recursive path as (select *,0 depth from budget_allocation where id=$1 union all select p.*,c.depth+1 from budget_allocation p join path c on p.id=c.parent_id where c.depth<32) select ${allocationColumns},depth from path order by depth`,
      [id],
    )
  ).rows;
}
const allocationQuantity = z.number().int().nonnegative().safe();
const AllocationInput = z
  .object({
    dossierId: uuid,
    amountCny: z.union([z.string(), z.number()]),
    parentId: uuid.optional(),
    runId: uuid.optional(),
    delegationId: uuid.optional(),
    quotaRuns: allocationQuantity.optional(),
    gpuSeconds: allocationQuantity.optional(),
  })
  .strict();
export async function allocateBudget(
  client: pg.PoolClient,
  accountId: string,
  raw: z.input<typeof AllocationInput>,
) {
  const input = AllocationInput.parse(raw),
    amount = inputMicros(input.amountCny),
    period = currentPeriod();
  if (amount <= 0n)
    throw new ApiFailure("INVALID_INPUT", 400, "划拨金额必须大于零。");
  await lockBudget(client, accountId);
  await requireDossier(client, input.dossierId);
  if (input.runId && input.delegationId)
    throw new ApiFailure("SCOPE_DENIED", 403, "一个划拨只能对应一个目标。");
  let quotaCap: number | null = input.quotaRuns ?? null,
    gpuCap: number | null = input.gpuSeconds ?? null;
  if (input.runId) {
    const row = await runRow(client, input.runId);
    quotaCap = quantity(input.quotaRuns ?? row.quota_limit);
    gpuCap = quantity(input.gpuSeconds ?? row.gpu_limit);
    if (quotaCap > row.quota_limit || gpuCap > row.gpu_limit) throw denied();
  }
  if (input.delegationId) {
    const row = await client.query(
      "select request from delegation where id=$1",
      [input.delegationId],
    );
    if (!row.rowCount) throw denied();
    const parsed = Budget.safeParse(
      row.rows[0].request.budget ?? { cny: Number(decimal(amount)) },
    );
    if (!parsed.success)
      throw new ApiFailure("INVALID_INPUT", 400, "委托预算字段无效。");
    const q = parsed.data.quotaRuns ?? 0,
      g = (parsed.data.gpuMinutes ?? 0) * 60;
    quantity(g);
    quotaCap = input.quotaRuns ?? q;
    gpuCap = input.gpuSeconds ?? g;
    if (quotaCap > q || gpuCap > g) throw denied();
  }
  const old = await client.query(
    `select ${allocationColumns} from budget_allocation where period=$1 and ${input.runId ? "run_id=$2" : input.delegationId ? "delegation_id=$2" : "dossier_id=$2 and parent_id is null"}`,
    [period, input.runId ?? input.delegationId ?? input.dossierId],
  );
  if (old.rowCount) {
    const row = old.rows[0];
    if (
      row.dossier_id !== input.dossierId ||
      row.parent_id !== (input.parentId ?? null) ||
      micros(row.amount_cny) !== amount ||
      limit(row, "quota") !== quotaCap ||
      limit(row, "gpu") !== gpuCap
    )
      throw new ApiFailure(
        "IDEMPOTENCY_CONFLICT",
        409,
        "该目标已存在不同的预算划拨。",
      );
    return row;
  }
  if (input.parentId) {
    const parent = await allocation(client, input.parentId);
    if (parent.period !== period)
      throw new ApiFailure("BUDGET_PERIOD_EXPIRED", 409, "父预算不属于本月。");
    const path = await ancestors(client, parent.id);
    if (path.length >= 32 || path.at(-1)?.parent_id)
      throw new ApiFailure(
        "BUDGET_DEPTH_EXCEEDED",
        409,
        "预算来源链超过可安全处理的层数。",
      );
    if (!input.runId && !input.delegationId)
      throw new ApiFailure("SCOPE_DENIED", 403, "子划拨必须绑定运行或委托。");
    if (input.runId) {
      const run = await client.query(
        "select dossier_id,parent_run_id from run where id=$1",
        [input.runId],
      );
      if (!run.rowCount || run.rows[0].dossier_id !== input.dossierId)
        throw denied();
      if (parent.run_id) {
        if (
          run.rows[0].parent_run_id !== parent.run_id ||
          parent.dossier_id !== input.dossierId
        )
          throw denied();
      } else if (parent.delegation_id) {
        const link = await client.query(
          "select to_dossier,to_run from delegation where id=$1",
          [parent.delegation_id],
        );
        if (
          !link.rowCount ||
          link.rows[0].to_dossier !== input.dossierId ||
          (link.rows[0].to_run && link.rows[0].to_run !== input.runId)
        )
          throw denied();
      } else if (
        parent.dossier_id !== input.dossierId ||
        run.rows[0].parent_run_id
      )
        throw denied();
    } else {
      const link = await client.query(
        "select from_dossier,from_run from delegation where id=$1",
        [input.delegationId],
      );
      if (
        !link.rowCount ||
        link.rows[0].from_dossier !== input.dossierId ||
        parent.dossier_id !== input.dossierId ||
        (link.rows[0].from_run ?? null) !== (parent.run_id ?? null)
      )
        throw denied();
    }
    if (amount > (await unallocated(client, parent)))
      throw new ApiFailure(
        "BUDGET_EXCEEDED",
        409,
        "父预算扣除在途费用后余额不足。",
      );
    for (const dimension of dimensions) {
      const available = await unallocatedQuantity(client, parent, dimension),
        requested = dimension === "quota" ? quotaCap : gpuCap;
      if (requested === null || (available !== null && requested > available))
        throw new ApiFailure(
          "BUDGET_EXCEEDED",
          409,
          "父会员额度或GPU预算不足。",
        );
    }
  } else {
    if (input.runId || input.delegationId)
      throw new ApiFailure("SCOPE_DENIED", 403, "运行或委托必须从父预算划拨。");
    if (amount > (await monthlyRemaining(client, period)))
      throw new ApiFailure("BUDGET_EXCEEDED", 409, "账户月预算不足。");
  }
  const id = randomUUID(),
    created = await client.query(
      `insert into budget_allocation(id,account_id,dossier_id,parent_id,run_id,delegation_id,period,amount_cny,quota_limit,gpu_limit) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${allocationColumns}`,
      [
        id,
        accountId,
        input.dossierId,
        input.parentId ?? null,
        input.runId ?? null,
        input.delegationId ?? null,
        period,
        decimal(amount),
        quotaCap,
        gpuCap,
      ],
    );
  await appendEvent(client, accountId, {
    dossierId: input.dossierId,
    runId: input.runId ?? null,
    kind: "gate",
    action: "budget_allocated",
    payload: {
      allocationId: id,
      parentId: input.parentId ?? null,
      amountCny: decimal(amount),
      quotaRuns: quotaCap,
      gpuSeconds: gpuCap,
      period,
      accountReservation: !input.parentId,
    },
    dedupeKey: "allocation:" + id,
  });
  return created.rows[0];
}
async function growPath(
  client: pg.PoolClient,
  id: string,
  delta: bigint,
  changedRuns?: Set<string>,
) {
  const touched = changedRuns ?? new Set<string>();
  const node = await allocation(client, id),
    amount = micros(node.amount_cny),
    spent = micros(node.spent_cny);
  micros(decimal(amount + delta));
  if (node.parent_id) {
    const parent = await allocation(client, node.parent_id),
      available = await unallocated(client, parent);
    const before = amount > spent ? amount - spent : 0n,
      after = amount + delta > spent ? amount + delta - spent : 0n,
      needed = after - before - available;
    if (needed > 0n) await growPath(client, parent.id, needed, touched);
  } else {
    const before = amount > spent ? amount : spent,
      after = amount + delta > spent ? amount + delta : spent;
    if (after - before > (await monthlyRemaining(client, node.period)))
      throw new ApiFailure(
        "BUDGET_EXCEEDED",
        409,
        "账户月预算不足，无法追加。",
      );
  }
  await client.query(
    "update budget_allocation set amount_cny=amount_cny+$2 where id=$1",
    [id, decimal(delta)],
  );
  if (node.run_id) {
    await client.query("update run set budget_cny=budget_cny+$2 where id=$1", [
      node.run_id,
      decimal(delta),
    ]);
    touched.add(node.run_id);
  }
  if (node.delegation_id)
    await client.query(
      "update delegation set budget_cny=budget_cny+$2,request=jsonb_set(request,'{budget}',coalesce(request->'budget','{}')||jsonb_build_object('cny',budget_cny+$2),true) where id=$1",
      [node.delegation_id, decimal(delta)],
    );
  await appendEvent(client, node.account_id, {
    dossierId: node.dossier_id,
    runId: node.run_id,
    kind: "gate",
    action: "budget_allocation_increased",
    payload: {
      allocationId: node.id,
      parentId: node.parent_id,
      addedCny: decimal(delta),
      amountCny: decimal(amount + delta),
      period: node.period,
    },
    dedupeKey: "allocation-grow:" + randomUUID(),
  });
  if (!changedRuns && touched.size)
    await client.query(
      "update run set budget_revision=budget_revision+1 where id=any($1::uuid[])",
      [[...touched]],
    );
}
export async function prepareDossierBudget(
  client: pg.PoolClient,
  accountId: string,
  dossierId: string,
  amount: string,
) {
  await lockBudget(client, accountId);
  const root = await client.query(
    `select ${allocationColumns} from budget_allocation where dossier_id=$1 and parent_id is null and period=$2`,
    [dossierId, currentPeriod()],
  );
  if (!root.rowCount)
    return allocateBudget(client, accountId, { dossierId, amountCny: amount });
  const available = await unallocated(client, root.rows[0]),
    needed = micros(amount) - available;
  if (needed > 0n) await growPath(client, root.rows[0].id, needed);
  return allocation(client, root.rows[0].id);
}
async function runRow(client: pg.PoolClient, id: string) {
  if (!uuid.safeParse(id).success) throw denied();
  const rows = await client.query("select * from run where id=$1 for update", [
    id,
  ]);
  if (!rows.rowCount) throw denied();
  const row = rows.rows[0];
  for (const key of ["quota_runs", "gpu_seconds", "quota_limit", "gpu_limit"]) {
    row[key] = Number(row[key]);
    if (!Number.isSafeInteger(row[key]) || row[key] < 0)
      throw new ApiFailure(
        "USAGE_RANGE_INVALID",
        503,
        "用量累计超出可安全处理的范围，需要先对账。",
      );
  }
  return row;
}
async function fitsAllocationPath(
  client: pg.PoolClient,
  id: string,
  amount: bigint,
  quota = 0,
  gpu = 0,
): Promise<boolean> {
  const path = await ancestors(client, id);
  if (
    !path.length ||
    path.at(-1).parent_id ||
    (await monthlyRemaining(client, currentPeriod())) < 0n
  )
    return false;
  const states = await client.query(
    "select state from run where id=any($1::uuid[])",
    [path.filter((p) => p.run_id).map((p) => p.run_id)],
  );
  if (states.rows.some((r) => !["running", "waiting"].includes(r.state)))
    return false;
  for (let index = 0; index < path.length; index++) {
    const node = path[index],
      childOnPath = index ? path[index - 1].id : null;
    const reserved = await client.query(
      "select coalesce(sum(greatest(amount_cny-spent_cny,0)),0)::text held from budget_allocation where parent_id=$1 and($2::uuid is null or id<>$2)",
      [node.id, childOnPath],
    );
    const pending = await client.query(
      `with recursive branch as (select id from budget_allocation where id=$2::uuid union all select a.id from budget_allocation a join branch b on a.parent_id=b.id) select coalesce(sum(maximum_cny),0)::text held from budget_hold where state in ('reserved','unpriced') and(allocation_id=$1 or allocation_id in(select id from branch))`,
      [node.id, childOnPath],
    );
    if (
      micros(node.spent_cny) +
        micros(reserved.rows[0].held) +
        micros(pending.rows[0].held) +
        amount >
      micros(node.amount_cny)
    )
      return false;
  }
  return fitsQuantities(client, path, { quota, gpu });
}
async function pause(
  client: pg.PoolClient,
  accountId: string,
  run: Record<string, any>,
  reason: string,
) {
  if (["completed", "failed", "cancelled"].includes(run.state)) return;
  await client.query(
    "update run set budget_paused_from=case when state<>'paused_budget' then state else budget_paused_from end,state='paused_budget' where id=$1",
    [run.id],
  );
  if (run.budget_paused_revision === run.budget_revision) return;
  await client.query(
    "update run set budget_paused_revision=budget_revision where id=$1",
    [run.id],
  );
  const explanation: Record<string, string> = {
    USAGE_UNKNOWN: "实际费用尚未回报，需要先对账。",
    BUDGET_PERIOD_EXPIRED: "预算已跨月，需要你确认本月额度。",
    RESERVATION_EXCEEDS_REMAINING: "本次工具的费用上限超过剩余额度。",
    RESERVATION_OVERRUN: "实际费用或用量超过工具预留，需要先核对。",
    BUDGET_EXCEEDED: "已达到本次运行的费用或额度上限。",
  };
  await client.query(
    "insert into approval(account_id,run_id,kind,title,effects,risk) values($1,$2,'budget','预算门禁：等待你决定',$3::jsonb,'write')",
    [
      accountId,
      run.id,
      JSON.stringify([
        "暂停后续工具；可追加预算、下结论或终止。",
        explanation[reason] ?? "需要重新确认预算。",
      ]),
    ],
  );
  await appendEvent(client, accountId, {
    dossierId: run.dossier_id,
    runId: run.id,
    kind: "gate",
    action: "budget_paused",
    payload: {
      reason,
      budgetCny: run.budget_cny,
      spentCny: run.spent_cny,
      quotaRuns: run.quota_runs,
      quotaLimit: run.quota_limit,
      gpuSeconds: run.gpu_seconds,
      gpuLimit: run.gpu_limit,
      revision: run.budget_revision,
    },
    dedupeKey: "budget-pause:" + run.id + ":" + run.budget_revision,
  });
}
const HoldInput = z
  .object({
    runId: uuid,
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[-A-Za-z0-9_.:]+$/),
    maximumCny: z.union([z.string(), z.number()]),
    maximumQuota: counter.default(0),
    maximumGpuSeconds: counter.default(0),
  })
  .strict();
export async function authorizeTool(
  client: pg.PoolClient,
  accountId: string,
  raw: z.input<typeof HoldInput>,
): Promise<{ allowed: boolean; holdId?: string; reason?: string }> {
  const input = HoldInput.parse(raw),
    amount = inputMicros(input.maximumCny);
  if (!amount && !input.maximumQuota && !input.maximumGpuSeconds)
    throw new ApiFailure(
      "INVALID_INPUT",
      400,
      "计费工具需要明确的费用或额度上限。",
    );
  await lockBudget(client, accountId);
  const run = await runRow(client, input.runId);
  const existing = await client.query(
    "select * from budget_hold where run_id=$1 and request_id=$2",
    [run.id, input.requestId],
  );
  if (existing.rowCount) {
    const old = existing.rows[0];
    if (
      micros(old.maximum_cny) !== amount ||
      old.maximum_quota !== input.maximumQuota ||
      old.maximum_gpu_seconds !== input.maximumGpuSeconds
    )
      throw new ApiFailure(
        "IDEMPOTENCY_CONFLICT",
        409,
        "费用保留请求内容不同。",
      );
    return old.state === "reserved"
      ? { allowed: true, holdId: old.id }
      : {
          allowed: false,
          holdId: old.id,
          reason:
            old.state === "unpriced" ? "USAGE_UNKNOWN" : "ALREADY_SETTLED",
        };
  }
  if (run.state !== "running")
    return {
      allowed: false,
      reason:
        run.state === "paused_budget" ? "BUDGET_EXCEEDED" : "RUN_NOT_RUNNING",
    };
  const nodes = await client.query(
    `select ${allocationColumns} from budget_allocation where run_id=$1 order by period desc limit 1`,
    [run.id],
  );
  if (!nodes.rowCount)
    throw new ApiFailure("BUDGET_NOT_ALLOCATED", 409, "运行还没有预算划拨。");
  const node = nodes.rows[0];
  if (node.period !== currentPeriod()) {
    await pause(client, accountId, run, "BUDGET_PERIOD_EXPIRED");
    return { allowed: false, reason: "BUDGET_PERIOD_EXPIRED" };
  }
  const held = await client.query(
    "select coalesce(sum(maximum_cny),0)::text cny,coalesce(sum(maximum_quota),0)::text quota,coalesce(sum(maximum_gpu_seconds),0)::text gpu from budget_hold where run_id=$1 and state in ('reserved','unpriced')",
    [run.id],
  );
  const pending = {
    cny: held.rows[0].cny,
    quota: Number(held.rows[0].quota),
    gpu: Number(held.rows[0].gpu),
  };
  if (
    !Number.isSafeInteger(pending.quota) ||
    !Number.isSafeInteger(pending.gpu)
  )
    throw new ApiFailure(
      "USAGE_RANGE_INVALID",
      503,
      "费用保留用量需要先对账。",
    );
  if (
    micros(run.spent_cny) + micros(pending.cny) + amount >
      micros(run.budget_cny) ||
    run.quota_runs + pending.quota + input.maximumQuota > run.quota_limit ||
    run.gpu_seconds + pending.gpu + input.maximumGpuSeconds > run.gpu_limit ||
    !(await fitsAllocationPath(
      client,
      node.id,
      amount,
      input.maximumQuota,
      input.maximumGpuSeconds,
    ))
  ) {
    await pause(client, accountId, run, "RESERVATION_EXCEEDS_REMAINING");
    return { allowed: false, reason: "BUDGET_EXCEEDED" };
  }
  const id = randomUUID();
  await client.query(
    "insert into budget_hold(id,account_id,dossier_id,run_id,allocation_id,period,request_id,maximum_cny,maximum_quota,maximum_gpu_seconds,state) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved')",
    [
      id,
      accountId,
      run.dossier_id,
      run.id,
      node.id,
      node.period,
      input.requestId,
      decimal(amount),
      input.maximumQuota,
      input.maximumGpuSeconds,
    ],
  );
  return { allowed: true, holdId: id };
}
const Settlement = z
  .object({
    holdId: uuid,
    costCny: z.union([z.string(), z.number(), z.null()]),
    credentialKind: CredentialKind,
    quota: counter.default(0),
    gpuSeconds: counter.default(0),
  })
  .strict();
export async function settleTool(
  client: pg.PoolClient,
  accountId: string,
  raw: z.input<typeof Settlement>,
) {
  const input = Settlement.parse(raw),
    amount = input.costCny === null ? null : inputMicros(input.costCny);
  return settleAmount(client, accountId, input, amount, false);
}
// The mode is private: public tool inputs cannot select a summary-only settlement.
async function settleAmount(
  client: pg.PoolClient,
  accountId: string,
  input: z.output<typeof Settlement>,
  amount: bigint | null,
  observed: boolean,
) {
  const content = {
      ...input,
      costCny: amount === null ? null : decimal(amount),
    },
    hash = createHash("sha256")
      .update(
        canonical(observed ? { ...content, source: "os_usage" } : content),
      )
      .digest("hex");
  await lockBudget(client, accountId);
  const rows = await client.query(
    "select * from budget_hold where id=$1 for update",
    [input.holdId],
  );
  if (!rows.rowCount) throw denied();
  const hold = rows.rows[0],
    run = await runRow(client, hold.run_id);
  if (hold.settlement_hash === hash) return hold.receipt;
  if (hold.state === "settled" || hold.state === "cancelled")
    throw new ApiFailure(
      "IDEMPOTENCY_CONFLICT",
      409,
      "费用结算已完成且内容不同。",
    );
  const reconciled = hold.state === "unpriced";
  if (reconciled && amount === null)
    throw new ApiFailure(
      "IDEMPOTENCY_CONFLICT",
      409,
      "未知费用回报内容不同，需要真实对账。",
    );
  const costDelta = amount === null ? 0n : amount - micros(hold.known_cost_cny ?? '0');
  if (costDelta < 0n) throw new ApiFailure('OBSERVED_USAGE_INVALID',409,'已入账的已知费用不能减少。');
  const quotaDelta = input.quota - hold.actual_quota,
    gpuDelta = input.gpuSeconds - hold.actual_gpu_seconds;
  if (quotaDelta < 0 || gpuDelta < 0)
    throw new ApiFailure("IDEMPOTENCY_CONFLICT", 409, "已记录的用量不能减少。");
  const unknown = amount === null && input.credentialKind === "api_key";
  const path = await ancestors(client, hold.allocation_id),
    runIds = path.filter((p) => p.run_id).map((p) => p.run_id);
  if (observed) {
    // SUM is allowed to exceed a single cost-event limit, but never numeric(18,6).
    try {
      if (!path.length || path.at(-1).parent_id || !runIds.includes(run.id))
        throw new Error("invalid allocation path");
      for (const node of path)
        micros(decimal(micros(node.spent_cny) + costDelta));
      for (const id of runIds) {
        const ancestor = await runRow(client, id);
        micros(decimal(micros(ancestor.spent_cny) + costDelta));
      }
    } catch {
      throw new ApiFailure(
        "USAGE_RANGE_INVALID",
        503,
        "观察费用累计超出可安全处理的范围，需要先对账。",
      );
    }
  }
  await client.query(
    "update budget_allocation set spent_cny=spent_cny+$2,quota_spent=quota_spent+$3,gpu_spent=gpu_spent+$4 where id=any($1::uuid[])",
    [path.map((p) => p.id), decimal(costDelta), quotaDelta, gpuDelta],
  );
  await client.query(
    "update run set spent_cny=spent_cny+$2,quota_runs=quota_runs+$3,gpu_seconds=gpu_seconds+$4 where id=any($1::uuid[])",
    [runIds, decimal(costDelta), quotaDelta, gpuDelta],
  );
  const now = await runRow(client, run.id),
    excess =
      amount !== null && amount > micros(hold.maximum_cny)
        ? amount - micros(hold.maximum_cny)
        : 0n;
  const overrun =
    micros(now.spent_cny) > micros(now.budget_cny)
      ? micros(now.spent_cny) - micros(now.budget_cny)
      : 0n;
  const event = await appendEvent(client, accountId, {
    dossierId: run.dossier_id,
    runId: run.id,
    kind: observed ? "gate" : "cost",
    action: observed
      ? reconciled
        ? "os_usage_reconciled"
        : "os_usage_settled"
      : reconciled
        ? "usage_reconciled"
        : "usage_reported",
    costCny: observed || amount === null ? null : Number(decimal(amount)),
    quota: quotaDelta,
    gpuSeconds: gpuDelta,
    credentialKind: input.credentialKind,
    payload: {
      ...(observed
        ? {
            source: "os_usage",
            actualCostCny: amount === null ? null : decimal(amount),
          }
        : {}),
      holdId: hold.id,
      requestId: hold.request_id,
      reconciled,
      overrunCny: decimal(overrun),
      reservationExcessCny: decimal(excess),
      reason:
        excess > 0n ||
        quotaDelta > hold.maximum_quota ||
        gpuDelta > hold.maximum_gpu_seconds
          ? "provider_report_exceeded_reservation"
          : unknown
            ? "provider_usage_missing"
            : "provider_usage_reported",
    },
    dedupeKey:
      (observed ? "os-usage-settlement:" : "usage:") +
      hold.id +
      ":" +
      (reconciled ? "reconciled" : "reported"),
  });
  const receipt = {
    eventSeq: event.seq,
    settled: !unknown,
    costCny: amount === null ? null : decimal(amount),
    reconciled,
  };
  await client.query(
    "update budget_hold set state=$2,actual_cny=$3,actual_quota=$4,actual_gpu_seconds=$5,settlement_hash=$6,receipt=$7::jsonb,event_seq=$8 where id=$1",
    [
      hold.id,
      unknown ? "unpriced" : "settled",
      amount === null ? null : decimal(amount),
      input.quota,
      input.gpuSeconds,
      hash,
      JSON.stringify(receipt),
      event.seq,
    ],
  );
  if (amount !== null) await client.query('update budget_hold set known_cost_cny=$2 where id=$1',[hold.id,decimal(amount)]);
  const reservationOverrun =
    excess > 0n ||
    input.quota > hold.maximum_quota ||
    input.gpuSeconds > hold.maximum_gpu_seconds;
  for (const id of runIds) {
    const observed = await runRow(client, id),
      nearLimit =
        micros(observed.spent_cny) * 100n >=
          micros(observed.budget_cny) * 80n ||
        (observed.quota_limit > 0 &&
          observed.quota_runs * 100 >= observed.quota_limit * 80) ||
        (observed.gpu_limit > 0 &&
          observed.gpu_seconds * 100 >= observed.gpu_limit * 80);
    if (
      !unknown &&
      nearLimit &&
      observed.budget_warned_revision !== observed.budget_revision
    ) {
      await client.query(
        "update run set budget_warned_revision=budget_revision where id=$1",
        [id],
      );
      await appendEvent(client, accountId, {
        dossierId: observed.dossier_id,
        runId: id,
        kind: "gate",
        action: "budget_warning",
        payload: {
          threshold: 80,
          spentCny: observed.spent_cny,
          budgetCny: observed.budget_cny,
          quotaRuns: observed.quota_runs,
          quotaLimit: observed.quota_limit,
          gpuSeconds: observed.gpu_seconds,
          gpuLimit: observed.gpu_limit,
        },
        dedupeKey: "budget-warning:" + id + ":" + observed.budget_revision,
      });
    }
    if (
      unknown ||
      reservationOverrun ||
      micros(observed.spent_cny) >= micros(observed.budget_cny) ||
      (observed.quota_runs > 0 &&
        observed.quota_runs >= observed.quota_limit) ||
      (observed.gpu_seconds > 0 && observed.gpu_seconds >= observed.gpu_limit)
    )
      await pause(
        client,
        accountId,
        observed,
        unknown
          ? "USAGE_UNKNOWN"
          : reservationOverrun
            ? "RESERVATION_OVERRUN"
            : "BUDGET_EXCEEDED",
      );
  }
  return receipt;
}
/** Internal control-plane settlement. Amounts and hold identity come only from trusted rows. */
export async function settleObservedRun(
  client: pg.PoolClient,
  accountId: string,
  runId: string,
  complete: boolean,
) {
  if (typeof complete !== "boolean" || !uuid.safeParse(runId).success)
    throw new ApiFailure(
      "INVALID_INPUT",
      400,
      "观察结算需要运行身份与明确的完整状态。",
    );
  await lockBudget(client, accountId);
  const bindings = await client.query(
    "select * from os_binding where account_id=$1 and run_id=$2 for update",
    [accountId, runId],
  );
  if (!bindings.rowCount) throw denied();
  const binding = bindings.rows[0],
    run = await runRow(client, runId);
  if (
    binding.phase !== "accepted" ||
    !binding.hold_id ||
    run.state === "queued"
  )
    throw new ApiFailure(
      "OBSERVED_RUN_NOT_READY",
      409,
      "运行尚无已接受的费用预留绑定。",
    );
  const holds = await client.query(
    "select * from budget_hold where id=$1 for update",
    [binding.hold_id],
  );
  const hold = holds.rows[0];
  if (
    !hold ||
    hold.account_id !== accountId ||
    hold.run_id !== runId ||
    hold.dossier_id !== binding.dossier_id ||
    run.dossier_id !== binding.dossier_id
  )
    throw denied();
  // Do not filter invalid rows out: a missing or foreign ledger event must fail closed.
  const totals = await client.query(
    `select count(*)::text usage_count,count(distinct u.event_seq)::text event_count,
    count(*) filter(where u.cost_cny is null)::text unknown_count,sum(u.cost_cny)::text amount,
    coalesce(bool_or(e.seq is null or u.session_id<>$3 or u.dossier_id<>$4 or
      e.account_id<>u.account_id or e.dossier_id is distinct from u.dossier_id or
      e.run_id is distinct from u.run_id or e.kind<>'cost' or e.cost_cny is distinct from u.cost_cny),false) invalid
    from os_usage u left join event e on e.seq=u.event_seq where u.account_id=$1 and u.run_id=$2`,
    [accountId, runId, binding.session_id, binding.dossier_id],
  );
  const total = totals.rows[0];
  const ledger = await client.query(
    "select count(*)::text count from event where account_id=$1 and run_id=$2 and kind='cost'",
    [accountId, runId],
  );
  if (
    total.invalid ||
    total.usage_count !== total.event_count ||
    total.event_count !== ledger.rows[0].count
  )
    throw new ApiFailure(
      "OBSERVED_USAGE_INVALID",
      409,
      "观察用量与费用明细不一致，需要先对账。",
    );
  let amount: bigint | null = null;
  if (complete && total.usage_count !== "0" && total.unknown_count === "0") {
    try {
      amount = micros(total.amount);
    } catch {
      throw new ApiFailure(
        "USAGE_RANGE_INVALID",
        503,
        "观察费用汇总超出可安全处理的范围，需要先对账。",
      );
    }
    if (amount === 0n) amount = null;
  }
  if (run.role_id === 'research-clarify' && amount === null && total.amount !== null && micros(total.amount) > 0n) {
    const known = micros(total.amount), booked = micros(hold.known_cost_cny ?? '0');
    if (known < booked) throw new ApiFailure('OBSERVED_USAGE_INVALID',409,'已知费用记录不完整，不能减少累计。');
    const delta = known - booked;
    if (delta > 0n) {
      const path = await ancestors(client, hold.allocation_id);
      await client.query('update budget_allocation set spent_cny=spent_cny+$2 where id=any($1::uuid[])',[path.map(p=>p.id),decimal(delta)]);
      await client.query('update run set spent_cny=spent_cny+$2 where id=any($1::uuid[])',[path.filter(p=>p.run_id).map(p=>p.run_id),decimal(delta)]);
      await client.query('update budget_hold set known_cost_cny=$2 where id=$1',[hold.id,decimal(known)]);
      await appendEvent(client,accountId,{dossierId:run.dossier_id,runId,kind:'gate',action:'known_usage_booked',payload:{knownCny:decimal(known),remainingUsage:'unknown'},dedupeKey:'known-usage:'+hold.id+':'+decimal(known)});
    }
  }
  if (amount === null && hold.state === 'unpriced' && !hold.settlement_hash) {
    const pending = await appendEvent(client,accountId,{dossierId:run.dossier_id,runId,kind:'gate',action:'os_usage_pending',payload:{holdId:hold.id,reason:'usage_unknown'},dedupeKey:'os-usage-pending:'+hold.id});
    return {eventSeq:pending.seq,settled:false,costCny:null,reconciled:false};
  }
  return settleAmount(
    client,
    accountId,
    {
      holdId: hold.id,
      costCny: amount === null ? null : decimal(amount),
      credentialKind: "api_key",
      quota: 0,
      gpuSeconds: 0,
    },
    amount,
    true,
  );
}
export async function increaseRunBudget(
  client: pg.PoolClient,
  accountId: string,
  runId: string,
  rawAmount: unknown,
) {
  const addition =
    typeof rawAmount === "object" && rawAmount !== null
      ? BudgetAppend.parse(rawAmount)
      : { cny: rawAmount, quotaRuns: 0, gpuMinutes: 0 };
  const delta = inputMicros(addition.cny ?? 0),
    quotaDelta = addition.quotaRuns ?? 0,
    gpuDelta = (addition.gpuMinutes ?? 0) * 60;
  if (
    (delta <= 0n && !quotaDelta && !gpuDelta) ||
    !Number.isSafeInteger(gpuDelta)
  )
    throw new ApiFailure(
      "INVALID_INPUT",
      400,
      "需要追加正金额、整数额度或可换算为整数秒的GPU预算。",
    );
  await lockBudget(client, accountId);
  const run = await runRow(client, runId);
  if (
    !Number.isSafeInteger(run.quota_limit + quotaDelta) ||
    !Number.isSafeInteger(run.gpu_limit + gpuDelta)
  )
    throw new ApiFailure(
      "INVALID_INPUT",
      400,
      "额度或GPU预算超过可安全处理的范围。",
    );
  if (["completed", "failed", "cancelled"].includes(run.state))
    throw new ApiFailure("RUN_TERMINAL", 409, "运行已结束，不能追加预算。");
  const nodes = await client.query(
    `select ${allocationColumns} from budget_allocation where run_id=$1 order by period desc limit 1`,
    [run.id],
  );
  if (!nodes.rowCount)
    throw new ApiFailure("BUDGET_NOT_ALLOCATED", 409, "运行尚无预算划拨。");
  const node = nodes.rows[0];
  if (node.period !== currentPeriod()) {
    if (delta <= 0n)
      throw new ApiFailure(
        "BUDGET_PERIOD_EXPIRED",
        409,
        "确认新月预算时请同时指定本月人民币上限。",
      );
    const inflight = await client.query(
      `with recursive tree as (select id from budget_allocation where id=$1 union all select a.id from budget_allocation a join tree p on a.parent_id=p.id) select id from budget_hold where allocation_id in(select id from tree) and state in ('reserved','unpriced') limit 1`,
      [node.id],
    );
    if (inflight.rowCount)
      throw new ApiFailure(
        "USAGE_PENDING",
        409,
        "请先等待旧用量结算或对账，再确认新月预算。",
      );
    const previousParent = await allocation(client, node.parent_id);
    let parent: Record<string, any>;
    const touched = new Set<string>();
    if (previousParent.run_id || previousParent.delegation_id) {
      const found = await client.query(
        `select ${allocationColumns} from budget_allocation where period=$1 and ${previousParent.run_id ? "run_id" : "delegation_id"}=$2`,
        [
          currentPeriod(),
          previousParent.run_id ?? previousParent.delegation_id,
        ],
      );
      if (!found.rowCount)
        throw new ApiFailure(
          "BUDGET_PARENT_RECONFIRM",
          409,
          "请先确认上级运行或委托的本月预算。",
        );
      parent = found.rows[0];
      const needed = delta - (await unallocated(client, parent));
      if (needed > 0n) await growPath(client, parent.id, needed, touched);
    } else
      parent = await prepareDossierBudget(
        client,
        accountId,
        run.dossier_id,
        decimal(delta),
      );
    for (const dimension of dimensions) {
      const available = await unallocatedQuantity(client, parent, dimension),
        requested = dimension === "quota" ? quotaDelta : gpuDelta;
      if (available !== null && requested > available)
        await growQuantity(
          client,
          parent.id,
          dimension,
          requested - available,
          touched,
        );
    }
    if (touched.size)
      await client.query(
        "update run set budget_revision=budget_revision+1 where id=any($1::uuid[])",
        [[...touched]],
      );
    const budget = micros(run.spent_cny) + delta;
    micros(decimal(budget));
    const state =
      run.state === "paused_budget"
        ? (run.budget_paused_from ?? "running")
        : run.state;
    await client.query(
      "update run set budget_cny=$2,quota_limit=quota_runs+$3,gpu_limit=gpu_seconds+$4,budget_revision=budget_revision+1,state=$5 where id=$1",
      [run.id, decimal(budget), quotaDelta, gpuDelta, state],
    );
    await allocateBudget(client, accountId, {
      dossierId: run.dossier_id,
      runId: run.id,
      parentId: parent.id,
      amountCny: decimal(delta),
      quotaRuns: quotaDelta,
      gpuSeconds: gpuDelta,
    });
    await client.query(
      "update approval set state='approved',decided_at=now(),decided_scope='once' where run_id=$1 and kind='budget' and state='pending'",
      [run.id],
    );
    await appendEvent(client, accountId, {
      dossierId: run.dossier_id,
      runId: run.id,
      kind: "gate",
      action: "budget_period_renewed",
      risk: "write",
      payload: {
        fromPeriod: node.period,
        toPeriod: currentPeriod(),
        periodBudgetCny: decimal(delta),
        lifetimeBudgetCny: decimal(budget),
        quotaRuns: quotaDelta,
        gpuSeconds: gpuDelta,
      },
      dedupeKey: "budget-renew:" + run.id + ":" + currentPeriod(),
    });
    return {
      id: run.id,
      state,
      budgetCny: decimal(budget),
      spentCny: cny(run.spent_cny),
    };
  }
  const touched = new Set<string>([run.id]);
  if (delta > 0n) await growPath(client, node.id, delta, touched);
  await growQuantity(client, node.id, "quota", quotaDelta, touched);
  await growQuantity(client, node.id, "gpu", gpuDelta, touched);
  const fundingPath = await ancestors(client, node.id);
  for (const source of [...fundingPath].reverse()) {
    if (!source.run_id || source.run_id === run.id) continue;
    const parent = await runRow(client, source.run_id);
    if (parent.state !== "paused_budget") continue;
    const pending = await client.query(
      "with recursive tree as(select id from budget_allocation where id=$1 union all select a.id from budget_allocation a join tree t on a.parent_id=t.id) select id from budget_hold where allocation_id in(select id from tree) and state='unpriced' limit 1",
      [source.id],
    );
    if (
      !pending.rowCount &&
      micros(parent.spent_cny) < micros(parent.budget_cny) &&
      (parent.quota_runs === 0 || parent.quota_runs < parent.quota_limit) &&
      (parent.gpu_seconds === 0 || parent.gpu_seconds < parent.gpu_limit)
    ) {
      touched.add(parent.id);
      await client.query("update run set state=$2 where id=$1", [
        parent.id,
        parent.budget_paused_from ?? "running",
      ]);
      await client.query(
        "update approval set state='approved',decided_at=now(),decided_scope='once' where run_id=$1 and kind='budget' and state='pending'",
        [parent.id],
      );
      await appendEvent(client, accountId, {
        dossierId: parent.dossier_id,
        runId: parent.id,
        kind: "gate",
        action: "budget_ancestor_resumed",
        risk: "write",
        payload: { decidingRunId: run.id },
        dedupeKey: "budget-ancestor-resume:" + randomUUID(),
      });
    }
  }
  await client.query(
    "update run set budget_revision=budget_revision+1 where id=any($1::uuid[])",
    [[...touched]],
  );
  const unknown = await client.query(
    "with recursive tree as (select id from budget_allocation where id=$1 union all select a.id from budget_allocation a join tree p on a.parent_id=p.id) select id from budget_hold where allocation_id in(select id from tree) and state='unpriced' limit 1",
    [node.id],
  );
  const parents = await client.query(
      "select state from run where id=any($1::uuid[])",
      [
        fundingPath
          .filter((p) => p.run_id && p.run_id !== run.id)
          .map((p) => p.run_id),
      ],
    ),
    fundingReady = parents.rows.every((p) =>
      ["running", "waiting"].includes(p.state),
    );
  const remaining = micros(run.budget_cny) + delta - micros(run.spent_cny),
    resume =
      run.state === "paused_budget" &&
      fundingReady &&
      !unknown.rowCount &&
      remaining > 0n &&
      (run.quota_runs === 0 || run.quota_runs < run.quota_limit + quotaDelta) &&
      (run.gpu_seconds === 0 || run.gpu_seconds < run.gpu_limit + gpuDelta);
  await client.query("update run set state=$2 where id=$1", [
    run.id,
    resume ? (run.budget_paused_from ?? "running") : run.state,
  ]);
  if (!unknown.rowCount && (resume || run.state !== "paused_budget"))
    await client.query(
      "update approval set state='approved',decided_at=now(),decided_scope='once' where run_id=$1 and kind='budget' and state='pending'",
      [run.id],
    );
  await appendEvent(client, accountId, {
    dossierId: run.dossier_id,
    runId: run.id,
    kind: "gate",
    action: "budget_increased",
    risk: "write",
    payload: {
      addedCny: decimal(delta),
      addedQuotaRuns: quotaDelta,
      addedGpuSeconds: gpuDelta,
      budgetCny: decimal(micros(run.budget_cny) + delta),
      resumed: resume,
      unreconciled: !!unknown.rowCount,
    },
    dedupeKey: "budget-increase:" + run.id + ":" + (run.budget_revision + 1),
  });
  const updated = await runRow(client, run.id);
  return {
    id: updated.id,
    state: updated.state,
    budgetCny: cny(updated.budget_cny),
    spentCny: cny(updated.spent_cny),
  };
}
