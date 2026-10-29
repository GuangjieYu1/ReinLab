import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { createKernelDispatch } from "../src/kernel/dispatch";

const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 3,
});
const db = new Database(pool);
const account = randomUUID();
const dossier = randomUUID();
const runId = randomUUID();

const work = {
  id: "https://openalex.org/W3000000001",
  title: "Toolformer: Language Models Can Teach Themselves to Use Tools",
  open_access: { is_oa: true },
};

const wire = (body: unknown) => ({
  status: 200,
  bytes: Buffer.from(JSON.stringify(body)),
});
const atom = (id: string, title: string) => ({
  status: 200,
  bytes: Buffer.from(
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/${id}v1</id><title>${title}</title><summary>summary</summary><author><name>Fixture Author</name></author></entry></feed>`,
  ),
});

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','dispatch','/data/dossiers/'||$1::text)",
    [dossier, account],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'running',1,'{}')",
    [runId, account, dossier, randomUUID()],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("kernel tool dispatch", () => {
  it("routes papers.search to the real literature handler and returns real candidates", async () => {
    const dispatch = createKernelDispatch({
      db,
      cacheRoot: mkdtempSync(join(tmpdir(), "papers-cache-")),
      deposit: async () => {},
      cardDeposit: async () => {},
      http: {
        get: async () => atom("2302.04761", "Toolformer: Language Models Can Teach Themselves to Use Tools"),
      } as never,
    });
    const result = (await dispatch({
      account,
      dossier,
      run: runId,
      server: "papers",
      tool: "search",
      args: { query: "toolformer" },
    })) as { papers: Array<{ paperId: string; title: string }> };
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toContain("Toolformer");
    expect(result.papers[0].paperId).toBe("arxiv:2302.04761v1");
  });

  it("configured OpenAlex 仍按 work 编号返回候选", async () => {
    const previous = process.env.OPENALEX_API_KEY;
    process.env.OPENALEX_API_KEY = "fixture-key";
    try {
      const dispatch = createKernelDispatch({
        db,
        cacheRoot: mkdtempSync(join(tmpdir(), "papers-cache-")),
        deposit: async () => {},
        cardDeposit: async () => {},
        http: { get: async () => wire({ results: [work] }) } as never,
      });
      const result = (await dispatch({
        account,
        dossier,
        run: runId,
        server: "papers",
        tool: "search",
        args: { query: "toolformer" },
      })) as { papers: Array<{ paperId: string; title: string }> };
      expect(result.papers[0].paperId).toBe("W3000000001");
    } finally {
      if (previous === undefined) delete process.env.OPENALEX_API_KEY;
      else process.env.OPENALEX_API_KEY = previous;
    }
  });

  it("把分层讲解卡 body[].refs[] 里的 arXiv 号换成这次运行的资产 id", async () => {
    // 模型的页码依据习惯写 arXiv 号，而 schema 与回执按资产 id 核账：
    // dispatch 必须在落卡前换掉，否则整张讲解卡被拒，讲解写不出来。
    const assetId = randomUUID();
    await admin.query(
      "insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,status,is_open_access,sha256,path,abstract,view_metadata) values($1,$2,$3,$4,'arxiv:2302.04799v1','https://arxiv.org/abs/2302.04799','full_text',true,repeat('b',64),'papers/y.pdf','', '{}')",
      [assetId, account, dossier, runId],
    );
    const seen: Array<{ args: any }> = [];
    const dispatch = createKernelDispatch({
      db,
      cacheRoot: mkdtempSync(join(tmpdir(), "papers-cache-")),
      deposit: async () => {},
      cardDeposit: async () => {},
      cardHandlers: () => ({
        "cards.card.layer": async (_context: unknown, args: unknown) => {
          seen.push({ args });
          return { cardId: "card-layer", cardType: "layer" };
        },
      }),
      http: { get: async () => wire({ results: [] }) } as never,
    });
    await dispatch({
      account,
      dossier,
      run: runId,
      server: "cards",
      tool: "card.layer",
      args: {
        card: {
          paperId: "arxiv:2302.04799v1",
          no: "1",
          title: "提出问题",
          en: "Problem",
          body: [{ text: "这一层讲问题。", refs: [{ paperId: "arxiv:2302.04799v1", page: 1, quote: "原文" }] }],
        },
      },
    });
    expect(seen).toHaveLength(1);
    const card = seen[0].args.card;
    expect(card.paperId).toBe(assetId);
    expect(card.body[0].refs[0].paperId).toBe(assetId);
  });

  it("routes a finding card to the card layer and returns its receipt", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const dispatch = createKernelDispatch({
      db,
      cacheRoot: mkdtempSync(join(tmpdir(), "papers-cache-")),
      deposit: async () => {},
      cardDeposit: async () => {},
      cardHandlers: () => ({
        "cards.card.finding": async (_context: unknown, args: unknown) => {
          calls.push({ tool: "card.finding", args });
          return { cardId: "card-1", cardType: "finding" };
        },
      }),
      http: { get: async () => wire({ results: [] }) } as never,
    });
    const result = (await dispatch({
      account,
      dossier,
      run: runId,
      server: "cards",
      tool: "card.finding",
      args: { text: "工具调用显著提升事实性" },
    })) as { cardId: string };
    expect(result.cardId).toBe("card-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ text: "工具调用显著提升事实性" });
  });

  it("refuses tools it does not implement instead of inventing a result", async () => {
    const dispatch = createKernelDispatch({
      db,
      cacheRoot: mkdtempSync(join(tmpdir(), "papers-cache-")),
      deposit: async () => {},
      cardDeposit: async () => {},
      http: { get: async () => wire({ results: [] }) } as never,
    });
    await expect(
      dispatch({ account, dossier, run: runId, server: "cards", tool: "card.unknown", args: {} }),
    ).rejects.toMatchObject({ code: "KERNEL_TOOL_UNSUPPORTED" });
    await expect(
      dispatch({ account, dossier, run: runId, server: "papers", tool: "delete", args: {} }),
    ).rejects.toMatchObject({ code: "KERNEL_TOOL_UNSUPPORTED" });
  });

  it("层的写入落在内核卡片层：引用本轮读过的页才通过，并留下 card_created", async () => {
    const assetId = randomUUID();
    const pageText = "Toolformer learns to call APIs.";
    await admin.query(
      "insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,status,is_open_access,sha256,path,abstract,view_metadata) values($1,$2,$3,$4,'arxiv:2302.04761v1','https://arxiv.org/abs/2302.04761','full_text',true,repeat('a',64),'papers/x.pdf','', '{}')",
      [assetId, account, dossier, runId],
    );
    await admin.query(
      "insert into paper_page_read(account_id,dossier_id,run_id,asset_id,page,page_text,text_sha256) values($1,$2,$3,$4,1,$5,$6)",
      [account, dossier, runId, assetId, pageText, createHash("sha256").update(pageText).digest("hex")],
    );
    const dispatch = createKernelDispatch({
      db,
      cacheRoot: mkdtempSync(join(tmpdir(), "papers-cache-")),
      deposit: async () => {},
      cardDeposit: async () => {},
      http: { get: async () => wire({ results: [] }) } as never,
    });
    const card = {
      paperId: assetId,
      no: "1",
      title: "一句话",
      en: "One-liner",
      body: [{ text: "它学会了调用工具。", refs: [{ paperId: assetId, page: 1, quote: "learns to call APIs" }] }],
    };
    const saved = (await dispatch({
      account,
      dossier,
      run: runId,
      server: "cards",
      tool: "card.layer",
      args: { card },
    })) as { cardId: string };
    expect(saved.cardId).toEqual(expect.any(String));
    const stored = await admin.query(
      "select payload from event where run_id=$1 and action='card_created' and payload->>'cardType'='layer'",
      [runId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].payload.card.body[0].text).toBe("它学会了调用工具。");

    // 没读过的页不能写进卡片：引文必须来自本轮的回执。
    await expect(
      dispatch({
        account,
        dossier,
        run: runId,
        server: "cards",
        tool: "card.layer",
        args: { card: { ...card, no: "2", body: [{ text: "编的", refs: [{ paperId: assetId, page: 1, quote: "never read this" }] }] } },
      }),
    ).rejects.toMatchObject({ code: "CARD_CITATION_UNVERIFIED" });
  });
});
