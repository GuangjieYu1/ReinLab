// 导入：分章、抽取结果 → 提议（带出处）、拒绝过的不再冒出来、原文改了才允许重提。
import { describe, expect, it } from "vitest";
import type { Proposal } from "@reinlab/contracts";
import { mergeProposals, proposalsFromChapter, signatureOf, splitChapters } from "../src/creative/import-job";
import type { Extraction } from "../src/creative/extract";
import { emptyWork } from "../src/creative/work";
import { CHINESE_ERA, CUSTOM_ERA, GREGORIAN, emptyDocument } from "../src/creative/world";

const LEGACY_CALENDARS = [GREGORIAN, CHINESE_ERA, CUSTOM_ERA];

describe("分章", () => {
  it("Markdown 一级/二级标题分章，题记并进第一章", () => {
    const chapters = splitChapters("书名\n题记一句\n\n## 第一夜\n夜里出城。\n\n## 第二夜\n天亮回来。");
    expect(chapters.map((item) => item.title)).toEqual(["第一夜", "第二夜"]);
    expect(chapters[0].text).toContain("题记一句");
    expect(chapters[1].text).toBe("天亮回来。");
  });

  it("古籍回目标题也能分；没有标记就整篇一章", () => {
    const chapters = splitChapters("第一回　出城\n话说……\n\n第二回　归途\n却说……");
    expect(chapters.map((item) => item.title)).toEqual(["第一回 出城", "第二回 归途"]);
    const single = splitChapters("就一段话，没有标题。");
    expect(single).toHaveLength(1);
    expect(single[0].title).toBe("全文");
  });
});

const extraction: Extraction = {
  entities: [
    { kind: "person", name: "沈砚", aliases: ["沈生"], summary: "书生", para: 0, sentence: 0, quote: "沈生夜出阊门。", basis: "explicit" },
    { kind: "place", name: "阊门", aliases: [], para: 0, sentence: 0, quote: "夜出阊门。", basis: "explicit", candidates: [{ name: "苏州阊门", why: "今苏州市阊门" }] },
  ],
  events: [
    {
      title: "夜出阊门", what: "沈生夜里出城", kind: "stay",
      participants: [{ name: "沈砚", as: "actor" }], place: "阊门",
      start: "康熙二十三年三月初七", end: "康熙二十三年三月初七",
      narrative: "fact", para: 0, sentence: 0, quote: "沈生夜出阊门。",
    },
    {
      title: "听说他死了", what: "有人说沈生没回来", kind: "stay",
      participants: [{ name: "沈砚", as: "mentioned" }], place: null,
      start: "未定", end: "未定", narrative: "hearsay", para: 1, sentence: 0, quote: "人皆云沈生已死。",
    },
  ],
  merges: [{ name: "沈生", candidates: ["沈砚"], why: "前后都指书生", para: 0, sentence: 0, quote: "沈生夜出阊门。" }],
};

const work = emptyWork({ kind: "novel", title: "夜行", baseVersion: 1, id: "w1" });

