import { describe, expect, it } from "vitest";
import type { CanvasObject, Op, Stop } from "@reinlab/contracts";
import {
  applyBatch,
  describeBatch,
  describeChanges,
  emptyDocument,
  needsAcceptance,
  type PlanDocument,
  type StoredPlan,
  type UndoCandidate,
} from "../src/explore/plan";

const at = (iso: string) => new Date(iso);
const ids = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

function planOfDocument(document: Partial<PlanDocument> = {}, state: StoredPlan["state"] = "draft"): StoredPlan {
  return {
    revision: 3,
    state,
    document: { ...emptyDocument(), ...document },
    updatedAt: "2026-10-31T00:00:00.000Z",
  };
}

const stop = (overrides: Partial<Stop> = {}): Stop => ({
  id: ids(),
  kind: "spot",
  state: "candidate",
  name: "白川旁的石桥",
  geometry: { type: "Point", coordinates: [135.78, 35.01] },
  day: "2026-11-15",
  window: { start: "2026-11-15T07:10:00+09:00", end: "2026-11-15T07:50:00+09:00" },
  refs: [],
  source: "agent",
  ...overrides,
});

const addStop = (overrides: Partial<Stop> = {}): Op => {
  const { id: _id, source: _source, state, ...rest } = stop(overrides);
  return { op: "stop.add", stop: { ...rest, ...(state ? { state } : {}) } } as Op;
};

const canvas = (overrides: Partial<CanvasObject> = {}): CanvasObject => ({
  id: ids(),
  kind: "area",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [135.78, 35.01],
        [135.79, 35.01],
        [135.79, 35.02],
        [135.78, 35.01],
      ],
    ],
  },
  text: "白川附近街区",
  author: "agent",
  createdAt: "2026-10-31T00:00:00.000Z",
  ...overrides,
});

const run = (plan: StoredPlan, ops: Op[], extra: Partial<Parameters<typeof applyBatch>[0]> = {}) =>
  applyBatch({ plan, ops, actor: "page", now: () => at("2026-11-01T10:00:00.000Z"), newId: ids, ...extra });

