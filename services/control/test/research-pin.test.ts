import { it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { applyMigrations } from "../src/db/migrate";
import { Database } from "../src/db/database";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { HarnessStore, publishBench } from "../src/harness/store";
it("existing dossier stays pinned1.0.0 while new dossier1.2.0 sees cards and clarification; version cannot be silently updated", async () => {
  const admin = new pg.Pool({
      connectionString: "postgres://postgres@127.0.0.1:55432/reinlab_test",
    }),
    pool = new pg.Pool({
      connectionString: "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    });
  try {
    await applyMigrations(admin, resolve("infra/supabase/migrations"));
    const registry = await loadToolRegistry(),
      old = await loadBenchBundle({
        benchId: "research",
        version: "1.0.0",
        registry,
      }),
      current = await loadBenchBundle({ benchId: "research", registry });
    await publishBench(admin, old, registry);
    await publishBench(admin, current, registry);
    const account = randomUUID(),
      other = randomUUID(),
      oldId = randomUUID(),
      newId = randomUUID();
    await admin.query("insert into account(id) values($1),($2)", [
      account,
      other,
    ]);
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path,bench_version) values($1,$2,'research','old',$3,'1.0.0')",
      [oldId, account, "/data/dossiers/" + oldId]
    );
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','new',$3)",
      [newId, account, "/data/dossiers/" + newId]
    );
    const db = new Database(pool),
      store = new HarnessStore(db, current, registry);
    expect((await store.effective(account, oldId)).manifest.cards).toEqual({});
    expect((await store.effective(account, oldId)).manifest.version).toBe(
      "1.0.0"
    );
    expect((await store.effective(account, newId)).manifest.version).toBe(
      "1.2.0"
    );
    await expect(
      db.withAccount(account, (c) =>
        c.query("update dossier set bench_version='1.1.0' where id=$1", [oldId])
      )
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await db.withAccount(other, (c) =>
          c.query("select bench_version from dossier where id=$1", [oldId])
        )
      ).rowCount
    ).toBe(0);
  } finally {
    await pool.end();
    await admin.end();
  }
});
