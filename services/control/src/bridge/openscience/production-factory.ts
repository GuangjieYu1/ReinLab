import { runtimeConfiguration } from "../../configuration";
import { z } from "zod";
import type { Database } from "../../db/database";
import { ApiFailure } from "../../api/errors";
import { canonical } from "../../api/context";
import type { AccountDriver } from "../../provisioner/driver";
import { environmentDriver, type KeyVault } from "../../provisioner";
import {
  decryptBundle,
  OS_VERSION,
  type Tokens,
} from "../../provisioner/runtime";
import { RoleProjectRequest } from "./role-project";
import { RemoteRoleStore } from "./remote-role";
import { RoleRuntime } from "./role-runtime";
import type { RuntimeFactory } from "./run-bridge";
export type ProductionFactoryOptions = {
  driver?: AccountDriver;
  vault?: KeyVault;
  app?: string;
  controlUrl?: string;
  transport?: typeof fetch;
};
class FactoryFailure extends ApiFailure {}
const vaultUnavailable = () =>
  new FactoryFailure("VAULT_UNAVAILABLE", 503, "安全凭据存储尚未就绪。");
// This resolver must never initialize Vault: provisioning owns key creation.
const readonlyVault: KeyVault = {
  async key(client) {
    let key: Buffer | undefined;
    try {
      const result = await client.query(
        "select public.reinlab_machine_key($1) value",
        [null],
      );
      const value: unknown = result.rows[0]?.value;
      if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value))
        throw vaultUnavailable();
      key = Buffer.from(value, "base64");
      if (key.length !== 32 || key.toString("base64") !== value)
        throw vaultUnavailable();
      return key;
    } catch {
      key?.fill(0);
      throw vaultUnavailable();
    }
  },
};
const unavailable = () =>
  new FactoryFailure(
    "OS_UNAVAILABLE",
    503,
    "账户执行内核尚未通过身份与就绪验证。",
  );
const conflict = () =>
  new FactoryFailure(
    "PROVISIONING_CONFLICT",
    409,
    "账户机器、持久卷或部署配置与记录不一致。",
  );
const denied = () =>
  new FactoryFailure("SCOPE_DENIED", 403, "账户角色准备超出已授权范围。");
