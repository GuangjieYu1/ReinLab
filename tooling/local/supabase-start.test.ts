import { expect, it } from 'vitest';
import { startLocalSupabase } from './supabase-start';
it('bounds idempotent CLI startup recovery after a VM restart', async () => {
  let attempts = 0;
  await startLocalSupabase(async () => { if (++attempts === 1) throw Error('LOCAL_COMMAND_FAILED'); }, async () => {});
  expect(attempts).toBe(2);
});
it('propagates configuration/resource failures and bounds persistent failures', async () => {
  for (const [code, expected] of [['LOCAL_DISK_FULL', 1], ['LOCAL_SERVICE_UNHEALTHY', 3], ['LOCAL_COMMAND_FAILED', 3]] as const) {
    let attempts = 0;
    await expect(startLocalSupabase(async () => { attempts++; throw Error(code); }, async () => {})).rejects.toThrow(code);
    expect(attempts).toBe(expected);
  }
});
