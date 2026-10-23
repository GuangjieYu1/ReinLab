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
function engine() {
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
      if (path.startsWith("/images/")) return { Config: { Env: [] } };
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
          Id: "c".repeat(64),
          Name: "/" + name,
          Config: {
            ...b,
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
import { join } from "node:path";
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
