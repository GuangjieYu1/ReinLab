import { getuid } from 'node:process';
import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, chmod, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateHatchetDigest } from '../../../tooling/local/hatchet-integrity.mjs';

it('private manifest preserves pinned digest order and rejects directories, FIFO, oversize and missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reinlab-review-hatchet-')), uid = getuid!();
  const names = ['database.yaml', 'server.yaml', 'pgpass'];
  try {
    for (const name of names) await writeFile(join(root, name), 'fixture-' + name, { mode: 0o600 });
    const oldOrder = names.map(n => createHash('sha256').update('fixture-' + n).digest('hex')).join(':');
    expect((await privateHatchetDigest(root, uid)) === oldOrder).toBe(true);
    await chmod(root, 0o755); await expect(privateHatchetDigest(root, uid)).rejects.toThrow(); await chmod(root, 0o700);
    await rm(join(root, 'pgpass')); await expect(privateHatchetDigest(root, uid)).rejects.toThrow();
    await mkdir(join(root, 'pgpass'), { mode: 0o600 }); await expect(privateHatchetDigest(root, uid)).rejects.toThrow(); await rm(join(root, 'pgpass'), { recursive: true });
    execFileSync('/usr/bin/mkfifo', ['-m', '600', join(root, 'pgpass')]);
    await expect(privateHatchetDigest(root, uid)).rejects.toThrow(); await rm(join(root, 'pgpass'));
    await writeFile(join(root, 'pgpass'), Buffer.alloc(2097153), { mode: 0o600 }); await expect(privateHatchetDigest(root, uid)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
