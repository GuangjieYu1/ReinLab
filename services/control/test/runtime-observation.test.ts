import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepareRoleProject } from '../src/bridge/openscience/role-project';
import { RoleRuntime } from '../src/bridge/openscience/role-runtime';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(mode: 'stream' | 'cursor' | 'invalid_answer' = 'stream') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-runtime-read-'))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const pluginUrl = pathToFileURL(resolve('plugins/reinlab-os-plugin/index.js')).href;
  const project = await prepareRoleProject({ root, dossierId: randomUUID(), role: { id: 'observe-reader', prompt: 'fixture', toolGrants: {}, writeTargets: [], steps: 2 }, model: 'fixture/model', memory: '', pluginUrl });
  const sessionID = 'ses_fixture12345', requests: { path: string; method: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url!, 'http://localhost').pathname;
    requests.push({ path, method: req.method!, body: raw ? JSON.parse(raw) : null });
    if (path === '/runtime/events') {
      if (mode === 'cursor') { res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'cursor_expired', oldestSequence: 10 })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const sequence of [1, 2]) res.write(`id: ${sequence}\nevent: runtime.accepted\ndata: ${JSON.stringify({ sequence, sessionID, runID: 'run_fixture', type: 'runtime.accepted', properties: { acceptedAt: 1, effort: 'normal' }, time: 1 })}\n\n`);
      return; // Caller aborts its own live subscription.
    }
    res.setHeader('content-type', 'application/json');
    if (path === '/global/config') { res.end(JSON.stringify({ plugin: [pluginUrl] })); return; }
    if (path === '/runtime/events/replay') { res.writeHead(409).end(JSON.stringify({ error: 'cursor_expired', oldestSequence: 10 })); return; }
    if (path === '/runtime/decision' && mode === 'invalid_answer') { res.writeHead(400).end(JSON.stringify({error:'invalid_answer'})); return; }
    if (path === '/runtime/decision') { res.end(JSON.stringify({ sessionID, requestID: 'per_fixture', status: 'indeterminate', decidedAt: 1 })); return; }
    if (path === '/runtime/cancel') { res.end(JSON.stringify({ runID: 'run_fixture', sessionID, messageID: 'msg_fixture', state: 'cancelled', acceptedAt: 1, updatedAt: 2 })); return; }
    if (path === '/runtime/snapshot') { res.end(JSON.stringify({ sessionID, runs: [], oldestSequence: 0, latestSequence: 0, permissions: [], questions: [], decisionScope: 'connected_runtime' })); return; }
    res.end(JSON.stringify({ id: sessionID, directory: project.directory, workspace: 'project' }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const runtime = new RoleRuntime({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'x'.repeat(43), project });
  await runtime.createSession('observer', sessionID);
  return { runtime, sessionID, requests };
}
it('read-only observation port has no submission or decision methods and consumes real SDK SSE', async () => {
  const f = await fixture(), reader = f.runtime.reader();
  expect(Object.isFrozen(reader)).toBe(true);
  for (const forbidden of ['prompt', 'createSession', 'decide', 'cancel']) expect(forbidden in reader).toBe(false);
  const controller = new AbortController(), observed: number[] = [];
  for await (const event of reader.subscribe(f.sessionID, 0, controller.signal)) { observed.push(event.sequence); if (observed.length === 2) controller.abort(); }
  expect(observed).toEqual([1, 2]);
  expect(f.requests.filter(r => r.path === '/runtime/events')).toHaveLength(1);
  expect(f.requests.some(r => r.path === '/runtime/prompt')).toBe(false);
});
it('cursor conflicts retain their meaning and SSE does not silently retry or submit', async () => {
  const f = await fixture('cursor');
  await expect(f.runtime.replay(f.sessionID, 0)).rejects.toMatchObject({ code: 'CURSOR_EXPIRED', oldestSequence: 10 });
  const controller = new AbortController();
  await expect((async () => { for await (const _ of f.runtime.subscribe(f.sessionID, 0, controller.signal)) { /* no accepted event */ } })()).rejects.toMatchObject({ code: 'CURSOR_EXPIRED', oldestSequence: 10 });
  expect(f.requests.filter(r => r.path === '/runtime/events')).toHaveLength(1);
  expect(f.requests.some(r => r.path === '/runtime/prompt')).toBe(false);
});
it('decision forwarding permits only the product scopes and preserves indeterminate without retry', async () => {
  const f = await fixture();
  for (const reply of ['always', 'project']) await expect(f.runtime.decide({ sessionID: f.sessionID, kind: 'permission', requestID: 'per_fixture', reply })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  expect(f.requests.filter(r => r.path === '/runtime/decision')).toHaveLength(0);
  expect(await f.runtime.decide({ sessionID: f.sessionID, kind: 'permission', requestID: 'per_fixture', reply: 'session' })).toMatchObject({ status: 'indeterminate' });
  expect(f.requests.filter(r => r.path === '/runtime/decision')).toHaveLength(1);
  expect(f.requests.find(r => r.path === '/runtime/decision')!.body).toEqual({ sessionID: f.sessionID, kind: 'permission', requestID: 'per_fixture', reply: 'session' });
  expect((await f.runtime.cancel(f.sessionID, 'run_fixture')).state).toBe('cancelled');
});

it('invalid question answers preserve a client error and are never retried', async()=> {
 const f=await fixture('invalid_answer');
 await expect(f.runtime.decide({sessionID:f.sessionID,kind:'question',requestID:'que_fixture',answers:[['bad']]})).rejects.toMatchObject({code:'INVALID_ANSWER',status:400});
 expect(f.requests.filter(r=>r.path==='/runtime/decision')).toHaveLength(1);
});
