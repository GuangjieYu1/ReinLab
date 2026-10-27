// 由前端阶段的 /tmp/rl-prof/rs.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'rs',
  title: '研究台：自研审批与切换档案',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=research&file=3'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(1800);
    await ctx.shot('Y1.png');
    await page.waitForTimeout(2200); await ctx.shot('Y2.png');
    for (let i = 0; i < 3; i++) { await page.locator('.rs-ask .rh-btn').first().click(); await page.waitForTimeout(i === 2 ? 1800 : 1600); }
    await ctx.shot('Y3.png');
    await page.locator('.rs-sign').click(); await page.waitForTimeout(1600);
    await page.locator('.rs-speed').click(); await page.waitForTimeout(6000); await ctx.shot('Y4.png');
    await page.waitForTimeout(19000); await ctx.shot("Y5.png");
    const appr = page.locator('.ad-approval button', { hasText: '批准' }); ctx.note('approval', await appr.count());
    if (await appr.count()) { await appr.last().click(); await page.waitForTimeout(3000); }
    await page.locator('.rs-log button').nth(5).click(); await page.waitForTimeout(500); await ctx.shot('Y6.png');
    await page.locator('.en-tabs button').nth(2).click(); await page.waitForTimeout(1400); await ctx.shot('Y7.png');
    await page.goto(ctx.url('/?preview=workbench&studio=research&file=2'), { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000); await ctx.shot('Y8.png');
  },
};
