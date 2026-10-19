import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { claimGeneration } from './probe-evidence.mjs';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'reinlab-probe-independent-')); roots.push(path); return path; }

it('request serialization failure preserves zero-submission claim and prevents subsequent acquisition', async () => {
  const dir = await directory();
  const circular: { self?: unknown } = {}; circular.self = circular;
  await expect(claimGeneration(dir, { request: circular, metadata: { costCny: null } })).rejects.toThrow('LIVE_PROBE_REQUEST_WRITE_FAILED');
  const report = JSON.parse(await readFile(join(dir, 'live-generation.json'), 'utf8'));
  expect(report).toMatchObject({ state: 'failed-before-submit', callCount: 0, providerCallCount: null, costCny: null });
  await expect(readFile(join(dir, 'request.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(claimGeneration(dir, { request: {}, metadata: {} })).rejects.toThrow('LIVE_PROBE_ALREADY_EXISTS');
});

// Child CLI integration is wholly offline: fetch is replaced before the script
// imports, and all synthetic responses/reports stay in disposable temp folders.
it.each(['success', 'unknown', 'malformed', 'save-failure'])('CLI --output and claim integration retain %s outcome without resubmitting', async outcome => {
  const dir = await directory();
  const output = join(dir, 'isolated-output');
  const log = join(dir, 'fetch.log');
  const loader = join(dir, 'offline-fetch.mjs');
  if (outcome === 'save-failure') { await mkdir(output); await writeFile(join(output, 'interactive.html'), 'original-html'); }
  await writeFile(loader, `
import {appendFile,readFile} from 'node:fs/promises';
globalThis.fetch = async (url, options) => {
 const input = JSON.parse(options.body);
 const generating = Boolean(input.outline && input.allOutlines && input.stageId);
 await appendFile(${JSON.stringify(log)}, (generating ? 'generation' : 'validation') + '\\n');
 if (generating) {
   const intent = JSON.parse(await readFile(${JSON.stringify(join(output,'live-generation.json'))}, 'utf8'));
   if (intent.state !== 'submission-intent' || intent.callCount !== null) throw Error('PERSISTED_INTENT_MISSING');
 }
 if (generating && ${JSON.stringify(outcome)} === 'unknown') throw Error('SIMULATED_NETWORK_FAILURE');
 if (generating && ${JSON.stringify(outcome)} === 'malformed') return new Response('{', {status:200});
 return new Response(JSON.stringify(generating ? {success:true,content:{html:'<!doctype html><html><body>offline-test-only</body></html>',widgetType:'simulation'},effectiveOutline:{type:'interactive'}} : {errorCode:'MISSING_REQUIRED_FIELD'}), {status:generating?200:400});
};
`);
  const script = fileURLToPath(new URL('./openmaic-probe.mjs', import.meta.url));
  const args = ['--import', loader, script, 'http://127.0.0.1:1', '--generate', '--output', output];
  const first = await exec(process.execPath, args).then(() => 0, (error: { code: number }) => error.code);
  expect(first).toBe(outcome === 'success' ? 0 : 1);
  const original = await readFile(join(output, 'live-generation.json'), 'utf8');
  expect(JSON.parse(original)).toMatchObject({ state: ({ success: 'generated', unknown: 'indeterminate', malformed: 'response-processing-failed', 'save-failure': 'failed-to-save' })[outcome], callCount: 1, providerCallCount: null, costCny: null });
  if (outcome === 'save-failure') expect(await readFile(join(output, 'interactive.html'), 'utf8')).toBe('original-html');
  expect(JSON.parse(original).callCountScope).toContain('HTTP');
  expect(JSON.parse(await readFile(join(output, 'request.json'), 'utf8')).allOutlines).toHaveLength(1);
  await expect(exec(process.execPath, args)).rejects.toThrow('LIVE_PROBE_ALREADY_EXISTS');
  expect(await readFile(join(output, 'live-generation.json'), 'utf8')).toBe(original);
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  expect(calls.filter(value => value === 'generation')).toHaveLength(1);
  expect(calls.filter(value => value === 'validation')).toHaveLength(6);
});
