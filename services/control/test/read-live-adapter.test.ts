import { it, expect, vi } from "vitest";
import { createLiveReadAdapter } from "../../../src/data/read-live";
const dossier = "11111111-1111-4111-8111-111111111111",
  run = "22222222-2222-4222-8222-222222222222",
  asset = "33333333-3333-4333-8333-333333333333";
const state = () => ({
  dossier: { id: dossier, title: "真实档案" },
  cursor: 3,
  run: {
    id: run,
    state: "completed",
    budgetCny: 5,
    spentCny: null,
    usageUnknown: true,
    query: "真实查询",
  },
  papers: [
    {
      id: asset,
      runId: run,
      paperId: "W1",
      title: "实际论文",
      authors: ["实际作者"],
      venue: "实际来源",
      access: "full",
      license: "CC-BY",
    },
  ],
  pages: [
    { assetId: asset, page: 1, textSha256: "a".repeat(64), quote: "真实原文" },
  ],
  approvals: [],
});
const anchor = { paperId: asset, page: 1, quote: "真实原文" };
it("read live restores only real paper/page/card data, keeps unknown cost null and never returns quiz keys or pretend animations", async () => {
  const data = state(),
    events = [
      {
        seq: 1,
        runId: run,
        kind: "card",
        action: "card_created",
        payload: {
          cardId: "layer",
          cardType: "layer",
          card: {
            paperId: asset,
            no: "1",
            title: "真实层",
            en: "REAL",
            body: [{ text: "真实解释", refs: [anchor] }],
            anim: "fake-animation",
          },
        },
      },
      {
        seq: 2,
        runId: run,
        kind: "card",
        action: "card_created",
        payload: {
          cardId: "quiz",
          cardType: "quiz",
          card: {
            paperId: asset,
            layer: "1",
            q: "真实题目",
            hint: "原文",
            keys: [["never-export"]],
          },
        },
      },
      {
        seq: 3,
        runId: run,
        kind: "card",
        action: "card_created",
        payload: {
          cardId: "finding",
          cardType: "finding",
          card: {
            n: 37,
            text: "真实发现",
            evidence: [anchor],
            confidence: "low",
            status: "hypothesis",
            at: "2026-10-25T00:00:00Z",
          },
        },
      },
    ];
  const api = vi.fn(async (p: string) =>
    p.includes("/read-state")
      ? data
      : { items: events, cursor: 3, through: 3, done: true },
  );
  const a = createLiveReadAdapter(dossier, {
    api,
    generation: () => 1,
    decide: vi.fn(),
    stream: vi.fn(),
  } as any);
  const snap = await a.load();
  expect(snap.paper?.title).toBe("实际论文");
  expect(snap.layers[0].body[0].refs).toEqual(["p1"]);
  expect(snap.quizzes[0].layer).toBe("layer");
  expect(JSON.stringify(snap)).not.toContain("never-export");
  expect(snap.findings[0].n).toBe(37);
  expect(snap.run.spentCny).toBeNull();
  expect(snap.run.unknownCost).toBe(true);
  expect(snap.anims).toEqual([]);
  expect(snap.hasRepro).toBe(false);
  const got: any[] = [];
  const off = a.subscribe((e) => got.push(e));
  await a.ask("原样追问");
  expect(got.slice(-2).map((e) => e.type)).toEqual(["user", "agent"]);
  expect(got.at(-1).text).toMatch(/未接入/);
  await expect(a.grade("quiz", "答案")).rejects.toThrow(/未接入/);
  off();
});
it("estimate does not start a run; a lost confirmed response is resolved read-only, never submitted a second time", async () => {
  let accepted = false;
  const posts: any[] = [];
  const api = vi.fn(async (p: string, b?: any, key?: string) => {
    if (p.includes("/read-state"))
      return {
        ...state(),
        cursor: 0,
        papers: [],
        pages: [],
        run: accepted
          ? { ...state().run, id: run, estimateId: "estimate", state: "queued" }
          : null,
      };
    if (p.includes("/read-events")) return { items: [], cursor: 0, done: true };
    if (p.includes("/harness"))
      return {
        version: "1.1.0",
        entrypoints: { read: "research-read" },
        roles: { "research-read": { steps: 48 } },
      };
    if (p === "/v1/runs/estimate")
      return {
        id: "estimate",
        model: "deepseek/deepseek-v4-flash",
        estimatedCny: "0.050000",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    if (p === "/v1/runs") {
      posts.push({ b, key });
      accepted = true;
      throw Error("reply lost");
    }
    throw Error("unexpected " + p);
  });
  const a = createLiveReadAdapter(dossier, {
    api,
    generation: () => 1,
    decide: vi.fn(),
    stream: vi.fn(),
  } as any);
  await a.load();
  const quote = await a.estimate("用户论文查询", 5);
  expect(posts).toHaveLength(0);
  await a.start(quote.id, 5);
  await a.start(quote.id, 5);
  expect(posts).toHaveLength(1);
  expect(posts[0].b).toMatchObject({
    confirmed: true,
    dossierId: dossier,
    budget: { cny: 5 },
    input: { query: "用户论文查询" },
  });
  expect(posts[0].b.input.question).toContain("用户论文查询");
  expect((await a.load()).run.id).toBe(run);
});
