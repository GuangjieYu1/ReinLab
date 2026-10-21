import { it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testEvidenceDirectory } from './fixtures/test-evidence';

async function temporaryWorkspace() {
  const repo = resolve('.');
  const root = await mkdtemp(join(tmpdir(), 'reinlab-evidence-writer-'));
  for (const name of ['services', 'node_modules']) await symlink(join(repo, name), join(root, name));
  return { repo, root };
}
async function runDockerReport(repo: string, root: string, environment: NodeJS.ProcessEnv) {
  await promisify(execFile)(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', 'services/control/test/docker-independent.test.ts', '--root', root], {
    cwd: root, env: environment, timeout: 30000, maxBuffer: 65536,
  });
}

it('existing Docker report writer honors OUT in a temporary workspace instead of its historical repository path', async () => {
  const { repo, root } = await temporaryWorkspace();
  const output = join(root, 'requested-output');
  try {
    await mkdir(output);
    await runDockerReport(repo, root, { ...process.env, REINLAB_EVIDENCE_OUT: output });
    const report = JSON.parse(await readFile(join(output, 'docker-independent-observations.json'), 'utf8'));
    expect(report.realDockerValidated).toBe(false);
    await expect(readFile(join(root, 'evidence/P1-08-local/docker-independent-observations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 35000);

it('default evidence directories are unique system-temp paths even with the obsolete task selector', async () => {
  const first = await testEvidenceDirectory('first', { REINLAB_EVIDENCE_TASK: 'P1-05' });
  const second = await testEvidenceDirectory('second', {});
  try {
    expect(first).not.toBe(second);
    for (const dir of [first, second]) {
      const rel = relative(await realpath(tmpdir()), await realpath(dir));
      expect(rel.startsWith('..')).toBe(false);
      expect(rel).not.toBe('');
    }
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

it('only the explicit OUT selects the archive directory and preserves existing unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reinlab-evidence-out-'));
  try {
    await writeFile(join(root, 'previous.json'), 'unchanged');
    expect(await testEvidenceDirectory('writer', { REINLAB_EVIDENCE_OUT: root, REINLAB_EVIDENCE_TASK: 'P1-05' })).toBe(resolve(root));
    expect(await readFile(join(root, 'previous.json'), 'utf8')).toBe('unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('a default Docker report run leaves even its historical archive file untouched', async () => {
  const { repo, root } = await temporaryWorkspace();
  const historical = join(root, 'evidence/P1-08-local/docker-independent-observations.json');
  try {
    await mkdir(join(root, 'evidence/P1-08-local'), { recursive: true });
    await writeFile(historical, 'archive sentinel');
    const environment: NodeJS.ProcessEnv = { ...process.env, REINLAB_EVIDENCE_TASK: 'P1-05' };
    delete environment.REINLAB_EVIDENCE_OUT;
    await runDockerReport(repo, root, environment);
    expect(await readFile(historical, 'utf8')).toBe('archive sentinel');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 35000);
