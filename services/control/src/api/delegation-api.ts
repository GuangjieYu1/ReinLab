import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "../db/database";
import { mutate, type ApiEnv } from "./context";
import { ApiFailure } from "./errors";
import {
  buildDelegationResult,
  confirmDelegation,
  createDelegation,
  decideDelegation,
  getDelegation,
} from "../swarm/delegation";
import { createDossier, noteToDossier } from "../dossier/service";
import type { SwarmService } from "../swarm/service";

/** 跨台委托（契约 §6）。首个源台：探索台（exploration）。 */
export function registerDelegationApi(
  app: Hono<ApiEnv>,
  db: Database,
  swarm: SwarmService,
) {
  const Create = z
    .object({
      fromBench: z.enum(["exploration", "creative", "research"]),
      fromDossierId: z.string().uuid(),
      toBench: z.literal("research").default("research"),
      mode: z.literal("swarm").default("swarm"),
      question: z.string().min(2).max(2000),
      background: z.string().max(8000).optional(),
      materials: z
        .array(z.object({ ref: z.string().min(1), version: z.string().optional() }).strict())
        .max(50)
        .optional(),
      expected: z.string().max(2000).optional(),
      constraints: z.string().max(2000).optional(),
    })
    .strict();

  app.post("/v1/delegations", async (c) => {
    const key = c.req.header("idempotency-key") ?? c.req.header("Idempotency-Key") ?? "";
    const account = c.get("accountId");
    return mutate(c, db, Create, async (_client, input) => {
      const created = await createDelegation(
        db,
        account,
        {
          fromBench: input.fromBench,
          fromDossierId: input.fromDossierId,
          question: input.question,
          background: input.background,
          materials: input.materials ?? [],
          expected: input.expected,
          constraints: input.constraints,
        },
        key || input.question.slice(0, 60),
      );
      return { status: 201 as const, body: JSON.parse(JSON.stringify(created)) };
    });
  });

  app.post("/v1/delegations/:id/confirm", async (c) => {
    const account = c.get("accountId");
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success) throw new ApiFailure("INVALID_INPUT", 400, "委托 id 不对。");
    const outcome = await confirmDelegation(
      db,
      account,
      id.data,
      async (researchDossierId, question) => {
        const started = await swarm.start(account, researchDossierId, question);
        return { runId: started.runId };
      },
      async (client, acct, input) => {
        const dossier = await createDossier(client, acct, input, "page");
        return { id: String(dossier.id) };
      },
    );
    return c.json(outcome);
  });

  app.get("/v1/delegations/:id", async (c) => {
    const account = c.get("accountId");
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success) throw new ApiFailure("INVALID_INPUT", 400, "委托 id 不对。");
    const view = await getDelegation(db, account, id.data);
    // 有结果就核一次结果卡：内容没变不动版本，变了才更新同一张卡（B17①②）。
    if (view.runId) await refreshResultCard(db, swarm, account, id.data).catch(() => undefined);
    return c.json(await getDelegation(db, account, id.data));
  });

  const Decide = z
    .object({
      resultVersion: z.number().int().nonnegative().optional(),
      decision: z.enum(["adopt", "dismiss"]),
    })
    .strict();
  app.post("/v1/delegations/:id/decide", async (c) => {
    const account = c.get("accountId");
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success) throw new ApiFailure("INVALID_INPUT", 400, "委托 id 不对。");
    return mutate(c, db, Decide, async (_client, input) => {
      const outcome = await decideDelegation(
        db,
        account,
        id.data,
        { decision: input.decision, ...(input.resultVersion ? { resultVersion: input.resultVersion } : {}) },
        async (client, acct, dossier, text) => {
          await noteToDossier(client, acct, dossier, text);
        },
      );
      return { status: 200 as const, body: outcome };
    });
  });
}

/** 把群研的结果写成源档案里的结果卡（同一 id 重复回调只更新版本）。 */
export async function refreshResultCard(
  db: Database,
  swarm: SwarmService,
  account: string,
  delegationId: string,
  /** 只在决定之后（卡要关）时用；查看不碰。 */
  options: { force?: boolean } = {},
) {
  return db.withAccount(account, async (client) => {
    const row = (
      await client.query("select * from delegation where account_id=$1 and id=$2", [
        account,
        delegationId,
      ])
    ).rows[0];
    if (!row?.to_run) return null;
    const snapshot = await swarm.snapshot(account, String(row.to_run)).catch(() => null);
    if (!snapshot?.report) return null;
    const result = await buildDelegationResult(client, account, row, {
      state: snapshot.report.state,
      claims: snapshot.claims.map((claim) => ({
        id: claim.id,
        text: claim.text.slice(0, 200),
        status: claim.status,
      })),
      evidence: snapshot.evidence.map((entry) => ({
        id: entry.id,
        title: entry.source?.title ?? "",
        locator: entry.locator?.section ?? entry.locator?.quote?.slice(0, 60) ?? "",
      })),
      limits: snapshot.report.limits,
      gaps: snapshot.report.gaps,
    });
    // 结果没变就不出新版本：查看只读，不能因为被点开一次就升版（B17①）。
    const fingerprint = JSON.stringify({ ...(result as Record<string, unknown>), version: 0 });
    const previous = row.result_ref
      ? JSON.stringify({ ...(JSON.parse(String(row.result_ref)) as Record<string, unknown>), version: 0 })
      : "";
    if (!options.force && previous && previous === fingerprint)
      return JSON.parse(String(row.result_ref));
    const nextVersion = previous === fingerprint ? Number(row.result_version ?? 0) : Number(row.result_version ?? 0) + 1;
    const card = { ...(result as Record<string, unknown>), version: nextVersion };
    await client.query(
      "update delegation set result_version=$3, result_ref=$4 where account_id=$1 and id=$2",
      [account, delegationId, nextVersion, JSON.stringify(card)],
    );
    // 同一份委托只有一张结果卡：内容更新、版本递增（契约 §6）。
    await client.query(
      `insert into approval(id,account_id,run_id,dossier_id,kind,title,effects,risk,state,effect_key)
       values(gen_random_uuid(),$1,$2,$3,'delegation_result',$4,$5,'read','pending',$6)
       on conflict (account_id,run_id,effect_key) where effect_key is not null and state='pending'
       do update set title=excluded.title, effects=excluded.effects`,
      [
        account,
        String(row.to_run),
        String(row.from_dossier),
        `群研结果：第 ${nextVersion} 版`,
        JSON.stringify([card]),
        `delegation_result:${delegationId}`,
      ],
    );
    return card;
  });
}
