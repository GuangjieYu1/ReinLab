import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { mcpFixture } from './mcp-fixture';
import { createApp } from '../src/api/app';
import { appendEvent } from '../src/ledger';
import { publicReadEvent } from '../src/api/read-view';
import { projectReading } from '../../../src/data/read-projection';
import { createLiveReadAdapter } from '../../../src/data/read-live';
let f: Awaited<ReturnType<typeof mcpFixture>>, other: typeof f;
beforeAll(async () => { f = await mcpFixture(undefined, false, '1.1.0'); other = await mcpFixture(undefined, false, '1.1.0'); }, 30000);
afterAll(async () => { await other?.close(); await f?.close(); });

it('account snapshot is read-only repeatable-read and preserves one view across concurrent commits', async () => {
  await f.db.withAccountSnapshot(f.account, async client => {
    const flags = (await client.query("select current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') readonly")).rows[0];
    expect(flags).toEqual({ isolation: 'repeatable read', readonly: 'on' });
    const title = (await client.query('select title from dossier where id=$1', [f.dossier])).rows[0].title;
    await f.admin.query('update dossier set title=$2 where id=$1', [f.dossier, 'concurrent fixture']);
    expect((await client.query('select title from dossier where id=$1', [f.dossier])).rows[0].title).toBe(title);
    expect((await client.query('select id from dossier where id=$1', [other.dossier])).rowCount).toBe(0);
  });
  await expect(f.db.withAccountSnapshot(f.account, c => c.query('update dossier set title=$2 where id=$1', [f.dossier, 'forbidden']))).rejects.toMatchObject({ code: '25006' });
  expect((await f.admin.query('select title from dossier where id=$1', [f.dossier])).rows[0].title).toBe('concurrent fixture');
});

it('metadata migration retains FORCE RLS and append-only privileges and rejects non-object or oversized metadata', async () => {
  const insert = async (metadata: unknown) => f.db.withAccount(f.account, c => c.query("insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,status,is_open_access,path,abstract,view_metadata) values($1,$2,$3,$4,'W-fixture','https://example.invalid/paper','abstract_only',false,'papers/fixture.json','',$5) returning id", [randomUUID(), f.account, f.dossier, f.run, JSON.stringify(metadata)]));
  const id = (await insert({ title: 'Public fixture' })).rows[0].id;
  await expect(insert([])).rejects.toMatchObject({ code: '23514' });
  await expect(insert({ title: 'x'.repeat(32769) })).rejects.toMatchObject({ code: '23514' });
  expect((await other.db.withAccount(other.account, c => c.query('select id from paper_asset where id=$1', [id]))).rowCount).toBe(0);
  for (const query of ['update paper_asset set view_metadata=\'{}\' where id=$1', 'delete from paper_asset where id=$1']) await expect(f.db.withAccount(f.account, c => c.query(query, [id]))).rejects.toMatchObject({ code: '42501' });
  const flags = (await f.admin.query("select relrowsecurity rls,relforcerowsecurity force from pg_class where oid='paper_asset'::regclass")).rows[0]; expect(flags).toEqual({ rls: true, force: true });
  expect((await f.admin.query("select count(*)::int n from pg_trigger where tgrelid='paper_asset'::regclass and tgname='paper_asset_immutable' and tgenabled='O'")).rows[0].n).toBe(1);
});

it('read event projection excludes native raw tool/reasoning strings carrying quiz keys', () => {
  for (const type of ['tool', 'reasoning']) {
    const raw = { seq: 1, kind: 'tool', action: 'message.part.updated', payload: { properties: { part: { type, state: { raw: '{"keys":[["private-answer-fixture"]]}', output: '{"keys":[["private-answer-fixture"]]}' }, text: 'private-answer-fixture' } } } };
    expect(JSON.stringify(publicReadEvent(raw)).includes('private-answer-fixture')).toBe(false);
  }
  const card = publicReadEvent({ kind: 'card', action: 'card_created', payload: { cardType: 'quiz', card: { q: 'Public question', keys: [['private-answer-fixture']] } } });
  expect(card.payload.card.q).toBe('Public question'); expect(JSON.stringify(card).includes('private-answer-fixture')).toBe(false);
});

