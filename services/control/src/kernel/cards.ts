import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import type { Database } from "../db/database";
import { ApiFailure } from "../api/errors";
import { appendEvent, scrub } from "../ledger";
import { verifyCardSources } from "../mcp/card-integrity";
import type { AuthorizedCapability } from "../mcp/handler";
import type { CapabilityHandler } from "../mcp/handler";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const ajv = new Ajv({ strict: true, validateFormats: true });
ajv.addFormat(
  "uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
const validators = new Map<string, (value: unknown) => boolean>();
async function schemaFor(name: "layer" | "finding") {
  const cached = validators.get(name);
  if (cached) return cached;
  const text = await readFile(repositoryRoot + "schemas/research/" + name + ".json", "utf8");
  const validate = ajv.compile(JSON.parse(text)) as (value: unknown) => boolean;
  validators.set(name, validate);
  return validate;
}

/**
 * Card writes for the DSH kernel.
 *
 * The legacy card path resolves a frozen bench manifest through `run_harness`,
 * which a kernel run does not have. This writer keeps the two guarantees that
 * matter — the research card shape and every quote being text this run actually
 * read — and records the same `card_created` event the reading view consumes.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 卡片里引用的论文号（arXiv / OpenAlex 号等）不是资产 id 时收出来。
 * dispatch 只会在「本轮登记过这篇」时把号换成资产 id；换不掉的说明这篇还没入档，
 * 这时候 schema 只会甩一句「must match format uuid」，模型看不懂就只能改写 markdown。
 */
function unresolvedPaperIds(card: Record<string, unknown>): string[] {
  const out: string[] = [];
  const consider = (value: unknown) => {
    if (typeof value === "string" && value && !UUID.test(value)) out.push(value);
  };
  consider(card.paperId);
  consider(card.assetId);
  for (const entry of (card.evidence as Record<string, unknown>[] | undefined) ?? []) consider(entry?.paperId);
  for (const item of (card.items as Record<string, unknown>[] | undefined) ?? [])
    for (const citation of (item?.citations as Record<string, unknown>[] | undefined) ?? [])
      consider(citation?.paperId);
  for (const entry of (card.body as Record<string, unknown>[] | undefined) ?? [])
    for (const ref of (entry?.refs as Record<string, unknown>[] | undefined) ?? []) consider(ref?.paperId);
  return [...new Set(out)];
}

export function kernelCardHandlers(
  db: Database,
): Record<string, CapabilityHandler> {
  const write = (name: "layer" | "finding"): CapabilityHandler => async (context, args) => {
    const card = (args as { card?: unknown }).card;
    if (!card || typeof card !== "object" || Array.isArray(card))
      throw new ApiFailure("CARD_SHAPE_INVALID", 400, "卡片必须是对象。");
    const unresolved = unresolvedPaperIds(card as Record<string, unknown>);
    if (unresolved.length)
      throw new ApiFailure(
        "PAPER_NOT_REGISTERED",
        409,
        `卡片引用的「${unresolved[0]}」还没入档（它不是档案里的论文资产）。先把这篇论文登记进来：papers_register 用工作区里的 PDF 路径和标题，会在收件箱出一张入档批准卡；批准后把它返回的资产 id 填进 paperId（页码依据也用同一个 id）再写卡片。`,
      );
    const validate = await schemaFor(name);
    if (!validate(card))
      throw new ApiFailure(
        "CARD_SCHEMA_MISMATCH",
        400,
        `卡片不符合 ${name} 规范：${(validate as any).errors?.[0]?.instancePath ?? ""} ${(validate as any).errors?.[0]?.message ?? ""}`.trim(),
      );
    return db.withAccount(context.claims.account, async (client) => {
      await verifyCardSources(client, context as AuthorizedCapability, name, card as Record<string, any>);
      const id = randomUUID();
      const stored = { ...(card as Record<string, any>) };
      if (name === "finding") {
        const count = (
          await client.query(
            "select count(*)::int n from event where dossier_id=$1 and action='card_created' and payload->>'cardType'='finding'",
            [context.claims.dossier],
          )
        ).rows[0].n;
        stored.n = count + 1;
        stored.at = new Date().toISOString();
      }
      await appendEvent(client, context.claims.account, {
        dossierId: context.claims.dossier,
        runId: context.claims.run,
        kind: "card",
        action: "card_created",
        payload: { cardId: id, cardType: name, card: scrub(stored) },
        dedupeKey: "kernel-card:" + id,
      });
      return { cardId: id };
    });
  };
  return {
    "cards.card.layer": write("layer"),
    "cards.card.finding": write("finding"),
  };
}
