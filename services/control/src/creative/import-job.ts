/**
 * 导入原文（1B 契约 §5.2「导入」、19 §5）：txt / md → 分章 → 按章抽取 → 全部进待确认。
 *
 * 几条规矩：
 * - 一章一批：进度、花费、死活都记在这份任务上，可以暂停、可以续做。
 * - 抽出来的每一项都带原文位置（章、段、句）和原句；时间写法原样保留，认不出就带疑点。
 * - 拒绝过的不会再冒出来，除非原文改过（textVersion 变了）。
 * - 任务跑在控制面里，进程重启就中断：启动时按「任务卡在 running」处理成 failed。
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  CreativeCny as Cny,
  CreativeOp,
  Proposal,
  ImportJob,
  Work,
} from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvents } from './events';
import { PROCESS_STARTED_AT, loadWorld, requireCreativeDossier } from './service';
import { clip } from './text';
import { CHINESE_ERA, type CreativeDocument } from './world';
import { parseStoryTime } from './story-time';
import { provenanceOf, splitIntoChunks, type ChapterExtractor, type Extraction } from './extract';
import { applyWorkOps, wordsOf, type WorkDocument } from './work';
import { syncWorkRefs } from './work-service';

export type ImportChapter = { chapterId: string; title: string; text: string; textVersion: number };

export type ImportJobDocument = {
  id: string;
  workId: string;
  state: ImportJob['state'];
  total: number;
  done: number;
  proposals: number;
  current: { chapterId: string; title: string } | null;
  error: string | null;
  cost: Cny;
  /** 还没抽的章（按顺序）。 */
  queue: ImportChapter[];
};

const hash = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 16);

/**
 * 分章：优先 Markdown 标题，其次「第 N 回 / 第 N 章 / 卷之N」，都没有就整篇一章。
 * 只按明显标记切，不猜。
 */
export function splitChapters(text: string): { title: string; text: string }[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const lines = normalized.split('\n');
  const mdHeading = /^#{1,3}\s+(.+?)\s*#*\s*$/;
  const classical = /^\s*(第\s*[一二三四五六七八九十百千零〇0-9]+\s*[回章节卷篇])(?:[\s　·：:、.]+(.*))?\s*$/;
  const marks: { index: number; title: string }[] = [];
  lines.forEach((line, index) => {
    const md = mdHeading.exec(line);
    if (md) {
      // 一级标题如果只有一篇（书名），不当分章
      if (line.startsWith('##') || marks.length > 0) marks.push({ index, title: md[1].trim() });
      return;
    }
    const found = classical.exec(line);
    if (found) marks.push({ index, title: [found[1], found[2]].filter(Boolean).join(' ').trim() });
  });
  if (marks.length === 0) return [{ title: '全文', text: normalized }];
  // 第一个标记之前的内容（书名、题记）并进第一章
  const chapters: { title: string; text: string }[] = [];
  let preamble = lines.slice(0, marks[0].index).join('\n').trim();
  marks.forEach((mark, at) => {
    const start = mark.index + 1;
    const end = at + 1 < marks.length ? marks[at + 1].index : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    const title = mark.title || `第 ${at + 1} 章`;
    chapters.push({ title, text: at === 0 && preamble ? `${preamble}\n\n${body}`.trim() : body });
    preamble = '';
  });
  return chapters.filter((chapter) => chapter.text.length > 0 || chapter.title);
}

/** 一条提议的内容指纹：用来判「拒绝过的不再出现」。 */
export function signatureOf(kind: string, key: string, quote: string): string {
  return hash(`${kind}|${key}|${quote}`);
}

const normalizeName = (value: string) => value.replace(/\s+/g, '').trim();

export type ImportDeps = {
  extractor?: ChapterExtractor;
  /** 单章花费的单价（每百万 token）；没配就只记用量、不估价。 */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  provider?: string;
  model?: string;
  now?: () => string;
};

