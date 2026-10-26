import { it, expect } from "vitest";
import { randomUUID, generateKeyPairSync, createHash } from "node:crypto";
import { mcpFixture } from "./mcp-fixture";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner } from "../src/mcp/token";
import { dataHandlers } from "../src/mcp/data-handlers";
it("research1.2 finding must retain read-page quote verification before any card is deposited", async () => {
  const f = await mcpFixture(undefined, false, "1.2.0");
  try {
    const authority = new CapabilityAuthority(
        f.db,
        new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
      ),
      context = await authority.validate(
        await authority.issue(f.account, f.run),
      );
    await expect(
      dataHandlers(f.db)["cards.card.finding"](
        context,
        {
          card: {
            text: "Unsupported finding",
            evidence: [
              {
                paperId: randomUUID(),
                page: 1,
                quote: "This page was never read.",
              },
            ],
            confidence: "low",
            status: "hypothesis",
          },
        },
        randomUUID(),
      ),
    ).rejects.toBeDefined();
    expect(
      (
        await f.admin.query(
          "select 1 from event where run_id=$1 and action='card_created'",
          [f.run],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
});

it("research 1.2 direct card handlers accept current-run original text and reject forged quotes before deposit", async () => {
  const f = await mcpFixture(undefined, false, "1.2.0"),
    asset = randomUUID(),
    text = "Synthetic verified original finding on this current run page.";
  try {
    const authority = new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync("ed25519").privateKey));
    const context = await authority.validate(await authority.issue(f.account,f.run));
    await f.admin.query(
      "insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,license,status,is_open_access,sha256,path,abstract)values($1,$2,$3,$4,'W1','https://api.openalex.org/works/W1','cc-by','full_text',true,$5,'papers/fixture.pdf','')",
      [asset, f.account, f.dossier, f.run, "a".repeat(64)],
    );
    await f.db.withAccount(f.account, (c) =>
      c.query(
        "insert into paper_page_read(account_id,dossier_id,run_id,asset_id,page,text_sha256,page_text)values($1,$2,$3,$4,1,$5,$6)",
        [
          f.account,
          f.dossier,
          f.run,
          asset,
          createHash("sha256").update(text).digest("hex"),
          text,
        ],
      ),
    );
    const args = (quote: string) => ({
      card: {
        text: "Fixture finding",
        evidence: [{ paperId: asset, page: 1, quote }],
        confidence: "low",
        status: "hypothesis",
      },
    });
    const handler = dataHandlers(f.db)["cards.card.finding"];
    await expect(
      handler(
        context,
        args("A forged sentence absent from the page."),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "CARD_CITATION_UNVERIFIED" });
    expect(
      (
        await f.admin.query(
          "select 1 from event where run_id=$1 and action='card_created'",
          [f.run],
        )
      ).rowCount,
    ).toBe(0);
    const result = await handler(
      context,
      args("verified original finding"),
      randomUUID(),
    );
    expect(result).toHaveProperty("cardId");
    expect(
      (
        await f.admin.query(
          "select 1 from event where run_id=$1 and action='card_created'",
          [f.run],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
