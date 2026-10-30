import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applyMigrations } from "../src/db/migrate";
import { Database } from "../src/db/database";
import {
  commitRegistration,
  existingByDigest,
  prepareRegistration,
  readWorkspacePdf,
  resolveInWorkspace,
} from "../src/mcp/register";

const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 2,
});

const db = new Database(pool);
const account = randomUUID();
const dossier = randomUUID();
let home = "";
const run = randomUUID();
/** 一份最小但真实可解析的 PDF（单页，含一行可抽取文本）。 */
const PDF = Buffer.from(
  `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 12 Tf 20 100 Td (Registered Paper) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`,
);

const roots = () => ({
  host: path.join(home, "accounts", account, "dossiers", dossier),
  container: "/opt/reinlab-account/dossiers/" + dossier,
});

beforeAll(async () => {
  await applyMigrations(admin, path.resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','新的精读','/data/dossiers/'||$1::text)",
    [dossier, account],
  );
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,'research-read','read',$4,'running',1,'{}')`,
    [run, account, dossier, randomUUID()],
  );
  home = await mkdtemp(path.join(tmpdir(), "reinlab-register-"));
  await mkdir(roots().host, { recursive: true });
  await writeFile(path.join(roots().host, "paper.pdf"), PDF);
}, 30000);

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("papers.register 工作区登记", () => {
  it("只接受工作区里的路径：容器路径能映射回来，越界的拒绝", () => {
    const containerPath = "/opt/reinlab-account/dossiers/" + dossier + "/paper.pdf";
    expect(resolveInWorkspace(containerPath, roots())).toBe(path.join(roots().host, "paper.pdf"));
    expect(resolveInWorkspace("paper.pdf", roots())).toBe(path.join(roots().host, "paper.pdf"));
    expect(() => resolveInWorkspace("/etc/passwd", roots())).toThrow(/工作区/);
    expect(() => resolveInWorkspace("../../escape.pdf", roots())).toThrow(/工作区/);
  });

  it("准备阶段读文件算摘要，不写资产", async () => {
    const prepared = await prepareRegistration(
      { path: "paper.pdf", title: "Registered Paper" },
      roots(),
    );
    expect(prepared.digest).toHaveLength(64);
    expect(prepared.metadata.title).toBe("Registered Paper");
    expect(prepared.metadata.authors).toEqual([]);
    expect(prepared.metadata.doi).toBeNull();
    const count = await admin.query("select count(*)::int n from paper_asset where dossier_id=$1", [dossier]);
    expect(count.rows[0].n).toBe(0);
  });

  it("不是 PDF 的文件不认", async () => {
    await writeFile(path.join(roots().host, "note.txt"), "just text");
    await expect(readWorkspacePdf(path.join(roots().host, "note.txt"))).rejects.toThrow(/不是 PDF/);
  });

  it("批准后正式入档，同内容再登记直接复用，不再建资产", async () => {
    const deposit = async () => undefined;
    const prepared = await prepareRegistration({ path: "paper.pdf", title: "Registered Paper" }, roots());
    const first = await db.withAccount(account, (client) =>
      commitRegistration(client, { deposit, context: {} }, {
        account, dossier, run, prepared, expectedDigest: prepared.digest,
      }),
    );
    expect(first.reused).toBe(false);
    expect(first.status).toBe("full_text");
    const second = await db.withAccount(account, (client) =>
      commitRegistration(client, { deposit, context: {} }, {
        account, dossier, run, prepared, expectedDigest: prepared.digest,
      }),
    );
    expect(second.reused).toBe(true);
    expect(second.assetId).toBe(first.assetId);
    const n = await admin.query("select count(*)::int n from paper_asset where dossier_id=$1", [dossier]);
    expect(n.rows[0].n).toBe(1);
    const found = await db.withAccount(account, (client) =>
      existingByDigest(client, account, dossier, prepared.digest),
    );
    expect(found).toBeTruthy();
  });

  it("批准之后文件被换掉就拒绝，不按新内容入档", async () => {
    const deposit = async () => undefined;
    const prepared = await prepareRegistration({ path: "paper.pdf", title: "换文件" }, roots());
    await writeFile(path.join(roots().host, "paper.pdf"), Buffer.concat([PDF, Buffer.from("\n% tail\n")]));
    await expect(
      db.withAccount(account, (client) =>
        commitRegistration(client, { deposit, context: {} }, {
          account, dossier, run, prepared, expectedDigest: prepared.digest,
        }),
      ),
    ).rejects.toThrow(/变过/);
  });
});
