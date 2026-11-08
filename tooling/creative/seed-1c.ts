/**
 * 1C 的验收数据（真栈、真接口）：在 dc55c5ff 上存 v3（阊门北移、出阊门提前一小时），
 * 让《阊门夜行》《1B 页面验收 · 河边访友》都还基于旧版、都引用阊门。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CONTROL = process.env.REINLAB_CONTROL ?? 'http://127.0.0.1:3001';
const dossierId = 'dc55c5ff-0e39-4455-b725-dfe1b824a3a9';
const env: Record<string, string> = {};
for (const line of readFileSync(path.join(homedir(), '.local/state/reinlab/803a04fcd69a/verification-users.env'), 'utf8').split('\n')) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const headers = (extra: Record<string, string> = {}) => ({ Origin: CONTROL, 'Content-Type': 'application/json', 'X-ReinLab-CSRF': '1', ...extra });
const login = await fetch(`${CONTROL}/auth/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: env.B_EMAIL, password: env.B_PASSWORD }) });
const cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).find((item) => item.startsWith('rl_session='))!;
const req = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(`${CONTROL}${p}`, { ...init, headers: headers({ Cookie: cookie, ...(init.headers ?? {}) }) });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const post = (p: string, body: unknown) => req(p, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
const base = `/v1/creative/worlds/${dossierId}`;

const world = (await req(base)).body;
const place = world.entities.find((item: any) => item.name === '阊门');
const event = world.events.find((item: any) => item.title === '出阊门');
if (!place || !event) throw new Error('这份世界观里没有 阊门 / 出阊门');
const [lng, lat] = place.place.geo.coordinates as [number, number];
// 幂等：只有还在老位置才挪（跑第二遍不会继续往北）
const nextGeo = lat < 31.318
  ? { type: 'Point', coordinates: [lng, Number((lat + 0.003).toFixed(4))] }
  : { type: 'Point', coordinates: [lng, lat] };

// 让《河边访友》也引用出阊门（《阊门夜行》已经引用了）
const works = (await req(`${base}/works`)).body as any[];
const riverside = works.find((item) => item.title.includes('河边访友'));
if (riverside) {
  const detail = (await req(`${base}/works/${riverside.id}`)).body;
  const scene = detail.chapters[0]?.scenes[0];
  if (scene && !scene.eventIds.includes(event.id)) {
    const patched = await post(`${base}/works/${riverside.id}/ops`, {
      baseRevision: detail.revision,
      ops: [{ op: 'scene.update', id: scene.id, patch: { eventIds: [...scene.eventIds, event.id] } }],
    });
    console.log('《河边访友》引用出阊门：', patched.status);
  }
}

// 草稿：挪阊门 + 出阊门提前一小时
const shift = (label: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(label);
  if (!match) throw new Error(`时间标签不是公历：${label}`);
  const t = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 1, Number(match[5])));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};
const beforeDraft = (await req(`${base}/versions/draft`)).body;
if (!beforeDraft.items) console.log('草稿差异接口：', JSON.stringify(beforeDraft).slice(0, 160));
const shiftEvent = event.start.label !== shift(event.start.label);
const ops: unknown[] = [];
if (nextGeo.coordinates[1] !== lat) ops.push({ op: 'entity.update', id: place.id, patch: { place: { ...place.place, geo: nextGeo } } });
if (shiftEvent) ops.push({ op: 'event.update', id: event.id, patch: { start: { input: shift(event.start.label) }, end: { input: shift(event.end.label) } } });
if (ops.length) {
  const changed = await post(`${base}/ops`, { baseRevision: world.world.revision, ops });
  console.log('改草稿：', changed.status);
} else {
  console.log('草稿已经是改过的状态，跳过');
}
const draft = (await req(`${base}/versions/draft`)).body;
console.log('存版本前的草稿差异：', draft.items.map((item: any) => `${item.title}（${item.fields.join('、') || item.change}）`).join('；'));
const saved = await post(`${base}/versions`, { summary: 'v3：阊门北移约 300 米、出阊门提前一小时' });
console.log('存版本：', saved.status, JSON.stringify(saved.body));
const n = saved.body.n;
const impact = (await req(`${base}/impact?from=${n - 1}&to=${n}`)).body;
console.log(`影响清单 v${n - 1}→v${n}：`, impact.items.length, '条');
for (const item of impact.items) {
  console.log(' -', item.group, '｜确定受影响', item.sure.length, '处｜', item.works.map((w: any) => `${w.workId.slice(0, 8)}:${w.uses}${w.decision ? '/' + w.decision : ''}`).join(' '));
}
console.log('草稿差异（改之前）：', beforeDraft.items?.length ?? '—', '条');
