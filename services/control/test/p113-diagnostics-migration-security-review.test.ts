import { expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyMigrations } from '../src/db/migrate';

it('late predecessor revokes only diagnostic PUBLIC SELECT, preserves owner/stats access and applied successor bytes', async () => {
  const base = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/reinlab_test';
  const admin = new pg.Pool({ connectionString: base }), name = 'review_acl_' + randomUUID().replaceAll('-', '');
  const url = new URL(base); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const dir = await mkdtemp(path.join(tmpdir(), 'reinlab-review-acl-'));
  try {
    await admin.query(`create database "${name}"`);
    await pool.query(`create schema extensions;
      create view extensions.pg_stat_statements as select 1 n;
      create view extensions.pg_stat_statements_info as select 1 n;
      create view extensions.unrelated as select 1 n;
      grant select on all tables in schema extensions to public`);
    await writeFile(path.join(dir, '202610240001_successor.sql'), 'create table successor_probe(id integer);');
    expect(await applyMigrations(pool, dir)).toEqual(['202610240001_successor.sql']);
    const before = (await pool.query('select sha256 from reinlab_meta.migration')).rows[0].sha256;
    const migration = '202610240000_recovery_diagnostics_acl.sql';
    await writeFile(path.join(dir, migration), await readFile(path.resolve('infra/supabase/migrations', migration)));
    expect(await applyMigrations(pool, dir)).toEqual([migration]);
    expect(await applyMigrations(pool, dir)).toEqual([]);
    const rows = (await pool.query(`select c.relname, c.relowner = (select oid from pg_roles where rolname=current_user) owner_ok,
      exists(select 1 from aclexplode(c.relacl) a where a.grantee=0 and a.privilege_type='SELECT') public_select,
      has_table_privilege('pg_read_all_stats',c.oid,'SELECT') stats_select
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='extensions' order by c.relname`)).rows;
    expect(rows).toEqual([
      { relname: 'pg_stat_statements', owner_ok: true, public_select: false, stats_select: true },
      { relname: 'pg_stat_statements_info', owner_ok: true, public_select: false, stats_select: true },
      { relname: 'unrelated', owner_ok: true, public_select: true, stats_select: true },
    ]);
    expect((await pool.query("select sha256 from reinlab_meta.migration where name='202610240001_successor.sql'")).rows[0].sha256).toBe(before);
  } finally {
    await pool.end(); await admin.query(`drop database if exists "${name}"`); await admin.end(); await rm(dir, { recursive: true, force: true });
  }
});
