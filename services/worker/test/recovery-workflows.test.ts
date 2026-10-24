import { it, expect } from "vitest";
import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { randomUUID } from "node:crypto";
import { recoveryWorkflows } from "../src/workflows";
function fixture() {
  const definitions = new Map<string, any>(),
    calls: { name: string; input: any }[] = [];
  let fail = "";
  const hatchet = {
    task: (definition: any) => {
      definitions.set(definition.name, definition);
      return {
        runNoWait: async (input: any) => {
          if (fail === definition.name) throw Error("queue unavailable");
          calls.push({ name: definition.name, input });
        },
      };
    },
  };
  const ids = [randomUUID(), randomUUID()].sort(),
    pages: any[] = [];
  let observed = 0;
  const discovery = {
    ceiling: async () => ids.at(-1),
    page: async (after: any, size: any, through: any) => {
      pages.push({ after, size, through });
      return ids;
    },
  };
  const recovery = {
    recoverable: async () => [randomUUID()],
    reconcileRun: async () => {
      observed++;
    },
  };
  recoveryWorkflows(hatchet as any, discovery as any, recovery);
  return {
    definitions,
    calls,
    ids,
    pages,
    observed: () => observed,
    fail: (name: string) => {
      fail = name;
    },
  };
}
it("real task definitions constrain account concurrency and register autonomous cron", async () => {
  const f = fixture();
  expect(f.definitions.get("account.discover").onCrons).toEqual(["* * * * *"]);
  for (const name of ["account.reconcile", "run.observe"])
    expect(f.definitions.get(name).concurrency).toMatchObject({
      expression: "input.accountId",
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    });
  expect(f.definitions.get("run.observe").idempotency.expression).toBe(
    "input.accountId + ':' + input.runId"
  );
  await f.definitions.get("account.reconcile").fn({ accountId: f.ids[0] });
  expect(f.calls[0].name).toBe("run.observe");
  expect(f.observed()).toBe(0);
  await f.definitions.get("run.observe").fn(f.calls[0].input);
  expect(f.observed()).toBe(1);
  await expect(
    f.definitions
      .get("run.observe")
      .fn({ ...f.calls[0].input, prompt: "forbidden" })
  ).rejects.toThrow();
});
it("discovery awaits confirmed dispatch and restarts each sweep at the beginning", async () => {
  const f = fixture(),
    run = f.definitions.get("account.discover").fn;
  f.fail("account.reconcile");
  await expect(run({})).rejects.toThrow("queue unavailable");
  expect(f.calls).toEqual([]);
  f.fail("");
  await run({});
  await run({});
  expect(
    f.pages.every(
      (x) =>
        x.after === undefined && x.size === 100 && x.through === f.ids.at(-1)
    )
  ).toBe(true);
  expect(f.calls.map((x) => x.input.accountId)).toEqual([...f.ids, ...f.ids]);
});