it('read APIs enforce account and run scope, do not recover, and scrub both history and read SSE', async () => {
  const secret = randomBytes(48), issuer = 'https://read-security.fixture/auth/v1', recover = vi.fn();
  const app = await createApp({ pool: f.pool, auth: { issuer, secret }, pipeline: { recoverAccount: recover } as never });
  const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience('authenticated').setSubject(f.account).setIssuedAt().setExpirationTime('1h').sign(secret);
  const request = (suffix: string, dossier = f.dossier, signal?: AbortSignal) => app.request('/v1/dossiers/' + dossier + suffix, { headers: { authorization: 'Bearer ' + token }, signal });
  const e = await f.db.withAccount(f.account, c => appendEvent(c, f.account, { dossierId: f.dossier, runId: f.run, kind: 'tool', action: 'message.part.updated', payload: { properties: { part: { type: 'tool', state: { output: '{"keys":[["private-answer-fixture"]]}' } } } }, dedupeKey: randomUUID() }));
  const state = await (await request('/read-state')).json();
  await f.db.withAccount(f.account, c => appendEvent(c, f.account, { dossierId: f.dossier, runId: f.run, kind: 'message', payload: { text: 'after fixed water' }, dedupeKey: randomUUID() }));
  const history = await (await request('/read-events?after=0&through=' + state.cursor)).json();
  expect(history.items.map((x: any) => x.seq)).toEqual([e.seq]); expect(JSON.stringify(history).includes('private-answer-fixture')).toBe(false);
  expect((await request('/read-state', other.dossier)).status).toBe(404);
  expect((await request('/read-state?runId=' + other.run)).status).toBe(404);
  const abort = new AbortController(), response = await request('/events?view=read&after=0', f.dossier, abort.signal), reader = response.body!.getReader();
  let text = ''; try { for (let i = 0; i < 5 && !text.includes('data:'); i++) text += new TextDecoder().decode((await reader.read()).value); }
  finally { abort.abort(); await reader.cancel().catch(() => {}); }
  expect(text.includes('data:')).toBe(true); expect(text.includes('private-answer-fixture')).toBe(false); expect(recover).not.toHaveBeenCalled();
}, 30000);

it('projection never maps another paper p1, quiz keys or unknown approval into an actionable result', async () => {
  const asset = randomUUID(), foreign = randomUUID();
  const data: any = { dossier: { id: f.dossier, title: 'fixture' }, cursor: 0, run: { id: f.run, state: 'running', budgetCny: 1, spentCny: null, usageUnknown: true }, papers: [asset, foreign].map(id => ({ id, runId: f.run, paperId: id, access: 'full' })), pages: [asset, foreign].map(assetId => ({ assetId, page: 1, quote: 'source fixture' })), approvals: [{ id: 'sent', runId: f.run, kind: 'permission', state: 'pending', sent: true }, { id: 'unknown', runId: f.run, kind: 'permission', state: 'indeterminate' }, { id: 'question', runId: f.run, kind: 'question', state: 'pending' }] };
  const events: any[] = [{ runId: f.run, kind: 'card', action: 'card_created', payload: { cardId: 'foreign-finding', cardType: 'finding', card: { n: 1, text: 'foreign', evidence: [{ paperId: foreign, page: 1, quote: 'source fixture' }], confidence: 'low', status: 'hypothesis', at: 'fixture' } } }, { runId: f.run, kind: 'card', action: 'card_created', payload: { cardId: 'quiz', cardType: 'quiz', card: { paperId: asset, q: 'Question', layer: '1', keys: [['private-answer-fixture']] } } }];
  const snap = projectReading(data, events, asset); expect(snap.paper!.id).toBe(asset); expect(snap.findings).toEqual([]); expect(JSON.stringify(snap).includes('private-answer-fixture')).toBe(false); expect(snap.run.spentCny).toBeNull(); expect(snap.run.unknownCost).toBe(true); expect(snap.history.some(e => e.type === 'approval')).toBe(false);
  let generation = 1; const decide = vi.fn(), api = vi.fn(async () => data);
  const adapter = createLiveReadAdapter(f.dossier, { generation: () => generation, decide, api, stream: vi.fn() } as never); await adapter.load();
  for (const id of ['sent', 'unknown', 'question']) await expect(adapter.decide(id, true)).rejects.toThrow(); expect(decide).not.toHaveBeenCalled();
  generation = 2; await expect(adapter.decide('sent', true)).rejects.toThrow(); expect(api).toHaveBeenCalledTimes(1);
});

it('a late old-run snapshot cannot retarget cancellation after a new confirmed run is accepted', async () => {
  const dossier = randomUUID(), oldRun = randomUUID(), newRun = randomUUID(); let defer = false, release!: (value: unknown) => void;
  const state = (id: string) => ({ dossier: { id: dossier, title: 'fixture' }, cursor: 0, papers: [], pages: [], approvals: [], run: { id, state: id === oldRun ? 'completed' : 'queued', budgetCny: 1, spentCny: null, usageUnknown: false } });
  const cancellations: string[] = [];
  const api = vi.fn(async (path: string) => {
    if (path.includes('/read-state')) { if (defer) { defer = false; return new Promise(done => { release = done; }); } return state(path.includes(newRun) ? newRun : oldRun); }
    if (path.includes('/harness')) return { version: '1.1.0', entrypoints: { read: 'research-read' }, roles: { 'research-read': { steps: 1 } } };
    if (path === '/v1/runs/estimate') return { id: 'estimate', model: 'fixture', estimatedCny: '0.05', expiresAt: new Date(Date.now() + 60000).toISOString() };
    if (path === '/v1/runs') return { id: newRun };
    if (path.endsWith('/cancel')) { cancellations.push(path); return {}; }
    throw Error('UNEXPECTED_FIXTURE_ROUTE');
  });
  const adapter = createLiveReadAdapter(dossier, { api, generation: () => 1, decide: vi.fn(), stream: vi.fn() } as never);
  await adapter.load(); const quote = await adapter.estimate('fixture query', 1);
  defer = true; const old = adapter.load(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await adapter.start(quote.id, 1); release(state(oldRun)); await old;
  await adapter.cancel(); expect(cancellations.length === 1 && cancellations[0] === '/v1/runs/' + newRun + '/cancel').toBe(true);
});