describe("探索台计划引擎", () => {
  it("一批多个动作只把修订号加一次，并逐条给出权威结果", () => {
    const plan = planOfDocument();
    const batch = run(plan, [addStop(), addStop({ kind: "waypoint", name: "鸭川河岸" })]);
    expect(batch.plan.revision).toBe(plan.revision + 1);
    expect(batch.applied).toHaveLength(2);
    expect(batch.applied.every((entry) => entry.actor === "user")).toBe(true);
    expect(batch.applied[0].summary).toBe("添加候选机位「白川旁的石桥」");
    expect((batch.applied[0].result.stop as Stop).state).toBe("candidate");
    expect(batch.plan.document.stops).toHaveLength(2);
  });

  it("一批里有一条不成立就整批不生效，原计划不动", () => {
    const plan = planOfDocument({ stops: [stop()] });
    expect(() =>
      run(plan, [addStop({ name: "银阁寺" }), { op: "stop.remove", id: "不存在的" }]),
    ).toThrowError(/计划里没有这个停留点/);
    expect(plan.document.stops).toHaveLength(1);
  });

  it("新建停留点的 id、来源和见光由服务端决定，客户端塞的值不算", () => {
    const plan = planOfDocument();
    const batch = run(plan, [
      {
        op: "stop.add",
        stop: {
          ...(addStop() as any).stop,
          id: "客户端乱写的",
          source: "user",
          light: { horizon: [], lit: [], basis: null },
        },
      },
    ]);
    const created = batch.applied[0].result.stop as Stop;
    expect(created.id).not.toBe("客户端乱写的");
    expect(created.source).toBe("user"); // actor=page 时来源就是用户
    expect(created.light).toBeUndefined();
  });

  it("跨午夜的停留点按开拍当天记日期，结束要晚于开始", () => {
    const plan = planOfDocument();
    const batch = run(plan, [
      addStop({
        name: "祇园夜拍",
        day: "2026-11-15",
        window: { start: "2026-11-15T22:30:00+09:00", end: "2026-11-16T00:20:00+09:00" },
      }),
    ]);
    const created = batch.applied[0].result.stop as Stop;
    expect(created.day).toBe("2026-11-15");
    expect(created.window?.end).toBe("2026-11-16T00:20:00+09:00");
    expect(() =>
      run(plan, [
        addStop({ window: { start: "2026-11-15T07:10:00+09:00", end: "2026-11-15T06:50:00+09:00" } }),
      ]),
    ).toThrowError(/结束要晚于开始/);
  });

  it("街区必须用区域表示，机位必须用点位表示", () => {
    const plan = planOfDocument();
    expect(() => run(plan, [addStop({ kind: "area" })])).toThrowError(/街区要用区域/);
    expect(() =>
      run(plan, [
        addStop({
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [1, 1],
                [2, 1],
                [2, 2],
                [1, 1],
              ],
            ],
          },
        }),
      ]),
    ).toThrowError(/机位和顺路点要用点位/);
  });

  it("整份确认：所有候选转正、状态进入待执行；没有停留点就不许确认", () => {
    const plan = planOfDocument({ stops: [stop(), stop({ name: "哲学之道" })] });
    const batch = run(plan, [{ op: "plan.confirm" }]);
    expect(batch.plan.state).toBe("ready");
    expect(batch.plan.document.stops.every((row) => row.state === "confirmed")).toBe(true);
    expect(batch.applied[0].summary).toContain("确认整份计划");
    expect(() => run(planOfDocument(), [{ op: "plan.confirm" }])).toThrowError(/还没有停留点/);
  });

  it("只有 view.save 时不加修订、不记动作", () => {
    const plan = planOfDocument();
    const batch = run(plan, [
      {
        op: "view.save",
        viewport: { center: [135.78, 35.01], zoom: 15, bearing: 0, pitch: 0 },
        basemap: "satellite",
      },
    ]);
    expect(batch.revision).toBeUndefined();
    expect(batch.plan.revision).toBe(plan.revision);
    expect(batch.applied).toHaveLength(0);
    expect(batch.business).toBe(false);
    expect(batch.plan.document.lastViewport?.zoom).toBe(15);
    expect(batch.plan.document.basemap).toBe("satellite");
  });

  it("哪些 Agent 动作要用户同意：候选随便改，已确认的地点时段要问", () => {
    const candidate = stop();
    const confirmed = stop({ state: "confirmed", name: "南禅寺水路阁" });
    const plan = planOfDocument({ stops: [candidate, confirmed] });
    expect(needsAcceptance(plan, { op: "stop.update", id: candidate.id, patch: { window: null } })).toBe(false);
    expect(needsAcceptance(plan, { op: "stop.update", id: confirmed.id, patch: { window: null } })).toBe(true);
    // 补构图、引导词、参考图属于已批准范围内的编辑，不用逐条问。
    expect(needsAcceptance(plan, { op: "stop.update", id: confirmed.id, patch: { detail: { composition: "低机位" } } })).toBe(false);
    expect(needsAcceptance(plan, { op: "stop.confirm", ids: [candidate.id] })).toBe(true);
    expect(needsAcceptance(plan, { op: "stop.remove", id: confirmed.id })).toBe(true);
    expect(needsAcceptance(plan, { op: "stop.add", stop: { ...candidate, state: "confirmed" } as any })).toBe(true);
    expect(needsAcceptance(plan, { op: "canvas.undo" })).toBe(false);
    expect(needsAcceptance(planOfDocument({}, "ready"), { op: "plan.set", patch: { days: ["2026-11-16"] } })).toBe(true);
    expect(needsAcceptance(plan, { op: "plan.confirm" })).toBe(true);
  });

  it("用户撤回最近一笔画布改动，包括助手画的", () => {
    const drawn = canvas();
    const plan = planOfDocument({ canvas: [drawn] });
    const candidates: UndoCandidate[] = [
      {
        seq: "9",
        actor: "agent",
        inverse: { op: "canvas.remove", id: drawn.id },
        summary: "圈出「白川附近街区」",
      },
    ];
    const batch = run(plan, [{ op: "canvas.undo" }], { undoCandidates: candidates });
    expect(batch.plan.document.canvas).toHaveLength(0);
    expect(batch.applied[0].summary).toBe("撤回：圈出「白川附近街区」");
    expect(batch.undone).toEqual(["9"]);
    // 撤回只动画布，不动停留在计划里的正式停留点。
    expect(batch.plan.document.stops).toHaveLength(0);
  });

  it("助手只能撤回自己的画布改动", () => {
    const mine = { seq: "11", actor: "page" as const, inverse: { op: "canvas.remove", id: "x" } as Op, summary: "你画的" };
    const theirs = {
      seq: "10",
      actor: "agent" as const,
      inverse: { op: "canvas.remove", id: "y" } as Op,
      summary: "助手画的",
    };
    const plan = planOfDocument({ canvas: [canvas({ id: "y" })] });
    const batch = applyBatch({
      plan,
      ops: [{ op: "canvas.undo" }],
      actor: "agent",
      undoCandidates: [mine, theirs],
    });
    expect(batch.undone).toEqual(["10"]);
  });

  it("撤回删除会把原对象按原 id 放回", () => {
    const removed = canvas({ id: "keep-me", text: "箭头" });
    const plan = planOfDocument({ canvas: [] });
    const candidates: UndoCandidate[] = [
      {
        seq: "4",
        actor: "page",
        inverse: { op: "canvas.add", object: removed },
        summary: "删除：圈出「白川附近街区」",
      },
    ];
    const batch = run(plan, [{ op: "canvas.undo" }], { undoCandidates: candidates });
    expect(batch.plan.document.canvas).toHaveLength(1);
    expect(batch.plan.document.canvas[0].id).toBe("keep-me");
  });

  it("没有可撤回的东西时明确报错", () => {
    expect(() => run(planOfDocument(), [{ op: "canvas.undo" }])).toThrowError(/没有可撤回/);
  });

  it("修改画布时记下反向操作，删除画布时记下原对象", () => {
    const object = canvas({ text: "原来的字" });
    const plan = planOfDocument({ canvas: [object] });
    const batch = run(plan, [{ op: "canvas.update", id: object.id, patch: { text: "新的字" } }]);
    expect(batch.inverses[0]).toMatchObject({ op: "canvas.update", id: object.id, patch: { text: "原来的字" } });
    const removed = run(plan, [{ op: "canvas.remove", id: object.id }]);
    expect((removed.inverses[0] as any).object.text).toBe("原来的字");
  });

  it("草图原本没有的字段，反向 patch 记成 null（落 jsonb 不会丢），撤回后字段消失", () => {
    const note = canvas({ id: "note-1", kind: "note", text: undefined });
    delete (note as { text?: string }).text;
    const plan = planOfDocument({ canvas: [note] });
    const edited = run(plan, [{ op: "canvas.update", id: note.id, patch: { text: "这里逆光" } }]);
    expect(edited.inverses[0]).toMatchObject({ op: "canvas.update", id: note.id, patch: { text: null } });
    const undone = run(edited.plan, [{ op: "canvas.undo" }], {
      undoCandidates: [
        { seq: "5", actor: "page", inverse: edited.inverses[0]!, summary: "修改草图" },
      ],
    });
    expect(undone.plan.document.canvas[0].text).toBeUndefined();
  });

  it("计划修改卡列出前后对照与一句话标题", () => {
    const candidate = stop();
    const plan = planOfDocument({ stops: [candidate] });
    const ops: Op[] = [{ op: "stop.confirm", ids: [candidate.id] }];
    expect(describeBatch(plan, ops)).toBe("把「白川旁的石桥」定下来");
    const changes = describeChanges(plan, ops);
    expect(changes[0]).toEqual({
      stopId: candidate.id,
      before: { state: "candidate", name: candidate.name, kind: "spot" },
      after: { state: "confirmed", name: candidate.name, kind: "spot" },
    });
  });

  it("账户资料还没接通时不假装选上了模特器材", () => {
    expect(() => run(planOfDocument(), [{ op: "plan.select", gear: ["x"] }])).toThrowError(/还没接通/);
  });
});
