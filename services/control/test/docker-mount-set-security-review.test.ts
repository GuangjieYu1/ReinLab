import { it, expect } from "vitest";
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DockerMachines, dockerPlan } from "../src/provisioner/docker";

it("Docker mount order is irrelevant while the exact read-only credential mount set remains enforced", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "reinlab-mount-set-review-")));
  const accountId = randomUUID(), name = "rl-" + accountId.replaceAll("-", ""), volumeId = "rl_" + accountId.replaceAll("-", "");
  const tokens = { auth: randomBytes(32).toString("base64url"), container: randomBytes(32).toString("base64url") }, image = "reinlab-account:review-file", digest = "sha256:" + "d".repeat(64);
  const file = join(directory, accountId, "account.json");
  await mkdir(join(directory, accountId), { mode: 0o700 });
  await writeFile(file, JSON.stringify({ schema: "account_credentials@1", accountId, ...tokens }), { mode: 0o600 });
  const plan = dockerPlan({ accountId, volumeId, image, controlUrl: "http://host.docker.internal:3001/", tokens });
  const volume = { Type: "volume", Name: volumeId, Destination: "/data", RW: true };
  const bind = { Type: "bind", Source: file, Destination: "/run/reinlab-source/account.json", RW: false };
  const raw: any = { Id: "c".repeat(64), Created: "2020-01-01T00:00:00Z", Name: "/" + name, Image: digest,
    Config: { Image: digest, Env: Object.entries(plan.config.env).map(([k, v]) => k + "=" + v), Labels: { "io.reinlab.managed": "true", "io.reinlab.account": accountId, "io.reinlab.image": image }, Entrypoint: ["node", "/opt/reinlab/account-entrypoint.mjs"], Cmd: [], ExposedPorts: { "4097/tcp": {} } },
    HostConfig: { Privileged: false, NetworkMode: "bridge", RestartPolicy: { Name: "always" }, Memory: 2147483648, NanoCpus: 1000000000, ExtraHosts: ["host.docker.internal:host-gateway"], SecurityOpt: ["no-new-privileges:true"], Binds: [volumeId + ":/data", file + ":/run/reinlab-source/account.json:ro"], PortBindings: { "4097/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
    Mounts: [bind, volume], State: { Running: true }, NetworkSettings: { Networks: { bridge: {} } },
  };
  let mutations = 0;
  const driver = new DockerMachines("unix:///tmp/review-only.sock", async (path, method) => {
    if (method !== "GET") { mutations++; throw Error("UNEXPECTED_MUTATION"); }
    if (path.startsWith("/images/")) return { Id: digest, Config: { Env: [] } };
    if (path === "/containers/" + name + "/json") return raw;
    throw Error("UNEXPECTED_REQUEST");
  }, directory);
  try {
    expect((await driver.inspectCredentialMigration(name, image, false)).machine.config.mounts?.[0].volume === volumeId).toBe(true);
    expect(raw.Mounts[0] === bind).toBe(true);
    raw.Mounts = [volume, bind]; await driver.inspectCredentialMigration(name, image, false);
    for (const mounts of [[bind, volume, { Type: "bind", Source: "/tmp/socket", Destination: "/socket", RW: true }], [{ ...bind, RW: true }, volume], [{ ...bind, Source: file + ".foreign" }, volume], [{ ...bind, Destination: "/data" }, volume]]) {
      raw.Mounts = mounts;
      await expect(driver.inspectCredentialMigration(name, image, false)).rejects.toMatchObject({ code: "PROVISIONING_CONFLICT" });
    }
    expect(mutations).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
