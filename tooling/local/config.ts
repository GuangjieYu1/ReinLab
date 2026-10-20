import { constants, type Stats } from 'node:fs';
import { open, mkdir, lstat } from 'node:fs/promises';
import { dirname, resolve, parse, join } from 'node:path';
import { getuid } from 'node:process';
import { parseEnv } from 'node:util';

export function defaultModelEnvironment() {
  return {
    MODEL_ROUTE_CHEAP: 'deepseek/deepseek-v4-flash',
    MODEL_ROUTE_MID: 'deepseek/deepseek-v4-flash',
    MODEL_ROUTE_STRONG: 'deepseek/deepseek-v4-flash',
    MODEL_USD_CNY_RATE: '7.2',
  };
}

export function parseSupabaseStatus(raw: string) {
  try {
    const status = JSON.parse(raw) as Record<string, unknown>;
    const api = new URL(String(status.API_URL));
    const database = new URL(String(status.DB_URL));
    if (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || !api.port || api.pathname !== '/' || api.username || api.password || api.search || api.hash) throw Error();
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1' || !database.port || !database.username || !database.password || database.pathname !== '/postgres' || database.search || database.hash) throw Error();
    const anonKey = status.ANON_KEY;
    const jwtSecret = status.JWT_SECRET;
    if (typeof anonKey !== 'string' || anonKey.length < 16 || typeof jwtSecret !== 'string' || jwtSecret.length < 24) throw Error();
    return { apiUrl: api.origin, databaseUrl: database.href, anonKey, jwtSecret };
  } catch {
    throw new Error('LOCAL_STATUS_INVALID');
  }
}

function assertPrivate(stat: Stats) {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== getuid?.()) throw new Error('LOCAL_SECRET_PATH_UNSAFE');
}

async function assertAncestors(file: string) {
  const parent = resolve(dirname(file));
  let current = parse(parent).root;
  for (const segment of parent.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, segment);
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('LOCAL_SECRET_PATH_UNSAFE'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
  }
}

export async function writePrivateEnv(file: string, environment: Record<string, string>) {
  if (Object.entries(environment).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error('LOCAL_ENV_INVALID');
  const lines = Object.entries(environment).map(([key, value]) => {
    const line = ["'", '`', '"'].filter(candidate => !value.includes(candidate))
      .map(delimiter => `${key}=${delimiter}${value}${delimiter}`)
      .find(candidate => parseEnv(candidate)[key] === value);
    if (!line) throw new Error('LOCAL_ENV_INVALID');
    // Choose only a delimiter that Node's actual parser roundtrips exactly.
    return line;
  });
  await assertAncestors(file);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== getuid?.()) throw new Error('LOCAL_SECRET_PATH_UNSAFE');
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    assertPrivate(await handle.stat());
    await handle.truncate(0);
    await handle.writeFile(lines.join('\n') + '\n');
    await handle.sync();
  } catch {
    throw new Error('LOCAL_SECRET_PATH_UNSAFE');
  } finally {
    await handle?.close();
  }
}

export async function readPrivateEnv(file: string) {
  await assertAncestors(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    assertPrivate(stat);
    if (stat.size > 128 * 1024) throw new Error('LOCAL_SECRET_PATH_UNSAFE');
    const parsed = parseEnv(await handle.readFile('utf8'));
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } finally {
    await handle.close();
  }
}
