// 作品账本：大纲确认建章建场、正文版本、标注（实体/事件/冲突/过期出处）、导出用词数。
import { describe, expect, it } from "vitest";
import type { CreativeTextEdit as TextEdit, WorkOp } from "@reinlab/contracts";
import {
  applyTextEdit,
  applyWorkOps,
  computeMarks,
  emptyWork,
  markConflicts,
  paragraphsOf,
  quoteStillThere,
  wordsOf,
} from "../src/creative/work";
import type { CreativeDocument } from "../src/creative/world";
import { applyOps, emptyDocument } from "../src/creative/world";
import { buildDocx } from "../src/creative/docx";
import { stripRepeatedExisting } from "../src/creative/writer";

let counter = 0;
const ids = () => `id-${++counter}`;

const workWithOutline = () => {
  counter = 0;
  const work = emptyWork({ kind: "novel", title: "阊门夜行", baseVersion: 3, id: "w1" });
  const outcome = applyWorkOps(
    work,
    [
      {
        op: "outline.set",
        outline: {
          logline: "一个书生夜里出城送信",
          pov: "第三人称限制",
          ending: "信送到了，人没回来",
          chapters: [
            {
              id: "ch1",
              title: "出城",
              scenes: [
                { id: "sc1", title: "阊门", goal: "动身", eventIds: [], targetWords: 2000 },
                { id: "sc2", title: "古道", goal: "走夜路", eventIds: [], targetWords: 2000 },
              ],
            },
          ],
        },
      },
    ] as WorkOp[],
    { ids },
  );
  const confirmed = applyWorkOps(outcome.next, [{ op: "outline.confirm" }], { ids });
  return confirmed.next;
};

const worldWith = (): CreativeDocument => {
  const document = emptyDocument("测试世界观");
  document.entities = [
    { id: "p1", kind: "person", name: "沈砚", aliases: ["沈生"], origin: { basis: "author", by: "user" }, status: "accepted", workRefs: [], person: {} },
    { id: "pl1", kind: "place", name: "阊门", aliases: [], origin: { basis: "author", by: "user" }, status: "accepted", workRefs: [], place: { level: "city", parentId: null, geo: null, geoCertainty: "unlocated", connects: [] } },
  ];
  document.events = [
    {
      id: "e1", title: "出阊门", what: "动身", kind: "stay",
      participants: [{ entityId: "p1", as: "actor" }], placeId: "pl1", travel: null, narrative: "fact",
      origin: { basis: "author", by: "user" }, status: "accepted", gaps: [], workRefs: [],
      start: { t: 1, label: "第 1 日 06:00", certainty: "exact", calendar: "gregorian", relative: null },
      end: { t: 2, label: "第 1 日 07:00", certainty: "exact", calendar: "gregorian", relative: null },
    },
  ];
  return document;
};

