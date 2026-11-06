/**
 * 写作助手（1B 契约 §5.2「生成」）：按场景写，逐场保存，能停。
 *
 * 底线（19 §6、§8）：只按作者给的场景目标和已有设定写；不知道的就写不知道，不编设定；
 * 产出是提议（`text_edit` + 差异），作者接受才落笔；连续生成时逐场保存，随时能停。
 * 状态和进度记在任务上（creative.generate），页面按事件刷新。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CreativeCny as Cny, GenerateJob, Proposal } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvents } from './events';
import { PROCESS_STARTED_AT, loadWorld } from './service';
import { callStructured, extractJson, type ModelDeps } from './model-call';
import { clip } from './text';
import { applyWorkOps, sceneOf, wordsOf, type WorkDocument } from './work';
import { paragraphsOf } from './work';
import type { CreativeDocument } from './world';

export type GenerateJobDocument = {
  id: string;
  workId: string;
  state: GenerateJob['state'];
  sceneIds: string[];
  done: string[];
  mode: 'draft' | 'continue' | 'complete' | 'rewrite';
  hint?: string;
  range?: { para: number; from: number; to: number };
  error: string | null;
  cost: Cny;
};

const SYSTEM = `你在给一部小说写正文。用户给你这一场的目标、相关设定和前后文。

只输出 JSON：{"text":"正文","why":"这一稿怎么处理的（人话）"}
- 正文直接写，不要标题、不要解释、不要 markdown。
- 只写这一场：不要替下一场收尾，也不要跳到别的时间线。
- 只用给你的设定和原文里已经写到的信息。设定里没有的地点、人物、时间不要编；非写不可时写得更含糊，并在 why 里说明。
- 叙述性质要跟原文一致：原文是回忆、传闻就别写成正在发生。
- 中文正文，段落之间空一行。`;

export type WriterDeps = {
  model?: ModelDeps;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  provider?: string;
  now?: () => string;
};

/** 改写范围在正文里的原话：按「第几段 + 段内起止」取，取不到就空（那就按续写处理）。 */
export function rangeTextOf(
  text: string,
  range: { para: number; from: number; to: number } | undefined,
): string {
  if (!range) return '';
  const paragraphs = paragraphsOf(text);
  const paragraph = paragraphs[range.para];
  if (paragraph === undefined) return '';
  return paragraph.slice(range.from, range.to);
}

const costOf = (
  deps: WriterDeps,
  usage: { inputTokens: number | null; outputTokens: number | null },
): Cny => {
  if (!deps.pricing) return { value: null, known: false };
  if (!Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens)) return { value: null, known: false };
  return {
    value:
      ((usage.inputTokens as number) * deps.pricing.inputPerMillion +
        (usage.outputTokens as number) * deps.pricing.outputPerMillion) /
      1_000_000,
    known: true,
  };
};

const saveJob = async (
  client: pg.PoolClient,
  input: { account: string; dossier: string; workId: string },
  document: GenerateJobDocument,
): Promise<void> => {
  await client.query(
    `insert into creative_job(account_id,dossier_id,id,work_id,kind,state,document,updated_at)
     values($1,$2,$3,$4,'generate',$5,$6::jsonb,now())
     on conflict (account_id,dossier_id,id)
     do update set state=excluded.state, document=excluded.document, updated_at=now()`,
    [input.account, input.dossier, document.id, input.workId, document.state, JSON.stringify(document)],
  );
};

export const generateJobOf = (document: GenerateJobDocument): GenerateJob => ({
  id: document.id,
  workId: document.workId,
  sceneIds: document.sceneIds,
  done: document.done,
  state: document.state,
  error: document.error,
  cost: document.cost,
});

export async function readGenerateJob(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  jobId: string,
): Promise<GenerateJobDocument> {
  const row = (
    await client.query<{ document: GenerateJobDocument; updated_at: Date }>(
      "select document, updated_at from creative_job where account_id=$1 and dossier_id=$2 and id=$3 and kind='generate'",
      [account, dossier, jobId],
    )
  ).rows[0];
  if (!row) throw new ApiFailure('JOB_NOT_FOUND', 404, '找不到这个生成任务。');
  const job = row.document;
  // 上一个进程留下的「在跑」不会再动了：标成失败，页面重新发起就行（已落库的场不受影响）。
  if (job.state === 'running' && row.updated_at.toISOString() < PROCESS_STARTED_AT) {
    job.state = 'failed';
    job.error = '生成中断（服务重启），可以重新发起。';
    await saveJob(client, { account, dossier, workId: job.workId }, job);
  }
  return job;
}

