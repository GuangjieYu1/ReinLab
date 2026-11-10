import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const CONTROL = 'http://127.0.0.1:3001';
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
const works = (await req(`${base}/works`)).body;
const novel = works.find((w: any) => w.title.includes('阊门夜行'));
const work = (await req(`${base}/works/${novel.id}`)).body;
let target: any = null;
for (const chapter of work.chapters) for (const scene of chapter.scenes) {
  const shots = (await req(`${base}/works/${novel.id}/scenes/${scene.id}/shots`)).body;
  if (shots.shots?.length) { target = { shot: shots.shots[0], count: shots.shots.length }; break; }
  if (target) break;
}
console.log('目标：第', target.shot.n, '镜');
const clip = '/tmp/test-preview.webm';
if (!existsSync(clip)) await run('/opt/homebrew/bin/ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=5', '-c:v', 'libvpx', '-b:v', '1M', clip]);
const posterPath = '/tmp/test-poster.png';
await run('/opt/homebrew/bin/ffmpeg', ['-y', '-i', clip, '-frames:v', '1', posterPath]);
const form = new FormData();
form.set('video', new Blob([readFileSync(clip)], { type: 'video/webm' }), 'preview.webm');
form.set('poster', new Blob([readFileSync(posterPath)], { type: 'image/png' }), 'poster.png');
const uploaded = await fetch(`${CONTROL}${base}/shots/${target.shot.id}/preview`, { method: 'POST', body: form, headers: { Cookie: cookie, Origin: CONTROL, 'X-ReinLab-CSRF': '1' } });
console.log('预演上传：', uploaded.status);
const t0 = Date.now();
const started = await post(`${base}/shots/${target.shot.id}/takes`, { resolution: '480p', durationSec: 5 });
console.log('任务：', started.status, started.body.id);
let take: any = null;
for (let i = 0; i < 90; i += 1) {
  await new Promise((r) => setTimeout(r, 6000));
  const w = (await req(base)).body;
  take = (w.takes ?? []).find((t: any) => t.id === started.body.id);
  if (take && ['saved', 'failed'].includes(take.state)) break;
  if (i % 5 === 0) console.log('  …', take?.state, Math.round((Date.now() - t0) / 1000), '秒');
}
console.log('结果：', take?.state, '｜耗时', Math.round((Date.now() - t0) / 1000), '秒｜花费', JSON.stringify(take?.cost), '｜失败', (take?.failure ?? '').slice(0, 140), '｜url', take?.url ?? '');
