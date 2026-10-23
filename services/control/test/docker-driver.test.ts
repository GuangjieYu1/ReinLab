import {mkdtempSync,realpathSync} from "node:fs";
import { it, expect } from "vitest";
import { DockerMachines, dockerPlan } from "../src/provisioner/docker";
const accountId = "12345678-1234-4234-8234-123456789abc";
const input = {
  accountId,
  volumeId: "rl_" + accountId.replaceAll("-", ""),
  image: "reinlab-account:local",
  controlUrl: "http://host.docker.internal:3001/",
  tokens: { auth: "a".repeat(43), container: "b".repeat(43) },
};
it("Docker只能显式Unix socket与本地tag及精确控制面地址", () => {
  expect(() => new DockerMachines("tcp://127.0.0.1:2375")).toThrow();
  expect(dockerPlan(input).config.env.REINLAB_ACCOUNT_DRIVER).toBe("docker");
  for (const image of [
    "latest",
    "registry.fly.io/accounts:test",
    "reinlab-account:latest",
    "evil;cmd:local",
  ])
    expect(() => dockerPlan({ ...input, image })).toThrow();
  for (const controlUrl of [
    "http://public.example:3001/",
    "http://host.docker.internal:3002/",
  ])
    expect(() => dockerPlan({ ...input, controlUrl })).toThrow();
});
function engine(baseEnv:Record<string,string>={}) {
  const calls: {
      path: string;
      method: string;
      body: any;
    }[] = [],
    containers: any[] = [],
    volumes: any[] = [];
  const api = new DockerMachines(
    "unix:///tmp/reinlab-test.sock",
    async (path, method, body) => {
      calls.push({ path, method, body });
      if (path.startsWith("/images/")) return { Id:"sha256:"+"d".repeat(64),Config: { Env: Object.entries(baseEnv).map(([k,v])=>k+"="+v) } };
      if (path === "/volumes/create") {
        const b = body as any;
        volumes.push({ ...b, Options: {} });
        return b;
      }
      if (path === "/volumes") return { Volumes: volumes };
      if (path === "/containers/json?all=true")
        return containers.map((c) => ({
          Id: c.Id,
          Names: [c.Name],
          Labels: c.Config.Labels,
        }));
      if (path.startsWith("/containers/create?")) {
        const b = body as any;
        const name = path.split("=")[1];
        containers.push({
          Created:new Date().toISOString(),
          Id: "c".repeat(64),
          Name: "/" + name,
          Config: {
            ...b,
            Env:Object.entries({...baseEnv,...Object.fromEntries(b.Env.map((pair:string)=>[pair.slice(0,pair.indexOf('=')),pair.slice(pair.indexOf('=')+1)]))}).map(([k,v])=>k+'='+v),
            Entrypoint: ["node", "/opt/reinlab/account-entrypoint.mjs"],
          },
          Image: "sha256:" + "d".repeat(64),
          HostConfig: b.HostConfig,
          Mounts: [
            {
              Type: "volume",
              Name: b.HostConfig.Binds[0].split(":")[0],
              Destination: "/data",
              RW: true,
            }, { Type:"bind", Source:b.HostConfig.Binds[1].split(":")[0], Destination:"/run/reinlab-source/account.json", RW:false }
          ],
          State: { Running: false },
          NetworkSettings: {
            Ports: { "4097/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
          },
        });
        return { Id: "c".repeat(64) };
      }
      if (path.endsWith("/json")) {
        const key = path.split("/")[2];
        return containers.find((c) => c.Id === key || c.Name === "/" + key);
      }
      if (path.endsWith("/start")) {
        containers[0].State.Running = true;
        return {};
      }
      if (path.includes("/stop")) return {};
      if (method === "DELETE") {
        containers.length = 0;
        return {};
      }
      throw Error("unexpected engine request");
    }, realpathSync(mkdtempSync(join(tmpdir(),"reinlab-credential-driver-"))),
  );
  return { api, calls, containers, volumes };
}
it("一卷一容器，令牌只经私有文件只读挂载，随机端口仅映射宿主loopback", async () => {
  const e = engine();
  const v = await e.api.createVolume(input.volumeId);
  expect(v.id).toBe(input.volumeId);
  const m = await e.api.createMachine(dockerPlan(input));
  expect(m.state).toBe("started");
  expect(await e.api.endpoint(m.id, "ignored")).toBe("http://127.0.0.1:49152");
  expect(await e.api.listMachines()).toHaveLength(1);
  const create = e.calls.find((c) => c.path.startsWith("/containers/create"))!;
  expect(create.body.HostConfig.PortBindings).toEqual({
    "4097/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
  });
  expect(create.body.HostConfig.Privileged).toBe(false);
  expect(create.body.HostConfig.Binds[0]).toBe(input.volumeId + ":/data");
  expect(create.body.HostConfig.Binds[1]).toMatch(/:\/run\/reinlab-source\/account.json:ro$/);
  expect(JSON.stringify(create.body)).not.toContain(input.tokens.auth);
  expect(JSON.stringify(e.calls.map((c) => c.path))).not.toContain(
    input.tokens.auth,
  );
});
it("拒绝外国label、重复Env、额外socket卷、错误端口和提权，不删除资源", async () => {
  for (const change of [
    (c: any) => delete c.Config.Labels["io.reinlab.managed"],
    (c: any) => c.Config.Env.push("REINLAB_ACCOUNT_ID=other"),
    (c: any) =>
      c.Mounts.push({ Type: "bind", Destination: "/var/run/docker.sock" }),
    (c: any) => (c.HostConfig.PortBindings["4097/tcp"][0].HostIp = "0.0.0.0"),
    (c: any) => (c.HostConfig.Privileged = true),
    (c: any) => c.Config.Env.push("NODE_OPTIONS=--require=/data/evil.js"),
    (c: any) => {
      c.Config.Entrypoint = [];
      c.Config.Cmd = ["node", "-e", "evil"];
    },
    (c: any) => c.Config.Env.push("PATH=/data/bin"),
  ]) {
    const e = engine();
    await e.api.createMachine(dockerPlan(input));
    change(e.containers[0]);
    await expect(e.api.listMachines()).rejects.toMatchObject({
      code: "PROVISIONING_CONFLICT",
    });
    expect(e.calls.some((c) => c.method === "DELETE")).toBe(false);
  }
});
it("外国volume与provider敏感错误拒绝且不泄露", async () => {
  const e = engine();
  await e.api.createVolume(input.volumeId);
  delete e.volumes[0].Labels["io.reinlab.managed"];
  await expect(e.api.listVolumes()).rejects.toMatchObject({
    code: "PROVISIONING_CONFLICT",
  });
  const api = new DockerMachines("unix:///tmp/fake.sock", async () => {
    throw Error(input.tokens.auth + " private Env");
  });
  await expect(api.listMachines()).rejects.toThrow(
    "本地账户容器服务暂时不可用。",
  );
});
it("升级只重建受控同名容器，保留卷且检查配置", async () => {
  const e = engine();
  await e.api.createVolume(input.volumeId);
  const m = await e.api.createMachine(dockerPlan(input));
  await e.api.update(m.id, { ...m.config, image: "reinlab-account:next" });
  expect((await e.api.listMachines())[0].config.image).toBe(
    "reinlab-account:next",
  );
  expect(e.volumes).toHaveLength(1);
  expect(
    e.calls.filter((c) => c.method === "DELETE").map((c) => c.path),
  ).toEqual(["/containers/" + "c".repeat(64)]);
  await expect(
    e.api.update(m.id, { ...m.config, image: "reinlab-account:next", env: {} }),
  ).rejects.toMatchObject({ code: "PROVISIONING_CONFLICT" });
});

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { AccountLifecycle } from "../src/provisioner/lifecycle";
import type { Database } from "../src/db/database";
it("真实Unix HTTP协议固定API版本且Engine响应敏感内容不外露", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reinlab-engine-")),
    socket = join(dir, "engine.sock");
  let path = "";
  const server = createServer((req, res) => {
    path = req.url ?? "";
    res.writeHead(500);
    res.end("private provider Env " + input.tokens.auth);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const api = new DockerMachines("unix://" + socket);
    await expect(api.listVolumes()).rejects.toThrow(
      "本地账户容器服务暂时不可用。",
    );
    expect(path).toBe("/v1.41/volumes");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
it("仅Docker生命周期允许本地Storage且仍强制专用JWT", () => {
  const token = (role: string) =>
    "e30." +
    Buffer.from(JSON.stringify({ role })).toString("base64url") +
    ".signature";
  const cfg = {
    app: "reinlab-local",
    storageUrl: "http://127.0.0.1:54321/",
    storageToken: token("reinlab_snapshot_writer"),
    controlUrl: input.controlUrl,
  };
  const db = {} as Database,
    vault = {
      async key() {
        return Buffer.alloc(32);
      },
    };
  expect(
    () => new AccountLifecycle(db, engine().api, vault, cfg),
  ).not.toThrow();
  for (const storageUrl of [
    "http://localhost:54321/",
    "http://192.168.1.2:54321/",
    "http://127.0.0.1:54321/path",
  ])
    expect(
      () =>
        new AccountLifecycle(db, engine().api, vault, { ...cfg, storageUrl }),
    ).toThrow();
  for (const role of ["service_role", "authenticated", "anon"])
    expect(
      () =>
        new AccountLifecycle(db, engine().api, vault, {
          ...cfg,
          storageToken: token(role),
        }),
    ).toThrow();
});

import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { AccountProvisioner } from "../src/provisioner";
import { Database as RuntimeDatabase } from "../src/db/database";
it("真实PG上的Docker编排创建和重用一机一卷且采用中立计划", async () => {
  const admin = new pg.Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres@127.0.0.1:55432/reinlab_test",
    }),
    pool = new pg.Pool({
      connectionString:
        process.env.TEST_DATABASE_URL_APP ??
        "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    });
  try {
    const id = randomUUID();
    await admin.query("insert into account(id) values($1)", [id]);
    const e = engine(),
      key = randomBytes(32),
      db = new RuntimeDatabase(pool),
      provisioner = new AccountProvisioner(
        db,
        e.api,
        {
          async key() {
            return Buffer.from(key);
          },
        },
        {
          app: "reinlab-local",
          image: input.image,
          controlUrl: input.controlUrl,
        },
        async () => true,
      );
    const a = await provisioner.ensure(id),
      b = await provisioner.ensure(id);
    expect(a).toEqual(b);
    expect(a.state).toBe("ready");
    expect(e.volumes).toHaveLength(1);
    expect(e.containers).toHaveLength(1);
    expect(
      e.calls.filter((c) => c.path.startsWith("/containers/create")),
    ).toHaveLength(1);
  } finally {
    await pool.end();
    await admin.end();
  }
});

function makeLegacy(container:any,tokens=input.tokens){
  container.Mounts.length=1;
  container.HostConfig.Binds.length=1;
  container.Config.Env=container.Config.Env.filter((p:string)=>!p.startsWith('REINLAB_ACCOUNT_CREDENTIAL_FILE=')&&!p.startsWith('REINLAB_CREDENTIAL_SOURCE_UID='));
  container.Config.Env.push('OPENSCIENCE_AUTH_TOKEN='+tokens.auth,'REINLAB_CONTAINER_SECRET='+tokens.container);
}
it('旧ENV机器只准显式迁移；文件凭据必须与旧令牌相同，卷与部署限制保持',async()=>{
  const e=engine();const m=await e.api.createMachine(dockerPlan(input));makeLegacy(e.containers[0]);
  await expect(e.api.listMachines()).rejects.toMatchObject({code:'PROVISIONING_CONFLICT'});
  const [old]=await e.api.listLegacyMachines();expect(old.config.files).toBeUndefined();
  const desired={...m.config,image:'reinlab-account:file-auth'};
  const foreign=dockerPlan({...input,tokens:{...input.tokens,auth:'c'.repeat(43)}}).config.files;
  const before=e.calls.length;
  await expect(e.api.migrateCredentials(m.id,{...desired,files:foreign})).rejects.toMatchObject({code:'PROVISIONING_CONFLICT'});
  expect(e.calls.slice(before).every(c=>c.method==='GET')).toBe(true);
  await e.api.migrateCredentials(m.id,desired);
  const [now]=await e.api.listMachines();expect(now.config.env).not.toHaveProperty('OPENSCIENCE_AUTH_TOKEN');
  expect(now.config.files).toEqual(m.config.files);expect(e.containers[0].Mounts[0].Name).toBe(input.volumeId);
});

it('真实PG显式凭据迁移保留已验证的镜像baseline Env，删除旧令牌而不放宽部署配置',async()=>{
 const admin=new pg.Pool({connectionString:'postgres://postgres@127.0.0.1:55432/reinlab_test'}),pool=new pg.Pool({connectionString:'postgres://reinlab_app@127.0.0.1:55432/reinlab_test'});
 try{
  const id=randomUUID(),key=randomBytes(32),e=engine({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/data',NODE_VERSION:'22.23.0'}),db=new RuntimeDatabase(pool),vault={async key(){return Buffer.from(key)}};
  await admin.query('insert into account(id)values($1)',[id]);
  await new AccountProvisioner(db,e.api,vault,{app:'reinlab-local',image:input.image,controlUrl:input.controlUrl},async()=>true).ensure(id);
  const machine=(await e.api.listMachines())[0], bundle=JSON.parse(Buffer.from((machine.config.files as any[])[0].raw_value,'base64').toString());
  makeLegacy(e.containers[0],bundle);
  const lifecycle=new AccountLifecycle(db,e.api,vault,{app:'reinlab-local',storageUrl:'http://127.0.0.1:54321/',storageToken:'e30.'+Buffer.from(JSON.stringify({role:'reinlab_snapshot_writer'})).toString('base64url')+'.fixture',controlUrl:input.controlUrl});
  expect(await lifecycle.migrateCredentials(id,'reinlab-account:file-auth','wait',randomUUID())).toEqual({code:'UPDATE_REQUESTED'});
  const [now]=await e.api.listMachines();expect(now.config.env).toMatchObject({HOME:'/data',NODE_VERSION:'22.23.0'});expect(now.config.env).not.toHaveProperty('OPENSCIENCE_AUTH_TOKEN');expect(now.config.env).not.toHaveProperty('REINLAB_CONTAINER_SECRET');
 }finally{await pool.end();await admin.end();}
});

import {applyMigrations} from '../src/db/migrate';
import {reconcileKnownCredentialPreflight} from '../src/provisioner/credential-recovery';
import {createHash} from 'node:crypto';
async function knownPreflightFixture(defaults:Record<string,string>={HOME:'/data',PATH:'/usr/local/bin:/usr/bin:/bin',NODE_VERSION:'22.23.0'}){
 const admin=new pg.Pool({connectionString:'postgres://postgres@127.0.0.1:55432/reinlab_test'}),pool=new pg.Pool({connectionString:'postgres://reinlab_app@127.0.0.1:55432/reinlab_test'});
 await applyMigrations(admin,resolve('infra/supabase/migrations'));
 const id=randomUUID(),oldOp=randomUUID(),newOp=randomUUID(),key=randomBytes(32),db=new RuntimeDatabase(pool),vault={async key(){return Buffer.from(key)}},e=engine(defaults),target='reinlab-account:file-auth';
 await admin.query('insert into account(id)values($1)',[id]);
 await new AccountProvisioner(db,e.api,vault,{app:'reinlab-local',image:input.image,controlUrl:input.controlUrl},async()=>true).ensure(id);
 const [current]=await e.api.listMachines(),bundle=JSON.parse(Buffer.from((current.config.files as any[])[0].raw_value,'base64').toString());
 makeLegacy(e.containers[0],bundle);e.containers[0].Created='2020-01-01T00:00:00.000Z';
 await admin.query("insert into account_machine_operation(account_id,operation_id,request_hash,image,mode,state) values($1,$2,$3,$4,'wait','indeterminate')",[id,oldOp,createHash('sha256').update(JSON.stringify({image:target,mode:'wait',migrateCredentials:true})).digest('hex'),target]);
 await admin.query("update account_machine set state='starting',phase=$2,image=$3 where account_id=$1",[id,'upgrade_pending:'+oldOp,target]);
 const proof={db,driver:e.api,vault,accountId:id,operationId:oldOp,recoveryOperationId:newOp,expectedImmutableId:'c'.repeat(64),targetImageDigest:'sha256:'+'d'.repeat(64)};
 return {admin,pool,id,oldOp,newOp,target,proof,e,db,vault,close:async()=>{await pool.end();await admin.end();}};
}
it('已知变更前拒绝的专用恢复终结旧op并同租约预留新op；重放不二次变更且旧op不可复活',async()=>{
 const f=await knownPreflightFixture();try{
  const result=await reconcileKnownCredentialPreflight(f.proof);expect(result).toMatchObject({code:'CREDENTIAL_PREFLIGHT_RECOVERED',operationId:f.newOp});
  expect((await f.admin.query('select operation_id,state from account_machine_operation where account_id=$1 order by created_at,operation_id',[f.id])).rows).toEqual(expect.arrayContaining([{operation_id:f.oldOp,state:'not_applied'},{operation_id:f.newOp,state:'applied'}]));
  const mutations=f.e.calls.filter(c=>c.method!=='GET').length;
  expect(await reconcileKnownCredentialPreflight(f.proof)).toMatchObject({replayed:true});expect(f.e.calls.filter(c=>c.method!=='GET')).toHaveLength(mutations);
  const audit=(await f.admin.query('select * from credential_preflight_reconciliation where account_id=$1',[f.id])).rows;
  expect(audit).toHaveLength(1);expect(audit[0].reason).toBe('e044e46_image_env_preflight_rejection');expect(JSON.stringify(audit)).not.toContain('OPENSCIENCE_AUTH_TOKEN');
  await expect(f.db.withAccount(f.id,c=>c.query("update account_machine_operation set state='applied' where operation_id=$1",[f.oldOp]))).rejects.toMatchObject({code:'23514'});
  const lifecycle=new AccountLifecycle(f.db,f.e.api,f.vault,{app:'reinlab-local',storageUrl:'http://127.0.0.1:54321/',storageToken:'e30.'+Buffer.from(JSON.stringify({role:'reinlab_snapshot_writer'})).toString('base64url')+'.fixture',controlUrl:input.controlUrl});
  await expect(lifecycle.migrateCredentials(f.id,f.target,'wait',f.oldOp)).rejects.toMatchObject({code:'MIGRATION_NOT_APPLIED'});
 }finally{await f.close();}
});
it.each(['wrong-id','wrong-digest','new-container','active-run','not-e044-rejection'] as const)('专用恢复拒绝不完整证据 %s，旧unknown保持且不发新副作用',async which=>{
 const f=await knownPreflightFixture(which==='not-e044-rejection'?{}:undefined);try{
  let proof={...f.proof};
  if(which==='wrong-id')proof.expectedImmutableId='e'.repeat(64);
  if(which==='wrong-digest')proof.targetImageDigest='sha256:'+'e'.repeat(64);
  if(which==='new-container')f.e.containers[0].Created=new Date(Date.now()+3600000).toISOString();
  if(which==='active-run'){
   const dossier=randomUUID();await f.admin.query("insert into dossier(id,account_id,bench,title,workspace_path)values($1,$2,'research','active',$3)",[dossier,f.id,'/data/dossiers/'+dossier]);
   await f.admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny)values($1,$2,$3,'research-read','read',$4,'waiting',1)",[randomUUID(),f.id,dossier,randomUUID()]);
  }
  const before=f.e.calls.length;
  await expect(reconcileKnownCredentialPreflight(proof)).rejects.toMatchObject({code:'CREDENTIAL_RECONCILIATION_REQUIRED'});
  expect(f.e.calls.slice(before).every(c=>c.method==='GET')).toBe(true);
  expect((await f.admin.query('select state from account_machine_operation where account_id=$1 and operation_id=$2',[f.id,f.oldOp])).rows[0].state).toBe('indeterminate');
  expect((await f.admin.query('select 1 from credential_preflight_reconciliation where account_id=$1',[f.id])).rowCount).toBe(0);
 }finally{await f.close();}
});
