/**
 * 建 1B 的验收内容（试用账户）：一部原创短篇（真生成两场）+ 一部导入的《聊斋》选篇。
 *
 * 走页面同一条 HTTP 路径：登录 → 找/建世界观 → 建作品 → 大纲 → 生成 → 接受提议；
 * 导入篇先传原文（assetId）再导入，等抽取跑完。
 *
 * 用法：pnpm tsx tooling/creative/seed-1b.ts [--world <dossierId>]
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CONTROL = process.env.REINLAB_CONTROL_URL?.replace(/\/+$/, '') ?? 'http://127.0.0.1:3001';
const env: Record<string, string> = {};
for (const line of readFileSync(path.join(homedir(), '.local/state/reinlab/803a04fcd69a/verification-users.env'), 'utf8').split('\n')) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const headers = (extra: Record<string, string> = {}) => ({
  Origin: CONTROL,
  'Content-Type': 'application/json',
  'X-ReinLab-CSRF': '1',
  ...extra,
});

const login = await fetch(`${CONTROL}/auth/login`, {
  method: 'POST',
  headers: headers(),
  body: JSON.stringify({ email: env.B_EMAIL, password: env.B_PASSWORD }),
});
const cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).find((item) => item.startsWith('rl_session='))!;

const call = async (pathname: string, init: RequestInit = {}) => {
  const response = await fetch(`${CONTROL}${pathname}`, {
    ...init,
    headers: headers({ Cookie: cookie, ...(init.headers ?? {}) }),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} → ${response.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
};
const post = (pathname: string, body: unknown) =>
  call(pathname, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });

/** 找 1A 那份世界观（没有就新建一个）。 */
const args = process.argv.slice(2);
const explicit = args.includes('--world') ? args[args.indexOf('--world') + 1] : null;
const dossiers = await call('/v1/dossiers?bench=creative');
const world =
  (explicit && dossiers.items.find((item: any) => item.id === explicit)) ??
  dossiers.items.find((item: any) => String(item.title).includes('阊门到山村'));
if (!world) throw new Error('没找到 1A 的世界观，先跑 seed-world.ts，或用 --world 指定。');
const dossierId = world.id as string;
console.log(`世界观：${dossierId}《${world.title}》`);

const snapshot = await call(`/v1/creative/worlds/${dossierId}`);
const events = snapshot.events as any[];
const eventByName = (title: string) => events.find((item) => item.title === title);

// ── 作品一：原创短篇，真生成两场 ──
const workA = await post(`/v1/creative/worlds/${dossierId}/works`, {
  kind: 'novel',
  title: '阊门夜行（原创短篇）',
  targetWords: 8000,
});
console.log(`作品一 ${workA.id}《${workA.title}》锁定版本 v${workA.baseVersion}`);

const outline = await post(`/v1/creative/worlds/${dossierId}/works/${workA.id}/ops`, {
  baseRevision: workA.revision,
  ops: [
    {
      op: 'outline.set',
      outline: {
        logline: '落第书生沈砚替人送一封急信，从阊门夜行到支硎山下的村子，天亮前必须送到。',
        pov: '第三人称限制（沈砚）',
        ending: '信送到了，他没能回来。',
        chapters: [
          {
            id: 'ch-1',
            title: '出城',
            scenes: [
              {
                id: 'sc-1',
                title: '阊门',
                goal: '沈砚在闭门前出城，遇到客栈掌柜顾嬷嬷的嘱咐',
                eventIds: [eventByName('出阊门')?.id].filter(Boolean),
                targetWords: 1800,
              },
              {
                id: 'sc-2',
                title: '夜路',
                goal: '走古道进山，路上想起白天听到的传闻',
                eventIds: [eventByName('到山村')?.id].filter(Boolean),
                targetWords: 2200,
              },
            ],
          },
        ],
      },
    },
    { op: 'outline.confirm' },
  ],
});
const sceneIds = outline.work.chapters[0].scenes.map((scene: any) => scene.id);
console.log(`大纲已确认，两场：${outline.work.chapters[0].scenes.map((scene: any) => scene.title).join(' / ')}`);