function costOf(
  deps: ImportDeps,
  usage: { inputTokens: number | null; outputTokens: number | null },
): { value: number | null; known: boolean } {
  if (!deps.pricing) return { value: null, known: false };
  if (!Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens)) return { value: null, known: false };
  return {
    value:
      ((usage.inputTokens as number) * deps.pricing.inputPerMillion +
        (usage.outputTokens as number) * deps.pricing.outputPerMillion) /
      1_000_000,
    known: true,
  };
}

/** 抽取结果 → 提议。实体先、事件后、共指单独一条；不合格的整条丢掉。 */
export function proposalsFromChapter(input: {
  extraction: Extraction;
  work: WorkDocument;
  world: CreativeDocument;
  chapter: ImportChapter;
  batchId: string;
}): Proposal[] {
  const { extraction, world, chapter, batchId, work } = input;
  const proposals: Proposal[] = [];
  const prose = (text: string, fallback: string) => (text.trim() ? text.trim() : fallback);

  for (const entity of extraction.entities) {
    const existing = world.entities.find(
      (item) => item.name === entity.name || (item.aliases ?? []).includes(entity.name),
    );
    if (existing) {
      // 已经入账：只把新别名/新写法提出来，不重复建人。
      const extraAliases = entity.aliases.filter(
        (alias) => alias !== existing.name && !(existing.aliases ?? []).includes(alias),
      );
      if (!extraAliases.length) continue;
      proposals.push({
        id: randomUUID(),
        batchId,
        kind: 'entity',
        title: `${existing.name} 的另一个写法`,
        summary: `原文里的「${extraAliases.join('、')}」看着就是${existing.name}。`,
        ops: [{ op: 'entity.update', id: existing.id, patch: { aliases: [...(existing.aliases ?? []), ...extraAliases] } } as CreativeOp],
        origin: provenanceOf({
          workId: work.id,
          textVersion: chapter.textVersion,
          chapterId: chapter.chapterId,
          para: entity.para,
          sentence: entity.sentence,
          quote: entity.quote,
          basis: entity.basis,
          why: entity.doubt,
        }),
        doubts: entity.doubt ? [entity.doubt] : [],
        dependsOn: [],
        conflicts: [],
        status: 'pending',
        ...(entity.candidates?.length
          ? { candidates: entity.candidates.map((item) => ({ label: item.name, ops: [] as CreativeOp[], why: item.why })) }
          : {}),
      });
      continue;
    }
    const identity = entity.kind === 'place' ? 'site' : undefined;
    proposals.push({
      id: randomUUID(),
      batchId,
      kind: 'entity',
      title: `${entity.name}`,
      summary: prose(entity.summary ?? '', `原文里出现的${entity.kind === 'person' ? '人物' : entity.kind === 'place' ? '地点' : entity.kind === 'item' ? '物件' : '组织'}。`),
      ops: [
        {
          op: 'entity.add',
          entity: {
            kind: entity.kind,
            name: entity.name,
            aliases: entity.aliases,
            ...(entity.summary ? { summary: entity.summary } : {}),
            ...(identity
              ? { place: { level: 'site', parentId: null, geo: null, geoCertainty: 'unlocated', connects: [] } }
              : {}),
          },
        } as CreativeOp,
      ],
      origin: provenanceOf({
        workId: work.id,
        textVersion: chapter.textVersion,
        chapterId: chapter.chapterId,
        para: entity.para,
        sentence: entity.sentence,
        quote: entity.quote,
        basis: entity.basis,
        why: entity.doubt,
      }),
      doubts: entity.doubt ? [entity.doubt] : [],
      dependsOn: [],
      conflicts: [],
      status: 'pending',
      ...(entity.candidates?.length
        ? { candidates: entity.candidates.map((item) => ({ label: item.name, ops: [] as CreativeOp[], why: item.why })) }
        : {}),
    });
  }

  for (const event of extraction.events) {
    const calendarId = world.calendars.find((item) => item.kind === 'chinese_era')?.id ?? 'gregorian';
    const check = (input: string): { input: string; doubt?: string } => {
      if (!input.trim()) return { input: '未定' };
      const parsed = parseStoryTime(input, { calendars: world.calendars, events: [], defaultCalendar: calendarId });
      return parsed.ok ? { input } : { input: '未定', doubt: `时间写法「${input}」认不出来：${parsed.failure.message}` };
    };
    const start = check(event.start);
    const end = check(event.end || event.start);
    const doubts = [event.doubt, start.doubt, end.doubt].filter((item): item is string => Boolean(item));
    proposals.push({
      id: randomUUID(),
      batchId,
      kind: 'event',
      title: event.title,
      summary: prose(event.what, '原文里写到的一件事。'),
      ops: [
        {
          op: 'event.add',
          event: {
            title: event.title,
            what: prose(event.what, event.title),
            kind: event.kind,
            participants: event.participants.map((participant) => ({
              entityId: '',
              entityName: participant.name,
              as: participant.as,
            })),
            placeId: null,
            ...(event.place ? { placeName: event.place } : {}),
            travel: null,
            narrative: event.narrative,
            start: { input: start.input, calendar: calendarId },
            end: { input: end.input, calendar: calendarId },
          },
        } as unknown as CreativeOp,
      ],
      origin: provenanceOf({
        workId: work.id,
        textVersion: chapter.textVersion,
        chapterId: chapter.chapterId,
        para: event.para,
        sentence: event.sentence,
        quote: event.quote,
        basis: 'explicit',
        why: event.doubt,
      }),
      doubts,
      // 依赖同章里新建的实体（名字要能对上）
      dependsOn: [],
      conflicts: [],
      status: 'pending',
    });
  }

  // 同一批里新提的实体：共指直接并进它的别名，不必再提一张「他是谁」的卡。
  const batchEntities = new Map<string, Proposal>();
  for (const proposal of proposals) {
    if (proposal.kind !== 'entity') continue;
    const op = proposal.ops[0];
    if (!op || op.op !== 'entity.add') continue;
    batchEntities.set(op.entity.name, proposal);
    for (const alias of op.entity.aliases ?? []) batchEntities.set(alias, proposal);
  }

  for (const merge of extraction.merges) {
    const batchHit = merge.candidates.map((name) => batchEntities.get(name)).find(Boolean);
    if (batchHit) {
      const op = batchHit.ops[0];
      if (op && op.op === 'entity.add') {
        const aliases = new Set([...(op.entity.aliases ?? []), merge.name]);
        op.entity = { ...op.entity, aliases: [...aliases] };
      }
      continue;
    }
    const candidates = merge.candidates
      .map((name) => world.entities.find((item) => item.name === name || (item.aliases ?? []).includes(name)))
      .filter((entity): entity is CreativeDocument['entities'][number] => Boolean(entity));
    if (!candidates.length) continue;
    proposals.push({
      id: randomUUID(),
      batchId,
      kind: 'merge',
      title: `「${merge.name}」是谁`,
      summary: merge.why || `原文里的「${merge.name}」可能是下面这几个人之一。`,
      ops: [] as CreativeOp[],
      origin: provenanceOf({
        workId: work.id,
        textVersion: chapter.textVersion,
        chapterId: chapter.chapterId,
        para: merge.para,
        sentence: merge.sentence,
        quote: merge.quote,
        basis: 'inferred',
      }),
      doubts: [`原文用的是「${merge.name}」，共指不确定。`],
      dependsOn: [],
      conflicts: [],
      status: 'pending',
      candidates: candidates.map((entity) => ({
        label: entity.name,
        ops: [
          {
            op: 'entity.update',
            id: entity.id,
            patch: { aliases: [...(entity.aliases ?? []), merge.name] },
          } as CreativeOp,
        ],
        why: `把「${merge.name}」记成${entity.name}的别称。`,
      })),
    });
  }
  return proposals;
}

