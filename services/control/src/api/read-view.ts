import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/database";
import type { ApiEnv } from "./context";
import { ApiFailure, denied } from "./errors";
import { requireDossier, readEvents, parseCursor, scrub } from "../ledger";
import { pendingMcpApproval } from "../mcp/approval-bridge";

/** This view never exports quiz answers, including legacy nested tool payloads. */
export function publicReadValue(value: any): any {
  if (Array.isArray(value)) return value.map(publicReadValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key.toLowerCase() !== "keys")
        .map(([key, v]) => [key, publicReadValue(v)]),
    );
  return value;
}
/** Read clients need results and message text, never native tool inputs/outputs.
 * In particular, a tool output may be a JSON string containing private quiz keys.
 */
export function publicReadEvent(event: any): any {
  const raw = event.payload ?? {};
  let payload: Record<string, unknown> = {};
  if (event.kind === "card" && event.action === "card_created") {
    payload = { cardId: raw.cardId, cardType: raw.cardType, card: raw.card };
  } else if (event.action === "capability.call") {
    const s = raw.summary ?? {};
    payload = {
      capability: raw.capability,
      success: raw.success,
      replay: raw.replay,
      durationMs: raw.durationMs,
      summary: {
        query: s.query,
        count: s.count,
        assetId: s.assetId,
        status: s.status,
        license: s.license,
        pages: s.pages,
        sizeBytes: s.sizeBytes,
      },
    };
  } else if (event.action === "paper_page_read") {
    payload = {
      assetId: raw.assetId,
      page: raw.page,
      textSha256: raw.textSha256,
      quote: raw.quote,
    };
  } else {
    const p = raw.properties ?? {};
    payload = {
      properties: {
        ...(p.info ? { info: { id: p.info.id, role: p.info.role } } : {}),
        ...(p.part?.type === "text"
          ? {
              part: {
                id: p.part.id,
                type: "text",
                messageID: p.part.messageID,
                text: p.part.text,
              },
            }
          : {}),
      },
    };
  }
  return publicReadValue({ ...event, payload });
}
const labels: Record<string, string> = {
  "papers.search": "检索论文",
  "papers.fetch": "下载论文全文",
  "papers.pages": "按页读取原文",
  "files.write": "写入档案文件",
  "cards.card.layer": "写入分层讲解",
  "cards.card.quiz": "写入检查题",
  "cards.card.finding": "记录发现",
};
const tooLarge = () =>
  new ApiFailure(
    "READ_VIEW_TOO_LARGE",
    413,
    "档案历史过大，请分档阅读；不会静默截断结果。",
  );
