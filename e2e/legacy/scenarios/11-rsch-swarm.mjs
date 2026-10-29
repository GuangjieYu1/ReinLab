// 由前端阶段的 /tmp/rl-prof/sw.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'sw',
  title: '研究台：群研与反驳',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=research&file=1'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2000);
    await page.waitForTimeout(10500); await ctx.shot('W1.png');
    await page.locator('.sw-proto-btn').click(); await page.waitForTimeout(400); await ctx.shot('W2.png');
    await page.locator('.sw-proto-btn').click();
    await page.locator('.sw-filters button', { hasText: '反驳' }).click(); await page.waitForTimeout(200);
    await page.locator('.sw-speed').click(); await page.locator('.sw-speed').click(); await page.waitForTimeout(6000);
    const r = page.locator('.sw-log li button').first(); if (await r.count()) { await r.click(); await page.waitForTimeout(500); }
    await ctx.shot('W3.png');
    await page.locator('.en-tabs button').nth(0).click(); await page.waitForTimeout(1100); await ctx.shot('W4.png');
    await page.locator('.en-tabs button').nth(2).click(); await page.waitForTimeout(1100);
    await page.locator('.sw-post input').fill('@C01 给线性注意力找一个反例'); await page.locator('.sw-post .rh-btn').click(); await page.waitForTimeout(3000); await ctx.shot('W5.png');
    await page.locator('.sw-play').click(); await page.waitForTimeout(100);
    await page.locator('.sw-track').click({ position: { x: 560, y: 12 } }); await page.waitForTimeout(300);
    await page.locator('.en-tabs button').nth(3).click(); await page.waitForTimeout(1200); await ctx.shot('W6.png');
  },
};
