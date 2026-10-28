import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountFiles } from "../src/mcp/files";
import { PaperHttp } from "../src/mcp/paper-http";
import { paperHandlers } from "../src/mcp/papers";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityAuthority } from "../src/mcp/authority";
import { implementedCatalog, mcpFixture } from "./mcp-fixture";

// No real request is permitted: simulate Node's lookup callback contract, including all:true.
vi.mock("node:https", () => ({
  request: (_url: unknown, options: any, receive: (response: any) => void) => {
    const req = new EventEmitter() as any;
    req.destroy = () => {};
    req.end = () =>
      queueMicrotask(() => {
        const all = options.family !== 4 && options.autoSelectFamily !== false;
        options.lookup(
          "arxiv.org",
          { all },
          (error: unknown, result: unknown, family: unknown) => {
            if (
              error ||
              (all
                ? !Array.isArray(result)
                : typeof result !== "string" || family !== 4)
            ) {
              req.emit(
                "error",
                new Error("fixture lookup callback shape mismatch"),
              );
              return;
            }
            const response = Readable.from([Buffer.from("fixture")]) as any;
            response.statusCode = 200;
            response.headers = {};
            receive(response);
          },
        );
      });
    return req;
  },
}));

function pdf() {
  const stream = "BT /F1 12 Tf 10 100 Td (INDEPENDENT_PAGE) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  text +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

it("independent papers: production wire honors Node22 lookup address-family contract without network", async () => {
  const http = new PaperHttp({ dns: async () => ["93.184.216.34"] });
  expect(
    (
      await http.get("https://arxiv.org/fixture", ["arxiv.org"], 100)
    ).bytes.toString(),
  ).toBe("fixture");
});

it("independent papers: every redirect rechecks all DNS answers before a connection", async () => {
  let connections = 0,
    lookups = 0;
  const http = new PaperHttp({
    dns: async () =>
      ++lookups === 1 ? ["93.184.216.34"] : ["93.184.216.34", "10.0.0.2"],
    wire: async (_url, target) => {
      // 出站目标带着系统解析器给的 family，wire 只连这一个地址。
      expect(target).toEqual({ address: "93.184.216.34", family: 4 });
      connections++;
      return {
        status: 302,
        headers: { location: "/next" },
        bytes: Buffer.alloc(0),
      };
    },
  });
  await expect(
    http.get("https://arxiv.org/start", ["arxiv.org"], 100),
  ).rejects.toMatchObject({ code: "PAPERS_EGRESS_DENIED" });
  expect(connections).toBe(1);
  expect(lookups).toBe(2);
  const old = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    expect(() => new PaperHttp({ dns: async () => [] })).toThrow(
      expect.objectContaining({ code: "TEST_DEPENDENCY_FORBIDDEN" }),
    );
  } finally {
    process.env.NODE_ENV = old;
  }
});

