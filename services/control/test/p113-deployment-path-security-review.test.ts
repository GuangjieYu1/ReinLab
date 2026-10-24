import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { planRoleProject } from '../src/bridge/openscience/role-project';

it('only exact deployment root and fixed plugin select the deployment executable; argv remains scoped', () => {
  const runId = randomUUID();
  const input = { root: '/data', dossierId: randomUUID(), role: { id: 'review-read', prompt: '只读', toolGrants: {}, writeTargets: [], steps: 1 }, memory: '', model: 'fixture/fixture', pluginUrl: 'file:///opt/reinlab/plugin/index.js', mcp: { runId, aliases: {}, grants: [{ name: 'papers.search', permission: 'allow', risk: 'read' }] } };
  const local = fileURLToPath(new URL('../../account-runtime/mcp/client.mjs', import.meta.url));
  const command = (patch: object) => JSON.parse(planRoleProject({ ...input, ...patch }).files['openscience.json']).mcp.reinlab_papers.command;
  expect(command({})).toEqual(['node', '/services/account-runtime/mcp/client.mjs', `/data/mcp-clients/${runId}.json`, 'papers']);
  expect(command({ root: '/data-other' })[1]).toBe(local);
  expect(command({ pluginUrl: 'file:///opt/reinlab/plugin/other.js' })[1]).toBe(local);
  for (const root of ['/data/', '/data/../data', '/data/.']) expect(() => command({ root })).toThrow();
});