export async function startGenerate(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
  input: {
    sceneIds: string[];
    mode: GenerateJobDocument['mode'];
    hint?: string;
    range?: { para: number; from: number; to: number };
  },
): Promise<GenerateJobDocument> {
  const work = (
    await client.query<{ document: WorkDocument }>(
      'select document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
      [account, dossier, workId],
    )
  ).rows[0]?.document;
  if (!work) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
  if (!work.outline || work.outline.state !== 'confirmed')
    throw new ApiFailure('OUTLINE_NOT_CONFIRMED', 409, '大纲还没确认，先把大纲定下来再写。');
  for (const sceneId of input.sceneIds) {
    const { scene } = sceneOf(work, sceneId);
    if (input.mode === 'rewrite' && !input.range && !scene.text.trim())
      throw new ApiFailure('INVALID_INPUT', 400, '这一场还没有正文，改写要给出范围或先用起稿。');
  }
  const job: GenerateJobDocument = {
    id: randomUUID(),
    workId,
    state: 'running',
    sceneIds: input.sceneIds,
    done: [],
    mode: input.mode,
    ...(input.hint ? { hint: input.hint } : {}),
    ...(input.range ? { range: input.range } : {}),
    error: null,
    cost: { value: 0, known: true },
  };
  await saveJob(client, { account, dossier, workId }, job);
  await appendEvents(client, { account, dossier }, [{ type: 'creative.generate', data: generateJobOf(job) }]);
  return job;
}

