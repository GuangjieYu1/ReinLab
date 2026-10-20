import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireStartupLock } from './startup-lock';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });
it('holds a kernel mutex across callers and releases it without deleting files', async () => {
  const first = await acquireStartupLock(0); cleanup.push(first.release);
  await expect(acquireStartupLock(first.port)).rejects.toThrow('LOCAL_SETUP_BUSY');
  await first.release();
  const second = await acquireStartupLock(first.port); cleanup.push(second.release);
});
it('refuses a foreign listener without closing or signaling it', async () => {
  const foreign = createServer();
  await new Promise<void>(done => foreign.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise<void>(done => foreign.close(() => done())));
  const port = (foreign.address() as { port: number }).port;
  await expect(acquireStartupLock(port)).rejects.toThrow('LOCAL_SETUP_BUSY');
  expect(foreign.listening).toBe(true);
});
it('releases the mutex when its owner crashes, without a stale lock-file recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reinlab-setup-lock-'));
  const script = join(root, 'lock-probe.mjs');
  await writeFile(script, `import process from 'node:process';import{acquireStartupLock}from${JSON.stringify(pathToFileURL(resolve('tooling/local/startup-lock.ts')).href)};const lock=await acquireStartupLock(0);process.send({port:lock.port});`);
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const port = await new Promise<number>((accept, reject) => {
      const timer = setTimeout(() => reject(Error('LOCK_PROBE_TIMEOUT')), 2000);
      child.once('error', reject);
      child.once('message', value => { clearTimeout(timer); accept((value as { port: number }).port); });
    });
    await expect(acquireStartupLock(port)).rejects.toThrow('LOCAL_SETUP_BUSY');
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    child.kill('SIGKILL'); await exited;
    const recovered = await acquireStartupLock(port); cleanup.push(recovered.release);
  } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