const written: { sceneId: string; words: number; accepted: boolean }[] = [];
for (const sceneId of sceneIds) {
  const current = await call(`/v1/creative/worlds/${dossierId}/works/${workA.id}`);
  const job = await post(`/v1/creative/worlds/${dossierId}/works/${workA.id}/generate`, {
    sceneIds: [sceneId],
    mode: 'draft',
    hint: sceneId === sceneIds[0] ? '开场要有雨、有更鼓声，结尾落在出城那一刻。' : '夜路一段，写湿冷的山道和心里的犹疑，不要出现新的设定。',
  });
  let state = job.state;
  for (let index = 0; index < 900 && (state === 'running' || state === 'stopped'); index += 1) {
    await new Promise((done) => setTimeout(done, 1000));
    state = (await call(`/v1/creative/worlds/${dossierId}/generate/${job.id}`)).state;
  }
  if (state !== 'done') {
    console.log(`  场景生成没跑完（${state}），记下原因继续`);
    continue;
  }
  const proposals = await call(`/v1/creative/worlds/${dossierId}/proposals?kind=text_edit&limit=50`);
  const proposal = (proposals.proposals as any[]).find(
    (item) => item.ops?.[0]?.sceneId === sceneId && item.batchId === `generate_${job.id}`,
  );
  if (!proposal) continue;
  const accepted = await post(`/v1/creative/worlds/${dossierId}/works/${workA.id}/ops`, {
    baseRevision: current.revision,
    ops: [{ op: 'text.accept', proposalId: proposal.id }],
  });
  const scene = accepted.work.chapters[0].scenes.find((item: any) => item.id === sceneId);
  written.push({ sceneId, words: scene.words, accepted: true });
  console.log(`  写了「${scene.title}」：${scene.words} 字`);
}

// ── 作品二：导入《聊斋》选篇（真抽取）──
const classic = readFileSync('/tmp/liaozhai_selection.txt', 'utf8');
const workB = await post(`/v1/creative/worlds/${dossierId}/works`, {
  kind: 'novel',
  title: '聊斋志异 · 选篇（宅妖 / 王六郎 / 画皮）',
});
const asset = await post(`/v1/creative/worlds/${dossierId}/assets`, {
  name: 'liaozhai-juan1-selection.txt',
  content: classic,
  format: 'text',
});
const job = await post(`/v1/creative/worlds/${dossierId}/works/${workB.id}/import`, { assetId: asset.assetId });
console.log(`导入任务 ${job.id}：${job.chapters.total} 章，正在抽…`);
let state = job.state;
let latest = job;
for (let index = 0; index < 900 && state !== 'done' && state !== 'failed'; index += 1) {
  await new Promise((done) => setTimeout(done, 2000));
  latest = await call(`/v1/creative/worlds/${dossierId}/imports/${job.id}`);
  state = latest.state;
  if (index % 15 === 0) console.log(`  进度 ${latest.chapters.done}/${latest.chapters.total}，提议 ${latest.proposals} 条`);
}
console.log(`导入 ${state}：${latest.chapters.done}/${latest.chapters.total} 章，${latest.proposals} 条提议，花费 ${JSON.stringify(latest.cost)}`);

const detailB = await call(`/v1/creative/worlds/${dossierId}/works/${workB.id}`);
const proposals = await call(`/v1/creative/worlds/${dossierId}/proposals?limit=200`);
const sample = (proposals.proposals as any[]).slice(0, 12).map((item) => ({
  kind: item.kind,
  title: item.title,
  batch: item.batchId,
  quote: item.origin?.source?.quote?.slice(0, 30),
  candidates: (item.candidates ?? []).map((candidate: any) => candidate.label).slice(0, 3),
  doubts: item.doubts.slice(0, 2),
}));

console.log(
  JSON.stringify(
    {
      dossierId,
      original: { workId: workA.id, title: workA.title, scenes: written },
      imported: {
        workId: workB.id,
        chapters: detailB.chapters.map((chapter: any) => `${chapter.title}（${chapter.scenes[0]?.words ?? 0} 字）`),
        importJob: { state: latest.state, proposals: latest.proposals, cost: latest.cost },
      },
      proposalSamples: sample,
    },
    null,
    2,
  ),
);