/** 给这一场的写作上下文：目标、引用事件、相关实体、前后各一场的结尾/开头。 */
export function sceneContext(work: WorkDocument, world: CreativeDocument, sceneId: string): string {
  const { scene, chapter } = sceneOf(work, sceneId);
  const flat = work.chapters.flatMap((item) => item.scenes.map((entry) => ({ chapter: item, scene: entry })));
  const index = flat.findIndex((item) => item.scene.id === sceneId);
  const previous = index > 0 ? flat[index - 1] : null;
  const next = index >= 0 && index + 1 < flat.length ? flat[index + 1] : null;
  const related = world.events.filter((event) => scene.eventIds.includes(event.id));
  const people = new Set<string>();
  for (const event of related) for (const participant of event.participants) if (participant.entityId) people.add(participant.entityId);
  const outline = work.outline;
  return [
    `作品：${work.title}`,
    outline ? `主线：${outline.logline}；视角：${outline.pov}；结局方向：${outline.ending}` : '',
    `本章：第 ${chapter.no} 章 ${chapter.title}`,
    `本场：${scene.title}｜目标：${scene.goal || '（作者没写）'}｜目标字数：${scene.targetWords ?? work.targetWords ?? '未定'}`,
    related.length
      ? `本场引用的事件：${related
          .map(
            (event) =>
              `${event.title}（${event.start.label}–${event.end.label}，${
                event.placeId ? world.entities.find((item) => item.id === event.placeId)?.name ?? '地点未知' : '地点未定'
              }，${event.narrative}）`,
          )
          .join('；')}`
      : '本场没有引用事件：按目标写，别自己造大事件。',
    people.size
      ? `出场人物与地点：${[...people]
          .map((id) => world.entities.find((item) => item.id === id))
          .filter(Boolean)
          .map((entity) => `${entity!.name}${entity!.summary ? `（${entity!.summary}）` : ''}`)
          .join('；')}`
      : '',
    previous ? `前一场（${previous.scene.title}）结尾：${clip(previous.scene.text.slice(-300), 300) || '（空的）'}` : '',
    next ? `后一场（${next.scene.title}）目标：${next.scene.goal || '（作者没写）'}` : '',
    scene.text.trim() ? `本场已有正文（续写/改写要在它的基础上）：\n${clip(scene.text, 4000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 跑一个生成任务：一场一次事务；场与场之间看状态，停了就停在能续做的地方。 */
export async function runGenerate(
  database: import('../db/database').Database,
  deps: WriterDeps,
  account: string,
  dossier: string,
  jobId: string,
): Promise<void> {
  if (!deps.model) {
    await database.withAccount(account, async (client) => {
      const job = await readGenerateJob(client, account, dossier, jobId);
      job.state = 'failed';
      job.error = '本机没配置模型 key，生成开不了。';
      await saveJob(client, { account, dossier, workId: job.workId }, job);
      await appendEvents(client, { account, dossier }, [{ type: 'creative.generate', data: generateJobOf(job) }]);
    });
    return;
  }
  for (;;) {
    const step = await database.withAccount(account, async (client) => {
      const job = await readGenerateJob(client, account, dossier, jobId);
      if (job.state === 'stopped' || job.state === 'failed' || job.state === 'done') return null;
      const pending = job.sceneIds.find((id) => !job.done.includes(id));
      if (!pending) {
        job.state = 'done';
        await saveJob(client, { account, dossier, workId: job.workId }, job);
        await appendEvents(client, { account, dossier }, [{ type: 'creative.generate', data: generateJobOf(job) }]);
        return null;
      }
      return { job, sceneId: pending };
    });
    if (!step) return;
    const { job, sceneId } = step;
    try {
      const loaded = await database.withAccount(account, async (client) => {
        const world = await loadWorld(client, account, dossier);
        const work = (
          await client.query<{ document: WorkDocument }>(
            'select document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
            [account, dossier, job.workId],
          )
        ).rows[0]?.document;
        if (!work) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
        return { world: world.document, work, revision: (await client.query<{ revision: number }>(
          'select revision from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
          [account, dossier, job.workId],
        )).rows[0]?.revision ?? 1 };
      });
      const { scene } = sceneOf(loaded.work, sceneId);
      const prompt = [
        sceneContext(loaded.work, loaded.world, sceneId),
        job.mode === 'continue' ? '接在本场正文末尾续写。' : '',
        job.mode === 'complete' ? '把本场补完整（对着目标字数）。' : '',
        job.mode === 'rewrite' ? `改写这一段（第 ${job.range?.para ?? 0} 段 ${job.range?.from ?? 0}–${job.range?.to ?? 0}）。` : '',
        job.mode === 'draft' ? '本场还没有正文，起一稿。' : '',
        job.hint ? `作者的要求：${job.hint}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      // 先告诉页面「这一场在写」，逐场可见（正文还不落笔）
      await database.withAccount(account, async (client) => {
        await appendEvents(client, { account, dossier }, [
          { type: 'creative.text', data: { workId: job.workId, sceneId, state: 'generating', textVersion: scene.textVersion } },
        ]);
      });
      const result = await callStructured(deps.model, { system: SYSTEM, prompt });
      const parsed = extractJson(result.text) as { text?: unknown; why?: unknown } | null;
      const body = clip(parsed?.text ?? '', 200_000).trim();
      if (!body) throw new ApiFailure('GENERATE_EMPTY', 503, '模型没有给出正文。');
      const why = clip(parsed?.why ?? '', 500);
      // 改写要给出被替换的那一段原话，接受时才能准确替换（不是拿整场的前 400 字顶替）。
      const before = job.mode === 'rewrite' ? rangeTextOf(scene.text, job.range) : '';
      const cost = costOf(deps, result.usage);
      await database.withAccount(account, async (client) => {
        const work = (
          await client.query<{ revision: number; document: WorkDocument }>(
            'select revision, document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3 for update',
            [account, dossier, job.workId],
          )
        ).rows[0];
        if (!work) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
        const { scene: target } = sceneOf(work.document, sceneId);
        const text = job.mode === 'rewrite' ? body : job.mode === 'continue' ? `${target.text.trim()}\n\n${body}`.trim() : body;
        const proposal: Proposal = {
          id: randomUUID(),
          batchId: `generate_${job.id}`,
          kind: 'text_edit',
          title: `${target.title}：${job.mode === 'rewrite' ? '改写' : job.mode === 'continue' ? '续写' : job.mode === 'complete' ? '补全' : '起稿'}`,
          summary: why || clip(body, 200),
          ops: [
            {
              op: 'text.set',
              workId: job.workId,
              sceneId,
              baseTextVersion: target.textVersion,
              mode: job.mode,
              range: job.range ?? null,
              before,
              after: text,
            },
          ] as unknown as Proposal['ops'],
          origin: { basis: 'inferred', by: 'writer', why: why || '按本场目标生成' },
          doubts: [],
          dependsOn: [],
          conflicts: [],
          status: 'pending',
        };
        // 空场景起稿且作者开了 autoAcceptDraft：直接落成草稿，但仍走提议（可撤回）
        const autoAccept = job.mode === 'draft' && !target.text.trim() && work.document.autoAcceptDraft === true;
        const state = await loadWorld(client, account, dossier, { lock: true });
        const nextWorld: CreativeDocument = {
          ...state.document,
          proposals: [...state.document.proposals, autoAccept ? { ...proposal, status: 'accepted' as const } : proposal],
          usage:
            cost.known && cost.value !== null && state.document.usage.value !== null
              ? { value: Number((state.document.usage.value + cost.value).toFixed(6)), known: true }
              : { value: state.document.usage.value, known: state.document.usage.known && cost.known },
        };
        const worldRevision = state.revision + 1;
        await client.query(
          'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
          [account, dossier, worldRevision, JSON.stringify(nextWorld)],
        );
        let sceneState: 'generating' | 'draft' | 'written' = 'draft';
        if (autoAccept) {
          const applied = applyWorkOps(work.document, [
            { op: 'text.set', sceneId, baseTextVersion: target.textVersion, text },
          ]);
          sceneState = 'written';
          await client.query(
            'update creative_work set revision=$4, document=$5::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2 and work_id=$3',
            [account, dossier, job.workId, work.revision + 1, JSON.stringify(applied.next)],
          );
        }
        const nextJob: GenerateJobDocument = {
          ...job,
          done: [...job.done, sceneId],
          cost:
            cost.known && cost.value !== null
              ? { value: Number(((job.cost.value ?? 0) + cost.value).toFixed(6)), known: true }
              : { value: job.cost.value, known: job.cost.known && cost.known },
          error: null,
        };
        await saveJob(client, { account, dossier, workId: job.workId }, nextJob);
        await appendEvents(client, { account, dossier }, [
          { type: 'creative.proposal', data: proposal },
          { type: 'creative.text', data: { workId: job.workId, sceneId, state: sceneState, textVersion: target.textVersion } },
          { type: 'creative.generate', data: generateJobOf(nextJob) },
          { type: 'creative.usage', data: { cost: nextWorld.usage } },
        ]);
        await client.query(
          `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose)
           values(gen_random_uuid(),$1,$2,null,$3,$4,$5,$6,$7,null,null,$8,'creative_generate')`,
          [
            account,
            dossier,
            deps.provider ?? 'deepseek-official',
            deps.model!.model,
            cost.known,
            cost.known ? result.usage.inputTokens : null,
            cost.known ? result.usage.outputTokens : null,
            cost.known && cost.value !== null ? cost.value.toFixed(6) : null,
          ],
        );
        void paragraphsOf;
        void wordsOf;
        void loaded.revision;
      });
    } catch (error) {
      const failure = error instanceof ApiFailure ? error.message : String((error as Error)?.message ?? error);
      await database.withAccount(account, async (client) => {
        const jobNow = await readGenerateJob(client, account, dossier, jobId);
        jobNow.state = 'failed';
        jobNow.error = clip(failure, 300);
        await saveJob(client, { account, dossier, workId: jobNow.workId }, jobNow);
        await appendEvents(client, { account, dossier }, [{ type: 'creative.generate', data: generateJobOf(jobNow) }]);
      });
      return;
    }
  }
}

export async function stopGenerate(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  jobId: string,
): Promise<GenerateJobDocument> {
  const job = await readGenerateJob(client, account, dossier, jobId);
  if (job.state === 'running') job.state = 'stopped';
  await saveJob(client, { account, dossier, workId: job.workId }, job);
  await appendEvents(client, { account, dossier }, [{ type: 'creative.generate', data: generateJobOf(job) }]);
  return job;
}