const Row = z.object({
  fly_machine_id: z.string().min(1),
  fly_volume_id: z.string().min(1),
  state: z.literal("ready"),
  os_version: z.literal(OS_VERSION),
  image: z.string().min(1),
  envelope: z
    .object({
      iv: z.string().max(100),
      tag: z.string().max(100),
      ciphertext: z.string().max(4096),
    })
    .strict(),
});
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function configMatches(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  kind: AccountDriver["kind"],
) {
  const observed = { ...actual },
    plan = { ...expected };
  if (observed.services !== undefined) {
    if (!Array.isArray(observed.services) || observed.services.length !== 0)
      throw conflict();
    delete observed.services;
  }
  if (kind === "docker") {
    // Docker normalizes resource limits before returning, and includes immutable
    // image Env. Its normalized DTO intentionally omits guest allocation fields.
    delete plan.guest;
    const env = z.record(z.string()).safeParse(observed.env),
      wanted = z.record(z.string()).safeParse(plan.env);
    if (!env.success || !wanted.success) throw conflict();
    if (
      Object.entries(wanted.data).some(
        ([key, value]) => env.data[key] !== value,
      ) ||
      Object.keys(env.data).some(
        (key) =>
          /^(?:OPENSCIENCE_|REINLAB_)/.test(key) &&
          !Object.hasOwn(wanted.data, key),
      )
    )
      throw conflict();
    observed.env = wanted.data;
  }
  if (!same(observed, plan)) throw conflict();
}
function checkedEndpoint(
  value: string,
  driver: AccountDriver,
  machineId: string,
  app: string,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw conflict();
  }
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw conflict();
  if (driver.kind === "docker") {
    if (
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      Number(url.port) < 1 ||
      Number(url.port) > 65535
    )
      throw conflict();
  } else if (driver.kind === "fly") {
    if (
      !/^[a-f0-9]{10,32}$/.test(machineId) ||
      url.hostname !== machineId + ".vm." + app + ".internal" ||
      url.port !== "4096"
    )
      throw conflict();
  } else throw conflict();
  return url.origin;
}
/** Production-only account resolver; never provisions, starts or repairs resources. */
export function createProductionAccountResolver(
  db: Database,
  options: ProductionFactoryOptions = {},
) {
  const dependencies = Object.freeze({ ...options }),
    vault = dependencies.vault ?? readonlyVault;
  const config = runtimeConfiguration();
  const app =
      dependencies.app ?? config.FLY_APP_ACCOUNTS ?? "reinlab-local",
    controlUrl = dependencies.controlUrl ?? config.REINLAB_CONTROL_URL;
  return async (accountId: string) => {
    try {
      const identity = z.string().uuid().safeParse(accountId);
      if (!identity.success) throw denied();
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(app) || !controlUrl)
        throw unavailable();
      const account = identity.data.toLowerCase();
      const authorized = await db.withAccount(account, async (client) => {
        const result = await client.query(
          "select m.fly_machine_id,m.fly_volume_id,m.state,m.os_version,m.image,s.envelope from account_machine m join account_machine_secret s on s.account_id=m.account_id where m.account_id=$1",
          [account],
        );
        const parsed = Row.safeParse(result.rows[0]);
        if (result.rowCount !== 1 || !parsed.success) throw unavailable();
        let key: Buffer | undefined;
        try {
          key = await vault.key(client);
          if (!Buffer.isBuffer(key) || key.length !== 32) throw unavailable();
          const tokens = decryptBundle(account, key, parsed.data.envelope);
          const { envelope: _envelope, ...record } = parsed.data;
          return { record, tokens };
        } finally {
          key?.fill(0);
        }
      });
      const driver = dependencies.driver ?? environmentDriver();
      if (!["fly", "docker"].includes(driver.kind)) throw conflict();
      const record = authorized.record,
        tokens: Tokens = authorized.tokens;
      const plan = driver.plan({
        accountId: account,
        volumeId: record.fly_volume_id,
        image: record.image,
        controlUrl,
        tokens,
      });
      const [allMachines, allVolumes] = await Promise.all([
        driver.listMachines(),
        driver.listVolumes(),
      ]);
      const machines = allMachines.filter(
        (item) =>
          item.id === record.fly_machine_id ||
          item.name === "rl-" + account.replaceAll("-", "") ||
          item.config.metadata?.reinlab_account_id === account,
      );
      const volumes = allVolumes.filter(
        (item) =>
          item.id === record.fly_volume_id ||
          item.name === "rl_" + account.replaceAll("-", ""),
      );
      const machine = machines[0],
        volume = volumes[0];
      if (
        machines.length !== 1 ||
        volumes.length !== 1 ||
        !machine ||
        !volume ||
        machine.id !== record.fly_machine_id ||
        machine.name !== plan.name ||
        machine.name !== "rl-" + account.replaceAll("-", "") ||
        machine.state !== "started" ||
        machine.region !== driver.region ||
        machine.region !== plan.region ||
        volume.id !== record.fly_volume_id ||
        volume.name !== "rl_" + account.replaceAll("-", "") ||
        volume.region !== driver.region ||
        (volume.attached_machine_id &&
          volume.attached_machine_id !== machine.id)
      )
        throw conflict();
      configMatches(machine.config, plan.config, driver.kind);
      const baseUrl = checkedEndpoint(
        await driver.endpoint(machine.id, app),
        driver,
        machine.id,
        app,
      );
      return { baseUrl, token: tokens.auth, accountId: account };
    } catch (error) {
      if (error instanceof FactoryFailure) throw error;
      if ((error as { code?: string })?.code === "SCOPE_DENIED") throw denied();
      throw unavailable();
    }
  };
}

export function createProductionRuntimeFactory(
  db: Database,
  options: ProductionFactoryOptions = {},
): RuntimeFactory {
  const resolve = createProductionAccountResolver(db, options);
  return async (accountId, rawRole) => {
    const role = RoleProjectRequest.safeParse(rawRole);
    if (!role.success) throw denied();
    const connection = await resolve(accountId);
    const store = new RemoteRoleStore(connection, options.transport);
    const project = await store.prepare({
      ...role.data,
      root: "/data",
      pluginUrl: "file:///opt/reinlab/plugin/index.js",
    });
    return new RoleRuntime({ ...connection, project });
  };
}
