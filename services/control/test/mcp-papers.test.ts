import { it, expect } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperHttp, publicIPv4 } from "../src/mcp/paper-http";
import { paperHandlers } from "../src/mcp/papers";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner } from "../src/mcp/token";
import { mcpFixture, implementedCatalog } from "./mcp-fixture";
function pdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 45 >>\nstream\nBT /F1 12 Tf 10 100 Td (PAGE_ONE) Tj ET\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    "<< /Length 45 >>\nstream\nBT /F1 12 Tf 10 100 Td (PAGE_TWO) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(text));
    text += i + 1 + " 0 obj\n" + o + "\nendobj\n";
  });
  const xref = Buffer.byteLength(text);
  text +=
    "xref\n0 8\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n";
  return Buffer.from(text);
}
it("T-MCP-7 whitelist and pinned DNS reject redirects/private addresses before making a connection", async () => {
  let calls = 0;
  const h = new PaperHttp({
    dns: async () => ["93.184.216.34"],
    wire: async () => {
      calls++;
      return {
        status: 302,
        headers: { location: "https://evil.example/private" },
        bytes: Buffer.alloc(0),
      };
    },
  });
  await expect(
    h.get("https://arxiv.org/pdf/test", ["arxiv.org"], 1024),
  ).rejects.toMatchObject({ code: "PAPERS_EGRESS_DENIED" });
  expect(calls).toBe(1);
  for (const url of [
    "http://arxiv.org/pdf",
    "https://arxiv.org.evil.example/pdf",
    "https://user:pass@arxiv.org/pdf",
    "https://127.0.0.1/",
  ])
    await expect(h.get(url, ["arxiv.org"], 1024)).rejects.toMatchObject({
      code: "PAPERS_EGRESS_DENIED",
    });
  const privateDns = new PaperHttp({
    dns: async () => ["127.0.0.1"],
    wire: async () => {
      throw Error("must not connect");
    },
  });
  await expect(
    privateDns.get("https://arxiv.org/", ["arxiv.org"], 1024),
  ).rejects.toMatchObject({ code: "PAPERS_EGRESS_DENIED" });
  for (const ip of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "192.168.0.1",
    "::1",
    "::ffff:127.0.0.1",
  ])
    expect(publicIPv4(ip)).toBe(false);
});
it("T-MCP-7 fixture OA full text preserves original PDF page anchors; non-OA remains abstract_only", async () => {
  const f = await mcpFixture(await implementedCatalog()),
    cache = await realpath(
      await mkdtemp(path.join(tmpdir(), "reinlab-paper-cache-")),
    );
  try {
    const authority = new CapabilityAuthority(
        f.db,
        new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
      ),
      context = await authority.validate(
        await authority.issue(f.account, f.run),
      );
    const deposits: Array<Record<string, unknown>> = [];
    let full = true,
      networkCalls = 0;
    const http = new PaperHttp({
      dns: async () => ["93.184.216.34"],
      wire: async (url) => {
        networkCalls++;
        if (url.hostname === "arxiv.org")
          return {
            status: 200,
            headers: { contentType: "application/pdf" },
            bytes: pdf(),
          };
        return {
          status: 200,
          headers: { contentType: "application/json" },
          bytes: Buffer.from(
            JSON.stringify({
              id: "https://openalex.org/W123",
              title: "Fixture",
              authorships: [{author: {display_name: 'Fixture Author'}}],
              primary_location: {source: {display_name: 'Fixture Venue'}},
              open_access: { is_oa: full },
              best_oa_location: {
                is_oa: full,
                pdf_url: "https://arxiv.org/pdf/1234.12345",
                license: "cc-by",
              },
              abstract_inverted_index: { Fixture: [0], abstract: [1] },
            }),
          ),
        };
      },
    });
    const handlers = paperHandlers(
      f.db,
      cache,
      async (_c, id, bytes, metadata) => {
        deposits.push({ id, full: bytes !== null, ...metadata });
      },
      http,
    );
    const fetched = await handlers["papers.fetch"](
      context,
      { paperId: "W123" },
      randomUUID(),
    );
    expect(fetched.status).toBe("full_text");
    const saved = await f.db.withAccount(f.account,c=>c.query('select view_metadata from paper_asset where id=$1',[fetched.assetId]));
    expect(saved.rows[0].view_metadata).toMatchObject({title:'Fixture',authors:['Fixture Author'],venue:'Fixture Venue',sizeBytes:pdf().length});
    expect(deposits[0]).toMatchObject(saved.rows[0].view_metadata);
    const result = await handlers["papers.pages"](
      context,
      { assetId: fetched.assetId, pages: [1, 2] },
      randomUUID(),
    );
    expect(result.pages).toEqual([
      {
        page: 1,
        anchor: "paper:" + fetched.assetId + "#page=1",
        text: "PAGE_ONE",
      },
      {
        page: 2,
        anchor: "paper:" + fetched.assetId + "#page=2",
        text: "PAGE_TWO",
      },
    ]);
    await expect(
      handlers["papers.pages"](
        context,
        { assetId: fetched.assetId, pages: [3] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "PAPER_PAGE_INVALID" });
    full = false;
    const abstractOnly = await handlers["papers.fetch"](
      context,
      { paperId: "W123" },
      randomUUID(),
    );
    expect(abstractOnly.status).toBe("abstract_only");
    expect(
      await handlers["papers.pages"](
        context,
        { assetId: abstractOnly.assetId, pages: [1] },
        randomUUID(),
      ),
    ).toMatchObject({ status: "abstract_only", pages: [] });
    expect(networkCalls).toBe(3);
    expect(deposits.map((d) => d.full)).toEqual([true, false]);
    await expect(
      handlers["papers.pages"](
        context,
        { assetId: randomUUID(), pages: [1] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "PAPER_SCOPE_DENIED" });
  } finally {
    await f.close();
    await rm(cache, { recursive: true, force: true });
  }
});

it("公开可得但未写许可的 PDF 照实存全文，许可记为 null，不降级为只有摘要", async () => {
  const f = await mcpFixture(await implementedCatalog()),
    cache = await realpath(await mkdtemp(path.join(tmpdir(), "reinlab-paper-cache-")));
  try {
    const authority = new CapabilityAuthority(
        f.db,
        new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
      ),
      context = await authority.validate(await authority.issue(f.account, f.run));
    const http = new PaperHttp({
      dns: async () => ["93.184.216.34"],
      wire: async (url) =>
        url.hostname === "arxiv.org"
          ? { status: 200, headers: { contentType: "application/pdf" }, bytes: pdf() }
          : {
              status: 200,
              headers: { contentType: "application/json" },
              bytes: Buffer.from(
                JSON.stringify({
                  id: "https://openalex.org/W123",
                  title: "Fixture",
                  authorships: [{ author: { display_name: "Fixture Author" } }],
                  primary_location: { source: { display_name: "Fixture Venue" } },
                  open_access: { is_oa: true },
                  best_oa_location: {
                    is_oa: true,
                    pdf_url: "https://arxiv.org/pdf/1234.12345",
                    license: null,
                  },
                  abstract_inverted_index: { Fixture: [0], abstract: [1] },
                }),
              ),
            },
    });
    const handlers = paperHandlers(f.db, cache, async () => {}, http);
    const fetched = await handlers["papers.fetch"](context, { paperId: "W123" }, randomUUID());
    expect(fetched.status).toBe("full_text");
    expect(fetched.license).toBeNull();
    const pages = await handlers["papers.pages"](
      context,
      { assetId: fetched.assetId, pages: [1] },
      randomUUID(),
    );
    expect(pages.pages[0]).toMatchObject({ page: 1, text: "PAGE_ONE" });
  } finally {
    await f.close();
  }
});
