import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRoleProject } from '../src/bridge/openscience/role-project';
import { RoleRuntime } from '../src/bridge/openscience/role-runtime';

describe('D-3 delegation defense in depth', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => { vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) await close(); });

  it('cannot enable the test constructor switch in a production process', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new RoleRuntime({ baseUrl: 'http://127.0.0.1:1', token: 'test-only-randomless-token-padding-32', project: {} as never, testOnlyDelegation: true })).toThrowError(expect.objectContaining({ code: 'SCOPE_DENIED' }));
  });

  it.each([false, true])('sends delegation=%s only via an explicit test constructor option', async enabled => {
    const root = await mkdtemp(join(tmpdir(), 'reinlab-d3-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const pluginUrl = pathToFileURL(resolve('plugins/reinlab-os-plugin/index.js')).href;
    const project = await prepareRoleProject({ root, dossierId: '11111111-1111-4111-8111-111111111111', role: { id: 'delegation-check', prompt: '测试角色', toolGrants: {}, writeTargets: [], steps: 8 }, memory: '', model: 'role-fixture/fixture', pluginUrl });
    const submitted: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/global/config')) { res.end(JSON.stringify({ plugin: [pluginUrl] })); return; }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (req.url?.startsWith('/runtime/prompt')) {
        submitted.push(JSON.parse(raw));
        res.end(JSON.stringify({ runID: 'run_fixture', acceptedAt: '2026-10-20T00:00:00Z' }));
        return;
      }
      res.end(JSON.stringify({ id: 'session_fixture' }));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
    const address = server.address() as { port: number };
    const runtime = new RoleRuntime({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test-only-randomless-token-padding-32', project, ...(enabled ? { testOnlyDelegation: true } : {}) });
    const { sessionID } = await runtime.createSession();
    await runtime.prompt({ sessionID, requestID: 'd3-fixture', message: 'hello' });
    expect(submitted).toHaveLength(1);
    expect(submitted[0].delegation).toBe(enabled);
  });
});
