import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareRoleProject } from '../src/bridge/openscience/role-project';
import { RoleRuntime } from '../src/bridge/openscience/role-runtime';

it('cleanup reconnect accepts only the same account token and role capability, then restores once on the fresh endpoint', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-reconnect-'))), pluginUrl = 'file:///opt/reinlab/plugin/index.js';
  const input = { root, dossierId: randomUUID(), role: { id: 'cleanup-read', prompt: 'fixture', toolGrants: {}, writeTargets: [], steps: 1 }, memory: '', model: 'fixture/fixture', pluginUrl };
  const project = await prepareRoleProject(input), foreign = await prepareRoleProject({ ...input, role: { ...input.role, id: 'foreign-read' } });
  const original = JSON.stringify({ plugin: [pluginUrl], fixtureOriginal: true });
  const seen: Array<{ endpoint: string; method: string; path: string; content?: string }> = []; let config: any;
  const handler = (endpoint: string) => async (req: any, res: any) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, method = req.method;
    const data = raw ? JSON.parse(raw) : undefined;
    seen.push({ endpoint, method, path, ...(path === '/global/config/raw' && method === 'PUT' ? { content: data.content } : {}) });
    let response: any = true;
    if (path === '/global/config') { if (method === 'PATCH') config = data; response = { plugin: [pluginUrl] }; }
    if (path === '/global/config/raw') response = method === 'GET' ? { content: config ? JSON.stringify(config) : original, path: '/fixture' } : { plugin: [pluginUrl] };
    if (path === '/provider') response = config ? { all: [{ id: 'deepseek', models: { 'deepseek-v4-flash': { status: 'active', api: { id: 'deepseek-flash' }, limit: { context: 1048576, output: 1024 }, capabilities: { reasoning: false } } } }], default: {}, connected: ['deepseek'] } : { all: [], default: {}, connected: [] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
  };
  const old = createServer(handler('old')), fresh = createServer(handler('fresh'));
  old.listen(0, '127.0.0.1'); fresh.listen(0, '127.0.0.1'); await Promise.all([once(old, 'listening'), once(fresh, 'listening')]);
  const url = (server: typeof old) => 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const token = 'x'.repeat(43), first = new RoleRuntime({ baseUrl: url(old), token, project });
  try {
    const cleanup = (await first.configureSmokeGateway({ origin: 'http://host.docker.internal:43210', token: 'y'.repeat(43) })).cleanup;
    seen.length = 0;
    for (const [index, candidate] of [{}, new RoleRuntime({ baseUrl: url(fresh), token: 'z'.repeat(43), project }), new RoleRuntime({ baseUrl: url(fresh), token, project: foreign }), new RoleRuntime({ baseUrl: url(fresh), token, project: { ...project } })].entries()) {
      await expect(cleanup(candidate as RoleRuntime), 'candidate ' + index).rejects.toMatchObject({ code: 'SCOPE_DENIED' }); expect(seen).toHaveLength(0);
    }
    const same = new RoleRuntime({ baseUrl: url(fresh), token, project });
    const agents = join(project.directory, 'AGENTS.md'), originalAgents = await readFile(agents);
    await writeFile(agents, 'changed', { mode: 0o600 });
    await expect(cleanup(same)).rejects.toMatchObject({ code: 'SCOPE_DENIED' }); expect(seen).toHaveLength(0);
    await writeFile(agents, originalAgents, { mode: 0o600 });
    await Promise.all([cleanup(same), cleanup(same)]); await cleanup(same);
    expect(seen).toEqual([{ endpoint: 'fresh', method: 'PUT', path: '/global/config/raw', content: original }, { endpoint: 'fresh', method: 'DELETE', path: '/auth/deepseek' }]);
    expect(await first.cleanupSmokeGateway()).toEqual({ cleaned: true });
  } finally {
    for (const server of [old, fresh]) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    await rm(root, { recursive: true, force: true });
  }
});
