import { readRuntimeConfiguration } from "../src/configuration";
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { readPrivateEnv, writePrivateEnv } from '../../../tooling/local/config';
import { localPaths } from '../../../tooling/local/paths';
import { quietCommand } from '../../../tooling/local/process';
import { Database } from '../src/db/database';
import { SupabaseKeyVault, provisionerFromEnvironment, environmentDriver } from '../src/provisioner';
import { decryptBundle } from '../src/provisioner/runtime';
import { lifecycleFromEnvironment } from '../src/provisioner/lifecycle';
import { authenticateVerificationUser } from '../../../tooling/local/verification-auth';

// Real local infrastructure only. This script never loads a model key or calls
// prompt. Auth credentials remain in the private local state directory.
const paths = localPaths();
const results: { name: string; passed: boolean; code?: string }[] = [];
const upgrades = { applied: 0, reused: 0 };
let pool: pg.Pool | undefined;
async function check(name: string, work: () => Promise<void>) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) {
    const candidate = (error as { code?: string }).code;
    results.push({ name, passed: false, code: candidate && /^[A-Z0-9_]{1,64}$/.test(candidate) ? candidate : 'CHECK_FAILED' });
    throw Error('LOCAL_VERIFY_FAILED');
  }
}
try {
  const env = readRuntimeConfiguration(paths.runtime);
  process.env.REINLAB_RUNTIME_CONFIG_FILE = paths.runtime;
  pool = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
  const db = new Database(pool);
  await db.assertSafeRole();
  const authFile = join(paths.state, 'verification-users.env');
  let users: Record<string, string> = {};
  try { users = await readPrivateEnv(authFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sessions: { id: string; token: string }[] = [];
  await check('real_auth_registration_and_login', async () => {
    for (const label of ['A', 'B']) {
      const email = users[label + '_EMAIL'] ?? `local-${randomUUID()}@reinlab.invalid`;
      const password = users[label + '_PASSWORD'] ?? randomBytes(32).toString('base64url');
      // Persist before registration, so an unknown signup response is recovered
      // via login rather than creating a second account/container.
      users[label + '_EMAIL'] = email;
      users[label + '_PASSWORD'] = password;
      await writePrivateEnv(authFile, users);
      const session = await authenticateVerificationUser({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY }, { email, password, registered: users[label + '_REGISTERED'] === 'true' });
      sessions.push(session);
      users[label + '_REGISTERED'] = 'true';
      await writePrivateEnv(authFile, users);
    }
    assert.notEqual(sessions[0].id, sessions[1].id);
  });
  const driver = environmentDriver();
  const provisioner = provisionerFromEnvironment(db);
  await check('auth_trigger_queue_and_two_real_account_containers', async () => {
    for (const session of sessions) {
      let ready = false;
      for (const deadline = Date.now() + 240000; Date.now() < deadline;) {
        const row = await db.withAccount(session.id, c => c.query('select state,os_version from account_machine where account_id=$1', [session.id]));
        if (row.rows[0]?.state === 'ready') { assert.equal(row.rows[0].os_version, '2.0.150'); ready = true; break; }
        await delay(1000);
      }
      assert.equal(ready, true);
    }
    const machines = await driver.listMachines();
    const volumes = await driver.listVolumes();
    for (const { id } of sessions) {
      assert.equal(machines.filter(x => x.name === 'rl-' + id.replaceAll('-', '')).length, 1);
      assert.equal(volumes.filter(x => x.name === 'rl_' + id.replaceAll('-', '')).length, 1);
    }
  });
  async function api(index: number, path: string, body?: unknown) {
    return fetch('http://127.0.0.1:3001' + path, {
      method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + sessions[index].token, ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
    });
  }
  let dossier = '';
  await check('real_auth_jwt_control_api_and_cross_account_rls', async () => {
    for (const [i, user] of sessions.entries()) {
      const response = await api(i, '/v1/me'); assert.equal(response.status, 200);
      assert.equal((await response.json() as { id: string }).id, user.id);
    }
    if (users.DOSSIER_ID) {
      const restored = await api(0, '/v1/dossiers/' + users.DOSSIER_ID);
      assert.equal(restored.status, 200); await restored.body?.cancel(); dossier = users.DOSSIER_ID;
    } else {
      const created = await api(0, '/v1/dossiers', { bench: 'research', title: '本地基础设施验证' });
      assert.equal(created.status, 201); dossier = (await created.json() as { id: string }).id;
      users.DOSSIER_ID = dossier;
    }
    users.PROBE_MARKER ??= 'real-local-storage-probe-' + randomUUID();
    await writePrivateEnv(authFile, users);
    const denied = await api(1, '/v1/dossiers/' + dossier); assert.equal(denied.status, 404); await denied.body?.cancel();
    const hidden = await db.withAccount(sessions[1].id, c => c.query('select id from dossier where id=$1', [dossier]));
    assert.equal(hidden.rowCount, 0);
  });
  await check('real_vault_envelope_and_private_metadata_denied', async () => {
    const encrypted: string[] = [];
    for (const { id } of sessions) {
      await db.withAccount(id, async c => {
        const key = await new SupabaseKeyVault().key(c);
        try {
          const row = await c.query('select envelope from account_machine_secret where account_id=$1', [id]);
          const tokens = decryptBundle(id, key, row.rows[0].envelope);
          assert.equal(tokens.auth.length, 43); assert.equal(tokens.container.length, 43);
          encrypted.push(JSON.stringify(row.rows[0].envelope));
        } finally { key.fill(0); }
      });
      for (const sql of ['select * from vault.decrypted_secrets', 'select * from reinlab_meta.machine_key', 'select * from reinlab_meta.provision_job']) {
        await assert.rejects(db.withAccount(id, c => c.query(sql)), { code: '42501' });
      }
    }
    assert.notEqual(encrypted[0], encrypted[1]);
  });
  const machine = 'rl-' + sessions[0].id.replaceAll('-', '');
  const dockerEnv = { PATH: process.env.PATH!, DOCKER_HOST: env.DOCKER_HOST };
  const marker = users.PROBE_MARKER;
  await check('isolated_named_volume_probe', async () => {
    await quietCommand('docker', ['exec', '--user', '1000:1000', machine, 'node', '--input-type=module', '-e',
      'import{mkdir,writeFile}from"node:fs/promises";await mkdir(process.argv[1],{recursive:true});await writeFile(process.argv[1]+"/local-probe.txt",process.argv[2]);', '/data/dossiers/' + dossier, marker], { env: dockerEnv, timeoutMs: 10000 });
    const foreign = await quietCommand('docker', ['exec', '--user', '1000:1000', 'rl-' + sessions[1].id.replaceAll('-', ''), 'node', '-e',
      'const fs=require("node:fs");process.stdout.write(String(fs.existsSync(process.argv[1])))', '/data/dossiers/' + dossier + '/local-probe.txt'], { env: dockerEnv, timeoutMs: 10000 });
    assert.equal(foreign, 'false');
  });
  await check('explicit_image_upgrade_keeps_volume_and_credential_envelope', async () => {
    const lifecycle = lifecycleFromEnvironment(db);
    const before = (await driver.listMachines()).map(x => x.id).sort();
    for (const [index, session] of sessions.entries()) {
      const label = index === 0 ? 'A' : 'B';
      const envelope = await db.withAccount(session.id, async c => (await c.query('select envelope from account_machine_secret where account_id=$1', [session.id])).rows[0].envelope);
      const current = (await driver.listMachines()).find(x => x.id === 'rl-' + session.id.replaceAll('-', ''));
      assert.ok(current);
      if (current.config.image !== env.ACCOUNT_IMAGE) {
        if (users[label + '_UPGRADE_IMAGE'] !== env.ACCOUNT_IMAGE) {
          users[label + '_UPGRADE_IMAGE'] = env.ACCOUNT_IMAGE;
          users[label + '_UPGRADE_OPERATION'] = randomUUID();
          await writePrivateEnv(authFile, users);
        }
        assert.equal((await lifecycle.upgrade(session.id, env.ACCOUNT_IMAGE, 'wait', users[label + '_UPGRADE_OPERATION'])).code, 'UPDATE_REQUESTED');
        upgrades.applied++;
      } else upgrades.reused++;
      assert.equal((await provisioner.ensure(session.id)).state, 'ready');
      assert.equal((await provisioner.ensure(session.id)).state, 'ready');
      const restored = await db.withAccount(session.id, async c => (await c.query('select envelope from account_machine_secret where account_id=$1', [session.id])).rows[0].envelope);
      assert.deepEqual(restored, envelope);
    }
    assert.deepEqual((await driver.listMachines()).map(x => x.id).sort(), before);
    assert.equal(await quietCommand('docker', ['exec', '--user', '1000:1000', machine, 'cat', '/data/dossiers/' + dossier + '/local-probe.txt'], { env: dockerEnv, timeoutMs: 10000 }), marker);
  });
  await check('real_account_container_reaches_its_control_health_endpoint', async () => {
    const status = await quietCommand('docker', ['exec', '--user', '1000:1000', machine, 'node', '--input-type=module', '-e',
      'const r=await fetch("http://host.docker.internal:3001/health",{signal:AbortSignal.timeout(5000)});process.stdout.write(String(r.status));await r.body?.cancel();'], { env: dockerEnv, timeoutMs: 10000 });
    assert.equal(status, '200');
  });
  await check('real_private_storage_snapshot_and_account_access_denied', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const lifecycle = lifecycleFromEnvironment(db);
    const first = await lifecycle.snapshot(sessions[0].id, date);
    assert.equal(['SNAPSHOT_STORED', 'SNAPSHOT_EXISTS'].includes(first.code), true);
    assert.equal((await lifecycle.snapshot(sessions[0].id, date)).code, 'SNAPSHOT_EXISTS');
    const url = env.SUPABASE_URL + '/storage/v1/object/authenticated/dossier-snapshots/' + sessions[0].id + '/' + date + '.tar';
    const stored = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: 'Bearer ' + env.STORAGE_SERVICE_TOKEN }, signal: AbortSignal.timeout(10000) });
    assert.equal(stored.status, 200);
    // The tar stream must contain our actual volume bytes; no synthetic archive.
    assert.equal(Buffer.from(await stored.arrayBuffer()).includes(Buffer.from(marker)), true);
    for (const session of sessions) {
      const blocked = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: 'Bearer ' + session.token }, signal: AbortSignal.timeout(10000) });
      assert.equal(blocked.ok, false); await blocked.body?.cancel();
    }
  });
  await check('real_container_restart_keeps_volume_and_envelope', async () => {
    await quietCommand('docker', ['restart', machine], { env: dockerEnv, timeoutMs: 30000 });
    assert.equal((await provisioner.ensure(sessions[0].id)).state, 'ready');
    assert.equal(await quietCommand('docker', ['exec', '--user', '1000:1000', machine, 'cat', '/data/dossiers/' + dossier + '/local-probe.txt'], { env: dockerEnv, timeoutMs: 10000 }), marker);
  });
} catch {
  process.exitCode = 1;
} finally {
  await pool?.end();
  const out = process.env.REINLAB_EVIDENCE_OUT ?? await mkdtemp(join(tmpdir(), 'reinlab-local-verify-'));
  await mkdir(out, { recursive: true });
  const report = { at: new Date().toISOString(), realInfrastructure: true, modelRequests: 0, upgrades, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length, completed: process.exitCode !== 1, results };
  await writeFile(join(out, 'local-integration.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, results: undefined, reportDirectory: out }));
}
