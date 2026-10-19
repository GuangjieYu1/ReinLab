// 由前端阶段的 /tmp/rl-prof/cr.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'cr',
  title: '创作台：世界观矛盾检查与三视图',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=creative&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2000);
    await ctx.shot('C1.png');
    await page.locator('.ad-suggest button', { hasText: '检查矛盾' }).click(); await page.waitForTimeout(2000); await ctx.shot('C2.png');
    await page.locator('.cr-seg button').nth(1).click(); await page.waitForTimeout(800); await ctx.shot('C3.png');
    await page.locator('.cr-issue button').first().click(); await page.waitForTimeout(500);
    await page.locator('.cr-seg button').nth(2).click(); await page.waitForTimeout(800); await page.locator('.cr-place', { hasText: '灰港' }).click(); await page.waitForTimeout(500); await ctx.shot('C4.png');
    await page.locator('.cr-seg button').nth(0).click(); await page.waitForTimeout(500); await page.locator('.cr-person', { hasText: '梅里' }).click(); await page.waitForTimeout(400);
    await page.locator('.ad-suggest button', { hasText: '三视图' }).click(); await page.waitForTimeout(300); await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(2000); await ctx.shot('C5.png');
  },
};
