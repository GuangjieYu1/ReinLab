/**
 * 作品账本（design/prd/20-creative-contract.md §5.1、§5.2）。
 *
 * 一部作品 = 大纲 + 卷章 + 场景 + 正文。改动走 WorkOp 的原子批次，revision +1；
 * 修改规则（删场景要清引用、确认大纲会建章建场、正文要带 baseTextVersion）都在这里，
 * 页面和助手走同一套，纯计算、不碰数据库。
 *
 * 正文标注（marks）由服务端算：实体、事件、冲突、过期出处，前端只画。
 */

import { randomUUID } from 'node:crypto';
import type { Chapter, Outline, Proposal, Scene, TextEdit, TextMark, Work, WorkOp } from '@reinlab/contracts';
import type { CreativeDocument } from './world';
import { settingOf, syncItemsOfScene, type WorkSettingState } from './settings';
import { ApiFailure } from '../api/errors';

export type WorkDocument = {
  id: string;
  kind: Work['kind'];
  title: string;
  /** 建作品时锁定的已确认版本。 */
  baseVersion: number;
  targetWords: number | null;
  outline: Outline | null;
  chapters: Chapter[];
  source?: Work['source'];
  autoAcceptDraft?: boolean;
  /** 1C：这部作品的设定组合与待同步状态。 */
  setting?: WorkSettingState;
  createdAt: string;
};

const fail = (code: string, status: 400 | 404 | 409 | 422, message: string) =>
  new ApiFailure(code, status, message);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 字数：去掉空白后的字符数（中文按字算，够用且说得清）。 */
export function wordsOf(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length;
}

export function emptyWork(input: {
  id?: string;
  kind: Work['kind'];
  title: string;
  targetWords?: number | null;
  baseVersion: number;
  source?: Work['source'];
  createdAt?: string;
}): WorkDocument {
  return {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    title: input.title,
    baseVersion: input.baseVersion,
    targetWords: input.targetWords ?? null,
    outline: null,
    chapters: [],
    ...(input.source ? { source: input.source } : {}),
    autoAcceptDraft: false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

const newId = () => randomUUID();

export function sceneOf(document: WorkDocument, sceneId: string): { scene: Scene; chapter: Chapter } {
  for (const chapter of document.chapters)
    for (const scene of chapter.scenes) if (scene.id === sceneId) return { scene, chapter };
  throw fail('SCENE_NOT_FOUND', 404, '这一场已经不在了。');
}

/** 大纲确认之前不能生成；空场景要有标题。 */
export function assertGeneratable(document: WorkDocument): void {
  if (!document.outline || document.outline.state !== 'confirmed')
    throw fail('OUTLINE_NOT_CONFIRMED', 409, '大纲还没确认，先把大纲定下来再写。');
}

/** 一段正文按空行分段；标注用的段落下标就是这里的分段。 */
export function paragraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/).map((item) => item.replace(/\s+$/, ''));
}

export type WorkApplyOutcome = {
  next: WorkDocument;
  applied: { op: WorkOp['op']; summary: string }[];
  /** 正文动过的场景（服务端要推 creative.text）。 */
  touchedScenes: { sceneId: string; state: Scene['state']; textVersion: number }[];
  /** 大纲里提到的提议（确认大纲不等于入账，仍然挂在待确认）。 */
  proposalIds: string[];
};

export type WorkApplyOptions = { ids?: () => string; at?: string };

