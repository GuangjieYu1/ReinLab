import { beforeAll, expect, it } from "vitest";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { initialEffective, planBenchPatch } from "../src/harness/resolver";
import { fixtureBenchWithTunables } from "./fixtures/bench-tunable";

let base: ReturnType<typeof initialEffective>;
let registry: Awaited<ReturnType<typeof loadToolRegistry>>;
beforeAll(async () => {
  registry = await loadToolRegistry();
  base = initialEffective(await loadBenchBundle({ benchId: "research", registry }));
});

it.each([
  { roles: {} },
  { roles: { "research-read": {} } },
  { roles: { "research-read": { tools: {} } } },
  { roles: { "research-read": { memory: { write: [] } } } },
])("independent empty unlisted containers cannot disappear during planning: %j", patch => {
  expect(() => planBenchPatch(base, patch, registry, 300)).toThrow(
    expect.objectContaining({ code: "FIELD_NOT_TUNABLE", status: 400 }),
  );
});

it.each(["budget.*:unknown", "budget.*:tighten_only:unknown", "budget..*", "budget.*:"])(
  "independent malformed or unknown grant fails closed: %s", rule => {
    const snapshot = fixtureBenchWithTunables(base, [rule]);
    expect(() => planBenchPatch(snapshot, { budget: { default_cny: 4 } }, registry, 300)).toThrow(
      expect.objectContaining({ code: "FIELD_NOT_TUNABLE", status: 400 }),
    );
  },
);

it("independent middle wildcard grants one role segment and no neighboring field", () => {
  const snapshot = fixtureBenchWithTunables(base, ["roles.*.tools.literature"]);
  expect(planBenchPatch(snapshot, { roles: { "research-read": { tools: { literature: "deny" } } } }, registry, 300).requiresApproval).toBe(false);
  expect(() => planBenchPatch(snapshot, { roles: { "research-read": { tools: { read: "ask" } } } }, registry, 300)).toThrow(
    expect.objectContaining({ code: "FIELD_NOT_TUNABLE", status: 400 }),
  );
  expect(() => planBenchPatch(snapshot, { roles: { "research-read": { memory: { read: [] } } } }, registry, 300)).toThrow(
    expect.objectContaining({ code: "FIELD_NOT_TUNABLE", status: 400 }),
  );
});

it("independent same-value unlisted array rejects an otherwise valid mixed patch atomically", () => {
  const before = JSON.stringify(base);
  expect(() => planBenchPatch(base, {
    budget: { default_cny: 4 },
    roles: { "research-read": { write_targets: [...base.manifest.roles["research-read"].write_targets] } },
  }, registry, 300)).toThrow(expect.objectContaining({ code: "FIELD_NOT_TUNABLE", status: 400 }));
  expect(JSON.stringify(base)).toBe(before);
});

it("independent tighten_only grant preserves approval requirement and dangerous-tool floor", () => {
  const proposal = planBenchPatch(base, { roles: { "research-read": { tools: { read: "ask" } } } }, registry, 300);
  expect(proposal.requiresApproval).toBe(true);
  expect(() => planBenchPatch(base, { roles: { "research-read": { tools: { task: "ask" } } } }, registry, 300)).toThrow();
});
