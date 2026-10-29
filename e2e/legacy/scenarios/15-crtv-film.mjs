// 由前端阶段的 /tmp/rl-prof/vf.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'vf',
  title: '创作台：分镜 → 机位 → 一致性 → 成片',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=creative&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2000);
    await page.locator('.en-tabs button').nth(1).click(); await page.waitForTimeout(1200);
    await page.locator('.ad-suggest button', { hasText: '转为分镜' }).click(); await page.waitForTimeout(300); await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(1700);
    await page.locator('.en-tabs button').nth(2).click(); await page.waitForTimeout(1400); await ctx.shot('F1.png');
    await page.locator('.vf-prompt .rh-btn').click(); await page.waitForTimeout(300); await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(1300); await ctx.shot('F2.png');
    await page.waitForTimeout(2200); await ctx.shot('F3.png');
    const cv = page.locator('.vp-canvas'); const b = await cv.boundingBox();
    await page.mouse.move(b.x + 200, b.y + 120); await page.mouse.down(); await page.mouse.move(b.x + 320, b.y + 160, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(300); await ctx.shot('F4.png');
    await page.locator('.ad-suggest button', { hasText: '摆机位' }).click(); await page.waitForTimeout(300); await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(3200); await ctx.shot('F5.png');
    await page.locator('.vf-modes button').nth(0).click(); await page.waitForTimeout(400); await ctx.shot('F6.png');
    await page.locator('.ad-suggest button', { hasText: '检查一致性' }).click(); await page.waitForTimeout(1500); await page.locator('.vf-issue button').click(); await page.waitForTimeout(300);
    await page.locator('.ad-suggest button', { hasText: '生成全部成片' }).click(); await page.waitForTimeout(300); await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(8000); await ctx.shot('F7.png');
    await page.locator('.vf-modes button').nth(3).click(); await page.waitForTimeout(400); await ctx.shot('F8.png');
    await page.locator('.vf-shots button').nth(3).click(); await page.locator('.vf-modes button').nth(1).click(); await page.locator('.sw-play').click(); await page.waitForTimeout(2500); await ctx.shot('F9.png');
  },
};
