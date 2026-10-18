import type pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Only administrative CLI/tests call this; the HTTP application never does. */
export async function applyMigrations(pool: pg.Pool, directory: string): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(hashtext('reinlab.migrations'))");
    await client.query('create schema if not exists reinlab_meta');
    await client.query('revoke all on schema reinlab_meta from public');
    await client.query('create table if not exists reinlab_meta.migration(name text primary key,sha256 text not null,applied_at timestamptz not null default now())');
    for (const name of (await readdir(directory)).filter(f => /^\d+_[a-z_]+\.sql$/.test(f)).sort()) {
      const sql = await readFile(path.join(directory,name),'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query<{ sha256: string }>('select sha256 from reinlab_meta.migration where name=$1',[name]);
      if (previous.rowCount) {
        if (previous.rows[0].sha256 !== hash) throw new Error(`MIGRATION_CHANGED: 已应用迁移发生变化：${name}`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into reinlab_meta.migration(name,sha256) values($1,$2)',[name,hash]);
        await client.query('commit');
        applied.push(name);
      } catch (error) { await client.query('rollback'); throw error; }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('reinlab.migrations'))").catch(() => undefined);
    client.release();
  }
}
