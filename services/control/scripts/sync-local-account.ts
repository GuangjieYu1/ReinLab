/** Explicit local account administration. Credentials never leave host memory except to local Auth. */
import { SignJWT } from 'jose';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localPaths } from '../../../tooling/local/paths';
import { readPrivateEnv, writePrivateEnv, parseSupabaseStatus } from '../../../tooling/local/config';
import { quietCommand } from '../../../tooling/local/process';
import { readRuntimeConfiguration } from '../src/configuration';
import { LocalUsername, LocalLoginAlias } from '../src/local-login';
const AuthUser = z.object({
  id: z.string().uuid(), email: z.string().email(),
  user_metadata: z.record(z.unknown()).nullish(),
});

let stage = 'configuration';
try {
  if (process.env.DEEPSEEK_API_KEY || process.env.NODE_DEBUG) throw Error();
  const paths = localPaths(), file = join(paths.state, 'verification-users.env');
  const users = await readPrivateEnv(file), runtime = readRuntimeConfiguration(paths.runtime);
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--account')) throw Error();
  const accountId = z.string().uuid().parse(args[1] ?? users.A_ACCOUNT_ID);
  const username = LocalUsername.parse(users.A_EMAIL);
  const password = z.string().min(6).max(4096).parse(users.A_PASSWORD);
  if (runtime.PROVISIONER_DRIVER !== 'docker') throw Error();
  const status = parseSupabaseStatus(await quietCommand('pnpm', ['exec', 'supabase', 'status', '--workdir', 'infra', '-o', 'json'], {
    cwd: paths.root,
    env: { HOME: homedir(), PATH: process.env.PATH, DOCKER_HOST: runtime.DOCKER_HOST,
      DOCKER_CONFIG: join(paths.state, 'docker-client') },
    timeoutMs: 30000,
  }));
  if (status.apiUrl !== runtime.SUPABASE_URL) throw Error();
  const key = new TextEncoder().encode(status.jwtSecret);
  let token: string;
  try {
    token = await new SignJWT({ role: 'service_role' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer('supabase').setIssuedAt().setExpirationTime('60s').sign(key);
  } finally { key.fill(0); }
  const endpoint = new URL('/auth/v1/admin/users/' + accountId, status.apiUrl);
  const request = (method: string, body?: object) => fetch(endpoint, {
    method, headers: { authorization: 'Bearer ' + token, apikey: token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  stage = 'account';
  const found = await request('GET');
  if (!found.ok) { await found.body?.cancel(); throw Error(); }
  const user = AuthUser.parse(await found.json());
  const alias = LocalLoginAlias.parse({ username, email: user.email, accountId: user.id });
  if (alias.accountId !== accountId) throw Error();
  stage = 'password';
  const updated = await request('PUT', {
    password, user_metadata: { ...user.user_metadata, username },
  });
  if (!updated.ok) { await updated.body?.cancel(); throw Error(); }
  const result = AuthUser.parse(await updated.json());
  if (result.id !== accountId || result.email !== alias.email) throw Error();
  stage = 'alias';
  await writePrivateEnv(join(paths.state, 'login-alias.env'), {
    USERNAME: username, AUTH_EMAIL: alias.email, ACCOUNT_ID: accountId,
  });
  await writePrivateEnv(file, { ...users, A_ACCOUNT_ID: accountId });
  console.log(JSON.stringify({ code: 'LOCAL_ACCOUNT_SYNCED', sameAccount: true, credentialsPrinted: false }));
} catch {
  console.error(JSON.stringify({ code: 'LOCAL_ACCOUNT_SYNC_FAILED', stage }));
  process.exitCode = 1;
}
