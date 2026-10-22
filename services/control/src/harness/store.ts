import type pg from "pg";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ToolRegistry,
  ToolRegistry as RegistrySchema,
} from "@reinlab/contracts";
import { Database } from "../db/database";
import { ApiFailure, denied } from "../api/errors";
import { canonical } from "../api/context";
import { lockBudget } from "../budget";
import { appendEvent } from "../ledger";
import {
  initialEffective,
  planBenchPatch,
  verifyEffective,
  type EffectiveBench,
} from "./resolver";
import { type LoadedBenchBundle, assertBenchSafety } from "./manifest";
const sha = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
function conflict(): never {
  throw new ApiFailure(
    "BENCH_VERSION_CONFLICT",
    409,
    "同一工作台版本的内容不可变，请提升版本号。",
  );
}
/** Administrative CLI only; application RLS role has no INSERT/UPDATE grant. */
export async function publishBench(
  pool: pg.Pool,
  bundle: LoadedBenchBundle,
  registry: ToolRegistry,
) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      "bench-version:" + bundle.manifest.id + ":" + bundle.manifest.version,
    ]);
    const old = await c.query(
      "select bundle,registry from bench_version where bench=$1 and version=$2",
      [bundle.manifest.id, bundle.manifest.version],
    );
    if (old.rowCount) {
      if (
        canonical(old.rows[0].bundle) !== canonical(bundle) ||
        canonical(old.rows[0].registry) !== canonical(registry)
      )
        conflict();
      await c.query("commit");
      return;
    }
    RegistrySchema.parse(registry);
    assertBenchSafety(bundle.manifest, registry);
    if (
      bundle.registryHash !== sha(registry) ||
      bundle.digest !==
        sha({
          manifest: bundle.manifest,
          referencedHashes: bundle.referencedHashes,
          registryHash: bundle.registryHash,
        })
    )
      conflict();
    for (const [role, definition] of Object.entries(bundle.manifest.roles))
      if (
        createHash("sha256").update(bundle.prompts[role]).digest("hex") !==
        bundle.referencedHashes[definition.prompt]
      )
        conflict();
    for (const definition of Object.values(bundle.manifest.cards)) {
      const schema = bundle.schemas?.[definition.schema];
      if (typeof schema !== "string" || createHash("sha256").update(schema).digest("hex") !== bundle.referencedHashes[definition.schema]) conflict();
    }
    await c.query(
      "insert into bench_version(bench,version,digest,bundle,registry) values($1,$2,$3,$4::jsonb,$5::jsonb)",
      [
        bundle.manifest.id,
        bundle.manifest.version,
        bundle.digest,
        JSON.stringify(bundle),
        JSON.stringify(registry),
      ],
    );
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export class HarnessStore {
  constructor(
    private readonly db: Database,
    readonly bundle: LoadedBenchBundle,
    readonly registry: ToolRegistry,
  ) {}
  private async snapshot(
    c: pg.PoolClient,
    accountId: string,
    value: EffectiveBench,
  ) {
    const m = value.manifest;
    await c.query(
      "insert into bench_effective(account_id,digest,bench,version,bundle_digest,snapshot) values($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing",
      [
        accountId,
        value.digest,
        m.id,
        m.version,
        value.bundleDigest,
        JSON.stringify(value),
      ],
    );
    const saved = (
      await c.query(
        "select snapshot from bench_effective where account_id=$1 and digest=$2",
        [accountId, value.digest],
      )
    ).rows[0];
    if (!saved || canonical(saved.snapshot) !== canonical(value))
      throw new ApiFailure("HARNESS_CORRUPT", 503, "有效配置摘要发生冲突。");
  }
  private async context(
    c: pg.PoolClient,
    accountId: string,
    dossierId: string,
  ) {
    if (!z.string().uuid().safeParse(dossierId).success) throw denied();
    const d = (
      await c.query("select bench,archived_at from dossier where id=$1", [
        dossierId,
      ])
    ).rows[0];
    if (!d || d.bench !== this.bundle.manifest.id || d.archived_at)
      throw denied();
    const version = (
      await c.query(
        "select digest from bench_version where bench=$1 and version=$2",
        [d.bench, this.bundle.manifest.version],
      )
    ).rows[0];
    if (version?.digest !== this.bundle.digest)
      throw new ApiFailure(
        "BENCH_NOT_PUBLISHED",
        503,
        "工作台版本尚未由受信发布流程登记。",
      );
    const cap = (
      await c.query(
        "select monthly_budget_cny::text cap from account where id=$1",
        [accountId],
      )
    ).rows[0];
    if (!cap) throw denied();
    const tuning =
      (
        await c.query(
          "select patch from bench_tuning where account_id=$1 and bench=$2",
          [accountId, d.bench],
        )
      ).rows[0]?.patch ?? {};
    const account = planBenchPatch(
      initialEffective(this.bundle),
      tuning,
      this.registry,
      Number(cap.cap),
    );
    if (account.requiresApproval)
      throw new ApiFailure(
        "HARNESS_APPROVAL_REQUIRED",
        409,
        "账户微调不能自动放宽权限，请对目标档案申请批准。",
      );
    return {
      cap: Number(cap.cap),
      tuningHash: sha(tuning),
      base: account.candidate,
    };
  }
  async effectiveClient(
    c: pg.PoolClient,
    accountId: string,
    dossierId: string,
  ) {
    const context = await this.context(c, accountId, dossierId),
      override = (
        await c.query(
          "select effective_digest,account_tuning_hash from dossier_override where dossier_id=$1",
          [dossierId],
        )
      ).rows[0];
    if (!override) {
      await this.snapshot(c, accountId, context.base);
      return context.base;
    }
    if (override.account_tuning_hash !== context.tuningHash)
      throw new ApiFailure(
        "HARNESS_STALE",
        409,
        "账户微调已变化，请先重新核对档案覆盖。",
      );
    const row = (
      await c.query(
        "select snapshot from bench_effective where account_id=$1 and digest=$2",
        [accountId, override.effective_digest],
      )
    ).rows[0];
    if (!row)
      throw new ApiFailure("HARNESS_CORRUPT", 503, "档案配置快照缺失。");
    return planBenchPatch(
      verifyEffective(row.snapshot, this.registry),
      {},
      this.registry,
      context.cap,
    ).candidate;
  }
  effective(accountId: string, dossierId: string) {
    return this.db.withAccount(accountId, (c) =>
      this.effectiveClient(c, accountId, dossierId),
    );
  }
  private async apply(
    c: pg.PoolClient,
    accountId: string,
    dossierId: string,
    value: EffectiveBench,
    tuningHash: string,
  ) {
    await this.snapshot(c, accountId, value);
    await c.query(
      "insert into dossier_override(account_id,dossier_id,bench,effective_digest,account_tuning_hash) values($1,$2,$3,$4,$5) on conflict(account_id,dossier_id) do update set effective_digest=excluded.effective_digest,account_tuning_hash=excluded.account_tuning_hash",
      [accountId, dossierId, value.manifest.id, value.digest, tuningHash],
    );
  }
  propose(accountId: string, dossierId: string, patch: unknown, id: string) {
    return this.db.withAccount(accountId, (c) =>
      this.proposeClient(c, accountId, dossierId, patch, id),
    );
  }
  async proposeClient(
    c: pg.PoolClient,
    accountId: string,
    dossierId: string,
    patch: unknown,
    id: string,
  ) {
    if (!z.string().uuid().safeParse(id).success) throw denied();
    await lockBudget(c, accountId);
    const current = await this.effectiveClient(c, accountId, dossierId),
      context = await this.context(c, accountId, dossierId);
    const old = (
      await c.query("select * from harness_proposal where id=$1", [id])
    ).rows[0];
    if (old) {
      if (
        old.dossier_id !== dossierId ||
        canonical(old.patch) !== canonical(patch)
      )
        throw new ApiFailure(
          "IDEMPOTENCY_CONFLICT",
          409,
          "配置提议编号对应不同内容。",
        );
      return this.proposalReply(old);
    }
    const plan = planBenchPatch(current, patch, this.registry, context.cap);
    await this.snapshot(c, accountId, plan.candidate);
    const state = plan.requiresApproval ? "pending" : "applied";
    await c.query(
      "insert into harness_proposal(id,account_id,dossier_id,patch,base_digest,candidate_digest,state) values($1,$2,$3,$4::jsonb,$5,$6,$7)",
      [
        id,
        accountId,
        dossierId,
        JSON.stringify(patch),
        current.digest,
        plan.candidate.digest,
        state,
      ],
    );
    if (!plan.requiresApproval)
      await this.apply(
        c,
        accountId,
        dossierId,
        plan.candidate,
        context.tuningHash,
      );
    await appendEvent(c, accountId, {
      dossierId,
      kind: plan.requiresApproval ? "approval" : "gate",
      action: plan.requiresApproval ? "harness.proposed" : "harness.configured",
      risk: "write",
      payload: {
        proposalId: id,
        bench: current.manifest.id,
        version: current.manifest.version,
        baseDigest: current.digest,
        effectiveDigest: plan.requiresApproval
          ? current.digest
          : plan.candidate.digest,
        candidateDigest: plan.candidate.digest,
        changes: JSON.parse(JSON.stringify(plan.changes)),
      },
      dedupeKey: "harness-propose:" + id,
    });
    return this.proposalReply({
      id,
      state,
      candidate_digest: plan.candidate.digest,
    });
  }
  private proposalReply(row: Record<string, any>) {
    return {
      id: row.id,
      state: row.state as string,
      digest: row.candidate_digest as string,
      card: {
        kind: "approval" as const,
        title: "工作台权限放宽申请",
        effects: ["批准后从下一次运行采用提议配置。"],
        risk: "write" as const,
        action: "harness.loosen",
      },
    };
  }
  decide(accountId: string, id: string, decision: "approve" | "reject") {
    return this.db.withAccount(accountId, (c) =>
      this.decideClient(c, accountId, id, decision),
    );
  }
  async decideClient(
    c: pg.PoolClient,
    accountId: string,
    id: string,
    decision: "approve" | "reject",
  ) {
    if (
      !z.string().uuid().safeParse(id).success ||
      !["approve", "reject"].includes(decision)
    )
      throw denied();
    await lockBudget(c, accountId);
    const row = (
      await c.query("select * from harness_proposal where id=$1 for update", [
        id,
      ])
    ).rows[0];
    if (!row) throw denied();
    if (row.receipt) {
      if (row.decision !== decision)
        throw new ApiFailure(
          "IDEMPOTENCY_CONFLICT",
          409,
          "配置提议已经以不同决定处理。",
        );
      return row.receipt as { id: string; state: string; digest: string };
    }
    if (row.state !== "pending")
      throw new ApiFailure("HARNESS_NOT_PENDING", 409, "配置提议已直接生效。");
    const current = await this.effectiveClient(c, accountId, row.dossier_id),
      context = await this.context(c, accountId, row.dossier_id);
    if (current.digest !== row.base_digest)
      throw new ApiFailure(
        "HARNESS_STALE",
        409,
        "待批准配置的基础摘要已变化。",
      );
    const plan = planBenchPatch(current, row.patch, this.registry, context.cap);
    if (
      !plan.requiresApproval ||
      plan.candidate.digest !== row.candidate_digest
    )
      throw new ApiFailure("HARNESS_CORRUPT", 503, "待批准配置重算不一致。");
    if (decision === "approve")
      await this.apply(
        c,
        accountId,
        row.dossier_id,
        plan.candidate,
        context.tuningHash,
      );
    const receipt = {
      id,
      state: decision === "approve" ? "approved" : "rejected",
      digest: decision === "approve" ? plan.candidate.digest : current.digest,
    };
    await c.query(
      "update harness_proposal set state=$2,decision=$3,receipt=$4::jsonb where id=$1",
      [id, receipt.state, decision, JSON.stringify(receipt)],
    );
    await appendEvent(c, accountId, {
      dossierId: row.dossier_id,
      kind: "approval",
      action: decision === "approve" ? "harness.loosen" : "harness.rejected",
      risk: "write",
      payload: {
        proposalId: id,
        bench: current.manifest.id,
        version: current.manifest.version,
        baseDigest: current.digest,
        effectiveDigest: receipt.digest,
        decision,
        changes: JSON.parse(JSON.stringify(plan.changes)),
      },
      dedupeKey: "harness-decide:" + id,
    });
    return receipt;
  }
}