/** 把一个批次写进世界观账本（补去重：拒绝过的不再出现，除非原文改了）。 */
export function mergeProposals(
  world: CreativeDocument,
  proposals: Proposal[],
  textVersion: number,
): { world: CreativeDocument; added: Proposal[]; skipped: number } {
  const existing = new Set<string>();
  for (const proposal of world.proposals) {
    const source = proposal.origin?.source;
    const key = signatureOf(proposal.kind, clip(proposal.title, 80), clip(source?.quote ?? '', 200));
    if (proposal.status === 'rejected' && (source?.textVersion ?? -1) !== textVersion) continue;
    if (proposal.status === 'rejected' && (source?.textVersion ?? -1) === textVersion) existing.add(key);
    if (proposal.status === 'pending' || proposal.status === 'deferred' || proposal.status === 'accepted') existing.add(key);
  }
  const added: Proposal[] = [];
  let skipped = 0;
  for (const proposal of proposals) {
    const key = signatureOf(proposal.kind, clip(proposal.title, 80), clip(proposal.origin?.source?.quote ?? '', 200));
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    existing.add(key);
    added.push(proposal);
  }
  return {
    world: { ...world, proposals: [...world.proposals, ...added] },
    added,
    skipped,
  };
}

export const importJobOf = (document: ImportJobDocument): ImportJob => ({
  id: document.id,
  workId: document.workId,
  state: document.state,
  chapters: { total: document.total, done: document.done },
  proposals: document.proposals,
  current: document.current,
  error: document.error,
  cost: document.cost,
});

