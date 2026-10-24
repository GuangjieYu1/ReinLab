import { requireNativeArtifact } from "../../account-runtime/artifact.mjs";
requireNativeArtifact();
import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RoleRuntime } from '../src/bridge/openscience/role-runtime';
import { prepareRoleProject } from '../src/bridge/openscience/role-project';
import { startRoleProvider, startNativeRoleServer } from './fixtures/role-provider';

it.each(['controller_restart', 'in_flight_replay', 'kernel_restart'] as const)('native receipt recovery: %s', async scenario => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-native-recovery-')));
  const provider = await startRoleProvider(); let server: Awaited<ReturnType<typeof startNativeRoleServer>> | undefined;
  let release = () => {};
  try {
    server = await startNativeRoleServer(root, provider.url);
    const options = { root, dossierId: randomUUID(), role: { id: 'receipt-reader', prompt: 'Receipt contract fixture. Do not call tools.', toolGrants: {}, writeTargets: [], steps: 2 }, memory: '', model: 'role-fixture/fixture', pluginUrl: pathToFileURL(resolve('plugins/reinlab-os-plugin/index.js')).href };
    const project = await prepareRoleProject(options);
    const first = new RoleRuntime({ ...server, project });
    const sessionID = 'ses_rl' + randomUUID().replaceAll('-', ''), requestID = randomUUID(), message = 'RECOVERY_' + scenario;
    expect((await first.createSession('receipt-contract', sessionID)).sessionID).toBe(sessionID);
    if (scenario !== 'controller_restart') provider.delays.set(message, new Promise<void>(done => { release = done; }));
    const receipt = await first.prompt({ sessionID, requestID, message });
    await expect.poll(() => provider.requests.filter(body => JSON.stringify(body.messages).includes(message)).length, { timeout: 10000 }).toBe(1);
    if (scenario === 'controller_restart') await expect.poll(async () => (await first.snapshot(sessionID)).runs.find(run => run.requestID === requestID)?.state, { timeout: 10000 }).toBe('completed');
    else expect((await first.snapshot(sessionID)).runs.find(run => run.requestID === requestID)?.state).toBe('running');
    if (scenario === 'kernel_restart') {
      await server.close(); server = undefined;
      release();
      server = await startNativeRoleServer(root, provider.url);
    }
    const restored = new RoleRuntime({ ...server, project: await prepareRoleProject(options) });
    await restored.restoreSession(sessionID);
    expect(await restored.prompt({ sessionID, requestID, message })).toEqual(receipt);
    await expect(restored.prompt({ sessionID, requestID, message: message + ' changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(provider.requests.filter(body => JSON.stringify(body.messages).includes(message))).toHaveLength(1);
    const foreign = await prepareRoleProject({ ...options, role: { ...options.role, id: 'another-role' } });
    await expect(new RoleRuntime({ ...server, project: foreign }).restoreSession(sessionID)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    release();
  } finally { release(); await server?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
}, 60000);
