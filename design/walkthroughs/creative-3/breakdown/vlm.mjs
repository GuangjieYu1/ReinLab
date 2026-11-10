// 视觉模型写拆解表：关键帧 + 逐帧事件 → 带时间码的人话。key 只在本进程内存里读。
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const key = /^ARK_API_KEY=(.*)$/m.exec(readFileSync(homedir() + '/.config/reinlab/local.env', 'utf8'))?.[1]?.trim().replace(/^["']|["']$/g, '');
const [model, src, ...times] = process.argv.slice(2);
const ev = readFileSync(`/tmp/mvp3/exp/events-${src}.json`, 'utf8');
const content = [{ type: 'text', text: `下面是一段 5 秒视频（24 帧/秒）的 ${times.length} 张关键帧（时间依次是 ${times.join('、')} 秒），以及程序从逐帧数据里切出的事件和运镜（JSON，时间码 秒.毫秒；headYaw 每 3 帧一个值，单位度，正值朝画面右）。请写一张「镜头拆解表」：\n1. 运镜：一句话（固定 / 推 / 拉 / 摇 / 移，幅度）；\n2. 按时间码逐段写每个人的动作和表情（谁、几秒到几秒、做了什么、表情怎样），时间码以程序数据为准，画面只用来认人和补充程序没测到的；程序数据和画面矛盾时写出来；\n3. 最后一行：程序没测到、但画面里看得到的东西。\n只输出表，不要客套。\n\n程序数据：\n${ev}` },
  ...times.map(t => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(`/tmp/mvp3/exp/kf-${src.replace('seedance-', '')}-${t}.jpg`).toString('base64')}` } }))];
const r = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content }] }) });
const j = await r.json().catch(() => ({}));
if (!r.ok) { console.log('fail', r.status, JSON.stringify(j).slice(0, 300)); process.exit(0); }
writeFileSync(`/tmp/mvp3/exp/breakdown-${src}.md`, j.choices[0].message.content);
console.log('ok', model, JSON.stringify(j.usage));
