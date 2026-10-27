import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { resolve } from "node:path";
import { applyMigrations } from "../src/db/migrate";
import { BUSINESS_TABLES, resetBusinessData } from "../scripts/reset-business-data";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test";
const pool = new pg.Pool({ connectionString: url, max: 1 });

beforeAll(async () => {
  await applyMigrations(pool, resolve("infra/supabase/migrations"));
});
afterAll(async () => {
  await pool.end();
});

describe("business data reset", () => {
  it("never lists identity or provider configuration tables", () => {
    for (const kept of [
      "account",
      "credential",
      "account_machine_secret",
      "role_def",
      "bench_version",
      "reinlab_meta.machine_key",
      "reinlab_meta.migration",
    ])
      expect(BUSINESS_TABLES).not.toContain(kept as never);
  });

  it("dry run reports the tables it would truncate without touching data", async () => {
    const result = await resetBusinessData(url, { apply: false });
    expect(result.tables).toContain("run");
    expect(result.tables).toContain("dsh_session");
    expect(result.tables).toContain("usage_record");
    expect(result.tables).not.toContain("account");
    expect(result.paths).toEqual([]);
  });

  it("truncates every listed relation without CASCADE, keeping accounts", async () => {
    const client = await pool.connect();
    try {
      await client.query(
        "insert into account(id,display_name) values(gen_random_uuid(),'keep-me') on conflict do nothing",
      );
      const before = Number((await client.query("select count(*) from account")).rows[0].count);
      await client.query("begin");
      // Same statement the script runs; CASCADE is deliberately absent.
      await client.query(`truncate table ${BUSINESS_TABLES.join(", ")}`);
      const after = Number((await client.query("select count(*) from account")).rows[0].count);
      expect(after).toBe(before);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
