/**
 * 设定顾问 / 写作助手的会话（1B 契约 §5.2「助手」）。
 *
 * 契约说它走 `POST /v1/kernel/runs { mode:'creative_advisor'|'creative_writer' }`。
 * 这一批不把它塞进内核容器（那要新 mode / role / 插件 / 重建账户镜像），而是在控制面里跑，
 * 但**沿用同一张 run 和事件流**：页面按 runId 订阅 `/v1/kernel/runs/:id/stream` 就能看到对话。
 * 助手只产出提议，不落笔。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiFailure } from '../api/errors';
import { appendEvent } from '../ledger';
import { advise, type AdvisorDeps } from './advisor';
import { loadWorld } from './service';
import { runGenerate, startGenerate, type WriterDeps } from './writer';
import { runTurn } from './assistant-session';

export type CreativeMode = 'creative_advisor' | 'creative_writer';

export type CreativeRunDeps = {
  db: import('../db/database').Database;
  advisor?: AdvisorDeps;
  writer?: WriterDeps;
  chat?: import('./assistant-session').ChatDeps;
};

const ROLE = 'bench-assist';

/** 建一条运行；真正的回答在事务外跑（页面先拿到 runId，再去订阅事件）。 */
export async function createCreativeRun(
  client: pg.PoolClient,
  account: string,
  input: { dossierId: string; mode: CreativeMode; query: string; workId?: string; sceneId?: string },
): Promise<string> {
  const dossier = (
    await client.query('select bench from dossier where id=$1 and account_id=$2', [input.dossierId, account])
  ).rows[0];
  if (!dossier) throw new ApiFailure('DOSSIER_NOT_FOUND', 404, '档案不存在。');
  if (dossier.bench !== 'creative')
    throw new ApiFailure('BENCH_UNSUPPORTED', 400, '只有创作台档案能开设定顾问 / 写作助手。');
  const runId = randomUUID();
  await client.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,$4,'creative',$5,'queued',1,$6)`,
    [
      runId,
      account,
      input.dossierId,
      ROLE,
      randomUUID(),
      JSON.stringify({
        query: input.query,
        creativeMode: input.mode,
        ...(input.workId ? { workId: input.workId } : {}),
        ...(input.sceneId ? { sceneId: input.sceneId } : {}),
      }),
    ],
  );
  return runId;
}

const say = async (
  client: pg.PoolClient,
  account: string,
  input: { dossierId: string; runId: string; who: 'user' | 'assistant'; text: string; key: string },
): Promise<void> => {
  await appendEvent(client, account, {
    dossierId: input.dossierId,
    runId: input.runId,
    roleId: ROLE,
    kind: 'message',
    action: `${input.who}/message`,
    risk: 'read',
    payload: { message: { id: `${input.runId}:${input.key}`, role: input.who, content: [{ type: 'text', text: input.text }] } },
    dedupeKey: `creative-run:${input.runId}:${input.key}`,
  });
};

/** 跑一条创作台会话：先落用户那句话，再跑顾问/写作助手，最后落回复并收尾。 */
export async function runCreativeSession(
  deps: CreativeRunDeps,
  account: string,
  runId: string,
): Promise<void> {
  // 29 号之后走 assistant-session（多轮 + 工具 + Markdown）；老路径保留给「直接调 /advisor」的页面。
  const query = await deps.db.withAccount(account, async (client) => {
    const row = (
      await client.query<{ input: Record<string, string> }>(
        'select input from run where account_id=$1 and id=$2',
        [account, runId],
      )
    ).rows[0];
    return String(row?.input.query ?? '');
  });
  await runTurn({ db: deps.db, ...(deps.chat ? { chat: deps.chat } : {}) }, account, runId, query);
}

async function legacySession(
  deps: CreativeRunDeps,
  account: string,
  runId: string,
): Promise<void> {
  const run = await deps.db.withAccount(account, async (client) => {
    const row = (
      await client.query<{ dossier_id: string; input: Record<string, string> }>(
        'select dossier_id, input from run where account_id=$1 and id=$2',
        [account, runId],
      )
    ).rows[0];
    if (!row) throw new ApiFailure('RUN_NOT_FOUND', 404, '运行不存在。');
    await client.query("update run set state='running' where account_id=$1 and id=$2", [account, runId]);
    return row;
  });
  const dossierId = run.dossier_id;
  const query = String(run.input.query ?? '');
  const mode = (run.input.creativeMode === 'creative_writer' ? 'creative_writer' : 'creative_advisor') as CreativeMode;
  await deps.db.withAccount(account, (client) =>
    say(client, account, { dossierId, runId, who: 'user', text: query, key: 'user' }),
  );

  try {
    if (mode === 'creative_advisor') {
      const result = await deps.db.withAccount(account, (client) =>
        advise(client, account, dossierId, deps.advisor ?? {}, query, run.input.workId ? { workId: run.input.workId } : {}),
      );
      if (!result.proposals.length) {
        // 模型按底线提不出设定：照实回答，不把这次会话记成失败。
        const declined = result.declined ?? '这一步没有能入账的设定。';
        await deps.db.withAccount(account, (client) =>
          say(client, account, {
            dossierId,
            runId,
            who: 'assistant',
            text: `${declined}\n\n这次没有生成提议。要入账的话，请先补上能站得住的原文明写或作者设定。`,
            key: 'reply',
          }),
        );
        await deps.db.withAccount(account, async (client) => {
          await client.query("update run set state='completed', ended_at=now() where account_id=$1 and id=$2", [account, runId]);
        });
        return;
      }
      const proposal = result.proposals[0];
      const lines = [
        proposal.summary || proposal.title,
        proposal.doubts.length ? `还不确定的：${proposal.doubts.join('；')}` : '',
        proposal.conflicts.length
          ? `先跑了一遍硬检查：${proposal.conflicts.map((item) => `${item.severity === 'hard' ? '红' : '黄'}·${item.why}`).join('；')}`
          : '硬检查没发现这一条本身带来的新冲突。',
        '这条还是提议，你在待确认里点接受才入账。',
      ].filter(Boolean);
      await deps.db.withAccount(account, (client) =>
        say(client, account, { dossierId, runId, who: 'assistant', text: lines.join('\n\n'), key: 'reply' }),
      );
    } else {
      const sceneId = String(run.input.sceneId ?? '');
      const workId = String(run.input.workId ?? '');
      if (!workId || !sceneId) throw new ApiFailure('INVALID_INPUT', 400, '写作助手要指定作品和场景。');
      // 复用「按场生成」那条路：建任务 → 跑完 → 这条提议在待确认里，作者接受才落笔。
      const job = await deps.db.withAccount(account, (client) =>
        startGenerate(client, account, dossierId, workId, { sceneIds: [sceneId], mode: 'draft', hint: query }),
      );
      await runGenerate(deps.db, deps.writer ?? {}, account, dossierId, job.id);
      const draft = await deps.db.withAccount(account, async (client) => {
        const world = await loadWorld(client, account, dossierId);
        const proposal = world.document.proposals.find(
          (item) => item.batchId === `generate_${job.id}` && item.kind === 'text_edit',
        ) as { title?: string; summary?: string; ops?: { after?: string }[] } | undefined;
        return {
          title: proposal?.title ?? '这一场',
          why: proposal?.summary ?? '',
          words: (proposal?.ops?.[0]?.after ?? '').replace(/\s+/g, '').length,
        };
      });
      const lines = [
        `「${draft.title}」写了一稿（${draft.words} 字），放在待确认里，接受才写进正文。`,
        draft.why ? `处理方式：${draft.why}` : '',
      ].filter(Boolean);
      await deps.db.withAccount(account, (client) =>
        say(client, account, { dossierId, runId, who: 'assistant', text: lines.join('\n\n'), key: 'reply' }),
      );
    }
    await deps.db.withAccount(account, async (client) => {
      await client.query("update run set state='completed', ended_at=now() where account_id=$1 and id=$2", [account, runId]);
    });
  } catch (error) {
    const message = error instanceof ApiFailure ? error.message : String((error as Error)?.message ?? error);
    await deps.db
      .withAccount(account, async (client) => {
        await say(client, account, { dossierId, runId, who: 'assistant', text: `这一步没成：${message.slice(0, 300)}`, key: 'error' });
        await client.query("update run set state='failed', ended_at=now() where account_id=$1 and id=$2", [account, runId]);
      })
      .catch(() => undefined);
  }
}
