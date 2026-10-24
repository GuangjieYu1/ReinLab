import type pg from "pg";
import { parseCursor } from "../ledger";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Hono } from "hono";
import {
  PromotionDecision,
  PromotionItem,
  type JsonValue,
} from "@reinlab/contracts";
import type { Database } from "../db/database";
import { appendEvent, scrub } from "../ledger";
import { lockBudget } from "../budget";
import { mutate, canonical, type ApiEnv } from "./context";
import { ApiFailure, denied } from "./errors";
const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const invalid = () =>
  new ApiFailure(
    "PROMOTION_INVALID",
    400,
    "提议内容或依据不完整，请编辑后再提交。",
  );
const conflict = () =>
  new ApiFailure(
    "PROMOTION_CONFLICT",
    409,
    "提议已处理、过期或替代对象已变化，请刷新。",
  );
const Items = z
  .array(
    PromotionItem.extend({
      key: z.string().trim().min(1).max(200),
      evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(64),
    }),
  )
  .min(1)
  .max(64)
  .refine((a) => new Set(a.map((i) => i.key)).size === a.length);
const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
const evidenceFailure = () =>
  new ApiFailure(
    "PROMOTION_EVIDENCE_INVALID",
    409,
    "依据必须引用本档案本次运行的真实账本事件，请先查看来源对话再修改。",
  );
function evidenceSequence(ref: string) {
  if (
    !/^event:[1-9][0-9]{0,15}$/.test(ref) ||
    !Number.isSafeInteger(Number(ref.slice(6)))
  )
    throw evidenceFailure();
  return Number(ref.slice(6));
}
async function sourcePromotion(client: pg.PoolClient, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw denied();
  const source = (
    await client.query(
      "select p.from_run,r.dossier_id from promotion p join run r on r.account_id=p.account_id and r.id=p.from_run where p.id=$1",
      [id],
    )
  ).rows[0];
  if (!source) throw denied();
  return source;
}
function evidenceRow(row: Record<string, any>) {
  return {
    ref: "event:" + row.seq,
    event: scrub(
      json({
        seq: Number(row.seq),
        at: row.at.toISOString(),
        dossierId: row.dossier_id,
        runId: row.run_id,
        roleId: row.role_id,
        kind: row.kind,
        action: row.action,
        payload: row.payload,
      }),
    ),
  };
}

