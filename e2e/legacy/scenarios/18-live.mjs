// 自动化台看板面（常驻自动化，design/AUTOMATION_LIVE.md）：总览 → 告警 → 对话调参（低风险直接生效）→ 加来源（中风险走审批）
// → 接入 GitHub 项目（侦查 → 适配 → 沙盒试跑 → 批准上线）→ 模拟 → 拒绝交易请求。
export default {
  id: 'live',
  title: '自动化台看板：告警、调参与审批、接入项目、模拟、拒绝交易',
  async run(ctx) {
    const { page } = ctx;
    const ask = async t => { await page.locator('.ad-input textarea').fill(t); await page.keyboard.press('Enter'); };
    await page.goto(ctx.url('/?preview=workbench&studio=automation&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2200);
    await page.getByRole('tab', { name: /看板/ }).click(); await page.waitForTimeout(1200); await ctx.shot('L1.png');
    if (await page.locator('.lv-card:not(.is-add)').count() !== 4) throw new Error('看板应有 4 个常驻自动化');
    // 等论坛负面讨论触发告警
    await page.locator('.lv-card[data-state="alert"]').first().waitFor({ timeout: 30000 }); await ctx.shot('L2.png');
    await page.locator('.lv-card', { hasText: '新能源车舆情' }).click(); await page.waitForTimeout(600);
    await ask('阈值调到 -0.5'); await page.waitForTimeout(1200);
    if (!(await page.locator('.lv-side .au-versions li').first().textContent()).includes('-0.5')) throw new Error('低风险参数没有直接生效');
    await ask('加上短视频来源'); await page.waitForTimeout(1200);
    await page.locator('.lv-knob[data-pending]').waitFor(); await ctx.shot('L3.png');
    await page.locator('.ad-approval .rh-btn.is-solid').last().click(); await page.waitForTimeout(1500);
    if (await page.locator('.lv-knob[data-pending]').count()) throw new Error('批准后参数仍是待批准');
    await page.locator('.lv-tabs button', { hasText: '清单' }).click(); await page.waitForTimeout(300); await ctx.shot('L4.png');
    await page.locator('.lv-tabs button', { hasText: '日志' }).click(); await page.waitForTimeout(300);
    // 接入 GitHub 项目
    await page.locator('.lv-back').click(); await page.waitForTimeout(400);
    await ask('把 https://github.com/opendata/hotlist-tracker 接进来'); await page.waitForTimeout(3000); await ctx.shot('L5.png');
    await page.locator('.ad-approval', { hasText: '上线 LV-05' }).waitFor({ timeout: 25000 }); await ctx.shot('L6.png');
    await page.locator('.ad-approval .rh-btn.is-solid').last().click(); await page.waitForTimeout(800);
    await page.locator('.lv-verdict[data-r="live"]').waitFor();
    await page.locator('.lv-back').click(); await page.waitForTimeout(500);
    if (await page.locator('.lv-card:not(.is-add)').count() !== 5) throw new Error('批准后看板应有 5 个');
    await ctx.shot('L7.png');
    // 模拟
    await page.locator('.lv-card', { hasText: '舆情扩散模拟' }).click(); await page.waitForTimeout(500);
    await page.locator('.au-head .au-run').click(); await page.waitForTimeout(4000); await ctx.shot('L8.png');
    await page.locator('.lv-seg button', { hasText: '限流' }).first().click(); await page.waitForTimeout(800);
    // 交易请求必须被拒绝
    await page.locator('.au-item', { hasText: 'BTC 盘口波动' }).click(); await page.waitForTimeout(600);
    await ask('跌到 68000 就帮我买入'); await page.waitForTimeout(1200);
    if (!(await page.locator('.ad-msg, .ad-events, .ad').last().textContent()).includes('不下单')) throw new Error('交易请求没有被拒绝');
    await ctx.shot('L9.png');
  },
};
