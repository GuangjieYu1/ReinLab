import { it, expect, vi } from "vitest";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mcpFixture, implementedCatalog } from "./mcp-fixture";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityEngine } from "../src/mcp/engine";
it("successful page receipts append one event atomically; replay does not duplicate, event failure rolls receipt back", async () => {
  const f = await mcpFixture(await implementedCatalog(), false, "1.1.0");
  try {
    const asset = randomUUID();
    await f.db.withAccount(f.account, (c) =>
      c.query(
        "insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,license,status,is_open_access,sha256,path,abstract) values($1,$2,$3,$4,'W-FIXTURE','https://example.invalid/fixture','cc-by','full_text',true,$5,'papers/fixture.pdf','')",
        [asset, f.account, f.dossier, f.run, "a".repeat(64)],
      ),
    );
    const authority = new CapabilityAuthority(
      f.db,
      new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
    );
    const token = await authority.issue(f.account, f.run);
    const engine = new CapabilityEngine(authority, {
      "papers.pages": async (_context, args) => ({
        assetId: asset,
        status: "full_text",
        pages: (args.pages as number[]).map((page) => ({
          page,
          text: "FIXTURE_PAGE_" + page,
          anchor: "paper:" + asset + "#page=" + page,
        })),
      }),
    });
    const request = {
      capability: "papers.pages",
      args: { assetId: asset, pages: [1] },
      requestId: randomUUID(),
    };
    await engine.call("papers", token, request);
    await engine.call("papers", token, request);
    await engine.call("papers", token, { ...request, requestId: randomUUID() });
    const count = async (table: string, condition: string) =>
      Number(
        (
          await f.admin.query(
            `select count(*) from ${table} where run_id=$1 and ${condition}`,
            [f.run],
          )
        ).rows[0].count,
      );
    expect(await count("paper_page_read", "page=1")).toBe(1);
    expect(await count("event", "action='paper_page_read'")).toBe(1);
    const event = (
      await f.admin.query(
        "select payload from event where run_id=$1 and action='paper_page_read'",
        [f.run],
      )
    ).rows[0];
    expect(event.payload).toMatchObject({
      assetId: asset,
      page: 1,
      quote: "FIXTURE_PAGE_1",
    });
    const original = f.db.withAccount.bind(f.db);
    const intercept = vi
      .spyOn(f.db, "withAccount")
      .mockImplementation((account, work) =>
        original(account, (client) =>
          work(
            new Proxy(client, {
              get(target, key) {
                if (key === "query")
                  return (text: any, args: any) => {
                    if (
                      typeof text === "string" &&
                      text.startsWith("insert into event(") &&
                      args?.[5] === "paper_page_read"
                    )
                      throw Error("FIXTURE_EVENT_FAILURE");
                    return (target.query as any)(text, args);
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ),
      );
    await expect(
      engine.call("papers", token, {
        ...request,
        args: { assetId: asset, pages: [2] },
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_FAILED" });
    intercept.mockRestore();
    expect(await count("paper_page_read", "page=2")).toBe(0);
    expect(await count("event", "action='paper_page_read'")).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
