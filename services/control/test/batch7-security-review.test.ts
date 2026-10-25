import { expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mcpFixture } from './mcp-fixture';
import { CapabilitySigner, verifyCapabilityToken, verifyModelToken } from '../src/mcp/token';
import { prepareHumanPaperChoice, currentChoice } from '../src/clarify/candidates';
import { DEEPSEEK_PRICING_VERSION } from '../src/bridge/openscience/deepseek-pricing';

async function fixture() {
  const f = await mcpFixture();
  await f.db.withAccount(f.account, async c => {
    await c.query('insert into read_clarification(account_id,dossier_id)values($1,$2)', [f.account, f.dossier]);
    await c.query('insert into read_clarify_run(account_id,dossier_id,run_id)values($1,$2,$3)', [f.account, f.dossier, f.run]);
  }); return f;
}
const insert = (f: Awaited<ReturnType<typeof fixture>>, hash: string, maximum: number) => f.db.withAccount(f.account, c => c.query("insert into clarify_model_request(account_id,dossier_id,run_id,body_hash,maximum_micros,state)values($1,$2,$3,$4,$5,'forwarding')", [f.account, f.dossier, f.run, hash, maximum]));
const receipt = (promptTokens = 1000, completionTokens = 100) => ({ promptTokens, completionTokens, costUpperMicros: Math.ceil((promptTokens * 216 + completionTokens * 864) / 100), responseSha256: 'f'.repeat(64), responseModel: 'deepseek-flash', pricingVersion: DEEPSEEK_PRICING_VERSION, observedAt: Date.now() });
const complete = (f: Awaited<ReturnType<typeof fixture>>, hash: string, proof: unknown = receipt()) => f.db.withAccount(f.account, c => c.query("update clarify_model_request set state='completed',response_receipt=$2 where body_hash=$1", [hash, JSON.stringify(proof)]));

it('DB serializes simultaneous model claims, preserves unknown and refuses a total above 50000 micro-CNY', async () => {
  const f = await fixture();
  try {
    const claims = await Promise.allSettled([insert(f, 'a'.repeat(64), 30000), insert(f, 'b'.repeat(64), 30000)]);
    expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const hash = (await f.admin.query('select body_hash from clarify_model_request where dossier_id=$1', [f.dossier])).rows[0].body_hash;
    await complete(f, hash, receipt(9255, 1)); // Conservative known charge is exactly 20000.
    await expect(insert(f, 'c'.repeat(64), 30001)).rejects.toMatchObject({ code: '23514' });
    await expect(f.db.withAccount(f.account, c => c.query("update clarify_model_request set state='forwarding' where body_hash=$1", [hash]))).rejects.toMatchObject({ code: '23514' });
    await insert(f, 'd'.repeat(64), 1);
    await f.db.withAccount(f.account, c => c.query("update clarify_model_request set state='unknown' where body_hash=$1", ['d'.repeat(64)]));
    await expect(insert(f, 'e'.repeat(64), 1)).rejects.toMatchObject({ code: '23514' });
    await expect(f.db.withAccount(f.account, c => c.query("update clarify_model_request set state='completed' where body_hash=$1", ['d'.repeat(64)]))).rejects.toMatchObject({ code: '23514' });
  } finally { await f.close(); }
}, 30000);

it('the seventh completed-round attempt and reopening a closed run are denied independently of money', async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 6; i++) { const hash = String(i).repeat(64); await insert(f, hash, 100); await complete(f, hash, receipt(1, 1)); }
    await expect(insert(f, '7'.repeat(64), 1)).rejects.toMatchObject({ code: '23514' });
    await f.db.withAccount(f.account, c => c.query('update read_clarify_run set closed=true where run_id=$1', [f.run]));
    await expect(f.db.withAccount(f.account, c => c.query('update read_clarify_run set closed=false where run_id=$1', [f.run]))).rejects.toMatchObject({ code: '23514' });
  } finally { await f.close(); }
}, 30000);

it('chosen candidate/approval must be paired and scoped to the same account, dossier and run', async () => {
  const f = await fixture(), other = await fixture();
  try {
    const candidate = randomUUID(), approval = randomUUID();
    await f.admin.query("insert into read_candidate(id,account_id,dossier_id,run_id,request_id,paper_id,metadata)values($1,$2,$3,$4,'fixture','W123','{}')", [candidate, f.account, f.dossier, f.run]);
    await f.admin.query("insert into approval(id,account_id,run_id,kind,title,effects,risk)values($1,$2,$3,'question','fixture','[]','read')", [approval, other.account, other.run]);
    await expect(f.db.withAccount(f.account, c => c.query('update read_clarification set chosen_id=$2 where dossier_id=$1', [f.dossier, candidate]))).rejects.toMatchObject({ code: '23514' });
    await expect(f.db.withAccount(f.account, c => c.query('update read_clarification set chosen_id=$2,chosen_approval=$3 where dossier_id=$1', [f.dossier, candidate, approval]))).rejects.toMatchObject({ code: '23514' });
    expect((await other.db.withAccount(other.account, c => c.query('select id from read_candidate where id=$1', [candidate]))).rowCount).toBe(0);
    await expect(f.db.withAccount(f.account, c => c.query("update read_candidate set metadata='{}' where id=$1", [candidate]))).rejects.toMatchObject({ code: '42501' });
  } finally { await other.close(); await f.close(); }
}, 30000);

