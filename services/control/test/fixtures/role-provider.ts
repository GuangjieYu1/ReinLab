/** Test-only loopback provider. Never contacts a real model or accepts model credentials. */
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir,writeFile } from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FixtureCall { name: string; arguments: Record<string, unknown> }
export interface CapturedRequest { messages: Array<Record<string, any>>; tools?: Array<{ function: { name: string } }>; [key: string]: any }
export async function startRoleProvider() {
  const requests: CapturedRequest[] = [];
  const plans = new Map<string, FixtureCall[]>();
  let observerHits = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/observer') { observerHits++; res.end('observer'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as CapturedRequest;
    requests.push(body);
    const lastUser = body.messages.findLastIndex(message => message.role === 'user');
    const user = JSON.stringify(body.messages[lastUser]);
    const plan = [...plans].find(([marker]) => user.includes(marker))?.[1] ?? [];
    const hasToolReply = body.messages.slice(lastUser + 1).some(message => message.role === 'tool');
    const calls = hasToolReply ? [] : plan;
    const delta = calls.length ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call_fixture_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { role: 'assistant', content: 'Fixture finished.' };
    const finish = calls.length ? 'tool_calls' : 'stop';
    const base = { id: `chatcmpl_fixture_${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture' };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: delta, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  const url = await listen(server);
  return { requests, plans, url, get observerHits() { return observerHits; }, close: () => close(server) };
}
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

export async function startNativeRoleServer(root: string, providerURL: string,trustedPluginUrl=pathToFileURL(resolve('plugins/reinlab-os-plugin/index.js')).href) {
  const isolated = join(root, 'native');
  for (const dir of ['home', 'config', 'data', 'cache', 'state']) await mkdir(join(isolated, dir), { recursive: true });
  const token = randomBytes(32).toString('base64url');
  const config = {
    plugin:[trustedPluginUrl],
    provider: { 'role-fixture': { npm: '@ai-sdk/openai-compatible', env: [], options: { baseURL: `${providerURL}/v1`, apiKey: 'fixture-not-a-secret' }, models: { fixture: { name: 'Fixture', tool_call: true, limit: { context: 32768, output: 1024 } } } } },
    enabled_providers: ['role-fixture'], model: 'role-fixture/fixture', small_model: 'role-fixture/fixture', autoupdate: false,
  };
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(isolated, 'home'),
    XDG_CONFIG_HOME: join(isolated, 'config'), XDG_DATA_HOME: join(isolated, 'data'), XDG_CACHE_HOME: join(isolated, 'cache'), XDG_STATE_HOME: join(isolated, 'state'),
    OPENSCIENCE_CONFIG_DIR: join(isolated, 'config'), OPENSCIENCE_AUTH_TOKEN: token,
    OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: '1', OPENSCIENCE_DISABLE_AUTOUPDATE: '1', OPENSCIENCE_DISABLE_MODELS_FETCH: '1',
    OPENSCIENCE_DISABLE_CLAUDE_CODE: '1', OPENSCIENCE_DISABLE_BUNDLED_SKILLS: '1', OPENSCIENCE_DISABLE_LSP_DOWNLOAD: '1', OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENSCIENCE_DISABLE_AUTOCOMPACT: '1',
  };
  await writeFile(join(isolated,'config','openscience.json'),JSON.stringify(config),{mode:0o600});
  const binary = resolve('services/account-runtime/node_modules/.bin/openscience');
  const portProbe = createServer();
  const portURL = await listen(portProbe);
  const port = new URL(portURL).port;
  await close(portProbe);
  const child = spawn(binary, ['serve', '--port', port, '--format', 'json'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const ready = await new Promise<{ url: string; version: string }>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Native readiness timeout: ${output.slice(-6000)}`)), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native exited ${code}: ${output.slice(-6000)}`)); });
    child.stderr!.on('data', chunk => { output += chunk; });
    let stdout = '';
    child.stdout!.on('data', chunk => {
      stdout += chunk; output += chunk;
      for (const line of stdout.split('\n')) {
        try { const value = JSON.parse(line); if (value.type === 'server.ready') { clearTimeout(timer); resolveReady(value); return; } } catch { /* startup log */ }
      }
    });
  }).catch(async error => { await stop(child); throw error; });
  return { baseUrl: ready.url, token, version: ready.version, binary, close: () => stop(child), logs: () => output };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const killGroup = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { child.kill(signal); } };
    const timer = setTimeout(() => { killGroup('SIGKILL'); }, 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    killGroup('SIGTERM');
  });
}
