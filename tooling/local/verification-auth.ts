type Configuration = { url: string; anonKey: string };
type Identity = { email: string; password: string; registered: boolean };
/** Only the protected, generated verification identities; never a public signup API. */
export async function authenticateVerificationUser(config: Configuration, identity: Identity, transport: typeof fetch = fetch) {
  const failure = () => new Error('LOCAL_VERIFY_AUTH_FAILED');
  const url = new URL(config.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !/^local-[a-f0-9-]{36}@reinlab\.invalid$/.test(identity.email) || !/^[A-Za-z0-9_-]{43}$/.test(identity.password)) throw failure();
  const request = (path: string) => transport(config.url + path, {
    method: 'POST', headers: { apikey: config.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: identity.email, password: identity.password }), signal: AbortSignal.timeout(10000),
  });
  type AuthBody = { user?: { id?: string }; access_token?: string; error_code?: string };
  let response = await request('/auth/v1/token?grant_type=password');
  let body = await response.json() as AuthBody;
  if (!response.ok && !identity.registered && response.status === 400 && body.error_code === 'invalid_credentials') {
    // A saved intent whose first request never reached Auth. The same email is
    // unique in real Auth; never mint a replacement identity on unknown results.
    response = await request('/auth/v1/signup');
    body = await response.json() as AuthBody;
  }
  if (!response.ok || !/^[a-f0-9-]{36}$/.test(body.user?.id ?? '') || typeof body.access_token !== 'string' || !body.access_token) throw failure();
  return { id: body.user!.id!, token: body.access_token };
}
