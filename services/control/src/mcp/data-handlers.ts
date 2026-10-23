import { verifyCardSources } from "./card-integrity";
import { lockBudget } from "../budget";
import Ajv from "ajv";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db/database";
import { ApiFailure } from "../api/errors";
import { appendEvent, scrub } from "../ledger";
import type { JsonValue } from "@reinlab/contracts";
import { hash } from "./token";
import type { CapabilityHandler } from "./engine";
const deny = (code: string) =>
  new ApiFailure(code, 403, "能力参数超出本次运行范围。");
const ajv = new Ajv({ strict: true, validateFormats: true });
ajv.addFormat(
  "uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
const layers = z.array(z.enum(["L2", "L3", "L4"])).max(3),
  refs = z.array(z.string().uuid()).max(128);
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
export type CardDeposit = (
  context: Parameters<CapabilityHandler>[0],
  id: string,
  name: string,
  card: Record<string, unknown>,
  writeTargets: string[],
) => Promise<void>;
export function dataHandlers(
  db: Database,
  deposit?: CardDeposit,
): Record<string, CapabilityHandler> {
  const handlers: Record<string, CapabilityHandler> = {};
  handlers["memory.read"] = async (context, args) =>
    db.withAccount(context.claims.account, async (client) => {
      const scope = context.scope.memory;
      const requested =
        args.layers === undefined ? scope.layers : layers.parse(args.layers);
      if (requested.some((v) => !scope.layers.includes(v)))
        throw deny("MEMORY_SCOPE_DENIED");
      const requestedRefs =
        args.refs === undefined ? scope.refs : refs.parse(args.refs);
      if (
        scope.refs !== null &&
        requestedRefs?.some((v) => !scope.refs!.includes(v))
      )
        throw deny("MEMORY_SCOPE_DENIED");
      if (
        scope.assignedCitations ||
        !requested.length ||
        requestedRefs?.length === 0
      )
        return { items: [] };
      const result = await client.query(
        `select m.id,m.layer,m.key,m.value,m.evidence from memory_item m where m.account_id=$1 and m.layer=any($3::text[]) and m.revoked_at is null
     and ((m.layer='L2' and m.dossier_id=$2 and m.thread_id is null) or (m.layer in ('L3','L4') and m.dossier_id is null and m.thread_id is null))
     and ($4::uuid[] is null or m.id=any($4::uuid[]))
     and not exists(select 1 from memory_item successor where successor.account_id=$1 and successor.supersedes=m.id)
     order by m.layer,m.key,m.id limit 129`,
        [
          context.claims.account,
          context.claims.dossier,
          requested,
          requestedRefs,
        ],
      );
      if (
        result.rows.length > 128 ||
        Buffer.byteLength(JSON.stringify(result.rows)) > 131072 ||
        result.rows.some(
          (v) =>
            Buffer.byteLength(JSON.stringify(v.value)) > 65536 ||
            Buffer.byteLength(JSON.stringify(v.evidence)) > 32768,
        )
      )
        throw new ApiFailure(
          "MEMORY_TOO_LARGE",
          413,
          "记忆读取超过大小限制，请收窄引用。",
        );
      return { items: result.rows };
    });
  handlers["memory.propose"] = async (context, args) =>
    db.withAccount(context.claims.account, async (client) => {
      await lockBudget(client, context.claims.account);
      if (!["L3", "L4"].includes(String(args.targetLayer)))
        throw deny("MEMORY_SCOPE_DENIED");
      const id = randomUUID(),
        target = args.targetLayer === "L3" ? "L3.preference" : "L4.knowledge";
      const item = scrub(
        json({ key: args.key, value: args.value, evidence: args.evidence }),
      );
      await client.query(
        "insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at) values($1,$2,$3,$4,$5::jsonb,'MCP 建议：上线时待批准',now()+interval '30 days')",
        [
          id,
          context.claims.account,
          context.claims.run,
          target,
          JSON.stringify([item]),
        ],
      );
      await appendEvent(client, context.claims.account, {
        dossierId: context.claims.dossier,
        runId: context.claims.run,
        kind: "memory",
        action: "memory.proposed",
        payload: {
          promotionId: id,
          targetLayer: String(args.targetLayer),
          status: "pending",
          contentHash: hash(item),
        },
        dedupeKey: "mcp-promotion:" + id,
      });
      return { promotionId: id, status: "pending" };
    });
  for (const name of ["answer", "finding", "layer", "quiz"])
    handlers["cards.card." + name] = async (context, args) =>
      db.withAccount(context.claims.account, async (client) => {
        await lockBudget(client, context.claims.account);
        const row = (
          await client.query(
            `select e.snapshot,v.bundle from run_harness h join bench_effective e on e.account_id=h.account_id and e.digest=h.effective_digest join bench_version v on v.bench=h.bench and v.version=h.version where h.run_id=$1`,
            [context.claims.run],
          )
        ).rows[0];
        const declaration = row?.snapshot?.manifest?.cards?.[name];
        if (!declaration) throw deny("UNDECLARED_CARD");
        const text = row.bundle.schemas?.[declaration.schema];
        if (
          typeof text !== "string" ||
          createHash("sha256").update(text).digest("hex") !==
            row.bundle.referencedHashes[declaration.schema]
        )
          throw new ApiFailure(
            "CARD_SCHEMA_UNAVAILABLE",
            503,
            "冻结的卡片规范缺失。",
          );
        let valid = false;
        try {
          valid = ajv.compile(JSON.parse(text))(args.card);
        } catch {
          throw new ApiFailure(
            "CARD_SCHEMA_INVALID",
            503,
            "冻结的卡片规范无效。",
          );
        }
        if (!valid)
          throw new ApiFailure(
            "CARD_SCHEMA_MISMATCH",
            400,
            "卡片不符合工作台规范。",
          );
        const rawCard = args.card as Record<string, any>;
        const reviewed =
          row.snapshot.manifest.id === "research" &&
          row.snapshot.manifest.version === "1.1.0";
        if (reviewed) await verifyCardSources(client, context, name, rawCard);
        const id = randomUUID();
        if (reviewed && name === "quiz") {
          if (!deposit)
            throw new ApiFailure(
              "CARD_STORAGE_UNAVAILABLE",
              503,
              "检查题档案存储尚未就绪。",
            );
          await deposit(
            context,
            id,
            name,
            rawCard,
            row.snapshot.manifest.roles[context.claims.role].write_targets,
          );
        }
        const storedCard = { ...rawCard };
        if (name === "quiz") delete storedCard.keys;
        if (reviewed && name === "finding") {
          const count = (
            await client.query(
              "select count(*)::int n from event where dossier_id=$1 and action='card_created' and payload->>'cardType'='finding'",
              [context.claims.dossier],
            )
          ).rows[0].n;
          storedCard.n = count + 1;
          storedCard.at = new Date().toISOString();
        }
        const card = scrub(json(storedCard));
        await appendEvent(client, context.claims.account, {
          dossierId: context.claims.dossier,
          runId: context.claims.run,
          kind: "card",
          action: "card_created",
          payload: {
            cardId: id,
            ...(reviewed ? { cardType: name } : {}),
            card,
          },
          dedupeKey: "mcp-card:" + id,
        });
        return { cardId: id };
      });
  for (const operation of ["approval.request", "gate.request_open"])
    handlers["cards." + operation] = async (context, args) =>
      db.withAccount(context.claims.account, async (client) => {
        await lockBudget(client, context.claims.account);
        if (
          operation === "gate.request_open" &&
          !(
            await client.query(
              "select id from gate where dossier_id=$1 and id=$2",
              [context.claims.dossier, args.gateId],
            )
          ).rowCount
        )
          throw deny("GATE_SCOPE_DENIED");
        const gate =
          operation === "gate.request_open"
            ? (
                await client.query(
                  "select id,state,revision,review_artifact_id from gate where dossier_id=$1 and id=$2",
                  [context.claims.dossier, args.gateId],
                )
              ).rows[0]
            : null;
        const gateSnapshot = gate
          ? {
              gateId: gate.id,
              state: gate.state,
              revision: gate.revision,
              artifactId: gate.review_artifact_id,
            }
          : undefined;
        const id = randomUUID();
        await client.query(
          "insert into approval(id,account_id,run_id,kind,title,effects,risk) values($1,$2,$3,$4,$5,$6::jsonb,'write')",
          [
            id,
            context.claims.account,
            context.claims.run,
            operation === "gate.request_open" ? "gate" : "permission",
            operation === "gate.request_open"
              ? "请求用户放行门禁"
              : String(scrub(String(args.subject))),
            JSON.stringify(
              scrub(
                json({
                  ...args,
                  operation,
                  ...(gateSnapshot ? { gateSnapshot } : {}),
                }),
              ),
            ),
          ],
        );
        await appendEvent(client, context.claims.account, {
          dossierId: context.claims.dossier,
          runId: context.claims.run,
          kind: "card",
          action: operation,
          payload: {
            card: { kind: "approval", approvalId: id, operation },
            argsHash: hash(args),
          },
          dedupeKey: "mcp-request:" + id,
        });
        return { approvalId: id, state: "pending" };
      });
  return handlers;
}
