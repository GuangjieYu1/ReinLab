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

  it("has no kept table depending on a business table, so no CASCADE is needed", async () => {
    // TRUNCATE ... CASCADE is deliberately not used: if a kept relation still
    // referenced business rows the reset would abort instead of silently
    // cascading. This asserts that invariant statically (no locks in the suite).
    const rows = (
      await pool.query(
        `select c.conrelid::regclass::text child, c.confrelid::regclass::text parent
         from pg_constraint c
         join pg_class p on p.oid = c.confrelid
         join pg_namespace n on n.oid = p.relnamespace
         where c.contype = 'f' and n.nspname in ('public','reinlab_meta')`,
      )
    ).rows;
    const listed = new Set<string>(BUSINESS_TABLES as readonly string[]);
    const keptParents = rows
      .filter((row) => listed.has(row.parent) && !listed.has(row.child))
      .map((row) => `${row.child} -> ${row.parent}`);
    expect(keptParents).toEqual([]);
  });
});