it('MCP and paid-model audiences are mutually unusable, including expired model credentials', () => {
  const signer = new CapabilitySigner(generateKeyPairSync('ed25519').privateKey), now = 10000;
  const original = signer.issue({ account: randomUUID(), dossier: randomUUID(), run: randomUUID(), hold: randomUUID(), role: 'research-clarify', bench: 'research', version: '1.2.0', effectiveDigest: 'a'.repeat(64), catalogDigest: 'b'.repeat(64), scopeDigest: 'c'.repeat(64) }, now);
  const model = signer.issueModel(original.claims);
  expect(() => verifyModelToken(original.token, signer.publicKey, now)).toThrow();
  expect(() => verifyCapabilityToken(model, signer.publicKey, now)).toThrow();
  expect(verifyModelToken(model, signer.publicKey, now).jti === original.claims.jti).toBe(true);
  expect(() => verifyModelToken(model, signer.publicKey, original.claims.exp)).toThrow();
});

it('only a complete valid usage receipt can release excess reservation and the receipt cannot be rewritten', async () => {
  const f = await fixture(), hash = 'f'.repeat(64), valid = receipt();
  try {
    await insert(f, hash, 30000);
    const invalid: unknown[] = [null, {}, { ...valid, promptTokens: '1000' }, { ...valid, completionTokens: '100' }, { ...valid, costUpperMicros: '3024' }, { ...valid, costUpperMicros: 1 }, receipt(-1, 1), receipt(1.5, 1), receipt(1, 257), receipt(0, 0), receipt(15000, 1), { ...valid, responseSha256: 'invalid' }, { ...valid, responseModel: 'unpriced-model' }, { ...valid, pricingVersion: 'unverified' }];
    for (const key of ['promptTokens', 'completionTokens', 'costUpperMicros', 'responseSha256', 'responseModel', 'pricingVersion']) { const missing: Record<string, unknown> = { ...valid }; delete missing[key]; invalid.push(missing); }
    for (const proof of invalid) {
      await expect(complete(f, hash, proof)).rejects.toMatchObject({ code: '23514' });
      const row = (await f.admin.query('select state,response_receipt from clarify_model_request where account_id=$1 and body_hash=$2', [f.account, hash])).rows[0];
      expect(row).toEqual({ state: 'forwarding', response_receipt: null });
    }
    await complete(f, hash, valid);
    await expect(complete(f, hash, receipt(1, 1))).rejects.toMatchObject({ code: '23514' });
    await expect(f.db.withAccount(f.account, c => c.query('update clarify_model_request set maximum_micros=1 where body_hash=$1', [hash]))).rejects.toMatchObject({ code: '23514' });
    expect((await f.admin.query('select response_receipt from clarify_model_request where account_id=$1 and body_hash=$2', [f.account, hash])).rows[0].response_receipt).toEqual(valid);
  } finally { await f.close(); }
}, 30000);

