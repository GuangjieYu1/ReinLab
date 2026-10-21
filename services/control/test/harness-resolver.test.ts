import { beforeAll, expect, it } from "vitest";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { initialEffective, planBenchPatch } from "../src/harness/resolver";
let base: ReturnType<typeof initialEffective>,
  registry: Awaited<ReturnType<typeof loadToolRegistry>>;
beforeAll(async () => {
  registry = await loadToolRegistry();
  base = initialEffective(
    await loadBenchBundle({ benchId: "research", registry }),
  );
});
it("T-HAR-2 tightening is planned directly; loosening preserves base and requires user approval", () => {
  const tight = planBenchPatch(
    base,
    { roles: { "research-read": { tools: { literature: "ask" } } } },
    registry,
    300,
  );
  expect(tight.requiresApproval).toBe(false);
  expect(tight.candidate.manifest.roles["research-read"].tools.literature).toBe(
    "ask",
  );
  expect(base.manifest.roles["research-read"].tools.literature).toBe("allow");
  const loose = planBenchPatch(
    tight.candidate,
    { roles: { "research-read": { tools: { literature: "allow" } } } },
    registry,
    300,
  );
  expect(loose.requiresApproval).toBe(true);
  expect(loose.changes).toContainEqual(
    expect.objectContaining({
      path: "roles.research-read.tools.literature",
      direction: "loosen",
    }),
  );
});
it("new registered tools require approval, subset writes tighten and expansion requires approval", () => {
  expect(
    planBenchPatch(
      base,
      { roles: { "research-read": { tools: { read: "ask" } } } },
      registry,
      300,
    ).requiresApproval,
  ).toBe(true);
  expect(
    planBenchPatch(
      base,
      { roles: { "research-read": { write_targets: ["read/layers/"] } } },
      registry,
      300,
    ).requiresApproval,
  ).toBe(false);
  expect(
    planBenchPatch(
      base,
      { roles: { "research-read": { write_targets: ["new-notes/"] } } },
      registry,
      300,
    ).requiresApproval,
  ).toBe(true);
});
it("approval cannot cross floors or mutate gates/prompts; model/budget changes stay within declared policy", () => {
  for (const patch of [
    { roles: { "research-read": { tools: { "*": "allow" } } } },
    { roles: { "research-read": { tools: { task: "allow" } } } },
    { roles: { "research-read": { write_targets: ["../other/"] } } },
    { roles: { "research-read": { dossier_note: "{env:PRIVATE}" } } },
    { gates: {} },
    { roles: { "research-read": { prompt: "override" } } },
    { budget: { default_cny: 301 } },
    { roles: { "research-read": { tools: { unknown_capability: "allow" } } } },
  ])
    expect(() => planBenchPatch(base, patch, registry, 300)).toThrow();
  const changed = planBenchPatch(
    base,
    {
      model_slots: { strong: "mid" },
      budget: { default_cny: 4 },
      roles: { "research-read": { dossier_note: "请保持简洁" } },
    },
    registry,
    300,
  );
  expect(changed.requiresApproval).toBe(false);
  expect(changed.candidate.digest).not.toBe(base.digest);
});