/** 一个作品批次的纯计算：要么全成，要么抛错（调用方回滚事务）。 */
export function applyWorkOps(
  document: WorkDocument,
  ops: WorkOp[],
  options: WorkApplyOptions = {},
): WorkApplyOutcome {
  const next = clone(document);
  const applied: { op: WorkOp['op']; summary: string }[] = [];
  const touchedScenes: WorkApplyOutcome['touchedScenes'] = [];
  const ids = options.ids ?? newId;
  const push = (op: WorkOp['op'], summary: string) => applied.push({ op, summary });

  for (const op of ops) {
    switch (op.op) {
      case 'work.set': {
        if (op.patch.title !== undefined) {
          if (!op.patch.title.trim()) throw fail('INVALID_INPUT', 400, '作品要有名字。');
          next.title = op.patch.title.trim();
        }
        if (op.patch.targetWords !== undefined) {
          const target = op.patch.targetWords;
          if (target !== null && (!Number.isFinite(target) || target < 0))
            throw fail('INVALID_INPUT', 400, '目标字数要是不小于 0 的数。');
          next.targetWords = target === null ? null : Math.round(target);
        }
        if (op.patch.autoAcceptDraft !== undefined) next.autoAcceptDraft = op.patch.autoAcceptDraft === true;
        push(op.op, '改了作品设置');
        break;
      }
      case 'outline.set': {
        next.outline = {
          ...clone(op.outline),
          state: next.outline?.state === 'confirmed' ? 'confirmed' : 'draft',
          proposalIds: next.outline?.proposalIds ?? [],
        };
        if (!next.outline.chapters.length) throw fail('INVALID_INPUT', 400, '大纲至少要有一章。');
        push(op.op, `写了大纲（${next.outline.chapters.length} 章）`);
        break;
      }
      case 'outline.confirm': {
        if (!next.outline) throw fail('INVALID_INPUT', 400, '还没有大纲。');
        next.outline.state = 'confirmed';
        // 按大纲建章建场：已经存在的（同 id）保留正文，不覆盖作者写过的东西。
        const existing = new Map<string, Scene>();
        for (const chapter of next.chapters) for (const scene of chapter.scenes) existing.set(scene.id, scene);
        next.chapters = next.outline.chapters.map((chapter, index) => ({
          id: chapter.id || ids(),
          no: index + 1,
          title: chapter.title || `第 ${index + 1} 章`,
          scenes: chapter.scenes.map((scene) => {
            const kept = existing.get(scene.id);
            return {
              id: scene.id || ids(),
              title: scene.title || '未命名场景',
              goal: scene.goal ?? '',
              eventIds: [...(scene.eventIds ?? [])],
              text: kept?.text ?? '',
              textVersion: kept?.textVersion ?? 0,
              words: kept?.words ?? 0,
              targetWords: scene.targetWords ?? null,
              state: kept?.state ?? 'empty',
              marks: [],
            };
          }),
        }));
        push(op.op, '确认了大纲，按大纲建了章和场');
        break;
      }
      case 'chapter.add': {
        const at = clampIndex(op.at, next.chapters.length);
        next.chapters.splice(at, 0, { id: ids(), no: 0, title: op.title || '未命名章', scenes: [] });
        renumber(next.chapters);
        push(op.op, `加了「${op.title}」`);
        break;
      }
      case 'chapter.update': {
        const chapter = next.chapters.find((item) => item.id === op.id);
        if (!chapter) throw fail('CHAPTER_NOT_FOUND', 404, '这一章已经不在了。');
        chapter.title = op.title || chapter.title;
        push(op.op, `改了章名「${chapter.title}」`);
        break;
      }
      case 'chapter.remove': {
        const index = next.chapters.findIndex((item) => item.id === op.id);
        if (index < 0) throw fail('CHAPTER_NOT_FOUND', 404, '这一章已经不在了。');
        const [removed] = next.chapters.splice(index, 1);
        renumber(next.chapters);
        push(op.op, `删了「${removed.title}」（${removed.scenes.length} 场）`);
        break;
      }
      case 'chapter.move': {
        const index = next.chapters.findIndex((item) => item.id === op.id);
        if (index < 0) throw fail('CHAPTER_NOT_FOUND', 404, '这一章已经不在了。');
        const [chapter] = next.chapters.splice(index, 1);
        next.chapters.splice(clampIndex(op.to, next.chapters.length), 0, chapter);
        renumber(next.chapters);
        push(op.op, `挪了章「${chapter.title}」`);
        break;
      }
      case 'scene.add': {
        const chapter = next.chapters.find((item) => item.id === op.chapterId);
        if (!chapter) throw fail('CHAPTER_NOT_FOUND', 404, '这一章已经不在了。');
        const scene: Scene = {
          id: ids(), title: op.title || '未命名场景', goal: '', eventIds: [],
          text: '', textVersion: 0, words: 0, targetWords: null, state: 'empty', marks: [],
        };
        chapter.scenes.splice(clampIndex(op.at, chapter.scenes.length), 0, scene);
        push(op.op, `加了场景「${scene.title}」`);
        break;
      }
      case 'scene.update': {
        const { scene } = sceneOf(next, op.id);
        if (op.patch.title !== undefined) scene.title = op.patch.title || scene.title;
        if (op.patch.goal !== undefined) scene.goal = op.patch.goal;
        if (op.patch.eventIds !== undefined) scene.eventIds = [...new Set(op.patch.eventIds)];
        if (op.patch.targetWords !== undefined) scene.targetWords = op.patch.targetWords;
        push(op.op, `改了场景「${scene.title}」`);
        break;
      }
      case 'scene.remove': {
        const { scene, chapter } = sceneOf(next, op.id);
        chapter.scenes = chapter.scenes.filter((item) => item.id !== scene.id);
        push(op.op, `删了场景「${scene.title}」`);
        break;
      }
      case 'scene.move': {
        const { scene, chapter } = sceneOf(next, op.id);
        const target = next.chapters.find((item) => item.id === op.chapterId);
        if (!target) throw fail('CHAPTER_NOT_FOUND', 404, '目标章不存在。');
        chapter.scenes = chapter.scenes.filter((item) => item.id !== scene.id);
        target.scenes.splice(clampIndex(op.to, target.scenes.length), 0, scene);
        push(op.op, `把「${scene.title}」挪到「${target.title}」`);
        break;
      }
      case 'text.set': {
        const { scene } = sceneOf(next, op.sceneId);
        if (op.baseTextVersion !== scene.textVersion)
          throw fail('TEXT_VERSION_STALE', 409, '这场正文刚被改过，请按最新一版再写。');
        scene.text = op.text;
        scene.textVersion += 1;
        scene.words = wordsOf(op.text);
        scene.state = op.text.trim() ? 'written' : 'empty';
        touchedScenes.push({ sceneId: scene.id, state: scene.state, textVersion: scene.textVersion });
        push(op.op, `写了「${scene.title}」（${scene.words} 字）`);
        break;
      }
      case 'text.accept': {
        // 正文提议的落实要和世界观账本一起做，交给服务层（这里只接受 text.set）。
        throw fail('INVALID_INPUT', 400, '接受正文提议走 text.accept，由服务层落实。');
      }
      default:
        throw fail('INVALID_INPUT', 400, '不认识这个作品操作。');
    }
  }
  return {
    next: { ...next, chapters: next.chapters.map((chapter) => ({ ...chapter, scenes: chapter.scenes.map((scene) => ({ ...scene, marks: [] })) })) },
    applied,
    touchedScenes,
    proposalIds: next.outline?.proposalIds ?? [],
  };
}

