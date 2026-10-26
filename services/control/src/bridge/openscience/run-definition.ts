import { z } from "zod";
import { hash, CapabilityScope } from "../../mcp/token";
import type { Database } from "../../db/database";
import { ApiFailure, denied } from "../../api/errors";
import { canonical } from "../../api/context";
import { ToolRegistry } from "@reinlab/contracts";
import { verifyEffective } from "../../harness/resolver";
import { materializeHarnessRole } from "../../harness/materialize";
import type { RunDefinition } from "./run-bridge";
import { RoleProjectRequest } from "./role-project";
/** Legacy trusted configuration; never overrides the confirmed run model route. */
export type RunDefinitionOptions = {
  modelRoutes?: Partial<Record<"cheap" | "mid" | "strong", string>>;
  realModels?: boolean;
};
const invalid = () =>
  new ApiFailure("INVALID_INPUT", 400, "运行输入或收窄限制无效。");
const corrupt = () =>
  new ApiFailure("HARNESS_CORRUPT", 503, "运行绑定的工作台快照校验失败。");
const tooLarge = () =>
  new ApiFailure(
    "MEMORY_TOO_LARGE",
    413,
    "允许的记忆快照超过大小限制，请显式收窄引用。",
  );
const refsSchema = z.array(z.string().uuid()).max(128);
const memoryRow = z.object({
  id: z.string().uuid(),
  layer: z.enum(["L2", "L3", "L4"]),
  key: z.string(),
  value: z.unknown(),
  evidence: z.unknown(),
});
/** Loads immutable run authority only; never resolves current dossier tuning or role_def. */
export function createHarnessRunDefinitionLoader(
  db: Database,
  _options: RunDefinitionOptions = {},
): (accountId: string, runId: string) => Promise<RunDefinition> {
  return async (accountId, runId) => {
    if (
      !z.string().uuid().safeParse(accountId).success ||
      !z.string().uuid().safeParse(runId).success
    )
      throw denied();
    return db.withAccount(accountId, async (client) => {
      const result = await client.query(
        `select r.dossier_id,r.role_id,r.input,d.bench dossier_bench,h.bench,h.version,h.effective_digest,h.model_route,e.bundle_digest,e.snapshot,v.registry,v.digest version_digest,m.catalog,m.catalog_digest,m.scope,m.scope_digest
    from run r join dossier d on d.account_id=r.account_id and d.id=r.dossier_id
    left join run_harness h on h.account_id=r.account_id and h.dossier_id=r.dossier_id and h.run_id=r.id
    left join bench_effective e on e.account_id=h.account_id and e.digest=h.effective_digest and e.bench=h.bench and e.version=h.version
    left join bench_version v on v.bench=e.bench and v.version=e.version
    left join mcp_run m on m.account_id=r.account_id and m.run_id=r.id
    where r.account_id=$1 and r.id=$2`,
        [accountId, runId],
      );
      if (result.rowCount !== 1) throw denied();
      const row = result.rows[0];
      if (!row.effective_digest)
        throw new ApiFailure(
          "HARNESS_SNAPSHOT_MISSING",
          409,
          "运行尚未绑定不可变工作台快照。",
        );
      let registry: z.infer<typeof ToolRegistry>,
        effective: ReturnType<typeof verifyEffective>;
      try {
        registry = ToolRegistry.parse(row.registry);
        effective = verifyEffective(row.snapshot, registry);
        if (
          effective.digest !== row.effective_digest ||
          effective.manifest.id !== row.bench ||
          row.bench !== row.dossier_bench ||
          effective.manifest.version !== row.version ||
          effective.bundleDigest !== row.bundle_digest ||
          row.bundle_digest !== row.version_digest ||
          !Object.hasOwn(effective.manifest.roles, row.role_id)
        )
          throw corrupt();
      } catch {
        throw corrupt();
      }
      const boundRoute = RoleProjectRequest.shape.model.safeParse(
        row.model_route,
      );
      if (!boundRoute.success)
        throw new ApiFailure(
          "MODEL_ROUTE_UNBOUND",
          409,
          "运行尚未绑定有效的已确认模型路由，请重新确认。",
        );
      const tier =
        effective.manifest.model_slots[
          effective.manifest.roles[row.role_id].model_slot
        ];
      if (!tier) throw corrupt();
      // Estimate confirmation is the authority. Restart/environment changes cannot re-route this run.
      const modelRoutes = { [tier]: boundRoute.data };
      let input: Record<string, unknown>,
        message: string,
        maxSteps: number | undefined,
        refs: string[] | undefined;
      try {
        input = z.record(z.unknown()).parse(row.input);
        const fallback = canonical(input);
        if (fallback.length > 1000000) throw invalid();
        message =
          typeof input.question === "string" && input.question.trim()
            ? input.question.trim()
            : fallback;
        if (!message || message.length > 1000000) throw invalid();
        if (Object.hasOwn(input, "memoryRefs"))
          refs = refsSchema.parse(input.memoryRefs);
        if (Object.hasOwn(input, "limits")) {
          const limits = z
            .object({ maxSteps: z.number().int().min(1).optional() })
            .passthrough()
            .parse(input.limits);
          maxSteps = limits.maxSteps;
          if (
            maxSteps !== undefined &&
            maxSteps > effective.manifest.roles[row.role_id].steps
          )
            throw invalid();
        }
      } catch {
        throw invalid();
      }
      const scope = effective.manifest.roles[row.role_id].memory;
      let memory = "";
      // Assigned citations require the P1-15 verifier. UUID/path input is not proof.
      if (
        scope.refs === "explicit" &&
        scope.read.length &&
        refs?.length !== 0
      ) {
        const items = await client.query(
          `select m.id,m.layer,m.key,m.value,m.evidence from memory_item m
     where m.account_id=$1 and m.layer=any($3::text[]) and m.revoked_at is null
     and ((m.layer='L2' and m.dossier_id=$2 and m.thread_id is null) or (m.layer in ('L3','L4') and m.dossier_id is null and m.thread_id is null))
     and ($4::uuid[] is null or m.id=any($4::uuid[]))
     and not exists(select 1 from memory_item successor where successor.account_id=$1 and successor.supersedes=m.id)
     order by m.layer,m.key,m.id limit 129`,
          [
            accountId,
            row.dossier_id,
            scope.read.filter((layer) => layer !== "L1"),
            refs ?? null,
          ],
        );
        if (items.rows.length > 128) throw tooLarge();
        if (items.rows.length) {
          const selected = items.rows.map((raw) => {
            const parsed = memoryRow.safeParse(raw);
            if (!parsed.success) throw corrupt();
            const item = parsed.data;
            // Canonical JSON records preserve evidence; never silently truncate a source.
            if (
              Buffer.byteLength(canonical(item.value), "utf8") > 65536 ||
              Buffer.byteLength(canonical(item.evidence), "utf8") > 32768
            )
              throw tooLarge();
            return item;
          });
          memory = canonical({ items: selected });
          if (Buffer.byteLength(memory, "utf8") > 131072) throw tooLarge();
        }
      }
      let mcp: z.infer<typeof RoleProjectRequest>["mcp"];
      if (row.catalog) {
        const { digest, ...catalog } = row.catalog;
        const scope = CapabilityScope.parse(row.scope);
        if (
          hash(catalog) !== digest ||
          digest !== row.catalog_digest ||
          hash(scope) !== row.scope_digest
        )
          throw corrupt();
        mcp = {
          runId,
          grants: scope.grants
            .map((g) => ({ ...g, risk: row.catalog.capabilities[g.name].risk }))
            .map(({ writeTargets: _targets, ...g }) => g),
          aliases: Object.fromEntries(
            Object.entries(
              row.catalog.aliases as Record<
                string,
                Array<{ capability: string }>
              >,
            ).flatMap(([alias, entries]) => {
              const allowed = entries
                .map((e) => e.capability)
                .filter((name) => scope.grants.some((g) => g.name === name));
              return allowed.length ? [[alias, allowed]] : [];
            }),
          ),
        };
      }
      return {
        role: RoleProjectRequest.parse({
          ...materializeHarnessRole(effective, registry, {
            dossierId: row.dossier_id,
            roleId: row.role_id,
            modelRoutes,
            memory,
            maxSteps,
          }),
          ...(mcp ? { mcp } : {}),
          ...(_options.realModels &&
          ["research-read", "research-clarify"].includes(row.role_id) &&
          ["1.1.0", "1.2.0", "1.2.1"].includes(row.version)
            ? { modelGateway: true as const }
            : {}),
        }),
        message,
      };
    });
  };
}