it('verified known charges permit one larger next reservation while simultaneous callers and unknown charges remain fenced', async () => {
  const f = await fixture(), hash = 'a'.repeat(64);
  try {
    await insert(f, hash, 30000); await complete(f, hash); // 3024 known upper, not a zero/refund.
    const attempts = await Promise.allSettled([insert(f, 'b'.repeat(64), 40000), insert(f, 'c'.repeat(64), 40000)]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const totals = (await f.admin.query("select sum(maximum_micros)::int maximum,sum(reinlab_clarify_reservation(clarify_model_request))::int charged,count(*)::int rounds from clarify_model_request where account_id=$1 and dossier_id=$2", [f.account, f.dossier])).rows[0];
    expect(totals).toEqual({ maximum: 70000, charged: 43024, rounds: 2 });
    await f.db.withAccount(f.account, c => c.query("update clarify_model_request set state='unknown' where dossier_id=$1 and state='forwarding'", [f.dossier]));
    await expect(insert(f, 'd'.repeat(64), 1)).rejects.toMatchObject({ code: '23514' });
    const unknown = (await f.admin.query("select maximum_micros,response_receipt from clarify_model_request where account_id=$1 and state='unknown'", [f.account])).rows[0];
    expect(unknown).toEqual({ maximum_micros: 40000, response_receipt: null });
  } finally { await f.close(); }
}, 30000);

it('legacy synthetic rows release only a fully valid completed receipt without altering historical records', async () => {
  const f = await fixture(), valid = receipt();
  const reservation = async (row: unknown) => Number((await f.db.withAccount(f.account, c => c.query('select public.reinlab_clarify_reservation(jsonb_populate_record(null::public.clarify_model_request,$1::jsonb)) amount', [JSON.stringify(row)]))).rows[0].amount);
  try {
    const row = { state: 'completed', maximum_micros: 30000, response_receipt: valid };
    expect(await reservation(row)).toBe(3024);
    const invalid: unknown[] = [null, {}, { ...valid, promptTokens: '1000' }, { ...valid, completionTokens: '100' }, { ...valid, costUpperMicros: 1 }, receipt(-1, 1), receipt(1.5, 1), receipt(1, 257), receipt(0, 0), receipt(15000, 1), { ...valid, responseSha256: 'invalid' }, { ...valid, responseModel: 'unpriced-model' }, { ...valid, pricingVersion: 'unverified' }];
    for (const key of ['promptTokens', 'completionTokens', 'costUpperMicros', 'responseSha256', 'responseModel', 'pricingVersion']) { const missing: Record<string, unknown> = { ...valid }; delete missing[key]; invalid.push(missing); }
    for (const proof of invalid) expect(await reservation({ ...row, response_receipt: proof })).toBe(30000);
    for (const state of ['forwarding', 'unknown']) expect(await reservation({ ...row, state })).toBe(30000);
    expect((await f.admin.query('select count(*)::int n from clarify_model_request where account_id=$1', [f.account])).rows[0].n).toBe(0);
  } finally { await f.close(); }
}, 30000);


it('shared human paper choice rejects unknown/cross-dossier answers and never exposes an unconfirmed choice', async () => {
  const f = await fixture(), other = await fixture(), approval = randomUUID(), candidate = randomUUID();
  const effects = (paper: string) => JSON.stringify([{ questions: [{ header: 'REINLAB_PAPER_PICK', multiple: false, custom: false, options: [{ label: paper }, { label: '都不是' }] }] }]);
  const attempt = (paper: string, answers: string[][]) => f.db.withAccount(f.account, async c => {
    const a = (await c.query('select * from approval where id=$1', [approval])).rows[0];
    await prepareHumanPaperChoice(c, f.account, { ...a, effects: JSON.parse(effects(paper)) }, { decision: 'approve', answers });
  });
  try {
    await f.admin.query("update run set role_id='research-clarify',state='waiting',ended_at=null where id=$1", [f.run]);
    await f.admin.query("insert into read_candidate(id,account_id,dossier_id,run_id,request_id,paper_id,metadata)values($1,$2,$3,$4,'fixture','W321',$5)", [candidate, f.account, f.dossier, f.run, JSON.stringify({ paperId: 'W321', title: 'Fixture' })]);
    await f.admin.query("insert into read_candidate(id,account_id,dossier_id,run_id,request_id,paper_id,metadata)values($1,$2,$3,$4,'fixture','W999','{}')", [randomUUID(), other.account, other.dossier, other.run]);
    await f.admin.query("insert into approval(id,account_id,run_id,kind,title,effects,risk)values($1,$2,$3,'question','fixture',$4,'read')", [approval, f.account, f.run, effects('W321')]);
    for (const [paper, answers] of [['W321', [['W404']]], ['W999', [['W999']]], ['W321', [['W321', '都不是']]]] as [string, string[][]][]) {
      await expect(attempt(paper, answers)).rejects.toMatchObject({ code: 'CLARIFY_CONFLICT' });
      expect((await f.admin.query('select chosen_id,closed from read_clarification where dossier_id=$1', [f.dossier])).rows[0]).toEqual({ chosen_id: null, closed: false });
    }
    await attempt('W321', [['W321']]);
    expect((await f.admin.query('select closed from read_clarify_run where run_id=$1', [f.run])).rows[0].closed).toBe(true);
    expect(await f.db.withAccount(f.account, c => currentChoice(c, f.dossier))).toBeUndefined();
    await f.admin.query("update approval set state='indeterminate' where id=$1", [approval]);
    expect(await f.db.withAccount(f.account, c => currentChoice(c, f.dossier))).toBeUndefined();
    await expect(attempt('W321', [['W321']])).rejects.toMatchObject({ code: 'CLARIFY_CONFLICT' });
  } finally { await other.close(); await f.close(); }
}, 30000);
