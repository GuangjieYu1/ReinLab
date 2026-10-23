import { it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { verifyCardSources } from "../src/mcp/card-integrity";
import { mcpFixture, implementedCatalog } from "./mcp-fixture";

it("citation verification rejects whitespace-only quote even with a valid current-run receipt", async () => {
  const text = "Synthetic reviewed page text";
  const fake = { async query() { return { rowCount: 1, rows: [{ page_text: text, text_sha256: createHash("sha256").update(text).digest("hex") }] }; } };
  const context = { claims: { account: randomUUID(), dossier: randomUUID(), run: randomUUID() } };
  await expect(verifyCardSources(fake as never, context as never, "finding", { evidence: [{ paperId: randomUUID(), page: 1, quote: " \n\t " }] })).rejects.toMatchObject({ code: "CARD_CITATION_UNVERIFIED" });
});

it("paper page receipts enforce tenant isolation, append-only permissions and current-run citations", async () => {
  const f = await mcpFixture(await implementedCatalog(), false, "1.1.0");
  try {
    const asset = randomUUID(), text = "Synthetic current-run verified original text";
    await f.admin.query("insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,license,status,is_open_access,sha256,path,abstract) values($1,$2,$3,$4,'W1','https://api.openalex.org/works/W1','cc-by','full_text',true,$5,'papers/review.pdf','')", [asset, f.account, f.dossier, f.run, "a".repeat(64)]);
    const digest = createHash("sha256").update(text).digest("hex");
    await f.db.withAccount(f.account, c => c.query("insert into paper_page_read(account_id,dossier_id,run_id,asset_id,page,text_sha256,page_text) values($1,$2,$3,$4,1,$5,$6)", [f.account, f.dossier, f.run, asset, digest, text]));
    expect((await f.db.withAccount(randomUUID(), c => c.query("select 1 from paper_page_read where asset_id=$1", [asset]))).rowCount).toBe(0);
    for (const sql of ["update paper_page_read set page_text='forged' where asset_id=$1", "delete from paper_page_read where asset_id=$1"])
      await expect(f.db.withAccount(f.account, c => c.query(sql, [asset]))).rejects.toMatchObject({ code: "42501" });
    const context = { claims: { account: f.account, dossier: f.dossier, run: f.run } };
    const card = { evidence: [{ paperId: asset, page: 1, quote: "verified original" }] };
    await f.db.withAccount(f.account, c => verifyCardSources(c, context as never, "finding", card));
    await expect(f.db.withAccount(f.account, c => verifyCardSources(c, { claims: { ...context.claims, run: randomUUID() } } as never, "finding", card))).rejects.toMatchObject({ code: "CARD_CITATION_UNVERIFIED" });
    const metadata = await f.admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='paper_page_read'::regclass");
    expect(metadata.rows[0].relrowsecurity === true && metadata.rows[0].relforcerowsecurity === true).toBe(true);
  } finally { await f.close(); }
});
