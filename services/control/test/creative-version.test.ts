// 1C 版本差异与设定组合：按条目算增删改、列出改了哪些字段；作品按组合还原实际设定。
import { describe, expect, it } from "vitest";
import type { CreativeDocument } from "../src/creative/world";
import { emptyDocument } from "../src/creative/world";
import { diffDocuments } from "../src/creative/items";
import {
  dismissSync,
  effectiveDocument,
  followItem,
  keepItem,
  resolveSync,
  setOverride,
  settingOf,
  settingStateOf,
} from "../src/creative/settings";

const base = (): CreativeDocument => {
  const document = emptyDocument("测试世界观");
  document.entities = [
    {
      id: "p1", kind: "person", name: "沈砚", aliases: [], origin: { basis: "author", by: "user" },
      status: "accepted", workRefs: [], person: {},
    },
    {
      id: "pl1", kind: "place", name: "阊门", aliases: [],
      origin: { basis: "author", by: "user" }, status: "accepted", workRefs: [],
      place: { level: "city", parentId: null, geo: { type: "Point", coordinates: [120.6, 31.31] }, geoCertainty: "exact", connects: [] },
    },
  ];
  document.events = [
    {
      id: "e1", title: "出阊门", what: "动身", kind: "stay",
      participants: [{ entityId: "p1", as: "actor" }], placeId: "pl1", travel: null, narrative: "fact",
      origin: { basis: "author", by: "user" }, status: "accepted", gaps: [], workRefs: [],
      start: { t: 100, label: "第 1 日 06:00", certainty: "exact", calendar: "gregorian", relative: null },
      end: { t: 160, label: "第 1 日 07:00", certainty: "exact", calendar: "gregorian", relative: null },
    },
  ];
  return document;
};

describe("版本差异", () => {
  it("按条目算新增/修改/删除，并列出改了哪些字段", () => {
    const from = base();
    const to = base();
    // 阊门挪位置；出阊门改早一小时；沈砚改名；加一条规则；删掉一条事件
    to.entities[1].place = { ...to.entities[1].place!, geo: { type: "Point", coordinates: [120.61, 31.315] } };
    to.entities[0].name = "沈砚之";
    to.events[0].start = { ...to.events[0].start, t: 40, label: "第 1 日 05:00" };
    to.rules = [
      { id: "r1", text: "夜里不许出城。", machine: null, origin: { basis: "author", by: "user" }, status: "accepted" },
    ];
    to.events = [];

    const items = diffDocuments(from, to);
    const place = items.find((item) => item.itemId === "pl1")!;
    expect(place.change).toBe("update");
    expect(place.title).toContain("阊门");
    expect(place.fields).toContain("地点信息");
    const person = items.find((item) => item.itemId === "p1")!;
    expect(person.fields).toContain("名称");
    const event = items.find((item) => item.itemId === "e1")!;
    expect(event.change).toBe("remove");
    expect(event.after).toBeNull();
    const rule = items.find((item) => item.itemId === "r1")!;
    expect(rule.change).toBe("add");
    expect(rule.before).toBeNull();
  });

  it("没改动就没有条目", () => {
    expect(diffDocuments(base(), base())).toEqual([]);
  });
});

describe("作品的设定组合", () => {
  it("follow 记 picks + decision，并把受影响的场景标成待同步", () => {
    const state = settingStateOf({});
    const next = followItem(state, { itemId: "pl1", toVersion: 3, scenes: ["s1", "s2"], at: "2026-11-09T00:00:00Z" });
    expect(next.picks).toEqual([{ itemId: "pl1", fromVersion: 3, at: "2026-11-09T00:00:00Z" }]);
    expect(next.decisions[0]).toMatchObject({ itemId: "pl1", toVersion: 3, decision: "follow" });
    expect(next.sync.map((pair) => pair.sceneId)).toEqual(["s1", "s2"]);
    expect(settingOf({ baseVersion: 2, setting: next }).pendingSync).toBe(2);
  });

  it("keep 只记决定，并把这条的待同步撤掉", () => {
    const followed = followItem(settingStateOf({}), { itemId: "pl1", toVersion: 3, scenes: ["s1"], at: "t1" });
    const kept = keepItem(followed, { itemId: "pl1", toVersion: 3, at: "t2" });
    expect(kept.decisions[0].decision).toBe("keep");
    expect(kept.sync).toEqual([]);
  });

  it("dismiss 与接受改稿都能把一处待同步消掉，并且不再重复出现", () => {
    const followed = followItem(settingStateOf({}), { itemId: "pl1", toVersion: 3, scenes: ["s1", "s2"], at: "t1" });
    const dismissed = dismissSync(followed, { itemId: "pl1", sceneId: "s1", reason: "这段不用改", at: "t2" });
    expect(dismissed.sync.map((pair) => pair.sceneId)).toEqual(["s2"]);
    expect(dismissed.syncDone[0]).toMatchObject({ sceneId: "s1", via: "dismiss", reason: "这段不用改" });
    const resolved = resolveSync(dismissed, { itemId: "pl1", sceneId: "s2", at: "t3", via: "text_edit" });
    expect(resolved.sync).toEqual([]);
    // 再 follow 一次，处理过的不再冒出来
    const again = followItem(resolved, { itemId: "pl1", toVersion: 3, scenes: ["s1", "s2"], at: "t4" });
    expect(again.sync).toEqual([]);
  });

  it("effective = 基准 + picks + overrides，条目带来源标记", () => {
    const v2 = base();
    const v3 = base();
    v3.entities[1].place = { ...v3.entities[1].place!, geo: { type: "Point", coordinates: [120.62, 31.32] } };
    v3.events[0].start = { ...v3.events[0].start, t: 40, label: "第 1 日 05:00" };
    const state = setOverride(settingStateOf({}), {
      itemId: "p1", kind: "entity", patch: { summary: "本作品里的沈砚更阴沉" }, note: "本作品设定", at: "t",
    });
    const followed = followItem(state, { itemId: "pl1", toVersion: 3, scenes: ["s1"], at: "t" });
    const built = effectiveDocument({ base: v2, versions: new Map([[3, v3]]), setting: followed });
    const place = built.document.entities.find((item) => item.id === "pl1")!;
    expect((place.place?.geo as { coordinates: number[] }).coordinates).toEqual([120.62, 31.32]);
    expect(place.setting).toBe("picked");
    const person = built.document.entities.find((item) => item.id === "p1")!;
    expect(person.summary).toBe("本作品里的沈砚更阴沉");
    expect(person.setting).toBe("override");
    // 没跟的那条事件还是基准版本的时间
    expect(built.document.events[0].start.t).toBe(100);
    expect(built.document.events[0].setting).toBe("base");
  });
});