it("independent papers: 非开放获取只存摘要，跨账号/档案读不到资产", async () => {
  const f = await mcpFixture(await implementedCatalog()),
    cache = await realpath(
      await mkdtemp(path.join(tmpdir(), "reinlab-independent-paper-cache-")),
    );
  try {
    const authority = new CapabilityAuthority(
      f.db,
      new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
    );
    const context = await authority.validate(
      await authority.issue(f.account, f.run),
    );
    let connections = 0,
      deposited: Buffer | null | undefined;
    const http = new PaperHttp({
      dns: async () => ["93.184.216.34"],
      wire: async (url) => {
        connections++;
        expect(url.hostname).toBe("api.openalex.org");
        return {
          status: 200,
          headers: {},
          bytes: Buffer.from(
            JSON.stringify({
              id: "https://openalex.org/W99",
              // 许可缺失不再是降级理由（开放全文照取，许可记 null）；这条用例守的是非 OA 不下载与隔离。
              open_access: { is_oa: false },
              best_oa_location: {
                is_oa: true,
                pdf_url: "https://arxiv.org/pdf/fixture",
                license: null,
              },
            }),
          ),
        };
      },
    });
    const handlers = paperHandlers(
      f.db,
      cache,
      async (_context, _asset, bytes) => {
        deposited = bytes;
      },
      http,
    );
    const asset = await handlers["papers.fetch"](
      context,
      { paperId: "W99" },
      randomUUID(),
    );
    expect(asset.status).toBe("abstract_only");
    expect(connections).toBe(1);
    expect(deposited).toBeNull();
    for (const claims of [
      { ...context.claims, account: randomUUID() },
      { ...context.claims, dossier: randomUUID() },
    ])
      await expect(
        handlers["papers.pages"](
          { ...context, claims },
          { assetId: asset.assetId, pages: [1] },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "PAPER_SCOPE_DENIED" });
    await expect(
      f.db.withAccount(randomUUID(), (c) =>
        c.query("select * from paper_asset where id=$1", [asset.assetId]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      f.db.withAccount(f.account, (c) =>
        c.query("update paper_asset set source='changed' where id=$1", [
          asset.assetId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await f.close();
    await rm(cache, { recursive: true, force: true });
  }
});

it("independent papers: cached public PDF retains original anchors and tampered bytes fail closed", async () => {
  const f = await mcpFixture(await implementedCatalog()),
    cache = await realpath(
      await mkdtemp(path.join(tmpdir(), "reinlab-independent-paper-cache-")),
    );
  try {
    const authority = new CapabilityAuthority(
      f.db,
      new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
    );
    const context = await authority.validate(
      await authority.issue(f.account, f.run),
    );
    const http = new PaperHttp({
      dns: async () => ["93.184.216.34"],
      wire: async (url) => ({
        status: 200,
        headers: {},
        bytes:
          url.hostname === "arxiv.org"
            ? pdf()
            : Buffer.from(
                JSON.stringify({
                  id: "https://openalex.org/W99",
                  open_access: { is_oa: true },
                  best_oa_location: {
                    is_oa: true,
                    pdf_url: "https://arxiv.org/pdf/fixture",
                    license: "cc-by",
                  },
                }),
              ),
      }),
    });
    const handlers = paperHandlers(f.db, cache, async () => {}, http);
    // A process interrupted after creating the final cache name must not poison every later fetch.
    const expectedDigest = createHash("sha256").update(pdf()).digest("hex");
    await writeFile(
      path.join(cache, expectedDigest + ".pdf"),
      "%PDF-interrupted",
    );
    const asset = await handlers["papers.fetch"](
      context,
      { paperId: "W99" },
      randomUUID(),
    );
    expect(asset.status).toBe("full_text");
    expect(
      (
        await handlers["papers.pages"](
          context,
          { assetId: asset.assetId, pages: [1] },
          randomUUID(),
        )
      ).pages,
    ).toEqual([
      {
        page: 1,
        anchor: `paper:${asset.assetId}#page=1`,
        text: "INDEPENDENT_PAGE",
      },
    ]);
    const stored = (
      await f.admin.query("select sha256 from paper_asset where id=$1", [
        asset.assetId,
      ])
    ).rows[0];
    await writeFile(path.join(cache, stored.sha256 + ".pdf"), "%PDF-tampered");
    await expect(
      handlers["papers.pages"](
        context,
        { assetId: asset.assetId, pages: [1] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "PAPER_SCOPE_DENIED" });
  } finally {
    await f.close();
    await rm(cache, { recursive: true, force: true });
  }
});

it("independent papers: binary deposit ignores supplied paths and writes only fixed papers asset names", async () => {
  const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "reinlab-independent-paper-deposit-")),
    ),
    dossier = randomUUID(),
    assetId = randomUUID();
  try {
    const dir = path.join(root, "dossiers", dossier);
    await mkdir(path.join(dir, "findings"), { recursive: true });
    const bytes = Buffer.concat([pdf(), Buffer.from([0, 255, 128])]);
    await accountFiles(
      root,
      dossier,
      "importPaper",
      {
        assetId,
        pdf: bytes.toString("base64"),
        metadata: { path: "../escape", source: "fixture" },
        path: "findings/escape.pdf",
      },
      ["findings/"],
    );
    expect(await readFile(path.join(dir, `papers/${assetId}.pdf`))).toEqual(
      bytes,
    );
    await expect(
      readFile(path.join(dir, "findings/escape.pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      accountFiles(
        root,
        dossier,
        "importPaper",
        { assetId: "../escape", pdf: bytes.toString("base64"), metadata: {} },
        [],
      ),
    ).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
