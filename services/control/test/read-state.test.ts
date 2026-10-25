import { it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { mcpFixture } from "./mcp-fixture";
import { createApp } from "../src/api/app";
import { appendEvent } from "../src/ledger";

it("read snapshot is tenant-scoped, distinguishes unobserved/unknown cost, and bounds immutable history without quiz keys", async () => {
  const f = await mcpFixture(undefined, false, "1.1.0");
  try {
    const secret = randomBytes(48),
      issuer = "https://read.fixture/auth/v1",
      app = await createApp({ pool: f.pool, auth: { issuer, secret } });
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject(f.account)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
    const get = (suffix: string, dossier = f.dossier) =>
      app.request("/v1/dossiers/" + dossier + suffix, {
        headers: { authorization: "Bearer " + token },
      });
    await f.db.withAccount(f.account, (c) =>
      c.query(
        "insert into approval(id,account_id,run_id,kind,title,effects,risk)values($1,$2,$3,'permission','原始能力标题',$4,'write')",
        [
          randomUUID(),
          f.account,
          f.run,
          JSON.stringify({
            capability: "files.write",
            effects: ["写入本档案文件"],
            summary: { files: [{ path: "findings/review.md", bytes: 123 }] },
            args: { raw: '{\"keys\":[[\"PRIVATE_APPROVAL_ARGS\"]]}' },
          }),
        ],
      ),
    );
    const first = await get("/read-state");
    expect(first.status).toBe(200);
    const snap = await first.json();
    expect(snap.approvals[0]).toMatchObject({
      title: "写入档案文件",
      effects: [
        "写入本档案文件",
        "文件：findings/review.md（123 字节）",
        "只处理这一次请求；参数变化后需要重新批准。",
      ],
    });
    expect(JSON.stringify(snap)).not.toContain("PRIVATE_APPROVAL_ARGS");
    expect(snap.run.spentCny).toBeNull();
    expect(snap.run.usageUnknown).toBe(false);
    expect(snap.cursor).toBe(0);
    await f.admin.query("update budget_hold set state='unpriced' where id=$1", [
      f.hold,
    ]);
    expect((await (await get("/read-state")).json()).run.usageUnknown).toBe(
      true,
    );
    const event = await f.db.withAccount(f.account, (c) =>
      appendEvent(c, f.account, {
        dossierId: f.dossier,
        runId: f.run,
        kind: "card",
        action: "card_created",
        payload: {
          cardId: randomUUID(),
          cardType: "quiz",
          card: { q: "实际题目", keys: [["hidden-answer"]] },
        },
        dedupeKey: randomUUID(),
      }),
    );
    const state = await (await get("/read-state")).json();
    await f.db.withAccount(f.account, (c) =>
      appendEvent(c, f.account, {
        dossierId: f.dossier,
        runId: f.run,
        kind: "message",
        payload: { text: "在水位之后" },
        dedupeKey: randomUUID(),
      }),
    );
    const history = await (
      await get("/read-events?after=0&through=" + state.cursor)
    ).json();
    expect(history.items).toHaveLength(1);
    expect(history.items[0].seq).toBe(event.seq);
    expect(JSON.stringify(history)).not.toContain("hidden-answer");
    expect(history.items[0].payload.card.keys).toBeUndefined();
    expect(history.done).toBe(true);
    expect((await get("/read-state", randomUUID())).status).toBe(404);
    expect((await get("/read-events?after=10&through=1")).status).toBe(400);
  } finally {
    await f.close();
  }
});
