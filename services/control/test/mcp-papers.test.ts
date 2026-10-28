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

it("检索走 arXiv：候选是可下载的 arXiv 编号，下载得到全文，限流按业务错误报", async () => {
  const f = await mcpFixture(await implementedCatalog()),
    cache = await realpath(await mkdtemp(path.join(tmpdir(), "reinlab-paper-cache-")));
  const previous = process.env.OPENALEX_API_KEY;
  delete process.env.OPENALEX_API_KEY;
  try {
    const authority = new CapabilityAuthority(
        f.db,
        new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
      ),
      context = await authority.validate(await authority.issue(f.account, f.run));
    const atom = (id: string) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/${id}v2</id>
    <title>Toolformer &amp; Tools</title>
    <summary>Language models learn to call tools.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
  </entry>
</feed>`;
    let throttled = false,
      narrow = false;
    const seen: string[] = [];
    const http = new PaperHttp({
      dns: async () => ["93.184.216.34"],
      wire: async (url) => {
        seen.push(url.href);
        if (url.hostname === "arxiv.org")
          return { status: 200, headers: { contentType: "application/pdf" }, bytes: pdf() };
        if (throttled) return { status: 429, headers: {}, bytes: Buffer.from("Too Many Requests") };
        if (narrow && (url.searchParams.get("search_query") ?? "").split("all:").length > 4)
          return {
            status: 200,
            headers: { contentType: "application/atom+xml" },
            bytes: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'),
          };
        return {
          status: 200,
          headers: { contentType: "application/atom+xml" },
          bytes: Buffer.from(atom("2403.05521")),
        };
      },
    });
    const handlers = paperHandlers(f.db, cache, async () => {}, http);
    const search = (await handlers["papers.search"](
      context,
      { query: "Toolformer: language models use tools" },
      randomUUID(),
    )) as { papers: Array<Record<string, unknown>> };
    expect(search.papers).toEqual([
      {
        paperId: "arxiv:2403.05521v2",
        title: "Toolformer & Tools",
        source: "http://arxiv.org/abs/2403.05521v2",
        isOpenAccess: true,
      },
    ]);
    // arXiv learns AND-ed terms, so punctuation from the question must not leak through.
    expect(decodeURIComponent(seen[0])).toContain("all:Toolformer+AND+all:language+AND+all:models");

    const fetched = await handlers["papers.fetch"](
      context,
      { paperId: "2403.05521v2" },
      randomUUID(),
    );
    expect(fetched).toMatchObject({ status: "full_text", isOpenAccess: true, license: null });
    const saved = await f.db.withAccount(f.account, (c) =>
      c.query("select paper_id,abstract,view_metadata from paper_asset where id=$1", [fetched.assetId]),
    );
    expect(saved.rows[0]).toMatchObject({
      paper_id: "arxiv:2403.05521v2",
      abstract: "Language models learn to call tools.",
      view_metadata: { title: "Toolformer & Tools", authors: ["Ada Lovelace", "Alan Turing"], venue: "arXiv" },
    });
    const pages = await handlers["papers.pages"](
      context,
      { assetId: fetched.assetId, pages: [2] },
      randomUUID(),
    );
    expect(pages.pages[0]).toMatchObject({ page: 2, text: "PAGE_TWO" });

    // 长问题全 AND 往往一条都匹配不到，检索应自动收窄而不是直接回"没找到"。
    narrow = true;
    const relaxed = (await handlers["papers.search"](
      context,
      { query: "Toolformer language models teach themselves to use tools" },
      randomUUID(),
    )) as { papers: Array<Record<string, unknown>> };
    expect(relaxed.papers).toHaveLength(1);
    narrow = false;

    // 每个来源的失败都带回错误码；三家都没成才是本次调用失败。
    throttled = true;
    const failed = await handlers["papers.search"](context, { query: "toolformer" }, randomUUID()).catch(
      (error: any) => error,
    );
    expect(failed).toMatchObject({ code: "PAPERS_UNAVAILABLE" });
    expect(String(failed.message)).toContain("arxiv=PAPERS_UPSTREAM_STATUS");
    await expect(
      handlers["papers.search"](context, { query: "!!!", source: "arxiv" }, randomUUID()),
    ).rejects.toMatchObject({ code: "PAPERS_UNAVAILABLE" });
  } finally {
    if (previous === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = previous;
    await f.close();
    await rm(cache, { recursive: true, force: true });
  }
});

it("检索按来源分别报告结果与失败，DOI 候选能走 Unpaywall 拿到全文", async () => {
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
      wire: async (url) => {
        if (url.hostname === "api.openalex.org")
          return { status: 429, headers: {}, bytes: Buffer.from('{"error":"Rate limit exceeded"}') };
        if (url.hostname === "api.crossref.org" && url.pathname === "/works")
          return {
            status: 200,
            headers: { contentType: "application/json" },
            bytes: Buffer.from(
              JSON.stringify({ message: { items: [{ DOI: "10.1234/abc", title: ["Crossref Paper"] }] } }),
            ),
          };
        if (url.hostname === "api.crossref.org")
          return {
            status: 200,
            headers: { contentType: "application/json" },
            bytes: Buffer.from(
              JSON.stringify({
                message: {
                  title: ["Crossref Paper"],
                  abstract: "<jats:p>We study things.</jats:p>",
                  author: [{ given: "Ada", family: "Lovelace" }],
                  "container-title": ["Journal of Fixtures"],
                },
              }),
            ),
          };
        if (url.hostname === "api.unpaywall.org")
          return {
            status: 200,
            headers: { contentType: "application/json" },
            bytes: Buffer.from(
              JSON.stringify({
                is_oa: true,
                best_oa_location: { url_for_pdf: "https://arxiv.org/pdf/10.1234", license: "cc-by" },
              }),
            ),
          };
        if (url.hostname === "arxiv.org")
          return { status: 200, headers: { contentType: "application/pdf" }, bytes: pdf() };
        return {
          status: 200,
          headers: { contentType: "application/atom+xml" },
          bytes: Buffer.from(
            `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2403.05521v1</id><title>arXiv Paper</title><summary>Abstract.</summary></entry></feed>`,
          ),
        };
      },
    });
    const handlers = paperHandlers(f.db, cache, async () => {}, http);

    const all = (await handlers["papers.search"](context, { query: "fixtures" }, randomUUID())) as any;
    expect(all.papers.map((paper: any) => paper.paperId).sort()).toEqual([
      "arxiv:2403.05521v1",
      "doi:10.1234/abc",
    ]);
    expect(all.sources).toEqual([
      { source: "arxiv", ok: true, count: 1 },
      { source: "openalex", ok: false, count: 0, error: { code: "PAPERS_UPSTREAM_STATUS", message: expect.any(String) } },
      { source: "crossref", ok: true, count: 1 },
    ]);

    const only = (await handlers["papers.search"](context, { query: "fixtures", source: "crossref" }, randomUUID())) as any;
    expect(only.papers).toEqual([
      { paperId: "doi:10.1234/abc", title: "Crossref Paper", source: "https://doi.org/10.1234/abc", isOpenAccess: false },
    ]);
    await expect(
      handlers["papers.search"](context, { query: "fixtures", source: "semantic-scholar" }, randomUUID()),
    ).rejects.toMatchObject({ code: "PAPERS_UNAVAILABLE" });

    const fetched = await handlers["papers.fetch"](context, { paperId: "10.1234/abc" }, randomUUID());
    expect(fetched).toMatchObject({ status: "full_text", license: "cc-by", isOpenAccess: true });
    const saved = await f.db.withAccount(f.account, (c) =>
      c.query("select paper_id,abstract,view_metadata from paper_asset where id=$1", [fetched.assetId]),
    );
    expect(saved.rows[0]).toMatchObject({
      paper_id: "doi:10.1234/abc",
      abstract: "We study things.",
      view_metadata: { title: "Crossref Paper", authors: ["Ada Lovelace"], venue: "Journal of Fixtures" },
    });
  } finally {
    await f.close();
    await rm(cache, { recursive: true, force: true });
  }
});