describe("作品账本", () => {
  it("确认大纲会按大纲建章建场，再确认不覆盖已经写过的正文", () => {
    const work = workWithOutline();
    expect(work.chapters).toHaveLength(1);
    expect(work.chapters[0].scenes.map((scene) => scene.title)).toEqual(["阊门", "古道"]);
    expect(work.outline?.state).toBe("confirmed");
    expect(work.chapters[0].scenes[0].state).toBe("empty");

    const sceneId = work.chapters[0].scenes[0].id;
    const written = applyWorkOps(work, [{ op: "text.set", sceneId, baseTextVersion: 0, text: "第一稿。" }], { ids }).next;
    const reConfirmed = applyWorkOps(written, [{ op: "outline.confirm" }], { ids });
    expect(reConfirmed.next.chapters[0].scenes[0].text).toBe("第一稿。");
    expect(reConfirmed.next.chapters[0].scenes[0].textVersion).toBe(1);
  });

  it("正文版本对不上就拒绝，别把作者的改动盖掉", () => {
    const work = workWithOutline();
    const sceneId = work.chapters[0].scenes[0].id;
    const once = applyWorkOps(work, [{ op: "text.set", sceneId, baseTextVersion: 0, text: "第一稿。" }], { ids }).next;
    expect(() =>
      applyWorkOps(once, [{ op: "text.set", sceneId, baseTextVersion: 0, text: "并发覆盖" }], { ids }),
    ).toThrow(/刚被改过/);
    const twice = applyWorkOps(once, [{ op: "text.set", sceneId, baseTextVersion: 1, text: "第二稿。" }], { ids });
    expect(twice.next.chapters[0].scenes[0].textVersion).toBe(2);
    expect(twice.touchedScenes[0]).toEqual({ sceneId, state: "written", textVersion: 2 });
    expect(twice.next.chapters[0].scenes[0].words).toBe(wordsOf("第二稿。"));
  });

  it("删场景、挪场景、改目标字数都按批次算", () => {
    const work = workWithOutline();
    const [first, second] = work.chapters[0].scenes;
    const moved = applyWorkOps(
      work,
      [
        { op: "chapter.add", title: "回城" },
      ] as WorkOp[],
      { ids },
    ).next;
    const secondChapter = moved.chapters[1];
    const afterMove = applyWorkOps(moved, [{ op: "scene.move", id: first.id, chapterId: secondChapter.id, to: 0 }], { ids }).next;
    expect(afterMove.chapters[0].scenes.map((scene) => scene.id)).toEqual([second.id]);
    expect(afterMove.chapters[1].scenes[0].id).toBe(first.id);
    const removed = applyWorkOps(afterMove, [{ op: "scene.remove", id: second.id }], { ids }).next;
    expect(removed.chapters[0].scenes).toHaveLength(0);
  });

  it("接续和改写都按 before→after 定位；作者改后接受用整段文字", () => {
    const scene = {
      id: "sc1", title: "阊门", goal: "", eventIds: [], text: "第一段。\n\n第二段。", textVersion: 2,
      words: 0, targetWords: null, state: "draft" as const, marks: [],
    };
    const continueEdit: TextEdit = {
      workId: "w1", sceneId: "sc1", baseTextVersion: 2, mode: "continue", range: null, before: "", after: "第三段。",
    };
    expect(applyTextEdit(scene, continueEdit).text).toBe("第一段。\n\n第二段。\n\n第三段。");
    const rewrite: TextEdit = {
      workId: "w1", sceneId: "sc1", baseTextVersion: 2, mode: "rewrite",
      range: { para: 1, from: 0, to: 3 }, before: "第二段。", after: "改过的第二段。",
    };
    expect(applyTextEdit(scene, rewrite).text).toBe("第一段。\n\n改过的第二段。");
    expect(applyTextEdit(scene, rewrite, "整段换成这个").text).toBe("整段换成这个");
    expect(() => applyTextEdit({ ...scene, textVersion: 9 }, rewrite)).toThrow(/又改过/);
  });

  it("续写整场提议以原正文为 before，接受不会重复原文", () => {
    const scene = { ...workWithOutline().chapters[0].scenes[0], text: "旧正文。", textVersion: 1 };
    const edit: TextEdit = { workId: "w1", sceneId: scene.id, baseTextVersion: 1, mode: "continue", range: null, before: scene.text, after: "旧正文。\n\n新增段落。" };
    expect(applyTextEdit(scene, edit).text).toBe("旧正文。\n\n新增段落。");
  });

  it("正文提议可拒绝和暂缓，但不能经世界观接受", () => {
    const world = emptyDocument("测试");
    world.proposals = [{ id: "p-text", kind: "text_edit", title: "续写", summary: "", ops: [], origin: { basis: "inferred", by: "writer" }, doubts: [], dependsOn: [], conflicts: [], status: "pending" }];
    for (const decision of ["rejected", "deferred"] as const) {
      const result = applyOps(world, [{ op: "proposal.decide", id: "p-text", decision }], { actor: "user" });
      expect(result.next.proposals[0].status).toBe(decision);
    }
    expect(() => applyOps(world, [{ op: "proposal.decide", id: "p-text", decision: "accepted" }], { actor: "user" })).toThrow(/text.accept/);
  });

  it("改写只替换给出的那一段原话", () => {
    const scene = {
      id: "sc1", title: "阊门", goal: "", eventIds: [], text: "第一段。\n\n第二段有改动。", textVersion: 1,
      words: 0, targetWords: null, state: "written" as const, marks: [],
    };
    const range = { para: 1, from: 0, to: 3 };
    const paragraphs = paragraphsOf(scene.text);
    const before = paragraphs[range.para].slice(range.from, range.to);
    expect(before).toBe("第二段");
    const edit: TextEdit = {
      workId: "w1", sceneId: "sc1", baseTextVersion: 1, mode: "rewrite", range, before, after: "改了",
    };
    expect(applyTextEdit(scene, edit).text).toBe("第一段。\n\n改了有改动。");
  });

  it("正文标注：实体、别名、事件、冲突、过期出处", () => {
    const document = workWithOutline();
    const sceneId = document.chapters[0].scenes[0].id;
    const written = applyWorkOps(
      document,
      [{ op: "text.set", sceneId, baseTextVersion: 0, text: "沈砚在阊门等沈生。\n\n他想起出阊门那天。" }],
      { ids },
    ).next;
    const world = worldWith();
    const marks = computeMarks({ document: written, world, sceneId, conflicts: [], proposals: [] });
    const kinds = marks.map((mark) => `${mark.kind}:${mark.refId}`);
    expect(kinds).toContain("entity:p1");
    expect(kinds).toContain("event:e1");
    // 别名也标（沈生）
    expect(marks.filter((mark) => mark.refId === "p1").length).toBeGreaterThanOrEqual(2);
    // 冲突落在提到相关实体的那一段
    const withConflict = markConflicts(marks, written.chapters[0].scenes[0].text, [{ id: "cf1", entityIds: ["p1"], eventIds: [] }], world);
    expect(withConflict.some((mark) => mark.kind === "conflict" && mark.refId === "cf1")).toBe(true);

    // 过期出处：原文句子在正文里找不到了
    const proposal = {
      id: "pr1", kind: "entity" as const, title: "别名合并", summary: "",
      ops: [], origin: { basis: "explicit" as const, by: "importer" as const, source: { workId: "w1", textVersion: 1, chapterId: world.events.length ? "ch1" : "ch1", para: 0, sentence: 0, quote: "一句已经不在正文里的话" } },
      doubts: [], dependsOn: [], conflicts: [], status: "pending" as const,
    };
    const stale = computeMarks({ document: written, world, sceneId: written.chapters[0].scenes[0].id, conflicts: [], proposals: [proposal] });
    expect(stale.some((mark) => mark.kind === "stale_source" && mark.refId === "pr1")).toBe(true);
    expect(quoteStillThere("沈砚在阊门等沈生。", "沈砚在阊门")).toBe(true);
  });

  it("续写把模型抄回来的原文剪掉，只留新增（验收 B1）", () => {
    const existing = "第一段：夜里出了阊门。\n\n第二段：城墙在身后合上。\n\n第三段：雨还没有停。";
    // 1) 整段照抄 + 新段
    const copied = `${existing}\n\n第四段：他往西走。`;
    expect(stripRepeatedExisting(existing, copied)).toBe("第四段：他往西走。");
    // 2) 抄的时候顺手改了一段（第三段被改），仍按最后对上的一段剪
    const edited = "第一段：夜里出了阊门。\n\n第二段：城墙在身后合上。\n\n第三段：雨小了些。\n\n第四段：他往西走。";
    expect(stripRepeatedExisting(existing, edited)).toBe("第三段：雨小了些。\n\n第四段：他往西走。");
    // 3) 只给了新增：一个字不动
    expect(stripRepeatedExisting(existing, "第四段：他往西走。")).toBe("第四段：他往西走。");
    // 4) 整篇只抄原文：剪完是空，调用方会当失败处理
    expect(stripRepeatedExisting(existing, existing)).toBe("");
  });

  it("导出：md 有标题和章节，docx 是能打开的 zip", () => {
    const work = workWithOutline();
    const sceneId = work.chapters[0].scenes[0].id;
    const written = applyWorkOps(work, [{ op: "text.set", sceneId, baseTextVersion: 0, text: "夜里出了阊门。" }], { ids }).next;
    const paragraphs = paragraphsOf(written.chapters[0].scenes[0].text);
    expect(paragraphs).toEqual(["夜里出了阊门。"]);

    const docx = buildDocx({
      title: written.title,
      blocks: [{ text: "第 1 章　出城", bold: true }, { text: paragraphs[0] }],
    });
    expect(docx.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b])); // PK
    const text = new TextDecoder().decode(docx);
    expect(text).toContain("word/document.xml");
    expect(text).toContain("夜里出了阊门。");
  });
});
