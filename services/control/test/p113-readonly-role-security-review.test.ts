import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RemoteRoleStore } from '../src/bridge/openscience/remote-role';
import { planRoleProject } from '../src/bridge/openscience/role-project';
import { assertProject, projectPlugin } from '../src/bridge/openscience/project-authority';

it('recovery capability verifies existing role on every use and never falls back to prepare', async () => {
  const input = { root: '/data', dossierId: randomUUID(), role: { id: 'review-read', prompt: '只读角色', toolGrants: {}, writeTargets: [], steps: 1 }, memory: '', model: 'deepseek/deepseek-v4-flash', pluginUrl: 'file:///opt/reinlab/plugin/index.js' };
  const accountId = randomUUID(), plan = planRoleProject(input), paths: string[] = []; let missing = false;
  const store = new RemoteRoleStore({ baseUrl: 'http://127.0.0.1:49100', token: 'x'.repeat(43), accountId, readOnly: true }, (async (url) => {
    paths.push(new URL(String(url)).pathname);
    return missing ? new Response(null, { status: 404 }) : Response.json({ schemaVersion: 1, accountId, ...plan.project, hashes: plan.hashes, pluginUrl: plan.pluginUrl });
  }) as typeof fetch);
  const project = await store.prepare(input); await assertProject(project); await projectPlugin(project);
  missing = true;
  await expect(assertProject(project)).rejects.toMatchObject({ code: 'OS_UNAVAILABLE' });
  await expect(store.prepare(input)).rejects.toMatchObject({ code: 'OS_UNAVAILABLE' });
  expect(paths.length).toBeGreaterThanOrEqual(5);
  expect(paths.every(p => p === '/reinlab/roles/verify')).toBe(true);
});
