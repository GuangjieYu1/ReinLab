import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, lstat, symlink, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultModelEnvironment, parseSupabaseStatus, writePrivateEnv } from './config';

const status = { API_URL: 'http://127.0.0.1:54321', DB_URL: 'postgresql://postgres:fixture-local-password@127.0.0.1:54322/postgres', ANON_KEY: 'fixture-public-key-padding', SERVICE_ROLE_KEY: 'fixture-service-key-padding', JWT_SECRET: 'fixture-jwt-secret-padding-32-characters' };
describe('local stack configuration', () => {
  it('keeps all model tiers and fixed FX explicit without embedding credentials', () => {
    expect(defaultModelEnvironment()).toEqual({ MODEL_ROUTE_CHEAP: 'deepseek/deepseek-v4-flash', MODEL_ROUTE_MID: 'deepseek/deepseek-v4-flash', MODEL_ROUTE_STRONG: 'deepseek/deepseek-v4-flash', MODEL_USD_CNY_RATE: '7.2' });
  });
  it('accepts only a complete CLI local stack status', () => {
    expect(parseSupabaseStatus(JSON.stringify(status))).toMatchObject({ apiUrl: status.API_URL, databaseUrl: status.DB_URL, anonKey: status.ANON_KEY });
    for (const patch of [{ API_URL: 'https://example.com' }, { API_URL: 'http://127.0.0.1:54321/redirect' }, { DB_URL: 'postgres://postgres@other-host/postgres' }, { JWT_SECRET: '' }, { ANON_KEY: '' }]) expect(() => parseSupabaseStatus(JSON.stringify({ ...status, ...patch }))).toThrow('LOCAL_STATUS_INVALID');
  });
  it('writes mode600 ordinary credential files and refuses symlinks or multiline values', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-private-env-')));
    try {
      const file = join(root, 'runtime.env');
      await writePrivateEnv(file, { SAFE_NAME: 'fixture-value' });
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, 'utf8')).toContain('fixture-value');
      const linked = join(root, 'linked.env'); await symlink(file, linked);
      await expect(writePrivateEnv(linked, { SAFE_NAME: 'other' })).rejects.toThrow('LOCAL_SECRET_PATH_UNSAFE');
      await expect(writePrivateEnv(join(root, 'bad.env'), { SAFE_NAME: 'line1\nline2' })).rejects.toThrow('LOCAL_ENV_INVALID');
      await writeFile(join(root, 'broad.env'), 'broad', { mode: 0o644 });
      await expect(writePrivateEnv(join(root, 'broad.env'), { SAFE_NAME: 'other' })).rejects.toThrow('LOCAL_SECRET_PATH_UNSAFE');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
