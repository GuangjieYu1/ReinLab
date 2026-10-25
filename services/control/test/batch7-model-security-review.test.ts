import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { registerClarifyModel, authorizedModelPort } from '../src/clarify/model';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEEPSEEK_PRICING_VERSION } from '../src/bridge/openscience/deepseek-pricing';
import { reflectsCredential } from '../src/clarify/credential-reflection';
vi.mock('../src/ledger', async original => ({ ...await original<Record<string, unknown>>(), appendEvent: vi.fn() }));
vi.mock('../src/budget', async original => ({ ...await original<Record<string, unknown>>(), lockBudget: vi.fn() }));

it.each(['no-terminal', 'oversized-usage', 'split-token', 'usage-decreases', 'usage-increases', 'usage-identical'])('model response %s releases reservation only for a consistent complete receipt', async mode => {
  const token = 'fixture_model_token_123456789', states: string[] = [], proofs: any[] = [], claims = { account: randomUUID(), dossier: randomUUID(), run: randomUUID(), role: 'research-clarify', version: '1.2.0' };
  const auth = { claims, scope: { grants: [{ name: 'papers.search' }] } };
  const client = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('select pricing_context')) return { rows: [{ pricing_context: { currency:'CNY',window:'peak',pricingVersion: DEEPSEEK_PRICING_VERSION, usdCnyRate: '7.2', validFrom: Date.now() - 10000, validUntil: Date.now() + 10000 } }] };
    if (sql.startsWith('insert into clarify_model_request')) states.push('forwarding');
    if (sql.includes("set state='completed'")) { states.push('completed'); if (typeof args?.[3] === 'string') proofs.push(JSON.parse(args[3])); }
    if (sql.includes("set state='unknown'")) states.push('unknown');
    return { rows: [], rowCount: 1 };
  } };
  const authority = { validateModel: async () => auth, validateModelClient: async () => auth, db: { withAccount: async (_id: string, work: (c: typeof client) => unknown) => work(client) } };
  const chunks: any[] = mode === 'split-token' ? [
    { choices: [{ index: 0, delta: { content: token.slice(0, 9) } }] },
    { choices: [{ index: 0, delta: { content: token.slice(9) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 } },
  ] : mode.startsWith('usage-') ? [
    { choices: [{ index: 0, delta: { content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    { choices: [], usage: { prompt_tokens: mode === 'usage-decreases' ? 1 : mode === 'usage-increases' ? 101 : 100, completion_tokens: mode === 'usage-decreases' ? 1 : mode === 'usage-increases' ? 21 : 20 } },
  ] : [{ choices: [{ index: 0, delta: { content: 'fixture' }, ...(mode === 'no-terminal' ? {} : { finish_reason: 'stop' }) }], usage: { prompt_tokens: 100, completion_tokens: mode === 'oversized-usage' ? 257 : 4, total_tokens: mode === 'oversized-usage' ? 357 : 104 } }];
  const response = chunks.map(v => 'data: ' + JSON.stringify({model:'deepseek-flash',...v}) + '\n\n').join('') + 'data: [DONE]\n\n';
  const app = new Hono(); registerClarifyModel(app as never, authority as never, { prepare: async () => async () => new Response(response, { headers: { 'content-type': 'text/event-stream' } }) });
  const result = await app.request('/mcp/clarify-model', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', stream: true, thinking: { type: 'disabled' }, max_tokens: 256, messages: [{ role: 'user', content: 'fixture' }] }) });
  if (mode === 'usage-identical') {
    expect(result.status).toBe(200); expect(states).toEqual(['forwarding', 'completed']);
    expect(proofs[0]).toMatchObject({ promptTokens: 100, completionTokens: 20, costUpperMicros: 389, responseModel: 'deepseek-flash', pricingVersion: DEEPSEEK_PRICING_VERSION });
    expect(proofs[0].responseSha256).toMatch(/^[a-f0-9]{64}$/); await result.body?.cancel();
  } else {
    expect(result.status >= 400).toBe(true); expect(states).toEqual(['forwarding', 'unknown']); expect(proofs).toEqual([]);
    expect((await result.text()).includes('choices')).toBe(false);
  }
});

it('repeated tool-call indices append fragments in SDK order while separate indices remain separate', () => {
  const value = 'fixture-secret-material', args = JSON.stringify({ query: value }), cut = args.indexOf(value) + 8;
  const frame = (secondIndex: number) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 7, function: { arguments: args.slice(0, cut) } }, { index: secondIndex, function: { arguments: args.slice(cut) } }] } }] }) + '\n\ndata: [DONE]\n\n';
  expect(reflectsCredential(frame(7), [value])).toBe(true);
  expect(reflectsCredential(frame(8), [value])).toBe(false);
});

it('a prepared send cannot outlive the explicit authorization window while waiting for its DB admission', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-batch7-auth-window-'))), authorization = join(dir, 'auth.env'), key = join(dir, 'model.env');
  const now = vi.spyOn(Date, 'now').mockReturnValue(2000), fetch = vi.fn(async () => new Response('data: [DONE]\n\n'));
  vi.stubGlobal('fetch', fetch);
  try {
    await writeFile(key, "DEEPSEEK_API_KEY='fixture-only-key-material'\n", { mode: 0o600 });
    await writeFile(authorization, `AUTHORIZATION_ID='fixture'\nVALID_FROM='${new Date(1000).toISOString()}'\nVALID_UNTIL='${new Date(3000).toISOString()}'\nPRICING_VERSION='${DEEPSEEK_PRICING_VERSION}'\nMODEL_KEY_FILE='${key}'\n`, { mode: 0o600 });
    const send = await authorizedModelPort(authorization)!.prepare(); now.mockReturnValue(4000);
    let denied = false; try { await send(Buffer.from('{}')); } catch { denied = true; }
    expect(denied).toBe(true); expect(fetch).not.toHaveBeenCalled();
  } finally { now.mockRestore(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); }
});