const JOB_KIND = 'import';

async function saveJob(
  client: pg.PoolClient,
  input: { account: string; dossier: string; workId: string },
  document: ImportJobDocument,
): Promise<void> {
  await client.query(
    `insert into creative_job(account_id,dossier_id,id,work_id,kind,state,document,updated_at)
     values($1,$2,$3,$4,$5,$6,$7::jsonb,now())
     on conflict (account_id,dossier_id,id)
     do update set state=excluded.state, document=excluded.document, updated_at=now()`,
    [input.account, input.dossier, document.id, input.workId, JOB_KIND, document.state, JSON.stringify(document)],
  );
}

export async function readImportJob(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  jobId: string,
): Promise<ImportJobDocument> {
  const row = (
    await client.query<{ document: ImportJobDocument; updated_at: Date }>(
      "select document, updated_at from creative_job where account_id=$1 and dossier_id=$2 and id=$3 and kind='import'",
      [account, dossier, jobId],
    )
  ).rows[0];
  if (!row) throw new ApiFailure('JOB_NOT_FOUND', 404, '找不到这个导入任务。');
  const job = row.document;
  // 上一个进程留下的「在跑 / 排队」不会再动了：改成暂停，作者点继续就能接着抽（1B）。
  if ((job.state === 'running' || job.state === 'queued') && row.updated_at.toISOString() < PROCESS_STARTED_AT) {
    job.state = 'paused';
    job.error = '任务中断（服务重启），可以继续。';
    job.current = null;
    await saveJob(client, { account, dossier, workId: job.workId }, job);
  }
  return job;
}

export type ChapterPreview = { index: number; title: string; chars: number; paragraphs: number; preview: string };

/**
 * 只分章、不抽取、不落库（1B 前端要的「先看分章结果再开始」）。
 * 和真正导入用的是同一个 splitChapters，切出来一定一致。
 */
export async function previewImport(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
  source: { text: string },
): Promise<{ chapters: ChapterPreview[] }> {
  await requireCreativeDossier(client, account, dossier);
  const exists = (
    await client.query('select 1 from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3', [
      account,
      dossier,
      workId,
    ])
  ).rowCount;
  if (!exists) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
  const chapters = splitChapters(source.text).map((chapter, index) => ({
    index,
    title: chapter.title,
    chars: Array.from(chapter.text.replace(/\s+/g, '')).length,
    paragraphs: chapter.text.split(/\n\s*\n/).filter((item) => item.trim()).length,
    preview: clip(chapter.text.replace(/\s+/g, ' ').trim(), 80),
  }));
  if (!chapters.length) throw new ApiFailure('IMPORT_EMPTY', 422, '这份原文是空的。');
  return { chapters };
}

