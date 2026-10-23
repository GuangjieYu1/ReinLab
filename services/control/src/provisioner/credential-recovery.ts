import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Database } from "../db/database";
import { DockerMachines } from "./docker";
import type { KeyVault } from "./index";
import { decryptBundle } from "./runtime";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";
import { lockBudget } from "../budget";
const fail = () =>
  new ApiFailure(
    "CREDENTIAL_RECONCILIATION_REQUIRED",
    409,
    "凭据迁移结果需按固定证据人工对账。",
  );
const sha = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const Proof = z
  .object({
    accountId: z.string().uuid(),
    operationId: z.string().uuid(),
    recoveryOperationId: z.string().uuid(),
    expectedImmutableId: z.string().regex(/^[a-f0-9]{64}$/),
    targetImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .refine((v) => v.operationId !== v.recoveryOperationId);
/** Trusted local maintenance only. Not a generic unknown-result reset or a web/MCP capability.
 * This narrowly attests e044e46's image-ENV canonical rejection BEFORE the first mutation.
 * The old operation is terminal; a separately audited, pinned new intent runs under the same lease.
 */
export async function reconcileKnownCredentialPreflight(input: {
  db: Database;
  driver: DockerMachines;
  vault: KeyVault;
  accountId: string;
  operationId: string;
  recoveryOperationId: string;
  expectedImmutableId: string;
  targetImageDigest: string;
}) {
  const { db, driver, vault, ...raw } = input,
    p = Proof.parse(raw),
    lease = randomUUID();
  if (driver.kind !== "docker") throw fail();
  await db.withAccount(p.accountId, async (c) => {
    const changed = await c.query(
      "update account_machine set lease_id=$2,lease_until=now()+interval '200 seconds' where account_id=$1 and (lease_id is null or lease_until<now()) returning account_id",
      [p.accountId, lease],
    );
    if (!changed.rowCount) throw fail();
  });
  try {
    const previous = await db.withAccount(p.accountId, async (c) => {
      const reconciled = (
        await c.query(
          "select r.*,o.state recovery_state from credential_preflight_reconciliation r join account_machine_operation o on o.account_id=r.account_id and o.operation_id=r.recovery_operation_id where r.account_id=$1 and r.operation_id=$2",
          [p.accountId, p.operationId],
        )
      ).rows[0];
      if (reconciled) {
        if (
          reconciled.recovery_operation_id !== p.recoveryOperationId ||
          reconciled.immutable_id !== p.expectedImmutableId ||
          reconciled.target_image_digest !== p.targetImageDigest ||
          reconciled.recovery_state !== "applied"
        )
          throw fail();
        return { replayed: true as const };
      }
      const op = (
          await c.query(
            "select * from account_machine_operation where account_id=$1 and operation_id=$2",
            [p.accountId, p.operationId],
          )
        ).rows[0],
        machine = (
          await c.query("select * from account_machine where account_id=$1", [
            p.accountId,
          ])
        ).rows[0];
      if (
        !op ||
        op.state !== "indeterminate" ||
        op.mode !== "wait" ||
        op.request_hash !==
          createHash("sha256")
            .update(
              JSON.stringify({
                image: op.image,
                mode: "wait",
                migrateCredentials: true,
              }),
            )
            .digest("hex") ||
        machine?.state !== "starting" ||
        machine.phase !== "upgrade_pending:" + p.operationId
      )
        throw fail();
      const key = await vault.key(c);
      try {
        const secret = (
          await c.query(
            "select envelope from account_machine_secret where account_id=$1",
            [p.accountId],
          )
        ).rows[0];
        if (!secret) throw fail();
        return {
          replayed: false as const,
          op,
          machine,
          tokens: decryptBundle(p.accountId, key, secret.envelope),
        };
      } finally {
        key.fill(0);
      }
    });
    if (previous.replayed)
      return {
        code: "CREDENTIAL_PREFLIGHT_RECOVERED",
        operationId: p.recoveryOperationId,
        replayed: true,
      };
    const { op, machine, tokens } = previous,
      first = await driver.inspectCredentialMigration(
        machine.fly_machine_id,
        op.image,
      );
    if (
      first.immutableId !== p.expectedImmutableId ||
      first.targetImageDigest !== p.targetImageDigest ||
      Date.parse(first.createdAt) >= new Date(op.created_at).getTime() ||
      first.machine.config.files !== undefined ||
      first.machine.config.image === op.image
    )
      throw fail();
    const env = first.machine.config.env as Record<string, string>;
    if (
      env.REINLAB_ACCOUNT_ID !== p.accountId ||
      first.machine.config.mounts?.[0]?.volume !== machine.fly_volume_id ||
      env.OPENSCIENCE_AUTH_TOKEN !== tokens.auth ||
      env.REINLAB_CONTAINER_SECRET !== tokens.container
    )
      throw fail();
    const plan = driver.plan({
      accountId: p.accountId,
      volumeId: machine.fly_volume_id,
      image: op.image,
      controlUrl: env.REINLAB_CONTROL_URL,
      tokens,
    });
    const migratedEnv: Record<string, string> = { ...env, ...plan.config.env };
    delete migratedEnv.OPENSCIENCE_AUTH_TOKEN;
    delete migratedEnv.REINLAB_CONTAINER_SECRET;
    const imageDefaults = Object.keys(migratedEnv)
      .filter((key) => !Object.hasOwn(plan.config.env, key))
      .sort();
    if (
      !imageDefaults.length ||
      imageDefaults.some((key) =>
        /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$|^DATABASE_URL(?:_|$)/.test(key),
      )
    )
      throw fail();
    // Reproduce the old bug without executing it: only the verified image defaults
    // differ, so the old canonical comparison necessarily rejected before stop/delete.
    const oldIntended = {
      ...first.machine.config,
      image: op.image,
      files: plan.config.files,
      env: plan.config.env,
    };
    const normalizedLegacy = {
      ...first.machine.config,
      files: plan.config.files,
      env: migratedEnv,
    };
    if (
      canonical({ ...oldIntended, image: first.machine.config.image }) ===
      canonical(normalizedLegacy)
    )
      throw fail();
    const second = await driver.inspectCredentialMigration(
      machine.fly_machine_id,
      op.image,
    );
    if (
      second.immutableId !== first.immutableId ||
      second.createdAt !== first.createdAt ||
      second.targetImageDigest !== first.targetImageDigest ||
      canonical(second.machine.config) !== canonical(first.machine.config)
    )
      throw fail();
    const proofDigest = sha({
      operationId: p.operationId,
      immutableId: first.immutableId,
      containerCreatedAt: first.createdAt,
      targetImageDigest: p.targetImageDigest,
      imageDefaults,
      reason: "e044e46_image_env_preflight_rejection",
    });
    await db.withAccount(p.accountId, async (c) => {
      await lockBudget(c, p.accountId);
      const row = (
        await c.query(
          "select state,phase from account_machine where account_id=$1 and lease_id=$2 and lease_until>clock_timestamp() for update",
          [p.accountId, lease],
        )
      ).rows[0];
      const old = (
        await c.query(
          "select state from account_machine_operation where account_id=$1 and operation_id=$2 for update",
          [p.accountId, p.operationId],
        )
      ).rows[0];
      if (
        row?.state !== "starting" ||
        row.phase !== "upgrade_pending:" + p.operationId ||
        old?.state !== "indeterminate" ||
        (
          await c.query(
            "select id from run where account_id=$1 and state in ('queued','running','waiting','paused_budget') limit 1",
            [p.accountId],
          )
        ).rowCount
      )
        throw fail();
      await c.query(
        "insert into account_machine_operation(account_id,operation_id,request_hash,image,mode,state) values($1,$2,$3,$4,'wait','pending')",
        [p.accountId, p.recoveryOperationId, op.request_hash, op.image],
      );
      await c.query(
        "insert into credential_preflight_reconciliation(account_id,operation_id,recovery_operation_id,immutable_id,container_created_at,target_image_digest,proof_digest,reason) values($1,$2,$3,$4,$5,$6,$7,'e044e46_image_env_preflight_rejection')",
        [
          p.accountId,
          p.operationId,
          p.recoveryOperationId,
          first.immutableId,
          first.createdAt,
          p.targetImageDigest,
          proofDigest,
        ],
      );
      await c.query(
        "update account_machine_operation set state='not_applied' where account_id=$1 and operation_id=$2",
        [p.accountId, p.operationId],
      );
      await c.query(
        "update account_machine set state='starting',phase=$3 where account_id=$1 and lease_id=$2",
        [p.accountId, lease, "upgrade_pending:" + p.recoveryOperationId],
      );
    });
    try {
      await driver.migrateCredentials(
        machine.fly_machine_id,
        {
          ...first.machine.config,
          image: op.image,
          files: plan.config.files,
          env: migratedEnv,
        },
        {
          immutableId: first.immutableId,
          targetImageDigest: p.targetImageDigest,
        },
      );
      const completed = await driver.inspectCredentialMigration(
        machine.fly_machine_id,
        op.image,
        false,
      );
      if (
        completed.targetImageDigest !== p.targetImageDigest ||
        completed.runtimeImageDigest !== p.targetImageDigest ||
        completed.machine.config.image !== op.image ||
        canonical(completed.machine.config.files) !==
          canonical(plan.config.files)
      )
        throw fail();
      await db.withAccount(p.accountId, async (c) => {
        const changed = await c.query(
          "update account_machine_operation o set state='applied' where o.account_id=$1 and o.operation_id=$2 and o.state='pending' and exists(select 1 from account_machine m where m.account_id=$1 and m.lease_id=$3 and m.lease_until>clock_timestamp() and m.phase=$4)",
          [
            p.accountId,
            p.recoveryOperationId,
            lease,
            "upgrade_pending:" + p.recoveryOperationId,
          ],
        );
        if (!changed.rowCount) throw fail();
      });
    } catch {
      await db.withAccount(p.accountId, (c) =>
        c.query(
          "update account_machine_operation set state='indeterminate' where account_id=$1 and operation_id=$2 and state='pending'",
          [p.accountId, p.recoveryOperationId],
        ),
      );
      throw fail();
    }
    return {
      code: "CREDENTIAL_PREFLIGHT_RECOVERED",
      operationId: p.recoveryOperationId,
      replayed: false,
    };
  } finally {
    await db.withAccount(p.accountId, (c) =>
      c.query(
        "update account_machine set lease_id=null,lease_until=null where account_id=$1 and lease_id=$2",
        [p.accountId, lease],
      ),
    );
  }
}
