// 由前端阶段的 /tmp/rl-prof/trip-en.mjs 整理而来：入口「继续工作」→ 工作台 → 返回的快门转场。
// 原脚本只抽帧给人看。断言不看「帧数够不够」——那取决于机器快慢（本机 260 多帧，CI 只有 15～19 帧）——而是看三件事：
// ① 去和回都真的到达了目标页面（点击能找到对应元素）；② 两段都录到了画面；③ 画面确实在变（不同的帧至少 3 种），说明动画没卡住。
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export default {
  id: 'trip-en',
  title: '入口转场（ENGR）：继续工作 → 工作台 → 返回',
  deviceScaleFactor: 1,
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=entry&design=aperture&return=engineering&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    await page.getByText('ACCESS FILE').first().click(); await page.waitForTimeout(2600); await ctx.shot('tab.png');
    const cdp = await page.context().newCDPSession(page);
    const frames = [];
    cdp.on('Page.screencastFrame', async f => { frames.push({ t: f.metadata.timestamp, d: f.data }); await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 720, maxHeight: 450 });
    await page.waitForTimeout(200);
    const tGo = Date.now() / 1000;
    await page.getByText('继续工作').first().click();
    await page.waitForTimeout(5000);
    const tBack = Date.now() / 1000;
    await page.getByLabel('返回 ENGR Files').click();
    await page.waitForTimeout(4800);
    await cdp.send('Page.stopScreencast');
    const pick = (t0, span, n, name) => {
      const sel = frames.filter(f => f.t >= t0 && f.t <= t0 + span);
      const step = Math.max(1, Math.floor(sel.length / n));
      sel.filter((_, i) => i % step === 0).slice(0, n).forEach(f => writeFileSync(path.join(ctx.dir, `U-${name}-${String(Math.round((f.t - t0) * 1000)).padStart(4, '0')}.jpg`), Buffer.from(f.d, 'base64')));
      return sel.length;
    };
    const go = pick(tGo, 4.6, 30, 'go'), back = pick(tBack, 4.0, 20, 'back');
    ctx.note('frames', frames.length, 'go', go, 'back', back);
    const distinct = (t0, span) => new Set(frames.filter(f => f.t >= t0 && f.t <= t0 + span).map(f => createHash('sha1').update(f.d).digest('hex'))).size;
    const dGo = distinct(tGo, 4.6), dBack = distinct(tBack, 4.0);
    ctx.note('distinct', 'go', dGo, 'back', dBack);
    if (go < 3 || back < 3) throw new Error(`转场期间几乎没有录到画面：go=${go}，back=${back}`);
    if (dGo < 3 || dBack < 3) throw new Error(`转场画面没有变化（动画可能卡住）：不同帧 go=${dGo}，back=${dBack}`);
  },
};