export function registerPromotions(app: Hono<ApiEnv>, db: Database) {
  app.get('/v1/promotions/:id/superseded/:memoryId', (c) =>
    db.withAccount(c.get('accountId'), async (client) => {
      const promotion = c.req.param('id'), memory = c.req.param('memoryId');
      if (![promotion, memory].every(v => z.string().uuid().safeParse(v).success)) throw denied();
      const row = (await client.query(
        `select m.id,m.key,m.value from promotion p
         join run r on r.account_id=p.account_id and r.id=p.from_run
         join memory_item m on m.account_id=p.account_id and m.id=$2
         where p.id=$1 and m.thread_id is null
           and ((m.layer=split_part(p.target_layer,'.',1) and m.dossier_id is null) or (m.layer='L2' and m.dossier_id=r.dossier_id))
           and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p.items)='array' then p.items else '[]'::jsonb end) i where i->>'supersedes'=m.id::text and i->>'key'=m.key)`,
        [promotion, memory],
      )).rows[0];
      if (!row) throw denied();
      return c.json({ id:row.id, key:scrub(row.key), value:scrub(row.value) });
    }),
  );
  app.get("/v1/promotions", (c) =>
    db.withAccount(c.get("accountId"), async (client) => {
      if (
        c.req.query("state") !== undefined &&
        c.req.query("state") !== "pending"
      )
        throw invalid();
      const rows = await client.query(
        `select p.*,r.dossier_id,r.role_id,d.bench,d.title dossier_title from promotion p join run r on r.account_id=p.account_id and r.id=p.from_run join dossier d on d.account_id=r.account_id and d.id=r.dossier_id where p.account_id=$1 and p.status='pending' and p.expires_at>clock_timestamp() order by d.bench,p.created_at,p.id limit 200`,
        [c.get("accountId")],
      );
      return c.json({
        items: rows.rows.map((p) => ({
          id: p.id,
          target: p.target_layer,
          items: scrub(p.items),
          reason: scrub(p.reason),
          createdAt: p.created_at.toISOString(),
          expiresAt: p.expires_at.toISOString(),
          source: {
            bench: p.bench,
            dossierId: p.dossier_id,
            dossierTitle: scrub(p.dossier_title),
            runId: p.from_run,
            roleId: p.role_id,
          },
        })),
      });
    }),
  );
  app.get("/v1/promotions/:id/evidence", (c) =>
    db.withAccount(c.get("accountId"), async (client) => {
      const source = await sourcePromotion(client, c.req.param("id")),
        after = parseCursor(c.req.query("after"));
      const rows = (
        await client.query(
          "select seq,at,dossier_id,run_id,role_id,kind,action,payload from event where dossier_id=$1 and run_id=$2 and seq>$3 order by seq limit 100",
          [source.dossier_id, source.from_run, after],
        )
      ).rows;
      return c.json({
        items: rows.map(evidenceRow),
        nextAfter: rows.length === 100 ? Number(rows.at(-1).seq) : null,
      });
    }),
  );
  app.get("/v1/promotions/:id/evidence/:seq", (c) =>
    db.withAccount(c.get("accountId"), async (client) => {
      const source = await sourcePromotion(client, c.req.param("id"));
      let seq: number;
      try {
        seq = evidenceSequence("event:" + c.req.param("seq"));
      } catch {
        throw denied();
      }
      const row = (
        await client.query(
          "select seq,at,dossier_id,run_id,role_id,kind,action,payload from event where dossier_id=$1 and run_id=$2 and seq=$3",
          [source.dossier_id, source.from_run, seq],
        )
      ).rows[0];
      if (!row) throw denied();
      return c.json(evidenceRow(row));
    }),
  );
  app.post("/v1/promotions/:id/decide", (c) =>
    mutate(c, db, PromotionDecision, async (client, input) => {
      const id = z.string().uuid().safeParse(c.req.param("id"));
      if (!id.success) throw denied();
      const account = c.get("accountId");
      await lockBudget(client, account);
      const p = (
        await client.query(
          `select p.*,r.dossier_id,r.role_id,p.expires_at<=clock_timestamp() expired from promotion p join run r on r.account_id=p.account_id and r.id=p.from_run where p.id=$1 for update of p`,
          [id.data],
        )
      ).rows[0];
      if (!p) throw denied();
      const old = (
          await client.query(
            "select request_hash,receipt from promotion_decision where promotion_id=$1",
            [p.id],
          )
        ).rows[0],
        hash = digest(input);
      if (old) {
        if (old.request_hash !== hash) throw conflict();
        return { status: 200, body: old.receipt };
      }
      if (p.status !== "pending" || p.expired) throw conflict();
      const ids: string[] = [];
      if (input.decision !== "reject") {
        const parsed = Items.safeParse(
          input.decision === "edit" ? input.items : p.items,
        );
        if (!parsed.success) throw invalid();
        const layer =
            input.decision === "keep_local" ? "L2" : p.target_layer.slice(0, 2),
          dossier = layer === "L2" ? p.dossier_id : null;
        for (const item of parsed.data) {
          for (const ref of item.evidence) {
            const seq = evidenceSequence(ref);
            if (
              !(
                await client.query(
                  "select seq from event where dossier_id=$1 and run_id=$2 and seq=$3",
                  [p.dossier_id, p.from_run, seq],
                )
              ).rowCount
            )
              throw evidenceFailure();
          }
          if (item.supersedes) {
            const previous = (
              await client.query(
                "select layer,dossier_id,thread_id,key,revoked_at from memory_item where id=$1 for update",
                [item.supersedes],
              )
            ).rows[0];
            if (
              !previous ||
              previous.layer !== layer ||
              previous.dossier_id !== dossier ||
              previous.thread_id !== null ||
              previous.key !== item.key ||
              previous.revoked_at ||
              (
                await client.query(
                  "select id from memory_item where supersedes=$1",
                  [item.supersedes],
                )
              ).rowCount
            )
              throw conflict();
          }
          const memoryId = randomUUID();
          await client.query(
            "insert into memory_item(id,account_id,layer,dossier_id,key,value,evidence,supersedes)values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)",
            [
              memoryId,
              account,
              layer,
              dossier,
              item.key,
              JSON.stringify(item.value),
              JSON.stringify(item.evidence),
              item.supersedes ?? null,
            ],
          );
          ids.push(memoryId);
        }
      }
      const status = {
        approve: "approved",
        edit: "edited",
        reject: "rejected",
        keep_local: "kept_local",
      }[input.decision];
      const updated = await client.query(
        "update promotion set status=$2 where id=$1 and status='pending' and expires_at>clock_timestamp() returning id",
        [p.id, status],
      );
      if (!updated.rowCount) throw conflict();
      const receipt = {
        promotionId: p.id,
        decision: input.decision,
        status,
        memoryIds: ids,
      };
      await client.query(
        "insert into promotion_decision(account_id,promotion_id,request_hash,receipt)values($1,$2,$3,$4)",
        [account, p.id, hash, receipt],
      );
      await appendEvent(client, account, {
        dossierId: p.dossier_id,
        runId: p.from_run,
        roleId: p.role_id,
        kind: "memory",
        action: "promotion.decided",
        risk: "write",
        payload: json(receipt) as Record<string, JsonValue>,
        dedupeKey: "promotion-decided:" + p.id,
      });
      return { status: 200, body: receipt };
    }),
  );
}
