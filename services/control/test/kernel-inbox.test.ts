import { it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { kernelFixture } from "./kernel-fixture";
import { createApp } from "../src/api/app";
import { requestApproval } from "../src/run/approval";

it("收件箱只显示一张下载审批，决定后内核卡片变为 approved 且不产生第二张", async () => {
  const f = await kernelFixture();
  try {
    const secret = randomBytes(48),
      issuer = "https://kernel-inbox.fixture/auth/v1";
    const app = await createApp({ pool: f.pool, auth: { issuer, secret } });
    const cookie = await f.sessionCookie();
    const request = (path: string, body?: unknown, key = randomUUID()) =>
      app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: new URL(path, "http://localhost").origin,
          "X-ReinLab-CSRF": "1",
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const argsHash = "d".repeat(64);
    const card = await f.db.withAccount(f.account, (client) =>
      requestApproval(client, {
        account: f.account,
        dossier: f.dossier,
        run: f.run,
        capability: "papers.fetch",
        argsHash,
        title: "下载论文全文",
        effects: [{ capability: "papers.fetch", argsHash }],
        risk: "write",
      }),
    );

    const listed = await request("/v1/approvals?state=pending");
    expect(listed.status).toBe(200);
    const items = (await listed.json()).items as Array<{ id: string; title: string }>;
    expect(items.filter((item) => item.id === card.id)).toHaveLength(1);
    expect(items.find((item) => item.id === card.id)?.title).toContain("下载论文全文");

    const decided = await request(`/v1/approvals/${card.id}/decide`, { decision: "approve" });
    expect(decided.status).toBe(200);
    const after = await request("/v1/approvals?state=pending");
    expect(((await after.json()).items as Array<{ id: string }>).some((item) => item.id === card.id)).toBe(false);
    const rows = await f.admin.query("select state,decided_scope from approval where id=$1", [card.id]);
    expect(rows.rows[0]).toMatchObject({ state: "approved", decided_scope: "once" });
    const cards = await f.admin.query("select count(*)::int n from approval where account_id=$1 and run_id=$2 and effect_key is not null", [f.account, f.run]);
    expect(cards.rows[0].n).toBe(1);
  } finally {
    await f.close();
  }
});
