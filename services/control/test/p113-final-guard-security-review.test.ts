import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpSmokeGuard } from '../../../tooling/local/mcp-smoke-guard';

it.each(['raw-json', 'escaped-json', 'escaped-sse', 'escaped-tool-arguments', 'non-2xx'])('guard suppresses reflected credentials: %s', async kind => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-final-guard-'))), incoming = 'x'.repeat(43), upstream = 'fixture-upstream-value';
  const encoded = '\\u0066' + upstream.slice(1), direct = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: upstream } }] });
  const escaped = direct.replace(upstream, encoded);
  const guard = await startMcpSmokeGuard({ incomingToken: incoming, upstreamKey: upstream, markerPath: join(dir, 'marker'), testOnlyTransport: (async () => {
    if (kind === 'non-2xx') return new Response(upstream + incoming, { status: 503 });
    if (kind === 'escaped-tool-arguments') return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'fixture', arguments: '{"value":"' + encoded + '"}' } }] } }] });
    return new Response(kind === 'escaped-sse' ? 'data: ' + escaped + '\n\ndata: [DONE]\n\n' : kind === 'escaped-json' ? escaped : direct, { headers: { 'content-type': kind === 'escaped-sse' ? 'text/event-stream' : 'application/json' } });
  }) as typeof fetch });
  try {
    const reply = await fetch(`http://127.0.0.1:${guard.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer ' + incoming, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 1024, messages: [{ role: 'user', content: 'fixture' }] }) });
    const text = await reply.text();
    const parsed = kind === 'escaped-sse' && text.startsWith('data: ') ? JSON.parse(text.split('\n')[0].slice(6)) : JSON.parse(text);
    const toolArguments = parsed.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const decoded = typeof toolArguments === 'string' ? JSON.stringify(JSON.parse(toolArguments)) : JSON.stringify(parsed);
    expect(decoded.includes(upstream) || decoded.includes(incoming)).toBe(false);
    expect(guard.status().unknown).toBe(true);
  } finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});

it.each(['content', 'tool-arguments'])('guard suppresses credentials reconstructed across SSE %s frames', async kind => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reinlab-review-split-guard-'))), incoming = 'x'.repeat(43), upstream = 'fixture-upstream-value';
  let forwards = 0;
  const encodedArguments = '{"value":"\\u0066' + upstream.slice(1) + '"}';
  const split = kind === 'content' ? [upstream.slice(0, 8), upstream.slice(8)] : [encodedArguments.slice(0, 17), encodedArguments.slice(17)];
  const frames = kind === 'content' ? [
    { choices: [{ index: 0, delta: { content: split[0] } }] },
    { choices: [{ index: 0, delta: { content: split[1] }, finish_reason: 'stop' }] },
  ] : [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 7, function: { arguments: split[0] } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }, { index: 7, function: { arguments: split[1] } }] }, finish_reason: 'tool_calls' }] },
  ];
  const responseBody = frames.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
  const guard = await startMcpSmokeGuard({ incomingToken: incoming, upstreamKey: upstream, markerPath: join(dir, 'marker'), testOnlyTransport: (async () => { forwards++; return new Response(responseBody, { headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch });
  const call = (content: string) => fetch(`http://127.0.0.1:${guard.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer ' + incoming, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 1024, messages: [{ role: 'user', content }] }) });
  try {
    const reply = await call('first'); expect(reply.status).toBe(502);
    const text = await reply.text(); expect(text.includes(upstream) || text.includes(incoming) || text.includes('choices')).toBe(false);
    expect(guard.status().unknown).toBe(true);
    const later = await call('later'); expect(later.status).toBe(409); await later.body?.cancel(); expect(forwards).toBe(1);
  } finally { await guard.close(); await rm(dir, { recursive: true, force: true }); }
});