/**
 * 开始导入：分章、把正文写进作品的章和场、建任务行。真正的抽取由 runImport 在事务外跑。
 */
export async function startImport(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
  source: { text: string; title?: string; assetId?: string },
  options: { baseRevision?: number } = {},
): Promise<{ job: ImportJobDocument; revision: number }> {
  await requireCreativeDossier(client, account, dossier);
  const workRow = (
    await client.query<{ revision: number; document: WorkDocument }>(
      'select revision, document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3 for update',
      [account, dossier, workId],
    )
  ).rows[0];
  if (!workRow) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
  if (options.baseRevision !== undefined && options.baseRevision >= 0 && options.baseRevision !== workRow.revision)
    throw new ApiFailure('REVISION_STALE', 409, '这部作品刚被改过，请按最新状态再来一次。', {
      revision: workRow.revision,
    });
  const chapters = splitChapters(source.text);
  if (!chapters.length) throw new ApiFailure('IMPORT_EMPTY', 422, '这份原文是空的。');
  const document: WorkDocument = workRow.document;
  // 导入进来的章：一章一场，正文就是这一章；已有的章保留，追加在后面。
  const next = { ...document, chapters: [...document.chapters] };
  const work: WorkDocument & { source?: Work['source'] } = {
    ...next,
    source: {
      kind: 'import',
      assetId: source.assetId ?? `text:${hash(source.text.slice(0, 4000))}`,
      title: source.title ?? document.title,
      textVersion: 1,
    },
  };
  const queue: ImportChapter[] = [];
  for (const chapter of chapters) {
    const outcome = applyWorkOps(work, [{ op: 'chapter.add', title: chapter.title }]);
    const chapterId = outcome.next.chapters[outcome.next.chapters.length - 1].id;
    const added = applyWorkOps(outcome.next, [{ op: 'scene.add', chapterId, title: chapter.title }]);
    const chapterAfter = added.next.chapters.find((item) => item.id === chapterId)!;
    const scene = chapterAfter.scenes[chapterAfter.scenes.length - 1];
    Object.assign(work, added.next);
    // 正文直接落进场景（导入的原文是作者的，不是 AI 生成的）
    const sceneRow = work.chapters.flatMap((item) => item.scenes).find((item) => item.id === scene.id)!;
    sceneRow.text = chapter.text;
    sceneRow.textVersion = 1;
    sceneRow.words = wordsOf(chapter.text);
    sceneRow.state = 'written';
    queue.push({ chapterId, title: chapter.title, text: chapter.text, textVersion: 1 });
  }
  const revision = workRow.revision + 1;
  await client.query(
    'update creative_work set revision=$4, document=$5::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2 and work_id=$3',
    [account, dossier, workId, revision, JSON.stringify(work)],
  );
  const job: ImportJobDocument = {
    id: randomUUID(),
    workId,
    state: 'queued',
    total: chapters.length,
    done: 0,
    proposals: 0,
    current: null,
    error: null,
    cost: { value: 0, known: true },
    queue,
  };
  // 导入建了章和场，事件引用关系跟着更新
  await syncWorkRefs(client, account, dossier);
  await saveJob(client, { account, dossier, workId }, job);
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.work', data: { workId, revision } },
    { type: 'creative.import', data: importJobOf(job) },
  ]);
  return { job, revision };
}

