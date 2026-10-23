import { it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

it("exact dossier pin migration backfills old and override versions without changing content", async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test" });
  const client = await pool.connect(), schema = "review_pin_" + randomUUID().replaceAll("-", "");
  const account = randomUUID(), old = randomUUID(), overridden = randomUUID(), fresh = randomUUID();
  try {
    await client.query("begin");
    await client.query(`create schema ${schema}; set local search_path=${schema},pg_catalog`);
    // Minimal isolated pre-migration table shapes; exact checked-in migration SQL follows.
    await client.query("create table dossier(id uuid primary key,account_id uuid,bench text,title text,workspace_path text); create table bench_effective(account_id uuid,digest text,version text); create table dossier_override(account_id uuid,dossier_id uuid,effective_digest text)");
    await client.query("insert into dossier values($1,$3,'research','unchanged old','/data/old'),($2,$3,'research','unchanged override','/data/override')", [old, overridden, account]);
    await client.query("insert into bench_effective values($1,'review-digest','1.0.0-reviewed-override')", [account]);
    await client.query("insert into dossier_override values($1,$2,'review-digest')", [account, overridden]);
    await client.query(await readFile(resolve("infra/supabase/migrations/202610230003_dossier_bench_pin.sql"), "utf8"));
    await client.query("insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','new','/data/new')", [fresh, account]);
    const rows = (await client.query("select id,title,workspace_path,bench_version from dossier")).rows;
    expect(rows.find(r => r.id === old)?.bench_version === "1.0.0").toBe(true);
    expect(rows.find(r => r.id === overridden)?.bench_version === "1.0.0-reviewed-override").toBe(true);
    expect(rows.find(r => r.id === fresh)?.bench_version === "1.1.0").toBe(true);
    expect(rows.find(r => r.id === old)?.title === "unchanged old" && rows.find(r => r.id === overridden)?.workspace_path === "/data/override").toBe(true);
    for (const sql of ["update dossier set bench_version='1.1.0' where id=$1", "update dossier set bench='engineering' where id=$1"]) {
      await client.query("savepoint pin_review");
      await expect(client.query(sql, [old])).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback to savepoint pin_review");
    }
  } finally { await client.query("rollback"); client.release(); await pool.end(); }
});
