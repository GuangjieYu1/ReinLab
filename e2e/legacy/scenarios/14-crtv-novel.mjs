// 由前端阶段的 /tmp/rl-prof/nv.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'nv',
  title: '创作台：一致性、续写、转为分镜',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=creative&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2000);
    await ctx.shot('V0.png');
    await page.locator('.en-tabs button').nth(1).click(); await page.waitForTimeout(1500); await ctx.shot('V1.png');
    await page.locator('.nv-para').last().click(); await page.waitForTimeout(400); await ctx.shot('V2.png');
    await page.keyboard.press('Tab'); await page.waitForTimeout(300);
    await page.locator('.ad-suggest button', { hasText: '一致性' }).click(); await page.waitForTimeout(2000); await ctx.shot('V3.png');
    await page.locator('.nv-note .rq-options button').first().click(); await page.waitForTimeout(500);
    await page.locator('.ad-suggest button', { hasText: '续写' }).click(); await page.waitForTimeout(300); await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(3000); await ctx.shot('V4.png');
    await page.locator('.cr-seg button').nth(1).click(); await page.waitForTimeout(800);
    const src = page.locator('.nv-beats article').first(), dst = page.locator('.nv-beats section').nth(2).locator('.nv-drop');
    await src.dragTo(dst); await page.waitForTimeout(500); await ctx.shot('V5.png');
    await page.locator('.ad-suggest button', { hasText: '转为分镜' }).click(); await page.waitForTimeout(300); await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(1800);
    await page.locator('.en-tabs button').nth(2).click(); await page.waitForTimeout(1300); await ctx.shot('V6.png');
    await page.locator('.en-tabs button').nth(0).click(); await page.waitForTimeout(1300); await ctx.shot('V7.png');
  },
};
