import pg from 'pg';
import path from 'node:path';
import { applyMigrations } from '../src/db/migrate';

const url = process.env.DATABASE_URL ?? (process.argv.includes('--local-test') ? 'postgres://postgres@127.0.0.1:55432/reinlab_test' : undefined);
if (!url) throw new Error('CONFIG_MISSING: 迁移需要 DATABASE_URL；本地测试必须显式传 --local-test');
const pool = new pg.Pool({ connectionString: url });
try { console.log({ applied: await applyMigrations(pool,path.resolve('infra/supabase/migrations')) }); }
finally { await pool.end(); }
