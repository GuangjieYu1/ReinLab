import type pg from "pg";
import { createHash } from "node:crypto";
import type { AuthorizedCapability } from "./authority";
import { ApiFailure } from "../api/errors";
const denied = () =>
  new ApiFailure(
    "CARD_CITATION_UNVERIFIED",
    403,
    "卡片引用不是本次运行已读取的原文。",
  );
const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();
export async function verifyCardSources(
  client: pg.PoolClient,
  context: AuthorizedCapability,
  name: string,
  card: Record<string, any>,
) {
  const anchors =
    name === "layer"
      ? card.body.flatMap((p: any) => p.refs)
      : name === "finding"
        ? card.evidence
        : name === "answer"
          ? card.citations
          : [];
  if (card.paperId) {
    if (
      !(
        await client.query(
          "select 1 from paper_page_read where account_id=$1 and dossier_id=$2 and run_id=$3 and asset_id=$4 limit 1",
          [
            context.claims.account,
            context.claims.dossier,
            context.claims.run,
            card.paperId,
          ],
        )
      ).rowCount
    )
      throw denied();
  }
  for (const anchor of anchors) {
    if (!normalized(anchor.quote).length) throw denied();
    if (card.paperId && card.paperId !== anchor.paperId) throw denied();
    const rows = await client.query(
      "select page_text,text_sha256 from paper_page_read where account_id=$1 and dossier_id=$2 and run_id=$3 and asset_id=$4 and page=$5",
      [
        context.claims.account,
        context.claims.dossier,
        context.claims.run,
        anchor.paperId,
        anchor.page,
      ],
    );
    if (
      !rows.rows.some(
        (row) =>
          createHash("sha256").update(row.page_text).digest("hex") ===
            row.text_sha256 &&
          normalized(row.page_text).includes(normalized(anchor.quote)),
      )
    )
      throw denied();
  }
}
