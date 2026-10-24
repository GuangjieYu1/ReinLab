import { getuid } from 'node:process';
import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivateEvidence } from '../../../tooling/local/private-evidence';

it('concurrent private evidence writers cannot overwrite the winner or leave temporary hardlinks', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-private-evidence-'))), target = join(dir, 'report.json');
  try {
    const results = await Promise.allSettled([writePrivateEvidence(target, 'first-fixture'), writePrivateEvidence(target, 'second-fixture')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(['first-fixture', 'second-fixture']).toContain(await readFile(target, 'utf8'));
    const metadata = await stat(target); expect(metadata.nlink).toBe(1); expect(metadata.mode & 0o777).toBe(0o600); expect(metadata.uid).toBe(getuid?.());
    expect(await readdir(dir)).toEqual(['report.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
