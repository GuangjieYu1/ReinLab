import { runtimeConfiguration } from "../src/configuration";
const config = runtimeConfiguration();
import pg from 'pg';
import path from 'node:path';
import { applyMigrations } from '../src/db/migrate';

const url = config.DATABASE_URL ?? (process.argv.includes('--local-test') ? 'postgres://postgres@127.0.0.1:55432/reinlab_test' : undefined);
if (!url) throw new Error('CONFIG_MISSING: 迁移需要受保护配置文件中的 DATABASE_URL；REINLAB_RUNTIME_CONFIG_FILE 只传文件路径，本地测试必须显式传 --local-test');
const pool = new pg.Pool({ connectionString: url });
try { console.log({ applied: await applyMigrations(pool,path.resolve('infra/supabase/migrations')) }); }
finally { await pool.end(); }
