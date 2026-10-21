import {
  BenchManifest,
  benchPatchFor,
  type BenchPatch,
  type ToolRegistry,
  type BenchPermission,
} from "@reinlab/contracts";
import { createHash } from "node:crypto";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";
import { assertBenchSafety, type LoadedBenchBundle } from "./manifest";
export type EffectiveBench = {
  manifest: BenchManifest;
  prompts: Record<string, string>;
  dossierNotes: Record<string, string>;
  bundleDigest: string;
  registryHash: string;
  digest: string;
};
export type ConfigChange = {
  path: string;
  direction: "tighten" | "loosen" | "preference";
  before: unknown;
  after: unknown;
};
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
function seal(raw: Omit<EffectiveBench, "digest">): EffectiveBench {
  const value = { ...raw, digest: hash(raw) };
  const freeze = (v: unknown) => {
    if (v && typeof v === "object") {
      for (const item of Object.values(v)) freeze(item);
      Object.freeze(v);
    }
  };
  freeze(value);
  return value;
}
export function initialEffective(bundle: LoadedBenchBundle): EffectiveBench {
  return seal({
    manifest: structuredClone(bundle.manifest),
    prompts: { ...bundle.prompts },
    dossierNotes: {},
    bundleDigest: bundle.digest,
    registryHash: bundle.registryHash,
  });
}
export function verifyEffective(
  raw: unknown,
  registry: ToolRegistry,
): EffectiveBench {
  if (!raw || typeof raw !== "object")
    throw new ApiFailure("HARNESS_CORRUPT", 503, "工作台配置快照校验失败。");
  const { digest, ...data } = raw as EffectiveBench;
  if (!/^[a-f0-9]{64}$/.test(digest) || hash(data) !== digest)
    throw new ApiFailure("HARNESS_CORRUPT", 503, "工作台配置快照校验失败。");
  BenchManifest.parse(data.manifest);
  assertBenchSafety(data.manifest, registry);
  for (const role of Object.keys(data.manifest.roles))
    if (typeof data.prompts[role] !== "string")
      throw new ApiFailure("HARNESS_CORRUPT", 503, "工作台提示词快照缺失。");
  return seal(data);
}
const rank: Record<BenchPermission, number> = { allow: 0, ask: 1, deny: 2 };
function covered(target: string, allowed: string) {
  return (
    target === allowed || (allowed.endsWith("/") && target.startsWith(allowed))
  );
}
function assertTunable(manifest: BenchManifest, patch: BenchPatch) {
  const patterns = manifest.tunable.flatMap((rule) => {
    const [path, suffix, ...extra] = rule.split(":");
    if (extra.length || (suffix !== undefined && suffix !== "tighten_only"))
      return [];
    const parts = path.split(".");
    return parts.every(
      (part) => part === "*" || /^[a-z][a-z0-9_-]*$/.test(part),
    )
      ? [parts]
      : [];
  });
  const visit = (value: unknown, path: string[]) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length
    ) {
      for (const [key, child] of Object.entries(value))
        visit(child, [...path, key]);
      return;
    }
    // A terminal wildcard grants the declared subtree (budget.* includes
    // budget.by_mode.read); other wildcards match exactly one path segment.
    const allowed = patterns.some(
      (pattern) =>
        path.length >= pattern.length &&
        pattern.every((part, index) => part === "*" || part === path[index]) &&
        (pattern.length === path.length || pattern.at(-1) === "*"),
    );
    if (!allowed)
      throw new ApiFailure(
        "FIELD_NOT_TUNABLE",
        400,
        "该工作台未开放此微调字段。",
      );
  };
  for (const [key, value] of Object.entries(patch)) visit(value, [key]);
}
/** Produces a proposal only. Approval authority exists exclusively in HarnessStore. */
export function planBenchPatch(
  base: EffectiveBench,
  raw: unknown,
  registry: ToolRegistry,
  accountCapCny: number,
) {
  const parsed = benchPatchFor(base.manifest).safeParse(raw);
  if (!parsed.success)
    throw new ApiFailure("INVALID_INPUT", 400, "工作台微调字段无效。");
  assertTunable(base.manifest, parsed.data);
  const patch: BenchPatch = parsed.data,
    candidate = structuredClone(base),
    changes: ConfigChange[] = [];
  const add = (
    path: string,
    before: unknown,
    after: unknown,
    direction: ConfigChange["direction"],
  ) => {
    if (canonical(before) !== canonical(after))
      changes.push({ path, before, after, direction });
  };
  for (const [slot, tier] of Object.entries(patch.model_slots ?? {})) {
    add(
      "model_slots." + slot,
      candidate.manifest.model_slots[slot],
      tier,
      "preference",
    );
    candidate.manifest.model_slots[slot] = tier;
  }
  if (patch.budget) {
    const amounts = [
      patch.budget.default_cny,
      ...Object.values(patch.budget.by_mode ?? {}),
    ].filter((v): v is number => v !== null && v !== undefined);
    if (
      !Number.isFinite(accountCapCny) ||
      accountCapCny < 0 ||
      amounts.some((value) => value > accountCapCny)
    )
      throw new ApiFailure(
        "BUDGET_EXCEEDED",
        409,
        "工作台预算不能超过账户上限。",
      );
    const value = {
      ...candidate.manifest.budget,
      ...patch.budget,
      by_mode: {
        ...candidate.manifest.budget.by_mode,
        ...patch.budget.by_mode,
      },
    };
    add("budget", candidate.manifest.budget, value, "preference");
    candidate.manifest.budget = value;
  }
  for (const [role, update] of Object.entries(patch.roles ?? {})) {
    const target = candidate.manifest.roles[role];
    for (const [tool, permission] of Object.entries(update.tools ?? {})) {
      if (tool !== "*" && !Object.hasOwn(registry.tools, tool))
        throw new ApiFailure("INVALID_INPUT", 400, "工具没有已注册的契约。");
      const before = Object.hasOwn(target.tools, tool)
        ? target.tools[tool]
        : "deny";
      add(
        "roles." + role + ".tools." + tool,
        before,
        permission,
        rank[permission] < rank[before] ? "loosen" : "tighten",
      );
      target.tools[tool] = permission;
    }
    if (update.write_targets) {
      const before = target.write_targets;
      add(
        "roles." + role + ".write_targets",
        before,
        update.write_targets,
        update.write_targets.every((v) => before.some((a) => covered(v, a)))
          ? "tighten"
          : "loosen",
      );
      target.write_targets = update.write_targets;
    }
    if (update.memory)
      for (const dimension of ["read", "write"] as const) {
        const value = update.memory[dimension];
        if (value) {
          const before = target.memory[dimension];
          if (value.some((v) => !before.includes(v)))
            throw new ApiFailure("SCOPE_DENIED", 403, "记忆范围只能收窄。");
          add(
            "roles." + role + ".memory." + dimension,
            before,
            value,
            "tighten",
          );
          target.memory[dimension] = value;
        }
      }
    if (update.dossier_note !== undefined) {
      if (/\{(?:file|env):/i.test(update.dossier_note))
        throw new ApiFailure("SCOPE_DENIED", 403, "档案说明不能包含配置引用。");
      add(
        "roles." + role + ".dossier_note",
        candidate.dossierNotes[role] ?? "",
        update.dossier_note,
        "preference",
      );
      candidate.dossierNotes[role] = update.dossier_note;
    }
  }
  const effectiveBudgets = [
    candidate.manifest.budget.default_cny,
    ...Object.values(candidate.manifest.budget.by_mode),
  ].filter((v): v is number => v !== null && v !== undefined);
  if (
    !Number.isFinite(accountCapCny) ||
    accountCapCny < 0 ||
    effectiveBudgets.some((value) => value > accountCapCny)
  )
    throw new ApiFailure(
      "BUDGET_EXCEEDED",
      409,
      "有效配置的预算不能超过账户上限。",
    );
  assertBenchSafety(candidate.manifest, registry);
  const { digest: _digest, ...content } = candidate;
  return {
    candidate: seal(content),
    changes,
    requiresApproval: changes.some((v) => v.direction === "loosen"),
  };
}
