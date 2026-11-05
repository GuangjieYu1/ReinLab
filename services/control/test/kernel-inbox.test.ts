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

it("没有候选的提问卡：用户直接打字回答，回答送回原任务（不用重新开一轮）", async () => {
  const f = await kernelFixture();
  try {
    const resumed: Array<{ runId: string; prompt: string }> = [];
    const app = await createApp({
      pool: f.pool,
      auth: { issuer: "https://kernel-answer.fixture/auth/v1", secret: randomBytes(48) },
      kernel: {
        isLive: () => true,
        resumeAfterAnswer: async (_account: string, runId: string, prompt: string) => {
          resumed.push({ runId, prompt });
        },
      } as never,
    });
    const cookie = await f.sessionCookie();
    const request = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: new URL(path, "http://localhost").origin,
          "X-ReinLab-CSRF": "1",
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify(body),
      });

    // 助手的提问卡：只有问题、没有候选（模型把选项写进了正文）
    const card = await f.db.withAccount(f.account, (client) =>
      requestApproval(client, {
        account: f.account,
        dossier: f.dossier,
        run: f.run,
        capability: "cards.clarify.question",
        argsHash: "e".repeat(64),
        title: "这篇要不要现在下载全文？你想从哪个角度切入？",
        effects: [{ kind: "text", candidates: [] }],
        risk: "read",
        kind: "question",
      }),
    );
    // 提问后这一段执行在等用户：状态是 waiting，答完才续接
    await f.admin.query("update run set state='waiting' where id=$1", [f.run]);
    const answered = await request(`/v1/kernel/approvals/${card.id}/answer`, {
      text: "④ 从头到尾完整过一遍",
    });
    expect(answered.status, JSON.stringify(await answered.clone().json())).toBe(200);
    const body = (await answered.json()) as { state: string };
    expect(body.state).toBe("approved");
    const stored = await f.admin.query("select state,effects->'answer' as answer from approval where id=$1", [card.id]);
    expect(stored.rows[0].state).toBe("approved");
    expect(stored.rows[0].answer).toMatchObject({ text: "④ 从头到尾完整过一遍" });
    // 回答作为这一轮的输入送回原任务，而不是重开一轮
    expect(resumed).toHaveLength(1);
    expect(resumed[0].runId).toBe(f.run);
    expect(resumed[0].prompt).toContain("从头到尾完整过一遍");
    // 多选 + 自由输入：多选 id 与文字一起回来
    await f.admin.query("update run set state='waiting' where id=$1", [f.run]);
    const card2 = await f.db.withAccount(f.account, (client) =>
      requestApproval(client, {
        account: f.account,
        dossier: f.dossier,
        run: f.run,
        capability: "cards.clarify.question",
        argsHash: "f".repeat(64),
        title: "这几篇先读哪几篇？",
        effects: [{ kind: "paper_pick", candidates: [{ id: "W1", title: "A" }, { id: "W2", title: "B" }], multi: true }],
        risk: "read",
        kind: "question",
      }),
    );
    // 收件箱列表要带上候选项和多选标记，否则前端只看得到标题、无处作答
    const listed = await app.request("/v1/approvals?state=pending", { headers: { Cookie: cookie } });
    const listedBody = (await listed.json()) as { items: Array<{ id: string; question?: { multi: boolean; candidates: Array<{ id: string; title: string }> } }> };
    const row = listedBody.items.find((item) => item.id === card2.id);
    expect(row?.question?.multi).toBe(true);
    expect(row?.question?.candidates.map((c) => c.id)).toEqual(["W1", "W2"]);
    const multi = await request(`/v1/kernel/approvals/${card2.id}/answer`, {
      candidateIds: ["W1", "W2"],
      text: "先看这两篇，第三篇再说",
    });
    expect(multi.status).toBe(200);
    const multiBody = (await multi.json()) as { answer: { candidateIds: string[]; text: string } };
    expect(multiBody.answer.candidateIds).toEqual(["W1", "W2"]);
    expect(multiBody.answer.text).toBe("先看这两篇，第三篇再说");
    expect(resumed).toHaveLength(2);
    expect(resumed[1].prompt).toContain("W1、W2");
    expect(resumed[1].prompt).toContain("第三篇再说");
    // 一回合问了两个问题：答完第一个先不续接，两个都答完才一起交回去
    await f.admin.query("update run set state='waiting' where id=$1", [f.run]);
    const ask = (hash: string, title: string) =>
      f.db.withAccount(f.account, (client) =>
        requestApproval(client, {
          account: f.account, dossier: f.dossier, run: f.run, capability: "cards.clarify.question",
          argsHash: hash.repeat(64), title, effects: [{ kind: "text", candidates: [] }], risk: "read", kind: "question",
        }),
      );
    const q1 = await ask("1", "范围按哪片算？");
    const q2 = await ask("2", "答案拿来干什么？");
    const first = await request(`/v1/kernel/approvals/${q1.id}/answer`, { text: "东山一带" });
    expect(((await first.json()) as { waitingFor?: number }).waitingFor).toBe(1);
    expect(resumed).toHaveLength(2);
    await request(`/v1/kernel/approvals/${q2.id}/answer`, { text: "排拍摄日程" });
    expect(resumed).toHaveLength(3);
    expect(resumed[2].prompt).toContain("这 2 个提问");
    expect(resumed[2].prompt).toContain("东山一带");
    expect(resumed[2].prompt).toContain("排拍摄日程");
    expect(resumed[2].prompt).not.toContain("第三篇再说");
  } finally {
    await f.close();
  }
});
