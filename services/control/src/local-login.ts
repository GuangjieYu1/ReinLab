import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { readRuntimeConfiguration } from './configuration';

export const LocalUsername = z.string().min(1).max(64).regex(/^[\p{L}\p{N}_.-]+$/u);
export const LocalLoginAlias = z.object({
  username: LocalUsername,
  email: z.string().email().max(320),
  accountId: z.string().uuid(),
}).strict();

export function readLocalLoginAlias(file: string) {
  try { lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw Error('LOCAL_LOGIN_ALIAS_UNAVAILABLE');
  }
  const config = readRuntimeConfiguration(file);
  const parsed = LocalLoginAlias.safeParse({
    username: config.USERNAME, email: config.AUTH_EMAIL, accountId: config.ACCOUNT_ID,
  });
  if (!parsed.success) throw Error('LOCAL_LOGIN_ALIAS_INVALID');
  return parsed.data;
}