const clampIndex = (value: number | undefined, length: number): number =>
  value === undefined || !Number.isFinite(value) ? length : Math.max(0, Math.min(length, Math.round(value)));

const renumber = (chapters: Chapter[]) => {
  chapters.forEach((chapter, index) => {
    chapter.no = index + 1;
  });
};

/**
 * 把 `TextEdit` 应用到正文：rewrite 换范围内的字，其它模式按 before→after 定位。
 * 作者「改后接受」时传的是页面改过的整段文字，直接用它。
 */
export function applyTextEdit(
  scene: Scene,
  edit: TextEdit,
  acceptedText?: string,
): { text: string; from: number; to: number } {
  if (edit.baseTextVersion !== scene.textVersion)
    throw fail('TEXT_VERSION_STALE', 409, '这场正文在提议之后又改过，请重新生成或按最新正文改。');
  if (acceptedText !== undefined) return { text: acceptedText, from: 0, to: 0 };
  const text = scene.text ?? '';
  const before = edit.before ?? '';
  const after = edit.after ?? '';
  if (!before && !text) return { text: after, from: 0, to: 0 };
  if (before && text.includes(before)) {
    const at = text.indexOf(before);
    return { text: text.slice(0, at) + after + text.slice(at + before.length), from: at, to: at + before.length };
  }
  // 定位不到原句：接在末尾（continue / draft 的正常情形），不覆盖已有正文。
  const glue = text.trim() ? (text.endsWith('\n\n') ? '' : '\n\n') : '';
  return { text: text + glue + after, from: text.length, to: text.length };
}

/** 一段跟原句在不在：过期出处靠它判断。 */
export function quoteStillThere(text: string, quote: string): boolean {
  if (!quote.trim()) return true;
  const flat = text.replace(/\s+/g, '');
  return flat.includes(quote.replace(/\s+/g, ''));
}

export type MarkInput = {
  document: WorkDocument;
  world: CreativeDocument;
  /** 这一刻的冲突（服务端检查结果）。 */
  conflicts: { id: string; entityIds: string[]; eventIds: string[] }[];
  proposals: Proposal[];
};

/**
 * 正文标注：实体名、事件标题、冲突（红黄段落）、过期出处。
 * 只做字符串匹配，不改正文；认不出就不标，不猜。
 */
