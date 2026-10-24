import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareRoleProject } from '../src/bridge/openscience/role-project';
import { RoleRuntime } from '../src/bridge/openscience/role-runtime';

it('read-only restoration sends no filesystem grant while ordinary restoration still grants', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-no-grant-')));
  const pluginUrl = 'file:///opt/reinlab/plugin/index.js', sessionID = 'ses_review12345678';
  const project = await prepareRoleProject({ root, dossierId: randomUUID(), role: { id: 'review-read', prompt: '只读', toolGrants: {}, writeTargets: [], steps: 1 }, memory: '', model: 'fixture/fixture', pluginUrl });
  const methods: string[] = [];
  const server = createServer((req, res) => {
    methods.push(req.method ?? ''); req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(new URL(req.url!, 'http://localhost').pathname.endsWith('/config')
      ? { plugin: [pluginUrl] } : { id: sessionID, directory: project.directory, workspace: 'project' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    const read = new RoleRuntime({ baseUrl, token: 'x'.repeat(43), project, readOnlyRecovery: true });
    await read.restoreSession(sessionID); await read.restoreSession(sessionID);
    await read.reader().snapshot(sessionID); await read.reader().replay(sessionID, 0);
    expect(methods.length).toBeGreaterThan(0); expect(methods.every(m => m === 'GET')).toBe(true);
    methods.length = 0;
    await new RoleRuntime({ baseUrl, token: 'x'.repeat(43), project }).restoreSession(sessionID);
    expect(methods.some(m => m === 'POST')).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
});
