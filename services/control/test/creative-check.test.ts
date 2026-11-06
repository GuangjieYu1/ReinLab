// 五类检查与修法：用一份手搭的账本走纯计算，不连数据库。
// 覆盖红/黄、信息不足、未覆盖、「本次查过未发现」，以及「接受修法以后再查就没了」。
import { describe, expect, it } from "vitest";
import type { CreativeOp, CreativeRouteLeg, WorldEvent } from "@reinlab/contracts";
import { runCheck } from "../src/creative/check";
import { applyOps, emptyDocument, legIdFor, type CreativeDocument } from "../src/creative/world";
import { gregorianToT } from "../src/creative/story-time";

let counter = 0;
const ids = () => `id-${++counter}`;

type Built = { document: CreativeDocument; id: Record<string, string> };

const place = (name: string, level: string, geo: [number, number] | null, connects: { to: string; passable: boolean }[] = []) =>
  ({
    op: "entity.add",
    entity: {
      kind: "place",
      name,
      aliases: [],
      place: {
        level,
        parentId: null,
        geo: geo ? { type: "Point", coordinates: geo } : null,
        geoCertainty: geo ? "exact" : "unlocated",
        connects,
      },
    },
  }) as CreativeOp;

const person = (name: string) => ({ op: "entity.add", entity: { kind: "person", name, aliases: [], person: {} } }) as CreativeOp;

const event = (
  title: string,
  entityId: string,
  placeId: string | null,
  start: string,
  end: string,
  extra: Partial<WorldEvent> = {},
) =>
  ({
    op: "event.add",
    event: {
      title,
      what: title,
      kind: "stay",
      participants: [{ entityId, as: "actor" }],
      placeId,
      travel: null,
      narrative: "fact",
      start: { input: start },
      end: { input: end },
      ...extra,
    },
  }) as CreativeOp;

/** 两段：先建实体拿稳定 id，再按 id 建事件（一次批次里没法引用刚建的 id）。 */
const build = (): Built => {
  counter = 0;
  const first = applyOps(
    emptyDocument("测试世界观"),
    [
      place("青州城", "city", [118.5, 36.7]),
      place("清河镇", "city", [119.2, 37.1]),
      place("悦来客栈", "building", [119.21, 37.11], [{ to: "不存在的屋子", passable: true }]),
      place("客房", "room", null),
      person("张三"),
      person("李四"),
    ],
    { actor: "user", ids },
  );
  const id: Record<string, string> = {};
  for (const entity of first.next.entities) id[entity.name] = entity.id;
  const second = applyOps(
    first.next,
    [
      event("出发", id["张三"], id["青州城"], "1684-04-21 08:00", "1684-04-21 09:00"),
      event("进城", id["张三"], id["清河镇"], "1684-04-21 10:00", "1684-04-21 12:00", {
        travel: { fromId: id["青州城"], toId: id["清河镇"], modeId: "walk" },
      }),
      event("客栈闲谈", id["张三"], id["悦来客栈"], "1684-04-21 12:30", "1684-04-21 13:00", {
        kind: "interaction",
        participants: [
          { entityId: id["张三"], as: "present" },
          { entityId: id["李四"], as: "mentioned" },
        ],
      }),
    ],
    { actor: "user", ids },
  );
  return { document: second.next, id };
};

const legsFor = (document: CreativeDocument, needMin: number): CreativeRouteLeg[] => {
  const zhang = document.entities.find((item) => item.name === "张三")!;
  const [from, to] = document.events;
  return [
    {
      id: legIdFor(zhang.id, from.id, to.id),
      entityId: zhang.id,
      fromEventId: from.id,
      toEventId: to.id,
      modeId: "walk",
      kind: "network",
      path: { type: "LineString", coordinates: [[118.5, 36.7], [119.2, 37.1]] },
      distanceKm: 90,
      durationMin: needMin,
      failure: null,
      inferred: null,
    },
  ];
};

const now = () => new Date().toISOString();