export function computeMarks(input: {
  document: WorkDocument;
  world: CreativeDocument;
  sceneId: string;
  conflicts: { id: string; entityIds: string[]; eventIds: string[] }[];
  proposals: Proposal[];
}): TextMark[] {
  const { document, world, sceneId } = input;
  const { scene, chapter } = sceneOf(document, sceneId);
  const paragraphs = paragraphsOf(scene.text);
  const marks: TextMark[] = [];
  const names: { needle: string; kind: TextMark['kind']; refId: string }[] = [];
  for (const entity of world.entities)
    for (const name of [entity.name, ...(entity.aliases ?? [])])
      if (name && name.length >= 2) names.push({ needle: name, kind: 'entity', refId: entity.id });
  for (const event of world.events)
    if (event.title && event.title.length >= 2) names.push({ needle: event.title, kind: 'event', refId: event.id });
  for (const [para, text] of paragraphs.entries()) {
    const used = new Set<string>();
    for (const item of names) {
      let from = text.indexOf(item.needle);
      while (from >= 0 && marks.length < 4000) {
        const key = `${para}:${from}:${item.kind}:${item.refId}`;
        if (!used.has(key)) {
          used.add(key);
          marks.push({ para, from, to: from + item.needle.length, kind: item.kind, refId: item.refId });
        }
        from = text.indexOf(item.needle, from + 1);
      }
    }
    // 过期出处：这条提议的原文位置在正文里已经找不到了。
    for (const proposal of input.proposals) {
      const source = proposal.origin?.source;
      if (!source?.quote || source.chapterId !== chapter.id) continue;
      if (source.para !== para) continue;
      if (!quoteStillThere(scene.text, source.quote))
        marks.push({ para, from: 0, to: Math.min(text.length, source.quote.length || 1), kind: 'stale_source', refId: proposal.id });
    }
  }
  return marks;
}

/** 冲突段落：事件或人物出现在这一段，而且它们身上挂着冲突。 */
export function markConflicts(
  marks: TextMark[],
  text: string,
  conflicts: { id: string; entityIds: string[]; eventIds: string[] }[],
  world: CreativeDocument,
): TextMark[] {
  const extra: TextMark[] = [];
  for (const conflict of conflicts) {
    const needles = [
      ...conflict.eventIds.map((id) => world.events.find((event) => event.id === id)?.title ?? ''),
      ...conflict.entityIds.map((id) => world.entities.find((entity) => entity.id === id)?.name ?? ''),
    ].filter((item) => item.length >= 2);
    for (const mark of marks) {
      if (mark.kind !== 'event' && mark.kind !== 'entity') continue;
      const needle = text.slice(mark.from, mark.to);
      if (!needle) continue;
      if (!needles.some((item) => item === needle)) continue;
      extra.push({ para: mark.para, from: mark.from, to: mark.to, kind: 'conflict', refId: conflict.id });
    }
  }
  return extra;
}

/** 给页面的作品投影：正文带标注，字数现算；列表用 withText=false。 */
export function workOf(
  document: WorkDocument,
  revision: number,
  options: { withText: boolean; marks?: (sceneId: string) => TextMark[] },
): Work {
  const chapters = document.chapters.map((chapter) => ({
    ...chapter,
    scenes: chapter.scenes.map((scene) => ({
      ...scene,
      words: wordsOf(scene.text),
      marks: options.withText
        ? [
            ...(options.marks ? options.marks(scene.id) : []),
            // 1C：这一段因为某条设定更新待同步（refId = 条目 id）
            ...syncItemsOfScene(document, scene.id).map((itemId) => ({
              para: 0,
              from: 0,
              to: 0,
              kind: 'sync' as const,
              refId: itemId,
            })),
          ]
        : [],
      ...(options.withText ? {} : { text: '' }),
    })),
  }));
  const words = document.chapters.reduce(
    (total, chapter) => total + chapter.scenes.reduce((sum, scene) => sum + wordsOf(scene.text), 0),
    0,
  );
  return {
    id: document.id,
    worldId: '',
    kind: document.kind,
    title: document.title,
    baseVersion: document.baseVersion,
    revision,
    targetWords: document.targetWords,
    words,
    outline: document.outline,
    chapters,
    ...(document.source ? { source: document.source } : {}),
    ...(document.autoAcceptDraft === undefined ? {} : { autoAcceptDraft: document.autoAcceptDraft }),
    setting: settingOf(document),
  };
}
