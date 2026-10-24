import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mcpFixture } from "./mcp-fixture";

it("UUID-only discovery refuses CREATE on any application schema, not just public", async () => {
  const f = await mcpFixture(), c = await f.admin.connect(), schema = "review_discovery_" + randomUUID().replaceAll("-", "");
  try {
    await c.query("begin");
    await c.query(`create schema ${schema}; grant create on schema ${schema} to reinlab_reconcile_discovery`);
    await c.query("set local role reinlab_reconcile_discovery");
    await expect(c.query("select public.reinlab_assert_discovery()")).rejects.toMatchObject({ code: "42501" });
  } finally { await c.query("rollback"); c.release(); await f.close(); }
});

it("discovery rejects extra column/business/sequence rights, memberships and PUBLIC callable definers", async () => {
  const f = await mcpFixture(), c = await f.admin.connect(), fn = "review_discovery_" + randomUUID().replaceAll("-", "");
  try {
    await c.query("begin");
    for (const setup of [
      "grant select(display_name) on public.account to reinlab_reconcile_discovery",
      "grant select on public.run to reinlab_reconcile_discovery",
      "grant select on sequence public.event_seq_seq to reinlab_reconcile_discovery",
      "grant reinlab_app to reinlab_reconcile_discovery",
      "grant reinlab_reconcile_discovery to reinlab_app",
      `create function public.${fn}() returns integer language sql security definer as 'select 1'`,
    ]) {
      await c.query("savepoint discovery_review"); await c.query(setup); await c.query("set local role reinlab_reconcile_discovery");
      await expect(c.query("select public.reinlab_assert_discovery()")).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback to savepoint discovery_review");
    }
  } finally { await c.query("rollback"); c.release(); await f.close(); }
});
