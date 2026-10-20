import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm, lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as role from '../src/bridge/openscience/role-project';

const input = () => ({ root: '/data', dossierId: randomUUID(), role: { id: 'research-read', prompt: '使用中文，禁止危险动作。', toolGrants: { read: { risk: 'read', permission: 'allow' }, task: { risk: 'read', permission: 'allow' } }, writeTargets: [], steps: 4 }, memory: '只属于本角色的快照。', model: 'deepseek/deepseek-v4-flash', pluginUrl: 'file:///opt/reinlab/plugin/index.js' });
it('plans exact managed bytes and grants without requiring the container filesystem on the host', () => {
  const options = input();
  const plan = Reflect.get(role, 'planRoleProject')(options);
  expect(plan.project.directory).toBe(`/data/roles/${options.dossierId}/research-read`);
  expect(Object.keys(plan.files).sort()).toEqual(['.role-policy.json', 'AGENTS.md', 'openscience.json']);
  for (const [name, text] of Object.entries(plan.files)) expect(plan.hashes[name]).toBe(createHash('sha256').update(String(text)).digest('hex'));
  const permissions = JSON.parse(plan.files['openscience.json']).agent.research.permission;
  expect(Object.keys(permissions)[0]).toBe('*'); expect(permissions['*']).toBe('deny'); expect(permissions.task).toBe('deny');
  expect(permissions.external_directory).toEqual({ '*': 'deny', [`/data/dossiers/${options.dossierId}/*`]: 'allow' });
});
it('versions a logical role by canonical immutable input, including memory/model/policy', () => {
  const options = input(), version = Reflect.get(role, 'versionRoleOptions');
  const first = version(options);
  expect(first.role.id).toMatch(/^research-read--[a-f0-9]{32}$/);
  expect(version({ ...options, role: { ...options.role, toolGrants: { task: options.role.toolGrants.task, read: options.role.toolGrants.read } } })).toEqual(first);
  for (const patch of [{ memory: '另一份快照' }, { model: 'deepseek/another-model' }, { role: { ...options.role, steps: 5 } }]) expect(version({ ...options, ...patch }).role.id).not.toBe(first.role.id);
});
it('rejects invalid content before making a visible project directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-role-atomic-')));
  const options = input(); options.root = root; options.role.prompt = 'invalid {env:FIXTURE_ONLY}';
  try {
    await expect(role.prepareRoleProject(options)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(lstat(join(root, 'roles', options.dossierId, options.role.id))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('concurrent same-content preparation publishes complete files and reuses one project', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-role-publish-')));
  const options = { ...input(), root };
  try {
    const projects = await Promise.all(Array.from({ length: 4 }, () => role.prepareRoleProject(options)));
    expect(new Set(projects.map(p => p.directory)).size).toBe(1);
    const plan = Reflect.get(role, 'planRoleProject')(options);
    for (const project of projects) {
      await role.assertRoleProject(project);
      for (const [name, content] of Object.entries(plan.files)) expect(await readFile(join(project.directory, name), 'utf8')).toBe(content);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