export function registerReadView(app: Hono<ApiEnv>, db: Database) {
  app.get("/v1/dossiers/:id/read-state", (c) =>
    db.withAccountSnapshot(c.get("accountId"), async (client) => {
      const id = c.req.param("id");
      await requireDossier(client, id);
      const dossier = (
        await client.query("select id,title,bench from dossier where id=$1", [
          id,
        ])
      ).rows[0];
      if (dossier.bench !== "research") throw denied();
      const requested = c.req.query("runId");
      if (requested && !z.string().uuid().safeParse(requested).success)
        throw denied();
      const run = (
        await client.query(
          `select r.id,r.estimate_id "estimateId",r.state,r.budget_cny::text "budgetCny",r.spent_cny::text "knownSpentCny",r.input,r.ended_at "endedAt",
      (select count(*)::int from os_usage u where u.account_id=r.account_id and u.run_id=r.id) "usageCount",
      (coalesce(b.usage_uncertain,false) or exists(select 1 from os_usage u where u.account_id=r.account_id and u.run_id=r.id and u.cost_cny is null) or exists(select 1 from budget_hold h where h.account_id=r.account_id and h.run_id=r.id and h.state='unpriced')) "usageUnknown"
      from run r left join os_binding b on b.account_id=r.account_id and b.run_id=r.id where r.dossier_id=$1 and r.mode='read' and ($2::uuid is null or r.id=$2) order by r.created_at desc,r.id desc limit 1`,
          [id, requested ?? null],
        )
      ).rows[0];
      if (requested && !run) throw denied();
      const cursor = Number(
        (
          await client.query(
            "select coalesce(max(seq),0)::text cursor from event where dossier_id=$1",
            [id],
          )
        ).rows[0].cursor,
      );
      if (!Number.isSafeInteger(cursor)) throw tooLarge();
      const assets = (
        await client.query(
          'select id,run_id "runId",paper_id "paperId",status,license,view_metadata metadata,created_at "createdAt" from paper_asset where dossier_id=$1 order by created_at,id limit 1001',
          [id],
        )
      ).rows;
      const pages = run
        ? (
            await client.query(
              'select asset_id "assetId",page,text_sha256 "textSha256",left(page_text,300) quote from paper_page_read where dossier_id=$1 and run_id=$2 order by asset_id,page,text_sha256 limit 1001',
              [id, run.id],
            )
          ).rows
        : [];
      if (assets.length > 1000 || pages.length > 1000) throw tooLarge();
      const seenPages = new Map<string, string>();
      for (const page of pages) {
        const key = page.assetId + ":" + page.page;
        if (seenPages.has(key) && seenPages.get(key) !== page.textSha256)
          throw new ApiFailure(
            "PAPER_PAGE_CONFLICT",
            409,
            "同一原文页存在冲突回执，不能选择性展示。",
          );
        seenPages.set(key, page.textSha256);
      }
      const rows = run
        ? (
            await client.query(
              `select a.id,a.run_id "runId",a.kind,a.title,a.effects,a.risk,a.state,a.decision_sent sent,a.os_request_id native,b.phase,b.receipt
      from approval a left join os_binding b on b.account_id=a.account_id and b.run_id=a.run_id and b.session_id=a.os_session_id
      where a.run_id=$1 order by a.id limit 1001`,
              [run.id],
            )
          ).rows
        : [];
      if (rows.length > 1000) throw tooLarge();
      const hidden = new Set<string>(),
        bindings = new Map<
          string,
          { capability: string; approvalId: string }
        >();
      for (const a of rows.filter((a) => a.native))
        for (const e of Array.isArray(a.effects) ? a.effects : []) {
          const p = pendingMcpApproval(e?.properties ?? e);
          if (p) {
            hidden.add(p.approvalId);
            bindings.set(a.id, {
              capability: p.capability,
              approvalId: p.approvalId,
            });
          }
        }
      const approvals = rows
        .filter(
          (a) =>
            !hidden.has(a.id) &&
            (!a.native || (a.phase === "accepted" && a.receipt)),
        )
        .map((a) => {
          const binding = bindings.get(a.id);
          const details = (
            binding ? rows.find((row) => row.id === binding.approvalId) : a
          )?.effects;
          const capability =
            binding?.capability ??
            (typeof details?.capability === "string"
              ? details.capability
              : "permission");
          const described = Array.isArray(details?.effects)
            ? details.effects.filter((e: unknown) => typeof e === "string")
            : [];
          const files = Array.isArray(details?.summary?.files)
            ? details.summary.files.flatMap((f: any) =>
                typeof f?.path === "string"
                  ? [
                      `文件：${f.path}${Number.isSafeInteger(f.bytes) ? "（" + f.bytes + " 字节）" : ""}`,
                    ]
                  : [],
              )
            : [];
          return {
            id: a.id,
            runId: a.runId,
            kind: a.kind,
            title:
              a.kind === "question"
                ? "问题等待回答（请在收件箱处理）"
                : (labels[capability] ?? String(a.title)),
            action: capability,
            effects: [
              ...described,
              ...files,
              "只处理这一次请求；参数变化后需要重新批准。",
            ],
            risk: a.risk,
            state: a.state,
            sent: a.sent === true,
          };
        });
      const papers = assets.map((a) => {
        const m = a.metadata ?? {};
        return {
          id: a.id,
          runId: a.runId,
          paperId: a.paperId,
          access: a.status === "full_text" ? "full" : "abstract_only",
          license: a.license,
          title: typeof m.title === "string" ? m.title : null,
          authors: Array.isArray(m.authors)
            ? m.authors.filter((v: unknown) => typeof v === "string")
            : [],
          venue: typeof m.venue === "string" ? m.venue : null,
          sizeBytes:
            Number.isSafeInteger(m.sizeBytes) && m.sizeBytes >= 0
              ? m.sizeBytes
              : null,
        };
      });
      c.header("Cache-Control", "no-store");
      const result = scrub(
        publicReadValue({
          dossier: { id: dossier.id, title: dossier.title },
          cursor,
          papers,
          pages,
          approvals,
          run: run
            ? {
                id: run.id,
                estimateId: run.estimateId,
                state: run.state,
                budgetCny: Number(run.budgetCny),
                spentCny: run.usageCount ? Number(run.knownSpentCny) : null,
                usageUnknown: run.usageUnknown,
                query:
                  typeof run.input?.query === "string"
                    ? run.input.query
                    : typeof run.input?.question === "string"
                      ? run.input.question
                      : "",
                endedAt: run.endedAt,
              }
            : null,
        }),
      );
      return c.body(JSON.stringify(result), 200, {
        "Content-Type": "application/json",
      });
    }),
  );
  app.get("/v1/dossiers/:id/read-events", (c) =>
    db.withAccountSnapshot(c.get("accountId"), async (client) => {
      const id = c.req.param("id");
      await requireDossier(client, id);
      const after = parseCursor(c.req.query("after")),
        through = parseCursor(c.req.query("through"));
      if (after > through)
        throw new ApiFailure("INVALID_CURSOR", 400, "历史游标顺序无效。");
      const max = Number(
        (
          await client.query(
            "select coalesce(max(seq),0)::text cursor from event where dossier_id=$1",
            [id],
          )
        ).rows[0].cursor,
      );
      if (through > max)
        throw new ApiFailure("INVALID_CURSOR", 400, "历史水位尚不存在。");
      const batch = await readEvents(client, id, after),
        items = batch.filter((e) => e.seq <= through),
        cursor = items.at(-1)?.seq ?? after;
      c.header("Cache-Control", "no-store");
      return c.json({
        items: items.map(publicReadEvent),
        cursor,
        through,
        done:
          batch.length < 100 ||
          items.length < batch.length ||
          cursor >= through,
      });
    }),
  );
}
