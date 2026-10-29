import { expect, it } from "vitest";
import { cleanupSmoke, type SmokeCleanupName } from "./local/smoke-cleanup";
it("a failed cleanup never skips later resources and never leaks the error", async () => {
  const called: string[] = [];
  const names: SmokeCleanupName[] = [
    "evidence",
    "temporary_config",
    "observer",
    "http",
    "guard",
    "database",
  ];
  const failures = await cleanupSmoke(
    names.map((name) => ({
      name,
      close: async () => {
        called.push(name);
        if (name !== "database") throw Error("secret fixture detail");
      },
    })),
  );
  expect(called).toEqual(names);
  expect(failures).toEqual(names.slice(0, -1));
  expect(JSON.stringify(failures)).not.toContain("secret");
});
it("awaits each resource before closing the next", async () => {
  const order: string[] = [];
  await cleanupSmoke([
    {
      name: "guard",
      close: async () => {
        order.push("begin");
        await Promise.resolve();
        order.push("end");
      },
    },
    {
      name: "database",
      close: async () => {
        order.push("database");
      },
    },
  ]);
  expect(order).toEqual(["begin", "end", "database"]);
});
it("successful and empty cleanup have no failures", async () => {
  expect(await cleanupSmoke([])).toEqual([]);
  expect(
    await cleanupSmoke([{ name: "guard", close: async () => {} }]),
  ).toEqual([]);
});
