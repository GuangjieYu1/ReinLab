import { sameCredentialFiles } from "./credential-file";
import { runtimeConfiguration } from "../configuration";
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { Database } from "../db/database";
import { ApiFailure } from "../api/errors";
import {
  decryptBundle,
  encryptBundle,
  OS_VERSION,
  type Tokens,
} from "./runtime";
import { FlyMachines } from "./fly";
import { DockerMachines } from "./docker";
import { driverFor, type Machines, type AccountDriver } from "./driver";
export interface KeyVault {
  key(client: pg.PoolClient): Promise<Buffer>;
}
export class SupabaseKeyVault implements KeyVault {
  async key(client: pg.PoolClient) {
    try {
      const r = await client.query(
        "select public.reinlab_machine_key($1) value",
        [randomBytes(32).toString("base64")],
      );
      const key = Buffer.from(r.rows[0].value, "base64");
      if (key.length !== 32) throw new Error("KEY_INVALID");
      return key;
    } catch {
      throw new ApiFailure("VAULT_UNAVAILABLE", 503, "安全凭据存储尚未就绪。");
    }
  }
}
type State = {
  fly_machine_id: string | null;
  fly_volume_id: string | null;
  state: string;
  phase: string;
  image: string | null;
};
export class AccountProvisioner {
  private driver: AccountDriver;
  constructor(
    private db: Database,
    machines: Machines,
    private vault: KeyVault,
    private config: { app: string; image: string; controlUrl: string },
    private health:
      | ((machineId: string, tokens: Tokens) => Promise<boolean>)
      | undefined = undefined,
  ) {
    this.driver = driverFor(machines);
  }
  private account<T>(id: string, fn: (client: pg.PoolClient) => Promise<T>) {
    return this.db.withAccount(id, fn);
  }
  private async tokens(id: string) {
    return this.account(id, async (c) => {
      const key = await this.vault.key(c);
      try {
        const r = await c.query(
          "select envelope from account_machine_secret where account_id=$1",
          [id],
        );
        if (r.rowCount) return decryptBundle(id, key, r.rows[0].envelope);
        const tokens = {
          auth: randomBytes(32).toString("base64url"),
          container: randomBytes(32).toString("base64url"),
        };
        await c.query("insert into account_machine_secret values($1,$2)", [
          id,
          encryptBundle(id, key, tokens),
        ]);
        return tokens;
      } finally {
        key.fill(0);
      }
    });
  }
  private async save(
    id: string,
    lease: string,
    phase: string,
    patch: {
      machine?: string;
      volume?: string;
      state?: string;
      error?: string;
      healthy?: boolean;
    } = {},
  ) {
    const result = await this.account(id, (c) =>
      c.query(
        `update account_machine set phase=$2,state=coalesce($3,state),fly_machine_id=coalesce($4,fly_machine_id),fly_volume_id=coalesce($5,fly_volume_id),last_error_code=$6,updated_at=now(),os_version=case when $7 then $8 else os_version end,last_health_at=case when $7 then now() else last_health_at end where account_id=$1 and lease_id=$9 and lease_until>now()`,
        [
          id,
          phase,
          patch.state ?? null,
          patch.machine ?? null,
          patch.volume ?? null,
          patch.error ?? null,
          patch.healthy ?? false,
          OS_VERSION,
          lease,
        ],
      ),
    );
    if (result.rowCount !== 1)
      throw new ApiFailure(
        "PROVISIONING_LEASE_LOST",
        409,
        "账户机器操作租约已失效。",
      );
  }
  /** Trusted registration/reconcile entry. Never returns tokens, provider responses or raw errors. */
  async ensure(
    id: string,
  ): Promise<{ state: string; machineId: string | null }> {
    const lease = randomUUID(),
      deadline = Date.now() + 175000;
    await this.account(id, async (c) => {
      if (!(await c.query("select id from account where id=$1", [id])).rowCount)
        throw new ApiFailure("SCOPE_DENIED", 403, "账户不可用。");
      await c.query(
        "insert into account_machine(account_id,state,image) values($1,'provisioning',$2) on conflict do nothing",
        [id, this.config.image],
      );
    });
    let claimed = false;
    do {
      claimed = !!(
        await this.account(id, (c) =>
          c.query(
            "update account_machine set lease_id=$2,lease_until=now()+interval '200 seconds' where account_id=$1 and (lease_id is null or lease_until<now()) returning account_id",
            [id, lease],
          ),
        )
      ).rowCount;
      if (!claimed) await new Promise((r) => setTimeout(r, 100));
    } while (!claimed && Date.now() < deadline);
    if (!claimed)
      throw new ApiFailure(
        "PROVISIONING_BUSY",
        409,
        "账户机器正在处理，请稍后重试。",
      );
    const save = (
      phase: string,
      patch: Parameters<AccountProvisioner["save"]>[3] = {},
    ) => this.save(id, lease, phase, patch);
    try {
      let current = (
        await this.account(id, (c) =>
          c.query<State>("select * from account_machine where account_id=$1", [
            id,
          ]),
        )
      ).rows[0];
      try {
        const tokens = await this.tokens(id),
          volumeName = "rl_" + id.replaceAll("-", "");
        // Validate all deployment inputs before any resource mutation.
        this.driver.validateDeployment({
          accountId: id,
          image: this.config.image,
          controlUrl: this.config.controlUrl,
          tokens,
        });
        let volumes = (await this.driver.listVolumes()).filter(
          (v) => v.name === volumeName,
        );
        if (volumes.length > 1)
          throw new ApiFailure(
            "PROVISIONING_CONFLICT",
            409,
            "发现重复账户卷，请人工对账。",
          );
        let volume = volumes[0];
        if (current.fly_volume_id && volume?.id !== current.fly_volume_id)
          throw new ApiFailure(
            "PROVISIONING_CONFLICT",
            409,
            "账户卷与记录不一致。",
          );
        if (!volume) {
          if (current.phase === "volume_creating")
            throw new ApiFailure(
              "PROVISIONING_INDETERMINATE",
              409,
              "卷创建结果未知，请先人工核对。",
            );
          await save("volume_creating");
          volume = await this.driver.createVolume(volumeName);
        }
        if (volume.region !== this.driver.region)
          throw new ApiFailure(
            "PROVISIONING_CONFLICT",
            409,
            "账户卷区域不符。",
          );
        await save(
          current.phase === "machine_creating"
            ? "machine_creating"
            : "volume_ready",
          { volume: volume.id },
        );
        const matches = (await this.driver.listMachines()).filter(
          (m) =>
            m.name === "rl-" + id.replaceAll("-", "") ||
            m.config.metadata?.reinlab_account_id === id,
        );
        if (matches.length > 1)
          throw new ApiFailure(
            "PROVISIONING_CONFLICT",
            409,
            "发现重复账户机器，请人工对账。",
          );
        let m = matches[0];
        if (current.fly_machine_id && m?.id !== current.fly_machine_id)
          throw new ApiFailure(
            "PROVISIONING_CONFLICT",
            409,
            "账户机器与记录不一致。",
          );
        if (!m) {
          if (current.phase === "machine_creating")
            throw new ApiFailure(
              "PROVISIONING_INDETERMINATE",
              409,
              "机器创建结果未知，请先人工核对。",
            );
          await save("machine_creating");
          m = await this.driver.createMachine(
            this.driver.plan({
              accountId: id,
              volumeId: volume.id,
              image: this.config.image,
              controlUrl: this.config.controlUrl,
              tokens,
            }),
          );
        }
        const expectedConfig = this.driver.plan({
          accountId: id,
          volumeId: volume.id,
          image: this.config.image,
          controlUrl: this.config.controlUrl,
          tokens,
        }).config;
        if (
          !sameCredentialFiles(m.config.files, expectedConfig.files) ||
          Object.keys((m.config.env ?? {}) as object).some((k) =>
            /(?:_TOKEN|_SECRET|_KEY|_PASSWORD)$/.test(k),
          ) ||
          m.region !== this.driver.region ||
          m.config.metadata?.reinlab_account_id !== id ||
          m.config.mounts?.length !== 1 ||
          m.config.mounts[0].volume !== volume.id ||
          m.config.mounts[0].path !== "/data" ||
          (volume.attached_machine_id && volume.attached_machine_id !== m.id) ||
          m.config.image !== this.config.image ||
          (m.config.services !== undefined &&
            (!Array.isArray(m.config.services) ||
              m.config.services.length > 0)) ||
          m.config.auto_destroy !== false ||
          (m.config.restart as { policy?: string } | undefined)?.policy !==
            "always" ||
          Object.entries(
            this.driver.plan({
              accountId: id,
              volumeId: volume.id,
              image: this.config.image,
              controlUrl: this.config.controlUrl,
              tokens,
            }).config.env,
          ).some(
            ([key, value]) =>
              (m.config.env as Record<string, string> | undefined)?.[key] !==
              value,
          )
        )
          throw new ApiFailure(
            "PROVISIONING_CONFLICT",
            409,
            "账户机器的身份或卷不符。",
          );
        await save("health_pending", { machine: m.id, state: "starting" });
        if (m.state === "stopped" || m.state === "suspended")
          await this.driver.start(m.id);
        let ok = false;
        do {
          ok = this.health
            ? await this.health(m.id, tokens)
            : await this.check(m.id, tokens);
          if (ok) break;
          await new Promise((r) => setTimeout(r, 1000));
        } while (Date.now() < deadline);
        if (!ok)
          throw new ApiFailure(
            "OS_UNAVAILABLE",
            503,
            "账户运行时健康检查尚未通过。",
          );
        await save("ready", { state: "ready", healthy: true });
        return { state: "ready", machineId: m.id };
      } catch (error) {
        const code =
          error instanceof ApiFailure ? error.code : "PROVISIONER_UNAVAILABLE"; // Keep ambiguous creation phase durable; retry must reconcile before creating again.
        await this.account(id, (c) =>
          c.query(
            "update account_machine set state='failed',last_error_code=$2,updated_at=now() where account_id=$1 and lease_id=$3",
            [id, code, lease],
          ),
        );
        throw new ApiFailure(
          code,
          503,
          "账户机器尚未就绪，请重试或查看运维状态。",
        );
      }
    } finally {
      await this.account(id, (c) =>
        c.query(
          "update account_machine set lease_id=null,lease_until=null where account_id=$1 and lease_id=$2",
          [id, lease],
        ),
      );
    }
  }
  private async check(id: string, tokens: Tokens) {
    try {
      const r = await fetch(
        (await this.driver.endpoint(id, this.config.app)) + "/global/health",
        {
          headers: { authorization: "Bearer " + tokens.auth },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!r.ok) return false;
      const body = (await r.json()) as { healthy?: boolean; version?: string };
      return body.healthy === true && body.version === OS_VERSION;
    } catch {
      return false;
    }
  }
}
export function environmentDriver() {
  const config = runtimeConfiguration();
  const kind = config.PROVISIONER_DRIVER ?? "fly";
  if (kind === "docker") {
    if (!config.DOCKER_HOST)
      throw new ApiFailure(
        "PROVISIONER_CONFIG_MISSING",
        503,
        "本地账户机器部署配置尚未完成。",
      );
    return new DockerMachines(
      config.DOCKER_HOST,
      undefined,
      config.REINLAB_DOCKER_CREDENTIAL_DIR,
    );
  }
  if (kind !== "fly" || !config.FLY_APP_ACCOUNTS || !config.FLY_API_TOKEN)
    throw new ApiFailure(
      "PROVISIONER_CONFIG_MISSING",
      503,
      "账户机器部署配置尚未完成。",
    );
  return driverFor(
    new FlyMachines(config.FLY_APP_ACCOUNTS, config.FLY_API_TOKEN),
  );
}
export function provisionerFromEnvironment(db: Database) {
  const config = runtimeConfiguration();
  const { ACCOUNT_IMAGE, REINLAB_CONTROL_URL } = config;
  if (!ACCOUNT_IMAGE || !REINLAB_CONTROL_URL)
    throw new ApiFailure(
      "PROVISIONER_CONFIG_MISSING",
      503,
      "账户机器部署配置尚未完成。",
    );
  return new AccountProvisioner(
    db,
    environmentDriver(),
    new SupabaseKeyVault(),
    {
      app: config.FLY_APP_ACCOUNTS ?? "reinlab-local",
      image: ACCOUNT_IMAGE,
      controlUrl: REINLAB_CONTROL_URL,
    },
  );
}
