import { it, expect } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerMachines, dockerPlan } from "../src/provisioner/docker";

it("proof-bound recovery uses the immutable target image in the actual create request", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "reinlab-recovery-image-review-")));
  const accountId = randomUUID(), name = "rl-" + accountId.replaceAll("-", ""), volumeId = "rl_" + accountId.replaceAll("-", "");
  const tokens = { auth: randomBytes(32).toString("base64url"), container: randomBytes(32).toString("base64url") };
  const target = "reinlab-account:review-file", digest = "sha256:" + "d".repeat(64), immutableId = "c".repeat(64);
  const plan = dockerPlan({ accountId, volumeId, image: "reinlab-account:review-old", controlUrl: "http://host.docker.internal:3001/", tokens });
  const legacyEnv: Record<string, string> = { ...plan.config.env, HOME: "/data", PATH: "/usr/bin:/bin", OPENSCIENCE_AUTH_TOKEN: tokens.auth, REINLAB_CONTAINER_SECRET: tokens.container };
  delete legacyEnv.REINLAB_ACCOUNT_CREDENTIAL_FILE; delete legacyEnv.REINLAB_CREDENTIAL_SOURCE_UID;
  const raw = { Id: immutableId, Created: "2020-01-01T00:00:00Z", Name: "/" + name, Image: "sha256:" + "a".repeat(64),
    Config: { Image: plan.config.image, Env: Object.entries(legacyEnv).map(([k, v]) => k + "=" + v), Labels: { "io.reinlab.managed": "true", "io.reinlab.account": accountId }, Entrypoint: ["node", "/opt/reinlab/account-entrypoint.mjs"], Cmd: [], ExposedPorts: { "4097/tcp": {} } },
    HostConfig: { Privileged: false, NetworkMode: "bridge", RestartPolicy: { Name: "always" }, Memory: 2147483648, NanoCpus: 1000000000, ExtraHosts: ["host.docker.internal:host-gateway"], SecurityOpt: ["no-new-privileges:true"], Binds: [volumeId + ":/data"], PortBindings: { "4097/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
    Mounts: [{ Type: "volume", Name: volumeId, Destination: "/data", RW: true }], State: { Running: false }, NetworkSettings: { Networks: { bridge: {} } },
  };
  let createImage: unknown, createLogicalLabel: unknown, deleted = false, tagReadsAfterDelete = 0;
  const driver = new DockerMachines("unix:///tmp/review-only.sock", async (path, method, body) => {
    if (path === "/images/" + encodeURIComponent(target) + "/json" && deleted) {
      tagReadsAfterDelete++;
      return { Id: "sha256:" + "e".repeat(64), Config: { Env: ["HOME=/data", "PATH=/usr/bin:/bin"] } };
    }
    if (path.startsWith("/images/")) return { Id: digest, Config: { Env: ["HOME=/data", "PATH=/usr/bin:/bin"] } };
    if (path === "/containers/" + name + "/json") return raw;
    if (method === "DELETE") { deleted = true; return {}; }
    if (path.startsWith("/containers/create?")) { createImage = (body as any).Image; createLogicalLabel = (body as any).Labels?.["io.reinlab.image"]; throw Error("SYNTHETIC_CAPTURE_STOP"); }
    throw Error("UNEXPECTED_REVIEW_REQUEST");
  }, directory);
  try {
    const observed = await driver.inspectCredentialMigration(name, target);
    const desiredPlan = dockerPlan({ accountId, volumeId, image: target, controlUrl: "http://host.docker.internal:3001/", tokens });
    const env: Record<string,string> = { ...legacyEnv, ...desiredPlan.config.env }; delete env.OPENSCIENCE_AUTH_TOKEN; delete env.REINLAB_CONTAINER_SECRET;
    await expect(driver.migrateCredentials(name, { ...observed.machine.config, image: target, files: desiredPlan.config.files, env }, { immutableId, targetImageDigest: digest })).rejects.toThrow();
    expect(typeof createImage === "string").toBe(true);
    expect(createImage === digest).toBe(true);
    expect(createLogicalLabel === target).toBe(true);
    expect(tagReadsAfterDelete).toBe(0);
    (raw.Config.Labels as Record<string,string>)["io.reinlab.image"] = target;
    await expect(driver.inspectCredentialMigration(name, target)).rejects.toMatchObject({ code: "PROVISIONING_CONFLICT" });
    raw.Config.Image = raw.Image;
    (raw.Config.Labels as Record<string,string>)["io.reinlab.image"] = "invalid-image-label";
    await expect(driver.inspectCredentialMigration(name, target)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
