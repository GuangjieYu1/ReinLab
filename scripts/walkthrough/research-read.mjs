// 研究台 · 精读 全流程走查（design/walkthroughs/2026-10-26-research-read/PLAN.md）。
// 用法：
//   PLAYWRIGHT_MODULE=… node scripts/walkthrough/research-read.mjs --base http://127.0.0.1:5183 --creds <verification-users.env> --out <目录> [--cap 3]
//   不给 --creds 时按 mock 入口走（任意 4 位口令），用来先排查脚本本身。
// 账户只在脚本内存里，不写进字幕、截图文件名、结果和日志；密码框在录屏里是圆点。
import { readFileSync, mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:5183');
const OUT = arg('out', '/tmp/walkthrough');
const CAP = Number(arg('cap', '3'));
const credsFile = arg('creds');
let EMAIL = '', PASSWORD = '';
if (credsFile) {
  const env = Object.fromEntries(readFileSync(credsFile, 'utf8').split('\n').map(l => l.match(/^([A-Z_]+)='?([^']*)'?$/)).filter(Boolean).map(m => [m[1], m[2]]));
  EMAIL = env.A_EMAIL; PASSWORD = env.A_PASSWORD;
  if (!EMAIL || !PASSWORD) throw new Error('账户文件里没有 A_EMAIL / A_PASSWORD');
}
mkdirSync(join(OUT, 'shots'), { recursive: true });
mkdirSync(join(OUT, 'raw'), { recursive: true });

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(OUT, 'raw'), size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
const results = [];
const t0 = Date.now();
const wait = ms => page.waitForTimeout(ms);
const text = async sel => (await page.locator(sel).first().textContent({ timeout: 3000 }).catch(() => '')) ?? '';

// 字幕条：录屏顶部显示当前步骤、预期与结论。挂在 body 上，页内导航不会冲掉；整页刷新后重新挂。
async function caption(html) {
  await page.evaluate(h => {
    let el = document.getElementById('wt-cap');
    if (!el) {
      el = document.createElement('div'); el.id = 'wt-cap';
      el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;max-width:1100px;min-width:640px;padding:12px 18px;background:#141213ee;color:#f0eeea;font:500 15px/1.5 "Noto Sans SC",system-ui,sans-serif;box-shadow:0 8px 30px #0005;border-left:4px solid #ff7a1a';
      document.body.appendChild(el);
    }
    el.innerHTML = h;
  }, html).catch(() => {});
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const MARK = { '✓': '#7bd88f', '△': '#ffc857', '✗': '#ff6b6b' };

async function step(id, kind, action, expected, fn) {
  await caption(`<b style="color:#ff7a1a">${id}</b> · ${kind === '错' ? '<span style="color:#ff6b6b">错误分支</span>' : '正确路径'} · ${esc(action)}<br><span style="color:#b9b5ad">预期：${esc(expected)}</span>`);
  await wait(1600);
  const at = ((Date.now() - t0) / 1000).toFixed(0);
  let verdict = '✗', actual = '', note = '';
  try { ({ verdict, actual, note = '' } = await fn()); }
  catch (e) { verdict = '✗'; actual = '步骤出错：' + String(e.message || e).split('\n')[0].slice(0, 200); }
  await caption(`<b style="color:#ff7a1a">${id}</b> · ${esc(action)}<br><span style="color:#b9b5ad">预期：${esc(expected)}</span><br><b style="color:${MARK[verdict]}">${verdict}</b> 实际：${esc(actual)}`);
  await page.screenshot({ path: join(OUT, 'shots', `${id}.png`) }).catch(() => {});
  results.push({ id, kind, action, expected, actual, verdict, note, at: Number(at) });
  console.log(`${verdict} ${id} ${actual}`);
  await wait(2600);
  return verdict;
}
const ok = (actual, note) => ({ verdict: '✓', actual, note });
const part = (actual, note) => ({ verdict: '△', actual, note });
const bad = (actual, note) => ({ verdict: '✗', actual, note });
const money = s => { const m = String(s).match(/¥\s*([\d.]+)/); return m ? Number(m[1]) : NaN; };
// 面板里同时有「预算 ¥5」「上限 ¥0.50」：花费只认「已花 ¥…」那句。
const spentOf = s => { const m = String(s).match(/已花\s*¥\s*([\d.]+)/); return m ? Number(m[1]) : NaN; };

// ───────── 一、入口 ─────────
await page.goto(BASE + '/?preview=entry&design=mobius', { waitUntil: 'domcontentloaded' });
await wait(2500);
const live = !!credsFile;
await caption('<b style="color:#ff7a1a">研究台 · 精读 全流程走查</b><br>真实模式 · DeepSeek V4 Flash · 总预算上限 ¥' + CAP + ' · ' + new Date().toLocaleString('zh-CN'));
await wait(2500);

async function login(email, password) {
  if (await page.locator('#rl-id').count()) { await page.locator('#rl-id').fill(email); }
  await page.locator('#rl-key').fill(password);
  await page.locator('.rl-auth button[type=submit]').click();
}

if (live) {
  await step('E1', '错', '邮箱对、密码错，提交', '红色封锁画面 + 提示核对邮箱和密码，不进入选台', async () => {
    await login(EMAIL, 'wrong-password-123');
    await page.locator('.rl[data-phase="denied"]').waitFor({ timeout: 8000 });
    const help = await text('#rl-key-help');
    await wait(3200);
    const back = await page.locator('.rl[data-phase="locked"]').count();
    return help.includes('核对') && back ? ok(`封锁后恢复，提示「${help.trim()}」`) : part(`提示「${help.trim()}」，恢复=${!!back}`);
  });
  await step('E2', '错', '邮箱留空直接提交', '提示先填写身份（邮箱），不发请求', async () => {
    await page.locator('#rl-id').fill('');
    await page.locator('#rl-key').fill('anything');
    await page.locator('.rl-auth button[type=submit]').click();
    await wait(600);
    const help = await text('#rl-key-help');
    return /请输入.*邮箱/.test(help) ? ok(`提示「${help.trim()}」`) : bad(`提示是「${help.trim()}」`);
  });
}
await step('E3', '正', '输入正确账户登录', '核验动画 → 选台出现', async () => {
  await login(EMAIL || 'demo@rhine.test', PASSWORD || 'demo1234');
  await page.getByText('ACCESS STUDIO').first().waitFor({ timeout: 20000 });
  return ok('登录成功，选台出现');
});
await step('E4', '正', '选 RSCH → 进入工作台 → 抽取档案 → 继续工作', '进入研究台，页面不整页刷新、登录不掉', async () => {
  await page.getByText('RSCH', { exact: true }).last().click(); await wait(1500);
  await page.getByText('ACCESS STUDIO').first().click(); await wait(3500);
  await page.getByText('ACCESS FILE').first().click(); await wait(3000);
  await page.getByText('继续工作').first().click();
  await page.locator('.rd').first().waitFor({ timeout: 20000 }); await wait(2500);
  const onLogin = await page.locator('#rl-key').count();
  return onLogin ? bad('跳转后回到了登录页') : ok('进入研究台，登录状态保留');
});

// ───────── 二、研究台外壳 ─────────
await step('W2', '正', '看收件箱', '没有测试残留；有待办时是人话，不是原始 JSON', async () => {
  const open = await page.locator('.ibx').count();
  let body = '';
  if (open) { body = (await text('.ibx')) || ''; await page.keyboard.press('Escape'); await wait(800); }
  const json = /\{"source"|"type":/.test(body);
  return !open ? ok('收件箱没有自动弹出待办') : json ? bad('收件箱里出现原始 JSON') : part('收件箱自动打开了，内容可读', body.slice(0, 120));
});
await step('W1', '错', '点「群研」「自研」入口', '置灰并标出接入期次，点了不切换', async () => {
  const later = page.locator('[data-later]');
  const n = await later.count();
  if (!n) return bad('没有找到置灰入口');
  const labels = (await later.allTextContents()).join(' / ');
  await later.first().click({ force: true }); await wait(800);
  const still = await page.locator('.rd').count();
  return still ? ok(`置灰入口 ${n} 个：${labels.replace(/\s+/g, ' ')}；点击后仍在精读`) : bad('点击后离开了精读');
});
await step('W3', '正', '＋ 新建精读', '出现「想读哪篇？」，没有「预估费用」按钮，澄清 ¥0.000 / ¥0.5', async () => {
  await page.locator('.rd-new').click(); await page.locator('.rd-start').waitFor({ timeout: 10000 }); await wait(1200);
  const h = await text('.rd-start h2');
  const go = await page.locator('.rd-start .rd-go').count();
  const note = await text('.rd-start-note');
  return h.includes('想读哪篇') && !go ? ok(`「${h}」；${note.trim()}`) : bad(`标题「${h}」，预估按钮 ${go} 个`);
});

// ───────── 三、对话澄清 ─────────
const talk = async t => { await page.locator('.ad-input textarea').fill(t); await page.keyboard.press('Enter'); };
const lastPick = () => page.locator('.ad .rd-pick').last();
async function waitReply(prevPicks, prevAgents, ms = 240000) {
  // 等候选卡出现；助手先说「我先检索」之类的话不算答完。助手明确说没受理 / 要你补充时提前结束。
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await page.locator('.ad .rd-pick').count()) > prevPicks) { await wait(1500); return 'pick'; }
    const msgs = await page.locator('.ad .ad-msg.is-agent').allTextContents();
    const fresh = msgs.slice(prevAgents).join(' ');
    if (/未受理|请补充|补充线索|已停止|被取消/.test(fresh)) { await wait(3000); return (await page.locator('.ad .rd-pick').count()) > prevPicks ? 'pick' : 'agent:' + fresh.slice(-120); }
    await wait(1000);
  }
  return 'timeout';
}
let hasToolformer = false;
await step('C1', '正', '发：我想读那篇让大模型自己学会什么时候调用计算器、搜索这些工具的论文', '立刻显示「工作中」；数秒内回话并列出候选；AI 不替你选', async () => {
  const p0 = await page.locator('.ad .rd-pick').count();
  const a0 = await page.locator('.ad .ad-msg.is-agent').count();
  const sent = Date.now();
  await talk('我想读那篇让大模型自己学会什么时候调用计算器、搜索这些工具的论文');
  await wait(800);
  const typing = await page.locator('.ad-typing').count();
  const r = await waitReply(p0, a0);
  const secs = ((Date.now() - sent) / 1000).toFixed(0);
  if (r !== 'pick') return bad(`${secs} 秒内没有出现候选（${r}）`);
  const titles = await lastPick().locator('li b').allTextContents();
  hasToolformer = titles.some(t => /toolformer/i.test(t));
  const chosen = await page.locator('.rd-chosen').count();
  return typing && !chosen ? ok(`${secs} 秒列出 ${titles.length} 篇：${titles.join('；')}`) : part(`工作中提示=${!!typing}，自动选定=${!!chosen}；候选：${titles.join('；')}`);
});
await step('C2', '正', '看候选是否包含 Toolformer', '候选含 Toolformer，信息齐全', async () => {
  const li = await lastPick().locator('li').allTextContents();
  return hasToolformer ? ok('候选里有 Toolformer') : bad('候选里没有 Toolformer', li.join(' | ').slice(0, 600));
});
if (!hasToolformer) {
  await step('C3', '错', '点「都不是」，补一句：是 Meta 2023 年的 Toolformer', '第二轮检索出现 Toolformer，两轮合计不超过澄清上限', async () => {
    await lastPick().locator('.rh-btn', { hasText: '都不是' }).click(); await wait(1500);
    const p0 = await page.locator('.ad .rd-pick').count();
    const a0 = await page.locator('.ad .ad-msg.is-agent').count();
    await talk('都不是。是 Meta 2023 年的 Toolformer：Language Models Can Teach Themselves to Use Tools');
    const r = await waitReply(p0, a0);
    if (r !== 'pick') return bad(`第二轮没有出现候选（${r}）`, (await text('.ad')).slice(-400));
    const titles = await lastPick().locator('li b').allTextContents();
    hasToolformer = titles.some(t => /toolformer/i.test(t));
    return hasToolformer ? ok(`第二轮找到：${titles.join('；')}`) : bad(`第二轮仍没有：${titles.join('；')}`);
  });
}
let clarifySpent = 0;
await step('C4', '正', '看底栏澄清花费', '真实花了钱，金额大于 0', async () => {
  const bar = await text('.en-statusbar');
  const m = bar.match(/澄清\s*¥\s*([\d.]+)\s*\/\s*¥\s*([\d.]+)/);
  clarifySpent = m ? Number(m[1]) : NaN;
  return m && clarifySpent > 0 ? ok(`澄清 ¥${m[1]} / ¥${m[2]}`) : bad(m ? `显示 ¥${m[1]} / ¥${m[2]}，花了钱却显示 0` : '底栏没有找到澄清花费');
});
if (!hasToolformer) {
  await step('C3b', '正', '另开一份新精读，直接说出完整标题', '用准确标题检索能找到 Toolformer', async () => {
    await page.locator('.rd-new').click(); await page.locator('.rd-start').waitFor({ timeout: 10000 }); await wait(1500);
    const p0 = await page.locator('.ad .rd-pick').count();
    const a0 = await page.locator('.ad .ad-msg.is-agent').count();
    await talk('Toolformer: Language Models Can Teach Themselves to Use Tools');
    const r = await waitReply(p0, a0);
    if (r !== 'pick') return bad(`没有出现候选（${r}）`);
    const titles = await lastPick().locator('li b').allTextContents();
    hasToolformer = titles.some(t => /toolformer/i.test(t));
    return hasToolformer ? ok(`找到：${titles.join('；')}`) : bad(`仍没有：${titles.join('；')}`);
  });
}
if (!hasToolformer) {
  results.push({ id: 'STOP', kind: '—', action: '停止', expected: '—', actual: '两轮澄清都没找到 Toolformer，后续步骤需要选定论文，走查到此为止', verdict: '✗', at: Number(((Date.now() - t0) / 1000).toFixed(0)) });
} else {
  const repick = async () => {
    const p0 = await page.locator('.ad .rd-pick').count();
    const a0 = await page.locator('.ad .ad-msg.is-agent').count();
    await talk('还是读 Toolformer 那篇');
    if (await waitReply(p0, a0) !== 'pick') return false;
    const b = lastPick().locator('li button', { hasText: /Toolformer/i }).first();
    if (!(await b.count())) return false;
    await pickTool(); return true;
  };
  const pickTool = async () => { await lastPick().locator('li button', { hasText: /Toolformer/i }).first().click(); await page.locator('.rd-chosen').waitFor({ timeout: 10000 }); await wait(1000); };
  await step('C5', '正', '选 Toolformer', '出现「读这篇」卡片：标题、作者、页数或说明、预算栏', async () => {
    await pickTool();
    const c = await text('.rd-chosen');
    const budget = await page.locator('.rd-start-b input').count();
    return budget ? ok(c.replace(/\s+/g, ' ').slice(0, 160)) : part('卡片有，预算栏缺失');
  });
  await step('C6', '错', '点「换一篇」，再从候选里选回来', '回到「想读哪篇？」，对话保留；重新选回 Toolformer', async () => {
    await page.locator('.rd-chosen .rh-btn', { hasText: '换一篇' }).click(); await wait(1500);
    const h = await text('.rd-start h2');
    const picks = await page.locator('.ad .rd-pick').count();
    const enabled = await lastPick().locator('li button', { hasText: /Toolformer/i }).first().isEnabled().catch(() => false);
    if (!h.includes('想读哪篇')) return bad(`换一篇后标题是「${h}」`);
    if (!enabled) {
      // 旧候选卡已锁定：只能再说一句，让助手重新列出候选
      const ready = await repick();
      return part(`回到了「想读哪篇？」，但旧候选卡已锁定，要再说一句才能重新选；重新选回=${ready}`, `候选卡 ${picks} 张`);
    }
    await pickTool();
    return ok('回到「想读哪篇？」，又选回了 Toolformer');
  });

  // ───────── 四、预估 ─────────
  const setBudget = async v => { const i = page.locator('.rd-start-b input'); await i.fill(String(v)); await wait(300); };
  const estimate = async () => { await page.locator('.rd-start .rd-go', { hasText: '预估' }).click(); };
  let est = NaN;
  await step('S1', '错', '预算填 0，点预估', '提示「预算填 0 到 50 元之间」，不发请求', async () => {
    if (!(await page.locator('.rd-chosen').count())) return bad('没有选定论文，无法预估');
    await setBudget(0); await estimate(); await wait(800);
    const e = await text('.rd-start-err');
    return e.includes('0 到 50') ? ok(`提示「${e.trim()}」`) : bad(`提示是「${e.trim()}」`);
  });
  await step('S2', '错', '预算填 ¥0.5，预估', '若预估上限 > ¥0.5：提示超预算，「确认开始」不可点', async () => {
    await setBudget(0.5); await estimate();
    await page.locator('.rd-estimate').waitFor({ timeout: 30000 });
    est = money(await text('.rd-estimate .is-big'));
    const dis = await page.locator('.rd-estimate .rd-go').isDisabled();
    const warn = await text('.rd-estimate .rd-start-err');
    if (est > 0.5) return dis && warn ? ok(`预估上限 ¥${est}，提示超预算，确认按钮禁用`) : bad(`预估 ¥${est}，按钮禁用=${dis}，提示「${warn}」`);
    return part(`预估上限 ¥${est} 没超 ¥0.5，这条分支没触发`);
  });
  // 预估要重新算：回到选定卡片再改预算
  const reEstimate = async v => {
    if (await page.locator('.rd-chosen .rh-btn', { hasText: '换一篇' }).count() === 0) { /* confirm 状态下预算框仍可改 */ }
    await setBudget(v); await estimate().catch(() => {});
    await page.locator('.rd-estimate').waitFor({ timeout: 30000 }); await wait(800);
  };
  let runBudget = 0;
  await step('S3', '正', '预算改 ¥2.5，重新预估', '显示模型、最多步数、最多约 ¥y ≤ 2.5，「确认开始」可点', async () => {
    await setBudget(2.5); await wait(500);
    // confirm 状态下没有「预估费用」按钮：预算变了，看界面是否允许直接确认
    const hasEst = await page.locator('.rd-start .rd-go', { hasText: '预估' }).count();
    if (hasEst) await reEstimate(2.5);
    const dl = (await text('.rd-estimate dl')).replace(/\s+/g, ' ');
    est = money(await text('.rd-estimate .is-big'));
    const enabled = await page.locator('.rd-estimate .rd-go').isEnabled();
    runBudget = 2.5;
    return enabled && est <= 2.5 ? ok(dl) : bad(`${dl}；确认可点=${enabled}`);
  });

  // ───────── 五、运行 ─────────
  const spentNow = async () => spentOf((await text('.rd-start-run small')) || (await text('.rd-run-cost')));
  let firstSpent = 0;
  await step('R1', '正', '确认开始', '运行开始；第一步是「下载全文」审批，主面板和助手面板都能看到', async () => {
    // 被拒的这一次只需要能走到审批：预算用预估上限，避免预留过多
    await page.locator('.rd-estimate .rd-go').click();
    await page.locator('.rd-start-ap').first().waitFor({ timeout: 120000 });
    const cards = await page.locator('.rd-start-ap').allTextContents();
    if (cards.length > 1) console.log('DEBUG 审批卡数量 ' + cards.length + '：' + cards.map(c => c.replace(/\s+/g, ' ').slice(0, 90)).join(' || '));
    const ap = (await text('.rd-start-ap')).replace(/\s+/g, ' ');
    const dock = await page.locator('.ad-approval').count();
    return dock ? ok(ap.slice(0, 200)) : part(`主面板有审批，助手面板没有：${ap.slice(0, 160)}`);
  });
  await step('R2', '错', '点「不下载」', '运行如实停下，说明因拒绝而停止，不偷偷下载；花费照实显示', async () => {
    await page.locator('.rd-start-ap .rh-btn', { hasText: '不下载' }).click();
    await page.locator('.rd-runbar[data-state="cancelled"], .rd-runbar[data-state="failed"], .rd-start-run h2').first().waitFor({ timeout: 60000 });
    await wait(4000);
    const h = await text('.rd-start-run h2');
    const msg = (await text('.rd-start-run')).replace(/\s+/g, ' ');
    firstSpent = spentOf(msg);
    const honest = /没有批准|拒绝|没有读|停止|取消|已停/.test(msg);
    if (!honest) return bad(msg.slice(0, 200));
    return /已完成/.test(h) ? part(`说明如实，但标题写「${h}」，容易误解为读完了：${msg.slice(0, 160)}`) : ok(msg.slice(0, 200));
  });
  const left = CAP - (clarifySpent || 0.05) - (Number.isFinite(firstSpent) ? firstSpent : 0.1) - 0.1;
  if (left < est) {
    results.push({ id: 'STOP', kind: '—', action: '停止', expected: '—', actual: `剩余预算 ¥${left.toFixed(2)} 不够这篇的预估上限 ¥${est}，按授权上限停下`, verdict: '✗', at: Number(((Date.now() - t0) / 1000).toFixed(0)) });
  } else {
    await step('R3', '正', '重新开始 → 选同一篇 → 预估 → 确认 → 批准下载', '讲解逐层出现，带原文页码；运行条显示步骤和已花费', async () => {
      const again = page.locator('.rd-start .rd-go', { hasText: '重新开始' });
      if (await again.count()) { await again.click(); await wait(2500); }
      if (!(await page.locator('.rd-chosen').count())) {
        const btn = lastPick().locator('li button', { hasText: /Toolformer/i }).first();
        if (await btn.isEnabled().catch(() => false)) await pickTool();
        else if (!(await repick())) return bad('重新开始后再说一句也没能重新选到这篇');
      }
      await setBudget(Math.min(2.5, Math.floor(left * 10) / 10)); await estimate();
      await page.locator('.rd-estimate .rd-go').waitFor({ timeout: 30000 });
      if (await page.locator('.rd-estimate .rd-go').isDisabled()) return bad('预估超出剩余预算');
      await page.locator('.rd-estimate .rd-go').click();
      await page.locator('.rd-start-ap').waitFor({ timeout: 120000 });
      await page.locator('.rd-start-ap .rd-go', { hasText: '批准' }).click();
      await page.locator('.rd-runbar[data-state="running"], .rd-layer').first().waitFor({ timeout: 120000 });
      return ok('已批准下载，运行中');
    });
    await step('R4', '正', '等精读完成（最长 10 分钟），中途出现的审批逐项批准', '状态「已完成」；有讲解层和发现卡；实际花费 ≤ 预算，未知用量标出', async () => {
      const end = Date.now() + (live ? 600000 : 40000);
      let approvals = 0;
      while (Date.now() < end) {
        const st = await page.locator('.rd-runbar').first().getAttribute('data-state').catch(() => null);
        if (st === 'done' || st === 'failed' || st === 'cancelled') break;
        const ap = page.locator('.ad-approval .rh-btn.is-solid, .rd-start-ap .rd-go', { hasText: '批准' });
        if (await ap.count()) { await ap.first().click().catch(() => {}); approvals++; }
        await wait(3000);
      }
      const st = await page.locator('.rd-runbar').first().getAttribute('data-state').catch(() => '?');
      const layers = await page.locator('.rd-layer').count();
      const findings = await page.locator('.rd-finding').count();
      const cost = (await text('.rd-run-cost')).replace(/\s+/g, ' ');
      const line = `状态 ${st}，讲解 ${layers} 层，发现卡 ${findings} 张，${cost}，途中批准 ${approvals} 次`;
      return st === 'done' && layers && findings ? ok(line) : st === 'done' ? part(line) : bad(line);
    });
    await step('R5', '正', '追问：为什么要自监督地插入 API 调用？', '如实说明「追问第二期接入」，不编回答', async () => {
      const a0 = await page.locator('.ad .ad-msg.is-agent').count();
      await talk('为什么要自监督地插入 API 调用？'); await wait(5000);
      const tail = (await text('.ad')).slice(-300);
      return /未接入|第二期|P2-05/.test(tail) ? ok('如实说明追问还没接入') : part('回答内容需人工判断', tail);
    });
    await step('R6', '错', '检验页提交一个答案', '如实说明「评分未接入」', async () => {
      await page.locator('.en-tabs button').nth(3).click(); await wait(1200);
      if (!(await page.locator('.rd-q textarea').count())) return part('检验页没有题目（新档案尚未生成测验）');
      await page.locator('.rd-q textarea').first().fill('它让模型自己判断哪里调用工具有用'); await page.locator('.rd-q .rh-btn').first().click(); await wait(1500);
      const t = (await text('.rd-q')).replace(/\s+/g, ' ');
      return /未接入/.test(t) ? ok('如实说明评分未接入') : part(t.slice(0, 160));
    });
  }
}

// ───────── 六、会话 ─────────
await step('X1', '错', '刷新页面', '已知问题：会话只在内存里，刷新后回到登录页', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' }); await wait(4000);
  const login = await page.locator('#rl-key').count();
  return login ? part('刷新后回到登录页（已知问题，会话不持久）') : ok('刷新后仍保持登录');
});

await caption('<b style="color:#ff7a1a">走查结束</b><br>' + ['✓', '△', '✗'].map(m => `${m} ${results.filter(r => r.verdict === m).length}`).join('　'));
await wait(3000);
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ base: BASE, live, cap: CAP, startedAt: new Date(t0).toISOString(), seconds: (Date.now() - t0) / 1000, results }, null, 2));
await ctx.close(); await browser.close();
const vid = readdirSync(join(OUT, 'raw')).find(f => f.endsWith('.webm'));
if (vid) renameSync(join(OUT, 'raw', vid), join(OUT, 'video.webm'));
console.log('完成', results.length, '步');