describe("五类检查与修法", () => {
  it("路程不够：报红色硬冲突，带需要/只有多久和服务端生成的修法", () => {
    const { document } = build();
    // 只有 60 分钟，需要 600 分钟。
    const check = runCheck({ document, legs: legsFor(document, 600), revision: 2, now: now() });
    const conflict = check.conflicts.find((item) => item.kind === "travel_time")!;
    expect(conflict.severity).toBe("hard");
    expect(conflict.numbers).toEqual({ needMin: 600, haveMin: 60 });
    expect(conflict.why).toContain("10 小时");
    expect(conflict.fixes.length).toBeGreaterThanOrEqual(2);
    expect(conflict.fixes[0].ops[0].op).toBe("event.update");
    expect(conflict.fixes[0].preview[0].field).toBe("开始时间");
    expect(conflict.fixes[0].preview[0].after).not.toBe(conflict.fixes[0].preview[0].before);
    expect(check.clean).toContain("double_location");
  });

  it("按未确认推断路线算出来的赶不到只是黄色疑似冲突", () => {
    const { document } = build();
    const legs = legsFor(document, 600).map((leg) => ({
      ...leg,
      kind: "inferred" as const,
      segments: [{ from: 0, to: 1, kind: "inferred" as const }],
      inferred: { proposalId: "pr-1", why: "绕古城道", sources: [{ title: "县志" }] },
    }));
    const check = runCheck({ document, legs, revision: 2, now: now() });
    const conflict = check.conflicts.find((item) => item.kind === "travel_time")!;
    expect(conflict.severity).toBe("suspect");
    expect(conflict.why).toContain("推断");
    expect(conflict.fixes.some((fix) => fix.ops.some((op) => op.op === "proposal.decide"))).toBe(true);
  });

  it("作者确认过的路线（manual）按正式路线算，就是硬冲突", () => {
    const { document } = build();
    const legs = legsFor(document, 600).map((leg) => ({ ...leg, kind: "manual" as const }));
    const check = runCheck({ document, legs, revision: 2, now: now() });
    const conflict = check.conflicts.find((item) => item.kind === "travel_time")!;
    expect(conflict.severity).toBe("hard");
    expect(conflict.fixes.some((fix) => fix.ops.some((op) => op.op === "proposal.decide"))).toBe(false);
  });

  it("接受修法以后重查，这条冲突消失", () => {
    const { document } = build();
    const first = runCheck({ document, legs: legsFor(document, 600), revision: 2, now: now() });
    const conflict = first.conflicts.find((item) => item.kind === "travel_time")!;
    const fixed = applyOps(document, conflict.fixes[0].ops, { actor: "user", ids });
    const second = runCheck({ document: fixed.next, legs: legsFor(fixed.next, 600), revision: 3, now: now() });
    expect(second.conflicts.some((item) => item.kind === "travel_time")).toBe(false);
  });

  it("同时异地：重叠时间在两地 → 红色，房间与所属楼不算", () => {
    const { document, id } = build();
    const clash = applyOps(
      document,
      [
        event("在青州露面", id["张三"], id["青州城"], "1684-04-21 13:00", "1684-04-21 14:00"),
        event("在清河镇露面", id["张三"], id["清河镇"], "1684-04-21 13:30", "1684-04-21 14:30"),
      ],
      { actor: "user", ids },
    ).next;
    const check = runCheck({ document: clash, legs: [], revision: 3, now: now() });
    const conflict = check.conflicts.find((item) => item.kind === "double_location")!;
    expect(conflict).toBeTruthy();
    expect(conflict.why).toContain("同时");
    expect(conflict.fixes.some((fix) => fix.kind === "drop_constraint")).toBe(true);

    // 把客房挂到客栈下面，人同时在客栈和客房：父子地点不算同时异地。
    const parented = applyOps(
      clash,
      [
        {
          op: "entity.update",
          id: id["客房"],
          patch: {
            place: { level: "room", parentId: id["悦来客栈"], geo: null, geoCertainty: "unlocated", connects: [] },
          },
        } as CreativeOp,
        event("在客房", id["张三"], id["客房"], "1684-04-21 14:00", "1684-04-21 15:00"),
        event("在客栈大堂", id["张三"], id["悦来客栈"], "1684-04-21 14:30", "1684-04-21 15:30"),
      ],
      { actor: "user", ids },
    ).next;
    const recheck = runCheck({ document: parented, legs: [], revision: 4, now: now() });
    const pairs = recheck.conflicts.filter((item) => item.kind === "double_location");
    expect(pairs.some((item) => item.why.includes("悦来客栈") && item.why.includes("客房"))).toBe(false);
  });

  it("死亡之后实际出场 → 红色；标成回忆就不算", () => {
    const { document: base, id } = build();
    let document = applyOps(
      base,
      [
        event("病故", id["张三"], id["悦来客栈"], "1684-04-22 08:00", "1684-04-22 09:00", { kind: "death" }),
        event("又见他", id["张三"], id["清河镇"], "1684-04-23 08:00", "1684-04-23 09:00"),
      ],
      { actor: "user", ids },
    ).next;
    const deathEvent = document.events.find((item) => item.title === "病故")!;
    document = applyOps(
      document,
      [{ op: "entity.update", id: id["张三"], patch: { person: { died: deathEvent.id } } } as CreativeOp],
      { actor: "user", ids },
    ).next;
    const check = runCheck({ document, legs: [], revision: 5, now: now() });
    const conflict = check.conflicts.find((item) => item.kind === "dead_appearance")!;
    expect(conflict).toBeTruthy();
    const flashback = conflict.fixes.find((fix) => fix.label.includes("回忆"))!;
    const after = applyOps(document, flashback.ops, { actor: "user", ids }).next;
    const recheck = runCheck({ document: after, legs: [], revision: 6, now: now() });
    expect(recheck.conflicts.some((item) => item.kind === "dead_appearance")).toBe(false);
  });

  it("在场互动与位置记录不相容 → 红色，可以改成「被提及」", () => {
    const { document, id } = build();
    // 在清河镇的那段时间里，另加一场要求张三在青州城出席的互动。
    const misplaced = applyOps(
      document,
      [
        event("青州赴宴", id["张三"], id["青州城"], "1684-04-21 10:30", "1684-04-21 11:00", {
          kind: "interaction",
          participants: [{ entityId: id["张三"], as: "present" }],
        }),
      ],
      { actor: "user", ids },
    ).next;
    const check = runCheck({ document: misplaced, legs: [], revision: 3, now: now() });
    const conflict = check.conflicts.find(
      (item) => item.kind === "presence" && item.why.includes("在场"),
    )!;
    expect(conflict).toBeTruthy();
    const mention = conflict.fixes.find((fix) => fix.label.includes("被提及"))!;
    const after = applyOps(misplaced, mention.ops, { actor: "user", ids }).next;
    const recheck = runCheck({ document: after, legs: [], revision: 4, now: now() });
    expect(recheck.conflicts.some((item) => item.kind === "presence")).toBe(false);
  });

  it("地点层级与连接：房间没归属、连接指向不存在的地方 → 红色并给修法", () => {
    const { document, id } = build();
    const check = runCheck({ document, legs: [], revision: 2, now: now() });
    const hierarchy = check.conflicts.filter((item) => item.kind === "place_hierarchy");
    expect(hierarchy.some((item) => item.why.includes("房间"))).toBe(true);
    expect(hierarchy.some((item) => item.why.includes("不存在的地点"))).toBe(true);
    const room = hierarchy.find((item) => item.why.includes("房间"))!;
    expect(room.fixes[0].ops[0].op).toBe("entity.update");
    const after = applyOps(document, room.fixes[0].ops, { actor: "user", ids }).next;
    const placed = after.entities.find((item) => item.id === id["客房"])!;
    expect(placed.place?.parentId).toBe(id["悦来客栈"]);
    const recheck = runCheck({ document: after, legs: [], revision: 3, now: now() });
    expect(recheck.conflicts.some((item) => item.why.includes("房间"))).toBe(false);
  });

  it("确认 route 提议：推断路线变正式路线，同一段改按硬冲突算", () => {
    const { document } = build();
    const legs = legsFor(document, 600);
    const path = { type: "LineString" as const, coordinates: [[118.5, 36.7], [118.8, 36.9], [119.2, 37.1]] as [number, number][] };
    const withInferred: CreativeDocument = {
      ...document,
      inferredRoutes: [{ legId: legs[0].id, proposalId: "pr-test", path, why: "按县志走古道", sources: [{ title: "县志" }] }],
      proposals: [
        {
          id: "pr-test",
          kind: "route",
          title: "推断路线",
          summary: "按县志走古道",
          ops: [{ op: "route.draw", legId: legs[0].id, path }],
          origin: { basis: "inferred", by: "route_ai", why: "按县志走古道" },
          doubts: [],
          dependsOn: [],
          conflicts: [],
          status: "pending",
        },
      ],
    };
    // 确认前：按推断路线算，只能是黄色疑似冲突。
    const inferredLegs = legs.map((leg) => ({
      ...leg,
      kind: "inferred" as const,
      segments: [{ from: 0, to: 2, kind: "inferred" as const }],
      inferred: { proposalId: "pr-test", why: "按县志走古道", sources: [{ title: "县志" }] },
    }));
    const before = runCheck({ document: withInferred, legs: inferredLegs, revision: 2, now: now() });
    expect(before.conflicts.find((item) => item.kind === "travel_time")!.severity).toBe("suspect");

    const decided = applyOps(withInferred, [{ op: "proposal.decide", id: "pr-test", decision: "accepted" }], {
      actor: "user",
      ids,
    });
    expect(decided.next.manualRoutes.some((item) => item.legId === legs[0].id)).toBe(true);
    expect(decided.next.inferredRoutes).toEqual([]);
    expect(decided.next.proposals.find((item) => item.id === "pr-test")?.status).toBe("accepted");

    const after = runCheck({
      document: decided.next,
      legs: legs.map((leg) => ({ ...leg, kind: "manual" as const })),
      revision: 3,
      now: now(),
    });
    expect(after.conflicts.find((item) => item.kind === "travel_time")!.severity).toBe("hard");
  });

  it("信息不足与未覆盖照实显示，不当作通过", () => {
    const { document, id } = build();
    const withUnknown = applyOps(
      document,
      [
        event("传说", id["李四"], null, "未定", "未定", { kind: "stay", narrative: "hearsay", participants: [{ entityId: id["李四"], as: "mentioned" }] }),
        { op: "rule.set", rule: { id: "rule-1", text: "此地夜里不能出城。", machine: null } } as CreativeOp,
      ],
      { actor: "user", ids },
    ).next;
    const check = runCheck({ document: withUnknown, legs: [], revision: 3, now: now() });
    expect(check.insufficient.some((item) => item.gaps.some((text) => text.includes("时间未定")))).toBe(true);
    expect(check.insufficient.some((item) => item.gaps.some((text) => text.includes("地点未定")))).toBe(true);
    expect(check.uncovered).toEqual([expect.objectContaining({ ruleId: "rule-1" })]);
  });

  it("算不出路时按信息不足给缺口，不当成冲突也不当成通过", () => {
    const { document } = build();
    const legs = legsFor(document, 0).map((leg) => ({
      ...leg,
      kind: "none" as const,
      path: null,
      distanceKm: null,
      durationMin: null,
      failure: "两地在路网里不连通",
    }));
    const check = runCheck({ document, legs, revision: 2, now: now() });
    expect(check.conflicts.some((item) => item.kind === "travel_time")).toBe(false);
    expect(check.insufficient.some((item) => item.gaps.some((text) => text.includes("路线待定：两地在路网里不连通")))).toBe(true);
    expect(check.clean).not.toContain("travel_time");
  });
});
