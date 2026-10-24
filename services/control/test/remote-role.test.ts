import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { planRoleProject } from '../src/bridge/openscience/role-project';
import { RemoteRoleStore } from '../src/bridge/openscience/remote-role';
import { assertProject, projectGrants, projectPlugin } from '../src/bridge/openscience/project-authority';

const accountId = randomUUID(), token = 'x'.repeat(43);
const options = () => ({ root: '/data', dossierId: randomUUID(), role: { id: 'research-read', prompt: '只读研究角色。', toolGrants: { read: { risk: 'read' as const, permission: 'allow' as const } }, writeTargets: [], steps: 2 }, memory: '已按角色过滤的快照', model: 'deepseek/deepseek-v4-flash', pluginUrl: 'file:///opt/reinlab/plugin/index.js' });
it('issues a remote capability only after matching expected account, directory and all managed digests', async () => {
  const input = options(), plan = planRoleProject(input); let calls = 0;
  const transport = (async (url, init) => {
    expect(String(url)).toBe('http://127.0.0.1:49100/reinlab/roles/prepare');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + token);
    const body = JSON.parse(String(init?.body)); expect(body.root).toBeUndefined(); expect(body.pluginUrl).toBeUndefined();
    calls++; return Response.json({ schemaVersion: 1, accountId, ...plan.project, hashes: plan.hashes, pluginUrl: plan.pluginUrl });
  }) as typeof fetch;
  const store = new RemoteRoleStore({ baseUrl: 'http://127.0.0.1:49100', token, accountId }, transport);
  const project = await store.prepare(input);
  await assertProject(project);
  expect(await projectGrants(project)).toEqual(plan.grants);
  expect(await projectPlugin(project)).toBe(plan.pluginUrl);
  expect(calls).toBeGreaterThan(1);
  await expect(assertProject({ ...project })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
});
it.each(['account', 'directory', 'digest', 'plugin'])('refuses a mismatching %s receipt', async field => {
  const input = options(), plan = planRoleProject(input);
  const receipt = { schemaVersion: 1, accountId, ...plan.project, hashes: { ...plan.hashes }, pluginUrl: plan.pluginUrl };
  if (field === 'account') receipt.accountId = randomUUID();
  if (field === 'directory') receipt.directory = '/data/roles/another-dossier/role';
  if (field === 'digest') receipt.hashes['AGENTS.md'] = '0'.repeat(64);
  if (field === 'plugin') receipt.pluginUrl = 'file:///untrusted/plugin.js';
  const store = new RemoteRoleStore({ baseUrl: 'http://127.0.0.1:49100', token, accountId }, (async () => Response.json(receipt)) as typeof fetch);
  await expect(store.prepare(input)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
});
it('rechecks the remote managed files before reusing a capability', async () => {
  const input = options(), plan = planRoleProject(input); let changed = false;
  const store = new RemoteRoleStore({ baseUrl: 'http://127.0.0.1:49100', token, accountId }, (async () => Response.json({ schemaVersion: 1, accountId, ...plan.project, pluginUrl: plan.pluginUrl, hashes: { ...plan.hashes, ...(changed ? { 'AGENTS.md': '0'.repeat(64) } : {}) } })) as typeof fetch);
  const project = await store.prepare(input); changed = true;
  await expect(assertProject(project)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
});
it('deployment role digests use the fixed container MCP executable, never the control host checkout',()=>{
 const input={...options(),mcp:{runId:randomUUID(),aliases:{literature:['papers.search']},grants:[{name:'papers.search',permission:'allow' as const,risk:'read' as const}]}};
 const config=JSON.parse(planRoleProject(input).files['openscience.json']);
 expect(config.mcp.reinlab_papers.command[1]).toBe('/services/account-runtime/mcp/client.mjs');
 expect(JSON.stringify(config)).not.toContain('/Users/');
});