export async function setImportState(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  jobId: string,
  action: 'pause' | 'resume',
): Promise<ImportJobDocument> {
  const job = await readImportJob(client, account, dossier, jobId);
  if (action === 'pause') {
    if (job.state !== 'running' && job.state !== 'queued' && job.state !== 'paused')
      throw new ApiFailure('JOB_SETTLED', 409, '这个任务已经结束了。');
    // 最后一章已经抽完（队列空了）就没什么可暂停的：终态是 done。
    job.state = job.queue.length ? 'paused' : 'done';
    if (!job.queue.length) {
      job.error = null;
      job.current = null;
    }
  } else {
    if (job.state !== 'paused' && job.state !== 'failed' && job.state !== 'running')
      throw new ApiFailure('JOB_SETTLED', 409, '这个任务已经结束了。');
    if (!job.queue.length) {
      job.state = 'done';
      job.error = null;
      job.current = null;
    } else {
      job.state = 'queued';
      job.error = null;
    }
  }
  await saveJob(client, { account, dossier, workId: job.workId }, job);
  await appendEvents(client, { account, dossier }, [{ type: 'creative.import', data: importJobOf(job) }]);
  return job;
}

/**
 * 后台按章推进：一章一个事务（抽取结果 + 提议 + 进度一起提交），
 * 每章之间看一次状态，暂停/失败都停在能续做的地方。
 */
