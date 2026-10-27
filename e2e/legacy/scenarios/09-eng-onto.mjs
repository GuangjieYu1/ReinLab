// 由前端阶段的 /tmp/rl-prof/onto.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'onto',
  title: '工程台：本体视图',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=engineering&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500);
    await page.locator('.en-tabs button').nth(3).click(); await page.waitForTimeout(1000); await ctx.shot('N1.png');
    await page.locator('.on-conflict .rh-btn.is-solid').click(); await page.waitForTimeout(1300);
    await page.locator('.on-impact').click(); await page.waitForTimeout(1300); await ctx.shot('N2.png');
    await page.locator('.on-br', { hasText: 'legacy' }).locator('.on-cmp').click(); await page.waitForTimeout(800); await ctx.shot('N3.png');
    await page.locator('.on-seg button').nth(1).click(); await page.waitForTimeout(700); await ctx.shot('N4.png');
  },
};
