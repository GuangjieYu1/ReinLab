import { beforeAll, expect, it } from "vitest";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { initialEffective, planBenchPatch } from "../src/harness/resolver";
import { fixtureBenchWithTunables } from "./fixtures/bench-tunable";
let base: ReturnType<typeof initialEffective>,
  registry: Awaited<ReturnType<typeof loadToolRegistry>>;
beforeAll(async () => {
  registry = await loadToolRegistry();
  base = initialEffective(
    await loadBenchBundle({ benchId: "research", registry }),
  );
});
it.each([
  { roles: { "research-read": { write_targets: [] } } },
  { roles: { "research-read": { write_targets: ["read/layers/"] } } },
  { roles: { "research-read": { memory: { read: [] } } } },
  { roles: { "research-read": { memory: {} } } },
  { roles: { "research-read": { dossier_note: "" } } },
  {
    budget: { default_cny: 4 },
    roles: {
      "research-read": {
        tools: { literature: "deny" },
        dossier_note: "unlisted",
      },
    },
  },
])(
  "research rejects unlisted fields before planning or mutation: %j",
  (patch) => {
    const digest = base.digest;
    expect(() => planBenchPatch(base, patch, registry, 300)).toThrow(
      expect.objectContaining({ code: "FIELD_NOT_TUNABLE", status: 400 }),
    );
    expect(base.digest).toBe(digest);
  },
);
it("declared model, nested budget and tool controls remain usable", () => {
  const result = planBenchPatch(
    base,
    {
      model_slots: { strong: "mid" },
      budget: { by_mode: { read: 4 } },
      roles: { "research-read": { tools: { literature: "deny" } } },
    },
    registry,
    300,
  );
  expect(result.requiresApproval).toBe(false);
  expect(result.candidate.manifest.budget.by_mode.read).toBe(4);
  expect(
    result.candidate.manifest.roles["research-read"].tools.literature,
  ).toBe("deny");
});
it("an empty tunable list rejects preferences, exact field grants do not cover siblings", () => {
  // These snapshots are sealed through the same constructor as a loaded bundle.
  const make = (tunable: string[]) => fixtureBenchWithTunables(base, tunable);
  expect(() =>
    planBenchPatch(make([]), { model_slots: { strong: "mid" } }, registry, 300),
  ).toThrow(expect.objectContaining({ status: 400 }));
  expect(() =>
    planBenchPatch(
      make(["budget.default_cny"]),
      { budget: { by_mode: { read: 4 } } },
      registry,
      300,
    ),
  ).toThrow(expect.objectContaining({ status: 400 }));
  expect(
    planBenchPatch(
      make(["budget.default_cny"]),
      { budget: { default_cny: 4 } },
      registry,
      300,
    ).candidate.manifest.budget.default_cny,
  ).toBe(4);
});
