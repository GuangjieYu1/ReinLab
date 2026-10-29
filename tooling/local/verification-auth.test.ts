import { expect, it } from 'vitest';
import { authenticateVerificationUser } from './verification-auth';

const config = { url: 'http://127.0.0.1:54321', anonKey: 'fixture-anon-only' };
const identity = { email: 'local-1d9b5c59-ceab-4c98-aeb3-9654374c680c@reinlab.invalid', password: 'x'.repeat(43), registered: false };
const receipt = { user: { id: '1d9b5c59-ceab-4c98-aeb3-9654374c680c' }, access_token: 'fixture-session-token' };
it('recovers an unapplied signup using exactly the same saved identity', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const transport = (async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    return String(url).includes('/token?') ? Response.json({ error_code: 'invalid_credentials' }, { status: 400 }) : Response.json(receipt);
  }) as typeof fetch;
  expect(await authenticateVerificationUser(config, identity, transport)).toEqual({ id: receipt.user.id, token: receipt.access_token });
  expect(requests).toHaveLength(2);
  expect(requests[0].body).toEqual(requests[1].body);
  expect(requests[1].path).toBe(config.url + '/auth/v1/signup');
});
it('recovers an applied signup by login without a second registration', async () => {
  let calls = 0;
  const transport = (async () => { calls++; return Response.json(receipt); }) as typeof fetch;
  await authenticateVerificationUser(config, identity, transport);
  expect(calls).toBe(1);
});
it('never turns transient failures or invalid known-user credentials into new registrations', async () => {
  for (const [status, body, registered] of [[503, {}, false], [400, { error_code: 'invalid_credentials' }, true]] as const) {
    let calls = 0;
    const transport = (async () => { calls++; return Response.json(body, { status }); }) as typeof fetch;
    await expect(authenticateVerificationUser(config, { ...identity, registered }, transport)).rejects.toThrow('LOCAL_VERIFY_AUTH_FAILED');
    expect(calls).toBe(1);
  }
});
