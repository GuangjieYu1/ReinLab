import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpSmokeGuard } from '../../../tooling/local/mcp-smoke-guard';

it.each(['raw-json', 'escaped-json', 'escaped-sse', 'non-2xx'])('guard suppresses reflected credentials: %s', async kind => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-final-guard-'))), incoming = 'x'.repeat(43), upstream = 'fixture-upstream-value';
  const encoded = '\\u0066' + upstream.slice(1), direct = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: upstream } }] });
  const escaped = direct.replace(upstream, encoded);
  const guard = await startMcpSmokeGuard({ incomingToken: incoming, upstreamKey: upstream, markerPath: join(dir, 'marker'), testOnlyTransport: (async () => {
    if (kind === 'non-2xx') return new Response(upstream + incoming, { status: 503 });
    return new Response(kind === 'escaped-sse' ? 'data: ' + escaped + '\n\ndata: [DONE]\n\n' : kind === 'escaped-json' ? escaped : direct, { headers: { 'content-type': kind === 'escaped-sse' ? 'text/event-stream' : 'application/json' } });
  }) as typeof fetch });
  try {
    const reply = await fetch(`http://127.0.0.1:${guard.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer ' + incoming, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 1024, messages: [{ role: 'user', content: 'fixture' }] }) });
    const text = await reply.text();
    const decoded = kind === 'escaped-sse' && text.startsWith('data: ') ? JSON.stringify(JSON.parse(text.split('\n')[0].slice(6))) : JSON.stringify(JSON.parse(text));
    expect(decoded.includes(upstream) || decoded.includes(incoming)).toBe(false);
    expect(guard.status().unknown).toBe(true);
  } finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});
