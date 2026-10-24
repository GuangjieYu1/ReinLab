import { it, expect, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { mcpFixture } from './mcp-fixture';
import { createSmokeApp } from '../src/api/smoke-app';

it('one-shot operator estimates through the real API using file configuration rather than ambient pricing ENV', async () => {
  const f = await mcpFixture(undefined, false, '1.1.0');
  try {
    vi.stubEnv('MODEL_USD_CNY_RATE', '0');
    for (const tier of ['CHEAP', 'MID', 'STRONG']) vi.stubEnv('MODEL_ROUTE_' + tier, 'wrong/model');
    const catalog = vi.fn(async (url: unknown) => {
      expect(url).toBe('https://models.dev/api.json');
      return Response.json({ deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.3, output: 1.2 }, limit: { context: 1000000, output: 4000 } } } } });
    });
    vi.stubGlobal('fetch', catalog);
    const secret = randomBytes(48), issuer = 'https://smoke-config.fixture/auth/v1';
    const app = await createSmokeApp({ pool: f.pool, auth: { issuer, secret } }, {
      MODEL_ROUTE_CHEAP: 'deepseek/deepseek-v4-flash', MODEL_ROUTE_MID: 'deepseek/deepseek-v4-flash', MODEL_ROUTE_STRONG: 'deepseek/deepseek-v4-flash', MODEL_USD_CNY_RATE: '7.2',
    });
    const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience('authenticated').setSubject(f.account).setIssuedAt().setExpirationTime('1h').sign(secret);
    const response = await app.request('/v1/runs/estimate', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ dossierId: f.dossier, mode: 'read' }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ model: 'deepseek/deepseek-v4-flash', usdCnyRate: '7.200000', assumptions: { benchVersion: '1.1.0', usageIsEstimate: true } });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect((await f.admin.query('select count(*) from run where account_id=$1', [f.account])).rows[0].count).toBe('1');
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await f.close(); }
});
