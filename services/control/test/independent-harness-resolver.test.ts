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
it("independent candidate budget retains no baseline value above current account cap", () => {
  expect(() =>
    planBenchPatch(base, { budget: { default_cny: 4 } }, registry, 10),
  ).toThrow();
});
it("independent nonbudget preference cannot preserve an over-cap effective mode budget", () => {
  expect(() =>
    planBenchPatch(base, { model_slots: { strong: "mid" } }, registry, 10),
  ).toThrow();
});
it("independent mixed tightening and expansion still requires approval without mutating base", () => {
  const before = base.digest;
  const p = planBenchPatch(
    base,
    {
      roles: {
        "research-read": {
          tools: { literature: "deny", read: "ask" },
          write_targets: ["read/layers/"],
        },
      },
    },
    registry,
    300,
  );
  expect(p.requiresApproval).toBe(true);
  expect(base.digest).toBe(before);
  expect(base.manifest.roles["research-read"].tools.literature).toBe("allow");
});
it("independent boolean approval is rejected and dangerous tasks cannot become ask", () => {
  expect(() =>
    planBenchPatch(
      base,
      {
        approved: true,
        roles: { "research-read": { tools: { read: "allow" } } },
      },
      registry,
      300,
    ),
  ).toThrow();
  expect(() =>
    planBenchPatch(
      base,
      { roles: { "research-read": { tools: { task: "ask" } } } },
      registry,
      300,
    ),
  ).toThrow();
});