export async function runImport(
  database: import('../db/database').Database,
  account: string,
  dossier: string,
  jobId: string,
  deps: ImportDeps,
): Promise<void> {
  const extractor = deps.extractor;
  for (;;) {
    // 取下一章（同一个事务里改状态，避免两个 runner 抢同一章）
    const step = await database.withAccount(account, async (client) => {
      const job = await readImportJob(client, account, dossier, jobId);
      if (job.state === 'done' || job.state === 'failed') return { job, chapter: null };
      if (job.state === 'paused') {
        // 暂停发生在最后一章收尾之后：队列空了就是抽完了，终态改成 done。
        if (!job.queue.length) {
          job.state = 'done';
          job.current = null;
          await saveJob(client, { account, dossier, workId: job.workId }, job);
          await appendEvents(client, { account, dossier }, [{ type: 'creative.import', data: importJobOf(job) }]);
          return { job, chapter: null };
        }
        return { job, chapter: null };
      }
      if (!job.queue.length) {
        job.state = 'done';
        job.current = null;
        await saveJob(client, { account, dossier, workId: job.workId }, job);
        await appendEvents(client, { account, dossier }, [{ type: 'creative.import', data: importJobOf(job) }]);
        return { job, chapter: null };
      }
      job.state = 'running';
      job.current = { chapterId: job.queue[0].chapterId, title: job.queue[0].title };
      await saveJob(client, { account, dossier, workId: job.workId }, job);
      return { job, chapter: job.queue[0] };
    });
    if (!step.chapter) return;
    if (!extractor) {
      await database.withAccount(account, async (client) => {
        const job = await readImportJob(client, account, dossier, jobId);
        job.state = 'failed';
        job.error = '本机没配置抽取模型，导入先停下。';
        await saveJob(client, { account, dossier, workId: job.workId }, job);
        await appendEvents(client, { account, dossier }, [{ type: 'creative.import', data: importJobOf(job) }]);
      });
      return;
    }
    try {
      const world = await database.withAccount(account, async (client) => (await loadWorld(client, account, dossier)).document);
      const workRow = await database.withAccount(account, async (client) => (
        await client.query<{ document: WorkDocument }>(
          'select document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
          [account, dossier, step.job.workId],
        )
      ).rows[0]?.document);
      if (!workRow) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
      // 一章可能有两三千字：分块抽，段号按块偏移接上，出处的段落不会错位。
      const chunks = splitIntoChunks(step.chapter.text, 3000);
      const merged: Extraction = { entities: [], events: [], merges: [] };
      const usageTotal = { inputTokens: 0 as number | null, outputTokens: 0 as number | null };
      for (const chunk of chunks) {
        const result = await extractor({
          chapterTitle: step.chapter.title,
          text: chunk.text,
          known: world.entities.map((item) => ({ name: item.name, kind: item.kind })),
          calendarHint: `可用历法：${world.calendars.map((item) => `${item.name}（${item.kind}）`).join('、')}`,
        });
        for (const entity of result.extraction.entities)
          merged.entities.push({ ...entity, para: entity.para + chunk.paraOffset });
        for (const event of result.extraction.events)
          merged.events.push({ ...event, para: event.para + chunk.paraOffset });
        for (const merge of result.extraction.merges)
          merged.merges.push({ ...merge, para: merge.para + chunk.paraOffset });
        usageTotal.inputTokens =
          usageTotal.inputTokens === null || result.usage.inputTokens === null
            ? null
            : usageTotal.inputTokens + result.usage.inputTokens;
        usageTotal.outputTokens =
          usageTotal.outputTokens === null || result.usage.outputTokens === null
            ? null
            : usageTotal.outputTokens + result.usage.outputTokens;
      }
      const result = { extraction: merged, usage: usageTotal };
      const batchId = `import_${step.chapter.chapterId}`;
      const proposals = proposalsFromChapter({
        extraction: result.extraction,
        work: workRow,
        world,
        chapter: step.chapter,
        batchId,
      });
      const cost = costOf(deps, result.usage);
      await database.withAccount(account, async (client) => {
        const state = await loadWorld(client, account, dossier, { lock: true });
        const merged = mergeProposals(state.document, proposals, step.chapter!.textVersion);
        const usage = merged.world.usage;
        const nextUsage =
          cost.known && cost.value !== null && usage.value !== null
            ? { value: Number((usage.value + cost.value).toFixed(6)), known: true }
            : { value: usage.value, known: usage.known && cost.known };
        const revision = state.revision + 1;
        const worldNext = { ...merged.world, usage: nextUsage };
        await client.query(
          'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
          [account, dossier, revision, JSON.stringify(worldNext)],
        );
        const job = await readImportJob(client, account, dossier, jobId);
        job.queue = job.queue.filter((item) => item.chapterId !== step.chapter!.chapterId);
        job.done += 1;
        // 最后一章抽完：即使中途被暂停过，终态也是 done（不然会停在「2/2 · paused」）。
        if (!job.queue.length) job.state = 'done';
        job.proposals += merged.added.length;
        job.current = null;
        job.cost =
          cost.known && cost.value !== null
            ? { value: Number((job.cost.value !== null ? job.cost.value + cost.value : cost.value).toFixed(6)), known: true }
            : { value: job.cost.value, known: job.cost.known && cost.known };
        await saveJob(client, { account, dossier, workId: job.workId }, job);
        await appendEvents(client, { account, dossier }, [
          ...(merged.added.length
            ? [{ type: 'creative.proposal', data: { batchId, added: merged.added.length, proposals: merged.added } }]
            : []),
          { type: 'creative.import', data: importJobOf(job) },
          ...(cost.known && cost.value !== null
            ? [{ type: 'creative.usage', data: { cost: nextUsage } }]
            : []),
        ]);
        if (deps.provider && deps.model)
          await client.query(
            `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose)
             values(gen_random_uuid(),$1,$2,null,$3,$4,$5,$6,$7,null,null,$8,'creative_import')`,
            [
              account,
              dossier,
              deps.provider,
              deps.model,
              cost.known,
              cost.known ? result.usage.inputTokens : null,
              cost.known ? result.usage.outputTokens : null,
              cost.known && cost.value !== null ? cost.value.toFixed(6) : null,
            ],
          );
      });
    } catch (error) {
      const failure = error instanceof ApiFailure ? error.message : String((error as Error)?.message ?? error);
      await database.withAccount(account, async (client) => {
        const job = await readImportJob(client, account, dossier, jobId);
        job.state = 'failed';
        job.error = clip(failure, 300);
        job.current = null;
        await saveJob(client, { account, dossier, workId: job.workId }, job);
        await appendEvents(client, { account, dossier }, [{ type: 'creative.import', data: importJobOf(job) }]);
      });
      return;
    }
  }
}

export { CHINESE_ERA };
