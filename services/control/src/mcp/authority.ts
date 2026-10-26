import { lockBudget } from "../budget";
import type pg from "pg";
import { z } from "zod";
import { ToolRegistry, CapabilityRegistryDocument } from "@reinlab/contracts";
import type { EffectiveBench } from "../harness/resolver";
import { verifyEffective } from "../harness/resolver";
import { ApiFailure } from "../api/errors";
import type { Database } from "../db/database";
import {
  compileCapabilityGrants,
  loadCapabilityCatalog,
  type CapabilityCatalog,
} from "./registry";
import {
  CapabilityScope,
  CapabilitySigner,
  hash,
  tokenDenied,
  verifyRuntimeModelToken,
  verifyCapabilityToken,
  verifyModelToken,
  type TokenClaims,
} from "./token";
const unavailable = () =>
  new ApiFailure("CAPABILITY_SNAPSHOT_MISSING", 409, "运行尚未绑定能力快照。");
export async function bindRunCapabilities(
  client: pg.PoolClient,
  account: string,
  run: string,
  effective: EffectiveBench,
  roleId: string,
  input: Record<string, unknown>,
  catalog: CapabilityCatalog,
) {
  const role = effective.manifest.roles[roleId];
  const refs = Object.hasOwn(input, "memoryRefs")
    ? z.array(z.string().uuid()).max(128).parse(input.memoryRefs)
    : null;
  const scope = CapabilityScope.parse({
    grants: compileCapabilityGrants(role, catalog),
    memory: {
      layers: role.memory.read.filter((v) => v !== "L1"),
      refs,
      assignedCitations: role.memory.refs === "assigned-citations",
    },
  });
  await client.query(
    "insert into mcp_run(account_id,dossier_id,run_id,effective_digest,catalog_digest,catalog,scope_digest,scope) values($1,(select dossier_id from run where id=$2),$2,$3,$4,$5::jsonb,$6,$7::jsonb)",
    [
      account,
      run,
      effective.digest,
      catalog.digest,
      JSON.stringify(catalog),
      hash(scope),
      JSON.stringify(scope),
    ],
  );
}
export type AuthorizedCapability = {
  claims: TokenClaims;
  scope: CapabilityScope;
  catalog: CapabilityCatalog;
};
/** Verification is online on every call, including replays; DB failure never falls back to offline grants. */
export class CapabilityAuthority {
  constructor(
    readonly db: Database,
    readonly signer: CapabilitySigner,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}
  async issue(account: string, run: string) {
    return this.db.withAccount(account, async (client) => {
      await lockBudget(client, account);
      const saved = await this.snapshot(client, account, run);
      const hold = (
        await client.query(
          "select id from budget_hold where account_id=$1 and run_id=$2 and state='reserved' order by created_at desc limit 1",
          [account, run],
        )
      ).rows[0];
      if (!hold) throw tokenDenied();
      const { token, claims } = this.signer.issue(
        {
          account,
          dossier: saved.row.dossier_id,
          run,
          role: saved.row.role_id,
          bench: saved.row.bench,
          version: saved.row.version,
          effectiveDigest: saved.row.effective_digest,
          catalogDigest: saved.catalog.digest,
          scopeDigest: hash(saved.scope),
          hold: hold.id,
        },
        this.now(),
      );
      await client.query(
        "insert into mcp_credential(jti,account_id,dossier_id,run_id,hold_id,claims_hash,issued_at,expires_at) values($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8))",
        [
          claims.jti,
          account,
          claims.dossier,
          run,
          hold.id,
          hash(claims),
          claims.iat,
          claims.exp,
        ],
      );
      return token;
    });
  }
  private async snapshot(client: pg.PoolClient, account: string, run: string) {
    const row = (
      await client.query(
        `select r.dossier_id,r.role_id,r.state,r.ended_at,h.bench,h.version,h.effective_digest,e.snapshot,v.registry,m.catalog,m.catalog_digest,m.scope,m.scope_digest
     from run r join run_harness h on h.account_id=r.account_id and h.run_id=r.id
     join bench_effective e on e.account_id=h.account_id and e.digest=h.effective_digest
     join bench_version v on v.bench=h.bench and v.version=h.version
     join mcp_run m on m.account_id=r.account_id and m.run_id=r.id and m.effective_digest=h.effective_digest
     where r.account_id=$1 and r.id=$2 for share of r`,
        [account, run],
      )
    ).rows[0];
    if (!row) throw unavailable();
    if (
      (
        await client.query("select 1 from mcp_run_revocation where run_id=$1", [
          run,
        ])
      ).rowCount
    )
      throw tokenDenied();
    if (!["running", "waiting"].includes(row.state) || row.ended_at)
      throw tokenDenied();
    const effective = verifyEffective(
      row.snapshot,
      ToolRegistry.parse(row.registry),
    );
    if (effective.digest !== row.effective_digest) throw tokenDenied();
    const document = CapabilityRegistryDocument.parse({
      ...row.registry,
      capabilityRevision: row.catalog.revision,
      capabilities: row.catalog.capabilities,
      aliases: row.catalog.aliases,
    });
    const catalog: CapabilityCatalog = {
      revision: document.capabilityRevision!,
      capabilities: document.capabilities!,
      aliases: document.aliases!,
      digest: row.catalog.digest,
    };
    if (
      hash({
        revision: catalog.revision,
        capabilities: catalog.capabilities,
        aliases: catalog.aliases,
      }) !== catalog.digest ||
      catalog.digest !== row.catalog_digest
    )
      throw tokenDenied();
    const scope = CapabilityScope.parse(row.scope);
    if (hash(scope) !== row.scope_digest) throw tokenDenied();
    return { row, scope, catalog };
  }
  async validate(raw: unknown): Promise<AuthorizedCapability> {
    const claims = verifyCapabilityToken(
      raw,
      this.signer.publicKey,
      this.now(),
    );
    return this.db.withAccount(claims.account, (client) =>
      this.validateClient(client, raw),
    );
  }
  async validateClient(
    client: pg.PoolClient,
    raw: unknown,
  ): Promise<AuthorizedCapability> {
    const claims = verifyCapabilityToken(
      raw,
      this.signer.publicKey,
      this.now(),
    );
    return this.validateClaimsClient(client, claims);
  }
  async issueModel(account: string, run: string, rawMcp: unknown) {
    const auth = await this.validate(rawMcp);
    if (
      auth.claims.account !== account ||
      auth.claims.run !== run ||
      auth.scope.grants.length !== 1 ||
      auth.scope.grants[0].name !== "papers.search"
    )
      throw tokenDenied();
    return this.signer.issueModel(auth.claims);
  }
  async validateModel(raw: unknown) {
    const claims = verifyModelToken(raw, this.signer.publicKey, this.now());
    return this.db.withAccount(claims.account, (c) =>
      this.validateModelClient(c, raw),
    );
  }
  async validateModelClient(client: pg.PoolClient, raw: unknown) {
    return this.validateClaimsClient(
      client,
      verifyModelToken(raw, this.signer.publicKey, this.now()),
    );
  }
  async issueRuntimeModel(account: string, run: string, rawMcp: unknown) {
    const auth = await this.validate(rawMcp);
    if (auth.claims.account !== account || auth.claims.run !== run)
      throw tokenDenied();
    return this.signer.issueRuntimeModel(auth.claims);
  }
  async validateRuntimeModel(raw: unknown) {
    const claims = verifyRuntimeModelToken(
      raw,
      this.signer.publicKey,
      this.now(),
    );
    return this.db.withAccount(claims.account, (c) =>
      this.validateRuntimeModelClient(c, raw),
    );
  }
  async validateRuntimeModelClient(client: pg.PoolClient, raw: unknown) {
    return this.validateClaimsClient(
      client,
      verifyRuntimeModelToken(raw, this.signer.publicKey, this.now()),
    );
  }
  private async validateClaimsClient(
    client: pg.PoolClient,
    claims: TokenClaims,
  ): Promise<AuthorizedCapability> {
    await lockBudget(client, claims.account);
    const saved = await this.snapshot(client, claims.account, claims.run);
    const row = (
      await client.query(
        "select c.claims_hash,c.revoked_at,c.expires_at>now() valid,h.state from mcp_credential c join budget_hold h on h.id=c.hold_id and h.account_id=c.account_id where c.jti=$1 and c.account_id=$2 for share of c,h",
        [claims.jti, claims.account],
      )
    ).rows[0];
    if (
      !row ||
      row.revoked_at ||
      !row.valid ||
      row.state !== "reserved" ||
      row.claims_hash !== hash(claims) ||
      claims.scopeDigest !== hash(saved.scope) ||
      claims.catalogDigest !== saved.catalog.digest ||
      claims.effectiveDigest !== saved.row.effective_digest ||
      claims.dossier !== saved.row.dossier_id ||
      claims.role !== saved.row.role_id ||
      claims.bench !== saved.row.bench ||
      claims.version !== saved.row.version
    )
      throw tokenDenied();
    if (
      claims.role === "research-clarify" &&
      !(
        await client.query(
          "select 1 from read_clarify_run r join read_clarification d using(account_id,dossier_id) where r.run_id=$1 and not r.closed and not d.closed",
          [claims.run],
        )
      ).rowCount
    )
      throw tokenDenied();
    return { claims, scope: saved.scope, catalog: saved.catalog };
  }
  async revoke(account: string, run: string) {
    await this.db.withAccount(account, (client) =>
      this.revokeClient(client, account, run),
    );
  }
  async revokeClient(client: pg.PoolClient, account: string, run: string) {
    await lockBudget(client, account);
    if (
      !(
        await client.query(
          "select id from run where account_id=$1 and id=$2 for update",
          [account, run],
        )
      ).rowCount
    )
      throw tokenDenied();
    await client.query(
      "insert into mcp_run_revocation(account_id,dossier_id,run_id) select account_id,dossier_id,run_id from mcp_run where account_id=$1 and run_id=$2 on conflict do nothing",
      [account, run],
    );
    await client.query(
      "update mcp_credential set revoked_at=coalesce(revoked_at,now()) where account_id=$1 and run_id=$2",
      [account, run],
    );
  }
}
export { loadCapabilityCatalog };
