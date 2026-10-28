import type pg from "pg";
import { createHash } from "node:crypto";
import type { AuthorizedCapability } from "./authority";
import { ApiFailure } from "../api/errors";
const denied = (message = "卡片引用不是本次运行已读取的原文。") =>
  new ApiFailure("CARD_CITATION_UNVERIFIED", 403, message);
const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();
/**
 * 比对用的紧凑形式：忽略大小写、空白、连字符和标点。PDF 抽出的原文常带换行断词
 * （"Tool-
former"）或全角标点，逐字比较会把正确的引用判成错。
 */
const compact = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\u00ad\u2010\u2011\u2012\u2013\u2014-]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
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
      throw denied(
        `这篇还没有本轮读过的页（paperId=${card.paperId}）。先调用 papers_pages 读页，再写卡片。`,
      );
  }
  for (const anchor of anchors) {
    if (!normalized(anchor.quote).length)
      throw denied("引文不能为空：quote 要写该页上的原话。");
    if (card.paperId && card.paperId !== anchor.paperId)
      throw denied(
        `卡片 paperId=${card.paperId}，但这条引用写的是 ${anchor.paperId}；两者要一致。`,
      );
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
    const matching = rows.rows.some(
      (row) =>
        createHash("sha256").update(row.page_text).digest("hex") ===
          row.text_sha256 &&
        (normalized(row.page_text).includes(normalized(anchor.quote)) ||
          (compact(anchor.quote).length >= 12 &&
            compact(row.page_text).includes(compact(anchor.quote)))),
    );
    if (!matching) {
      const read = (
        await client.query(
          "select distinct page from paper_page_read where account_id=$1 and dossier_id=$2 and run_id=$3 and asset_id=$4 order by page",
          [
            context.claims.account,
            context.claims.dossier,
            context.claims.run,
            anchor.paperId,
          ],
        )
      ).rows.map((row) => row.page);
      throw denied(
        rows.rows.length === 0
          ? `第 ${anchor.page} 页还没读过。这一轮读过的是：${read.length ? "第 " + read.join("、") + " 页" : "还没有任何页"}。`
          : `第 ${anchor.page} 页找不到这段原文："${normalized(anchor.quote).slice(0, 60)}"。quote 必须逐字来自读过的这一页。`,
      );
    }
  }
}