describe("抽取结果 → 提议", () => {
  it("实体、事件、共指各成一条提议，带章段句出处与原文", () => {
    const world = emptyDocument("测试世界观");
    world.calendars = LEGACY_CALENDARS;
    const proposals = proposalsFromChapter({
      extraction,
      work,
      world,
      chapter: { chapterId: "ch1", title: "第一夜", text: "沈生夜出阊门。\n\n人皆云沈生已死。", textVersion: 1 },
      batchId: "b1",
    });
    // 共指「沈生」并进同批新建的沈砚，不再单独提一张卡
    expect(proposals.length).toBe(4);
    const shen = proposals.find((item) => item.kind === "entity" && item.title === "沈砚")!;
    expect((shen.ops[0] as { entity: { aliases: string[] } }).entity.aliases).toContain("沈生");
    const entity = proposals.find((item) => item.kind === "entity" && item.title === "沈砚")!;
    expect(entity.origin.by).toBe("importer");
    expect(entity.origin.source).toMatchObject({ chapterId: "ch1", para: 0, sentence: 0, quote: "沈生夜出阊门。", textVersion: 1 });
    expect(entity.batchId).toBe("b1");
    const place = proposals.find((item) => item.kind === "entity" && item.title === "阊门")!;
    expect(place.candidates?.[0].label).toBe("苏州阊门");

    const event = proposals.find((item) => item.kind === "event" && item.title === "夜出阊门")!;
    const ops = event.ops[0] as { op: string; event: { participants: { entityName?: string }[]; placeName?: string; start: { input: string } } };
    expect(ops.op).toBe("event.add");
    expect(ops.event.participants[0].entityName).toBe("沈砚");
    expect(ops.event.placeName).toBe("阊门");
    expect(ops.event.start.input).toBe("康熙二十三年三月初七");

    const hearsay = proposals.find((item) => item.kind === "event" && item.title === "听说他死了")!;
    expect((hearsay.ops[0] as { event: { narrative: string } }).event.narrative).toBe("hearsay");

  });

  it("共指指向已入账的人时，才出「他是谁」的候选卡", () => {
    const world = emptyDocument("测试世界观");
    world.calendars = LEGACY_CALENDARS;
    world.entities = [
      {
        id: "p1", kind: "person", name: "沈砚", aliases: [], origin: { basis: "author", by: "user" },
        status: "accepted", workRefs: [], person: {},
      },
    ];
    const proposals = proposalsFromChapter({
      extraction: { entities: [], events: [], merges: extraction.merges },
      work,
      world,
      chapter: { chapterId: "ch1", title: "第一夜", text: "沈生夜出阊门。", textVersion: 1 },
      batchId: "b1",
    });
    expect(proposals).toHaveLength(1);
    const merge = proposals[0];
    expect(merge.kind).toBe("merge");
    expect(merge.candidates?.[0].label).toBe("沈砚");
    expect(merge.candidates?.[0].ops[0]).toMatchObject({ op: "entity.update", id: "p1" });
    expect(merge.ops).toEqual([]);
  });

  it("时间写法认不出来时照实留疑点，不编日期", () => {
    const world = emptyDocument("测试世界观");
    world.calendars = LEGACY_CALENDARS;
    const proposals = proposalsFromChapter({
      extraction: {
        entities: extraction.entities,
        events: [
          {
            title: "某日", what: "某日发生", kind: "other",
            participants: [{ name: "沈砚", as: "actor" }], place: null,
            start: "不记得是哪天", end: "不记得是哪天", narrative: "fact",
            para: 0, sentence: 0, quote: "某日。",
          },
        ],
        merges: [],
      },
      work,
      world,
      chapter: { chapterId: "ch1", title: "第一夜", text: "某日。", textVersion: 1 },
      batchId: "b1",
    });
    const event = proposals.find((item) => item.kind === "event")!;
    expect((event.ops[0] as { event: { start: { input: string } } }).event.start.input).toBe("未定");
    expect(event.doubts.some((item) => item.includes("认不出来"))).toBe(true);
  });

  it("拒绝过的同一条不会再冒出来；原文改了才允许重提", () => {
    const world = emptyDocument("测试世界观");
    world.calendars = LEGACY_CALENDARS;
    const chapter = { chapterId: "ch1", title: "第一夜", text: "沈生夜出阊门。\n\n人皆云沈生已死。", textVersion: 1 };
    const first = proposalsFromChapter({ extraction, work, world, chapter, batchId: "b1" });
    const rejected: Proposal = first[0];
    const before = mergeProposals(
      {
        ...world,
        proposals: [{ ...rejected, status: "rejected" }],
      },
      first,
      1,
    );
    expect(before.added.map((item) => item.title)).not.toContain(rejected.title);
    expect(before.skipped).toBeGreaterThan(0);

    // 原文改过（textVersion 变了）：允许重提
    const after = mergeProposals({ ...world, proposals: [{ ...rejected, status: "rejected" }] }, first, 2);
    expect(after.added.map((item) => item.title)).toContain(rejected.title);

    // 待确认里已有同一条：不重复加
    const pending = mergeProposals({ ...world, proposals: [{ ...rejected, status: "pending" }] }, first, 1);
    expect(pending.added.map((item) => item.title)).not.toContain(rejected.title);
    expect(signatureOf("entity", "沈砚", "沈生夜出阊门。")).toHaveLength(16);
  });
});
