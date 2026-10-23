import { getuid } from "node:process";
import { mkdirSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { readAccountCredentials } from "../../../account-runtime/credentials.mjs";
import {
  accountCredentialFiles,
  tokensFromFiles,
  ACCOUNT_CREDENTIAL_PATH,
} from "./credential-file";
import { request } from "node:http";
import { z } from "zod";
import { ApiFailure } from "../api/errors";
import { OS_VERSION, Tokens } from "./runtime";
import type {
  AccountDriver,
  AccountMachine,
  AccountVolume,
  PlanInput,
} from "./driver";
const owner = "io.reinlab.managed",
  account = "io.reinlab.account",
  logicalImageLabel = "io.reinlab.image";
const conflict = () =>
  new ApiFailure(
    "PROVISIONING_CONFLICT",
    409,
    "本地账户资源身份或隔离配置不符。",
  );
const unavailable = () =>
  new ApiFailure(
    "PROVISIONER_UNAVAILABLE",
    503,
    "本地账户容器服务暂时不可用。",
  );
const imagePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export function dockerPlan(i: PlanInput) {
  z.string().uuid().parse(i.accountId);
  Tokens.parse(i.tokens);
  if (!imagePattern.test(i.image) || i.image.endsWith(":latest"))
    throw Error("ACCOUNT_IMAGE_INVALID");
  if (i.controlUrl !== "http://host.docker.internal:3001/")
    throw Error("CONTROL_PRIVATE_URL_REQUIRED");
  if (i.volumeId !== "rl_" + i.accountId.replaceAll("-", "")) throw conflict();
  return {
    name: "rl-" + i.accountId.replaceAll("-", ""),
    region: "local",
    config: {
      image: i.image,
      auto_destroy: false,
      restart: { policy: "always" },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
      mounts: [{ volume: i.volumeId, path: "/data" }],
      metadata: {
        reinlab_account_id: i.accountId,
        reinlab_os_version: OS_VERSION,
      },
      files: accountCredentialFiles(i.accountId, i.tokens),
      env: {
        REINLAB_ACCOUNT_CREDENTIAL_FILE: ACCOUNT_CREDENTIAL_PATH,
        REINLAB_CREDENTIAL_SOURCE_UID: String(
          process.platform === "darwin" ? 0 : (getuid?.() ?? 0),
        ),
        OPENSCIENCE_DATA_DIR: "/data/os-data",
        OPENSCIENCE_CONFIG_DIR: "/data/os-config",
        REINLAB_CONTROL_URL: i.controlUrl,
        REINLAB_ACCOUNT_ID: i.accountId,
        REINLAB_ACCOUNT_DRIVER: "docker",
      },
    },
  };
}
type Json = Record<string, any>;
export type EngineTransport = (
  path: string,
  method: string,
  body?: unknown,
) => Promise<unknown>;
/** Docker Engine protocol only, never invokes a shell or exposes provider errors. */
export class DockerMachines implements AccountDriver {
  readonly kind = "docker" as const;
  readonly region = "local";
  private transport: EngineTransport;
  constructor(
    host: string,
    transport?: EngineTransport,
    private credentialDirectory = join(
      homedir(),
      ".local/state/reinlab/account-credentials",
    ),
  ) {
    if (
      !/^unix:\/\/\/[^\0\r\n]+$/.test(host) ||
      host.includes("?") ||
      host.includes("#") ||
      host.slice(7).split("/").includes("..")
    )
      throw new ApiFailure(
        "PROVISIONER_CONFIG_MISSING",
        503,
        "Docker 必须配置受控本地 Unix socket。",
      );
    const socketPath = host.slice(7);
    this.transport =
      transport ??
      ((path, method, body) =>
        new Promise((resolve, reject) => {
          const req = request(
            {
              socketPath,
              path: "/v1.41" + path,
              method,
              headers: { "content-type": "application/json" },
            },
            (res) => {
              let raw = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                raw += chunk;
                if (raw.length > 4 * 1024 * 1024) {
                  req.destroy();
                  reject(unavailable());
                }
              });
              res.on("end", () => {
                try {
                  if (
                    !res.statusCode ||
                    res.statusCode < 200 ||
                    res.statusCode >= 300
                  )
                    throw Error();
                  resolve(raw ? JSON.parse(raw) : {});
                } catch {
                  reject(unavailable());
                }
              });
              res.on("error", () => reject(unavailable()));
            },
          );
          const timer = setTimeout(() => req.destroy(), 15000);
          req.on("close", () => clearTimeout(timer));
          req.on("error", () => reject(unavailable()));
          req.end(body === undefined ? undefined : JSON.stringify(body));
        }));
  }
  private async call(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Json> {
    try {
      return (await this.transport(path, method, body)) as Json;
    } catch {
      throw unavailable();
    }
  }
  plan = dockerPlan;
  validateDeployment(input: Omit<PlanInput, "volumeId">) {
    this.plan({
      ...input,
      volumeId: "rl_" + input.accountId.replaceAll("-", ""),
    });
  }
  validateImage(image: string) {
    if (!imagePattern.test(image) || image.endsWith(":latest"))
      throw Error("ACCOUNT_IMAGE_INVALID");
  }
  private id(id: string) {
    if (!/^rl-[a-f0-9]{32}$/.test(id)) throw conflict();
    return id;
  }
  private immutableId(raw: Json) {
    if (!/^[a-f0-9]{64}$/.test(raw.Id)) throw conflict();
    return raw.Id as string;
  }
  private labels(id: string) {
    z.string().uuid().parse(id);
    return { [owner]: "true", [account]: id };
  }
  private async normalized(raw: Json, legacy = false): Promise<AccountMachine> {
    const name = String(raw.Name ?? "").replace(/^\//, "");
    this.id(name);
    const c = raw.Config ?? {},
      h = raw.HostConfig ?? {},
      labels = c.Labels ?? {},
      id = labels[account];
    if (
      labels[owner] !== "true" ||
      !z.string().uuid().safeParse(id).success ||
      name !== "rl-" + id.replaceAll("-", "")
    )
      throw conflict();
    const mounts = Array.isArray(raw.Mounts)
        ? [...raw.Mounts].sort((a: Json, b: Json) =>
            String(a.Destination).localeCompare(String(b.Destination)),
          )
        : (raw.Mounts ?? []),
      port = h.PortBindings?.["4097/tcp"];
    if (
      h.Privileged !== false ||
      h.NetworkMode !== "bridge" ||
      h.PidMode ||
      h.IpcMode === "host" ||
      h.ReadonlyRootfs === true ||
      h.RestartPolicy?.Name !== "always" ||
      h.Memory !== 2147483648 ||
      h.NanoCpus !== 1000000000 ||
      h.CapAdd?.length ||
      h.Devices?.length ||
      h.DeviceRequests?.length ||
      (h.Runtime && h.Runtime !== "runc") ||
      h.Dns?.length ||
      h.DnsSearch?.length ||
      h.DnsOptions?.length ||
      Object.keys(h.Sysctls ?? {}).length ||
      JSON.stringify(h.ExtraHosts) !==
        JSON.stringify(["host.docker.internal:host-gateway"]) ||
      Object.keys(raw.NetworkSettings?.Networks ?? {}).some(
        (k) => k !== "bridge",
      ) ||
      h.SecurityOpt?.length !== 1 ||
      h.SecurityOpt?.includes("seccomp=unconfined") ||
      !h.SecurityOpt?.some(
        (v: string) =>
          v === "no-new-privileges:true" || v === "no-new-privileges",
      ) ||
      (c.User && c.User !== "root") ||
      JSON.stringify(c.Entrypoint) !==
        JSON.stringify(["node", "/opt/reinlab/account-entrypoint.mjs"]) ||
      (c.Cmd != null && (!Array.isArray(c.Cmd) || c.Cmd.length !== 0)) ||
      Object.keys(h.Tmpfs ?? {}).length ||
      h.Mounts?.length ||
      h.UtsMode ||
      h.UsernsMode ||
      h.PublishAllPorts === true ||
      h.VolumesFrom?.length ||
      !Array.isArray(mounts) ||
      mounts.length !== (legacy ? 1 : 2) ||
      mounts[0].Type !== "volume" ||
      mounts[0].Name !== "rl_" + id.replaceAll("-", "") ||
      mounts[0].Destination !== "/data" ||
      mounts[0].RW !== true ||
      (!legacy &&
        (mounts[1].Type !== "bind" ||
          mounts[1].Destination !== ACCOUNT_CREDENTIAL_PATH ||
          mounts[1].RW !== false ||
          mounts[1].Source !== this.credentialPath(id) ||
          JSON.stringify(h.Binds) !==
            JSON.stringify([
              mounts[0].Name + ":/data",
              this.credentialPath(id) + ":" + ACCOUNT_CREDENTIAL_PATH + ":ro",
            ]))) ||
      (legacy &&
        JSON.stringify(h.Binds) !==
          JSON.stringify([mounts[0].Name + ":/data"])) ||
      Object.keys(h.PortBindings ?? {}).length !== 1 ||
      !Array.isArray(port) ||
      port.length !== 1 ||
      port[0].HostIp !== "127.0.0.1" ||
      Object.keys(c.ExposedPorts ?? {}).some((k) => k !== "4097/tcp")
    )
      throw conflict();
    const env: Record<string, string> = {};
    for (const pair of c.Env ?? []) {
      if (typeof pair !== "string" || !pair.includes("=")) throw conflict();
      const at = pair.indexOf("=");
      if (pair.slice(0, at) in env) throw conflict();
      env[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const logicalImage = labels[logicalImageLabel] ?? c.Image;
    this.validateImage(logicalImage);
    if (labels[logicalImageLabel] !== undefined && c.Image !== raw.Image)
      throw conflict();
    if (labels[logicalImageLabel] === undefined && c.Image !== logicalImage)
      throw conflict();
    if (!/^sha256:[a-f0-9]{64}$/.test(raw.Image)) throw conflict();
    const image = await this.call("/images/" + raw.Image + "/json");
    const baseEnv: Record<string, string> = {};
    for (const pair of image.Config?.Env ?? []) {
      if (typeof pair !== "string" || !pair.includes("=")) throw conflict();
      const at = pair.indexOf("=");
      baseEnv[pair.slice(0, at)] = pair.slice(at + 1);
    }
    if (
      Object.keys(baseEnv).some((key) =>
        /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$|^DATABASE_URL(?:_|$)/.test(key),
      )
    )
      throw conflict();
    const expected = this.plan({
      accountId: id,
      volumeId: "rl_" + id.replaceAll("-", ""),
      image: logicalImage,
      controlUrl: env.REINLAB_CONTROL_URL,
      tokens: legacy
        ? Tokens.parse({
            auth: env.OPENSCIENCE_AUTH_TOKEN,
            container: env.REINLAB_CONTAINER_SECRET,
          })
        : this.readCredentials(id),
    }).config.env;
    if (legacy) {
      delete (expected as Record<string, string>)
        .REINLAB_ACCOUNT_CREDENTIAL_FILE;
      delete (expected as Record<string, string>).REINLAB_CREDENTIAL_SOURCE_UID;
      Object.assign(expected, {
        OPENSCIENCE_AUTH_TOKEN: env.OPENSCIENCE_AUTH_TOKEN,
        REINLAB_CONTAINER_SECRET: env.REINLAB_CONTAINER_SECRET,
      });
    }
    const merged = { ...baseEnv, ...expected };
    if (
      Object.keys(env).length !== Object.keys(merged).length ||
      Object.entries(merged).some(([key, value]) => env[key] !== value)
    )
      throw conflict();
    return {
      id: name,
      name,
      region: "local",
      state: raw.State?.Running ? "started" : "stopped",
      config: {
        image: logicalImage,
        auto_destroy: false,
        restart: { policy: "always" },
        metadata: { reinlab_account_id: id, reinlab_os_version: OS_VERSION },
        mounts: [{ volume: mounts[0].Name, path: "/data" }],
        env,
        ...(legacy
          ? {}
          : { files: accountCredentialFiles(id, this.readCredentials(id)) }),
      },
    };
  }
  /** Only the trusted maintenance workflow may inspect legacy ENV machines for an explicit migration. */
  async listLegacyMachines() {
    return this.listMachineMode(true);
  }
  async listMachines() {
    return this.listMachineMode(false);
  }
  private async listMachineMode(legacy: boolean) {
    const rows = await this.call("/containers/json?all=true");
    if (!Array.isArray(rows)) throw unavailable();
    const candidates = rows.filter(
      (r: Json) =>
        r.Labels?.[owner] === "true" ||
        r.Names?.some((n: string) => /^\/rl-[a-f0-9]{32}$/.test(n)),
    );
    return Promise.all(
      candidates.map(async (r: Json) => {
        if (!/^[a-f0-9]{64}$/.test(r.Id)) throw conflict();
        const raw = await this.call("/containers/" + r.Id + "/json");
        return this.normalized(raw, legacy && raw.Mounts?.length === 1);
      }),
    );
  }
  async listVolumes(): Promise<AccountVolume[]> {
    const rows = (await this.call("/volumes")).Volumes;
    const containers = await this.call("/containers/json?all=true");
    if (!Array.isArray(containers)) throw unavailable();
    if (rows !== null && !Array.isArray(rows)) throw unavailable();
    return (rows ?? [])
      .filter(
        (v: Json) =>
          v.Labels?.[owner] === "true" || /^rl_[a-f0-9]{32}$/.test(v.Name),
      )
      .map((v: Json) => {
        const id = v.Labels?.[account];
        if (
          v.Labels?.[owner] !== "true" ||
          !z.string().uuid().safeParse(id).success ||
          v.Name !== "rl_" + id.replaceAll("-", "") ||
          v.Driver !== "local" ||
          Object.keys(v.Options ?? {}).length
        )
          throw conflict();
        for (const c of containers) {
          if (
            c.Mounts?.some((m: Json) => m.Name === v.Name) &&
            (c.Labels?.[owner] !== "true" ||
              c.Labels?.[account] !== id ||
              !c.Names?.includes("/rl-" + id.replaceAll("-", "")))
          )
            throw conflict();
        }
        return { id: v.Name, name: v.Name, region: "local" };
      });
  }
  async createVolume(name: string) {
    if (!/^rl_[a-f0-9]{32}$/.test(name)) throw conflict();
    const hex = name.slice(3),
      id =
        hex.slice(0, 8) +
        "-" +
        hex.slice(8, 12) +
        "-" +
        hex.slice(12, 16) +
        "-" +
        hex.slice(16, 20) +
        "-" +
        hex.slice(20);
    await this.call("/volumes/create", "POST", {
      Name: name,
      Driver: "local",
      Labels: this.labels(id),
    });
    const matches = (await this.listVolumes()).filter((v) => v.name === name);
    if (matches.length !== 1) throw conflict();
    return matches[0];
  }
  private credentialPath(id: string) {
    z.string().uuid().parse(id);
    if (
      !isAbsolute(this.credentialDirectory) ||
      /[:\0\r\n]/.test(this.credentialDirectory)
    )
      throw conflict();
    return join(this.credentialDirectory, id, "account.json");
  }
  private readCredentials(id: string) {
    try {
      const v = readAccountCredentials(this.credentialPath(id), {
        accountId: id,
      });
      return { auth: v.auth, container: v.container };
    } catch {
      throw conflict();
    }
  }
  private publishCredentials(id: string, files: unknown) {
    const tokens = tokensFromFiles(files, id),
      file = this.credentialPath(id),
      dir = join(this.credentialDirectory, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (
      realpathSync(dir) !== dir ||
      (lstatSync(dir).mode & 0o777) !== 0o700 ||
      lstatSync(dir).uid !== getuid?.()
    )
      throw conflict();
    try {
      writeFileSync(
        file,
        JSON.stringify({
          schema: "account_credentials@1",
          accountId: id,
          ...tokens,
        }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw conflict();
    }
    if (JSON.stringify(this.readCredentials(id)) !== JSON.stringify(tokens))
      throw conflict();
    return file;
  }
  private body(plan: ReturnType<typeof dockerPlan>, imageId: string) {
    const c = plan.config;
    return {
      Image: imageId,
      Env: Object.entries(c.env).map(([k, v]) => k + "=" + v),
      Labels: {
        ...this.labels(c.metadata.reinlab_account_id),
        [logicalImageLabel]: c.image,
      },
      ExposedPorts: { "4097/tcp": {} },
      HostConfig: {
        Binds: [
          c.mounts[0].volume + ":/data",
          this.publishCredentials(c.metadata.reinlab_account_id, c.files) +
            ":" +
            ACCOUNT_CREDENTIAL_PATH +
            ":ro",
        ],
        PortBindings: { "4097/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        RestartPolicy: { Name: "always" },
        Privileged: false,
        NetworkMode: "bridge",
        Memory: 2147483648,
        NanoCpus: 1000000000,
        ExtraHosts: ["host.docker.internal:host-gateway"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    };
  }
  async createMachine(input: unknown) {
    return this.createPinnedMachine(input);
  }
  private async createPinnedMachine(input: unknown, pinnedImage?: string) {
    const p = input as ReturnType<typeof dockerPlan>;
    const env = p.config.env;
    const plan = this.plan({
      accountId: env.REINLAB_ACCOUNT_ID,
      volumeId: p.config.mounts[0].volume,
      image: p.config.image,
      controlUrl: env.REINLAB_CONTROL_URL,
      tokens: tokensFromFiles(p.config.files, env.REINLAB_ACCOUNT_ID),
    });
    const imageId =
      pinnedImage ??
      (
        await this.call(
          "/images/" + encodeURIComponent(plan.config.image) + "/json",
        )
      ).Id;
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw conflict();
    await this.call(
      "/containers/create?name=" + plan.name,
      "POST",
      this.body(plan, imageId),
    );
    await this.start(plan.name);
    return this.normalized(
      await this.call("/containers/" + plan.name + "/json"),
    );
  }
  async start(id: string) {
    this.id(id);
    const raw = await this.call("/containers/" + id + "/json");
    await this.normalized(raw);
    await this.call("/containers/" + this.immutableId(raw) + "/start", "POST");
  }
  async endpoint(id: string, _app: string) {
    this.id(id);
    const raw = await this.call("/containers/" + id + "/json");
    await this.normalized(raw);
    const ports = raw.NetworkSettings?.Ports?.["4097/tcp"];
    if (
      !Array.isArray(ports) ||
      ports.length !== 1 ||
      ports[0].HostIp !== "127.0.0.1" ||
      !/^\d{1,5}$/.test(ports[0].HostPort) ||
      Number(ports[0].HostPort) < 1 ||
      Number(ports[0].HostPort) > 65535
    )
      throw conflict();
    return "http://127.0.0.1:" + ports[0].HostPort;
  }
  async inspectCredentialMigration(
    id: string,
    targetImage: string,
    legacy = true,
  ) {
    this.id(id);
    this.validateImage(targetImage);
    const raw = await this.call("/containers/" + id + "/json");
    const machine = await this.normalized(raw, legacy);
    const target = await this.call(
      "/images/" + encodeURIComponent(targetImage) + "/json",
    );
    if (
      !/^sha256:[a-f0-9]{64}$/.test(target.Id) ||
      typeof raw.Created !== "string" ||
      !Number.isFinite(Date.parse(raw.Created))
    )
      throw conflict();
    return {
      machine,
      runtimeImageDigest: raw.Image as string,
      immutableId: this.immutableId(raw),
      createdAt: new Date(raw.Created).toISOString(),
      targetImageDigest: target.Id as string,
    };
  }
  async migrateCredentials(
    id: string,
    input: unknown,
    proof?: { immutableId: string; targetImageDigest: string },
  ) {
    return this.replace(id, input, true, proof);
  }
  async update(id: string, input: unknown) {
    return this.replace(id, input, false);
  }
  private async replace(
    id: string,
    input: unknown,
    legacy: boolean,
    proof?: { immutableId: string; targetImageDigest: string },
  ) {
    this.id(id);
    const raw = await this.call("/containers/" + id + "/json");
    if (proof && raw.Id !== proof.immutableId) throw conflict();
    const old = await this.normalized(raw, legacy),
      c = input as Json,
      env = c.env;
    this.validateImage(c.image);
    const previous = {
      ...old.config,
      env: { ...(old.config.env as Record<string, string>) },
    };
    if (legacy) {
      const tokens = tokensFromFiles(c.files, env.REINLAB_ACCOUNT_ID),
        previousEnv = previous.env;
      if (
        previousEnv.OPENSCIENCE_AUTH_TOKEN !== tokens.auth ||
        previousEnv.REINLAB_CONTAINER_SECRET !== tokens.container
      )
        throw conflict();
      delete previousEnv.OPENSCIENCE_AUTH_TOKEN;
      delete previousEnv.REINLAB_CONTAINER_SECRET;
      Object.assign(previousEnv, {
        REINLAB_ACCOUNT_CREDENTIAL_FILE: ACCOUNT_CREDENTIAL_PATH,
        REINLAB_CREDENTIAL_SOURCE_UID: String(
          process.platform === "darwin" ? 0 : (getuid?.() ?? 0),
        ),
      });
      Object.assign(previous, {
        files: accountCredentialFiles(env.REINLAB_ACCOUNT_ID, tokens),
      });
    }
    // Canonical comparison ignores object-key order, never identity or any deployment field.
    const canonical = (v: any): string =>
      JSON.stringify(
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, JSON.parse(canonical(v[k]))]),
            )
          : Array.isArray(v)
            ? v.map((x) => JSON.parse(canonical(x)))
            : v,
      );
    if (canonical({ ...c, image: old.config.image }) !== canonical(previous))
      throw conflict();
    const plan = this.plan({
      accountId: env.REINLAB_ACCOUNT_ID,
      volumeId: c.mounts[0].volume,
      image: c.image,
      controlUrl: env.REINLAB_CONTROL_URL,
      tokens: tokensFromFiles(c.files, env.REINLAB_ACCOUNT_ID),
    });
    const imageId = (
      await this.call("/images/" + encodeURIComponent(c.image) + "/json")
    ).Id;
    if (
      !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
      (proof && imageId !== proof.targetImageDigest)
    )
      throw conflict();
    const resourceId = this.immutableId(raw);
    if (raw.State.Running)
      await this.call("/containers/" + resourceId + "/stop?t=10", "POST");
    await this.call("/containers/" + resourceId, "DELETE");
    await this.createPinnedMachine(plan, imageId);
  }
}
