import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import {
  loadCapabilityCatalog,
  type CapabilityCatalog,
} from "../src/mcp/registry";
import type { AuthorizedCapability } from "../src/mcp/handler";

/**
 * Minimal kernel fixture: one account/dossier/run plus the real capability
 * catalog. Only the tables the reading path touches are seeded, so a test never
 * depends on the retired bench/MCP machinery.
 */
export async function kernelFixture(options?: { chosenPaperId?: string }) {
  const admin = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      "postgres://postgres@127.0.0.1:55432/reinlab_test",
    connectionTimeoutMillis: 3000,
  });
  const pool = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL_APP ??
      "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    connectionTimeoutMillis: 3000,
  });
  const db = new Database(pool),
    account = randomUUID(),
    dossier = randomUUID(),
    run = randomUUID();
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path,bench_version) values($1::uuid,$2::uuid,'research','fixture','/data/dossiers/'||$1::text,'2.0.0')",
    [dossier, account],
  );
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1::uuid,$2::uuid,$3::uuid,'research-read','read',$4,'running',5,$5::jsonb)`,
    [
      run,
      account,
      dossier,
      randomUUID(),
      JSON.stringify(
        options?.chosenPaperId ? { chosenPaperId: options.chosenPaperId } : {},
      ),
    ],
  );
  const catalog: CapabilityCatalog = await loadCapabilityCatalog();
  const context = {
    claims: { account, dossier, run, role: "research-read" },
    scope: { grants: [] },
    catalog,
  } as unknown as AuthorizedCapability;
  return {
    admin,
    pool,
    db,
    account,
    dossier,
    run,
    catalog,
    context,
    async close() {
      await pool.end();
      await admin.end();
    },
  };
}
