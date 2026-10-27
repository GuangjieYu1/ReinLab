import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
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
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toContain("Toolformer");
    expect(result.papers[0].paperId).toContain("W3000000001");
  });

  it("refuses tools it does not implement instead of inventing a result", async () => {
    const dispatch = createKernelDispatch({
      db,
      cacheRoot: mkdtempSync(join(tmpdir(), "papers-cache-")),
      deposit: async () => {},
      http: { get: async () => wire({ results: [] }) } as never,
    });
    await expect(
      dispatch({ account, dossier, run: runId, server: "cards", tool: "card.finding", args: {} }),
    ).rejects.toMatchObject({ code: "KERNEL_TOOL_UNSUPPORTED" });
    await expect(
      dispatch({ account, dossier, run: runId, server: "papers", tool: "delete", args: {} }),
    ).rejects.toMatchObject({ code: "KERNEL_TOOL_UNSUPPORTED" });
  });
});
