import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, symlink, link, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpSmokeGuard } from '../../../tooling/local/mcp-smoke-guard';
const token = 'x'.repeat(43);
const body = (content: string) => JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 1024, messages: [{ role: 'user', content }] });
const call = async (port: number, content: string) => {
  const reply = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body(content) });
  await reply.body?.cancel(); return reply.status;
};

it.each(['symlink', 'hardlink', 'missing', 'replacement', 'mode', 'parent-mode'])('later paid round rejects marker drift: %s', async mode => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-mcp-'))), marker = join(dir, 'consumed'); let forwards = 0;
  const guard = await startMcpSmokeGuard({ incomingToken: token, upstreamKey: 'fixture-only', markerPath: marker, testOnlyTransport: (async () => { forwards++; return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fixture' } }] }); }) as typeof fetch });
  try {
    expect(await call(guard.port, 'first')).toBe(200);
    if (mode === 'symlink') { await writeFile(join(dir, 'target'), 'fixture', { mode: 0o600 }); await rm(marker); await symlink(join(dir, 'target'), marker); }
    if (mode === 'hardlink') await link(marker, join(dir, 'alias'));
    if (mode === 'missing') await rm(marker);
    if (mode === 'replacement') { await rm(marker); await writeFile(marker, 'replacement', { mode: 0o600 }); }
    if (mode === 'mode') await chmod(marker, 0o644);
    if (mode === 'parent-mode') await chmod(dir, 0o755);
    expect(await call(guard.port, 'second')).not.toBe(200);
    expect(forwards).toBe(1);
  } finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});

it('concurrent distinct requests cannot overlap upstream and do not spend a denied request', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-mcp-race-')));
  let release!: () => void, entered!: () => void, forwards = 0;
  const gate = new Promise<void>(done => { release = done; }), ready = new Promise<void>(done => { entered = done; });
  const guard = await startMcpSmokeGuard({ incomingToken: token, upstreamKey: 'fixture-only', markerPath: join(dir, 'consumed'), testOnlyTransport: (async () => { forwards++; entered(); await gate; return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fixture' } }] }); }) as typeof fetch });
  try {
    const first = call(guard.port, 'first'); await ready;
    expect(await call(guard.port, 'racing')).toBe(409); expect(forwards).toBe(1);
    release(); expect(await first).toBe(200);
    expect(await call(guard.port, 'next')).toBe(200); expect(forwards).toBe(2);
  } finally { release(); await guard.close(); await rm(dir, { recursive: true, force: true }); }
});

it('two guards sharing one absent marker can authorize only one workflow', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-mcp-two-'))); let forwards = 0;
  const options = { incomingToken: token, upstreamKey: 'fixture-only', markerPath: join(dir, 'consumed'), testOnlyTransport: (async () => { forwards++; return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fixture' } }] }); }) as typeof fetch };
  const a = await startMcpSmokeGuard(options), b = await startMcpSmokeGuard(options);
  try {
    const statuses = await Promise.all([call(a.port, 'one'), call(b.port, 'two')]);
    expect(statuses.filter(s => s === 200)).toHaveLength(1); expect(forwards).toBe(1);
  } finally { await a.close(); await b.close(); await rm(dir, { recursive: true, force: true }); }
});

it('invalid authorization, route and budget shapes spend no model round', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-mcp-deny-'))); let forwards = 0;
  const guard = await startMcpSmokeGuard({ incomingToken: token, upstreamKey: 'fixture-only', markerPath: join(dir, 'consumed'), testOnlyTransport: (async () => { forwards++; return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fixture' } }] }); }) as typeof fetch });
  try {
    const valid = JSON.parse(body('fixture'));
    for (const value of [{ ...valid, max_tokens: 1025 }, { ...valid, max_tokens: [1024] }, { ...valid, n: 2 }, { ...valid, model: 'foreign-model' }, { ...valid, thinking: undefined }, { ...valid, unexpected: true }, { ...valid, messages: [{ role: 'user', content: 'x'.repeat(65536) }] }]) {
      const reply = await fetch(`http://127.0.0.1:${guard.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(value) });
      expect([400, 413]).toContain(reply.status); await reply.body?.cancel();
    }
    for (const [suffix, auth] of [['/v1/chat/completions', 'invalid'], ['/other', token]]) {
      const reply = await fetch(`http://127.0.0.1:${guard.port}${suffix}`, { method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, body: body('fixture') });
      expect([401, 404]).toContain(reply.status); await reply.body?.cancel();
    }
    expect(forwards).toBe(0); expect(await call(guard.port, 'valid')).toBe(200); expect(forwards).toBe(1);
  } finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});

it('an upstream HTTP failure permanently fences later distinct rounds without retry', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-mcp-fail-'))); let forwards = 0;
  const guard = await startMcpSmokeGuard({ incomingToken: token, upstreamKey: 'fixture-only', markerPath: join(dir, 'consumed'), testOnlyTransport: (async () => { forwards++; return new Response('{}', { status: 503 }); }) as typeof fetch });
  try { expect(await call(guard.port, 'first')).toBe(503); expect(await call(guard.port, 'later')).toBe(409); expect(forwards).toBe(1); expect(guard.status().unknown).toBe(true); }
  finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});

it.each(['json', 'sse'])('upstream %s error carried by HTTP 200 fences the next round', async kind => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-mcp-error-'))); let forwards = 0;
  const guard = await startMcpSmokeGuard({ incomingToken: token, upstreamKey: 'fixture-only', markerPath: join(dir, 'consumed'), testOnlyTransport: (async () => {
    forwards++;
    return kind === 'json' ? Response.json({ error: { type: 'fixture_error' } }) : new Response('data: {"error":{"type":"fixture_error"}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch });
  try { await call(guard.port, 'first'); expect(await call(guard.port, 'later')).toBe(409); expect(forwards).toBe(1); }
  finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});

it.each(['sse-no-done', 'sse-no-finish', 'sse-json-invalid', 'json-no-finish', 'json-length', 'oversize'])('incomplete or excessive response fences the next round: %s', async kind => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-mcp-incomplete-'))); let forwards = 0;
  const texts: Record<string, string> = { 'sse-no-done': 'data: {"choices":[{"finish_reason":"stop"}]}\n\n', 'sse-no-finish': 'data: [DONE]\n\n', 'sse-json-invalid': 'data: invalid\n\ndata: [DONE]\n\n', 'json-no-finish': '{"choices":[]}', 'json-length': '{"choices":[{"finish_reason":"length"}]}', oversize: 'x'.repeat(524289) };
  const guard = await startMcpSmokeGuard({ incomingToken: token, upstreamKey: 'fixture-only', markerPath: join(dir, 'consumed'), testOnlyTransport: (async () => { forwards++; return new Response(texts[kind], { headers: { 'content-type': kind.startsWith('sse') ? 'text/event-stream' : 'application/json' } }); }) as typeof fetch });
  try { await call(guard.port, 'first'); expect(await call(guard.port, 'later')).toBe(409); expect(forwards).toBe(1); expect(guard.status().unknown).toBe(true); }
  finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});

it('complete split-chunk SSE tool-call response allows the next distinct round', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-mcp-sse-ok-'))); let forwards = 0;
  const guard = await startMcpSmokeGuard({ incomingToken: token, upstreamKey: 'fixture-only', markerPath: join(dir, 'consumed'), testOnlyTransport: (async () => {
    forwards++;
    return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('data: {"choices":[{"finish_')); c.enqueue(Buffer.from('reason":"tool_calls"}]}\n\ndata: [DONE]\n\n')); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch });
  try { expect(await call(guard.port, 'first')).toBe(200); expect(await call(guard.port, 'later')).toBe(200); expect(forwards).toBe(2); expect(guard.status().unknown).toBe(false); }
  finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});
