// 由前端阶段的 /tmp/rl-prof/df.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'df',
  title: '数据台：提问派生、拖拽编码、变体、关闭',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=data&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2200);
    await ctx.shot('D1.png');
    const ask = async t => { await page.locator('.dfa-box textarea').fill(t); await page.keyboard.press('Enter'); };
    await ask('累计最优'); await page.waitForTimeout(600); await ctx.shot('D2.png'); await page.waitForTimeout(1000);
    await ask('按类别看保留率'); await page.waitForTimeout(1600);
    await page.locator('.dft-src').click(); await page.waitForTimeout(400); await ask('只看保留的实验'); await page.waitForTimeout(1600);
    await page.locator('.dft-card').nth(0).click(); await page.waitForTimeout(400); await ask('改进幅度'); await page.waitForTimeout(1600); await ctx.shot('D3.png');
    await page.locator('.dfc-right button', { hasText: '编码' }).click(); await page.waitForTimeout(300);
    await page.locator('.dfe-slot', { hasText: '颜色' }).locator('.dfe-val button').click().catch(() => {});
    await page.locator('.dfc-grid th', { hasText: '类别' }).dragTo(page.locator('.dfe-slot', { hasText: '颜色' })); await page.waitForTimeout(500); await ctx.shot('D4.png');
    await page.locator('.dfc-right button', { hasText: '编码' }).click();
    await page.locator('.dfc-variants button').nth(2).click(); await page.waitForTimeout(500); await ctx.shot('D5.png');
    await ask('天气怎么样'); await page.waitForTimeout(1500); await ctx.shot('D6.png');
    await page.locator('.dfc-close').click(); await page.waitForTimeout(500); await ctx.shot('D7.png');
  },
};
