import type pg from "pg";
import { randomUUID } from "node:crypto";
import { scrub } from "../ledger";
import { ApiFailure } from "../api/errors";

export type CandidateMetadata = {
  paperId: string;
  title: string;
  authors: string;
  venue: string;
  access: "full" | "abstract_only";
  pages?: number;
  note?: string;
};
const sidecars = new WeakMap<object, CandidateMetadata[]>();
export function captureSearch(result: object, works: any[]) {
  sidecars.set(
    result,
    works
      .filter(
        (w) =>
          typeof w.id === "string" &&
          /^https:\/\/openalex\.org\/W[0-9]{1,30}$/.test(w.id)
      )
      .map((w) => {
        const first = String(w.biblio?.first_page ?? ""),
          last = String(w.biblio?.last_page ?? "");
        const pages =
          /^\d+$/.test(first) &&
          /^\d+$/.test(last) &&
          Number(last) >= Number(first) &&
          Number(last) - Number(first) < 1000
            ? Number(last) - Number(first) + 1
            : undefined;
        return {
          paperId: w.id.split("/").at(-1),
          title: String(w.title ?? "").slice(0, 1000),
          authors: Array.isArray(w.authorships)
            ? w.authorships
                .slice(0, 30)
                .flatMap((a: any) =>
                  typeof a?.author?.display_name === "string"
                    ? [a.author.display_name.slice(0, 120)]
                    : []
                )
                .join("、")
            : "",
          venue: String(w.primary_location?.source?.display_name ?? "").slice(
            0,
            500
          ),
          access: w.open_access?.is_oa === true ? "full" : "abstract_only",
          ...(pages
            ? { pages, note: "页数取公开书目页码范围估计，尚未下载PDF核验。" }
            : { note: "公开元数据未提供可靠页数；估价将明确使用保守假设。" }),
        } as CandidateMetadata;
      })
  );
}
/** Called only after output schema and online capability checks, in the success transaction. */
export async function publishSearch(
  c: pg.PoolClient,
  account: string,
  dossier: string,
  run: string,
  requestId: string,
  result: object
) {
  const records = sidecars.get(result);
  if (!records) return;
  for (const record of records) {
    if (!/^W[0-9]{1,30}$/.test(record.paperId))
      throw new ApiFailure("PAPER_SCOPE_DENIED", 403, "候选来源无效。");
    await c.query(
      "insert into read_candidate(id,account_id,dossier_id,run_id,request_id,paper_id,metadata) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing",
      [
        randomUUID(),
        account,
        dossier,
        run,
        requestId,
        record.paperId,
        JSON.stringify(scrub(record)),
      ]
    );
  }
}
export function candidateView(row: any) {
  return { id: row.id, ...row.metadata };
}
export async function currentChoice(c: pg.PoolClient, dossier: string) {
  return (
    await c.query(
      `select s.selection_revision revision,p.id,p.paper_id "paperId",p.metadata,a.state "approvalState" from read_clarification s join read_candidate p on p.account_id=s.account_id and p.dossier_id=s.dossier_id and p.id=s.chosen_id join approval a on a.account_id=s.account_id and a.id=s.chosen_approval where s.dossier_id=$1 and a.state='approved'`,
      [dossier]
    )
  ).rows[0];
}
export function nativeQuestions(effects: any): any[] {
  return (Array.isArray(effects) ? effects : []).flatMap((e) =>
    Array.isArray((e?.properties ?? e)?.questions)
      ? (e?.properties ?? e).questions
      : []
  );
}
export async function pickView(c: pg.PoolClient, dossier: string, a: any) {
  const questions = nativeQuestions(a.effects);
  if (questions.length !== 1) return null;
  const q = questions[0];
  if (
    q.header !== "REINLAB_PAPER_PICK" ||
    q.multiple === true ||
    !Array.isArray(q.options) ||
    q.options.length < 2
  )
    return null;
  const ids = q.options.map((o: any) => o.label);
  if (
    new Set(ids).size !== ids.length ||
    !ids.includes("都不是") ||
    ids.some(
      (id: any) =>
        id !== "都不是" &&
        (typeof id !== "string" || !/^W[0-9]{1,30}$/.test(id))
    )
  )
    return null;
  const rows = (
    await c.query(
      "select distinct on(paper_id) id,paper_id,metadata from read_candidate where dossier_id=$1 and run_id=$2 and paper_id=any($3::text[]) order by paper_id,created_at desc,id",
      [
        dossier,
        a.runId ?? a.run_id,
        ids.filter((id: string) => id !== "都不是"),
      ]
    )
  ).rows;
  if (rows.length !== ids.length - 1) return null;
  return {
    type: "pick",
    id: a.id,
    query: q.question,
    candidates: ids
      .filter((id: string) => id !== "都不是")
      .map((id: string) => candidateView(rows.find((r) => r.paper_id === id))),
    state: a.state === "pending" && !a.sent ? "pending" : "answered",
  };
}
