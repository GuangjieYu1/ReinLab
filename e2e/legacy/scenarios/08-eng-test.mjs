// 由前端阶段的 /tmp/rl-prof/tst.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'tst',
  title: '工程台测试：接口、录制回放、分析、矩阵',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=engineering&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500);
    await page.waitForTimeout(1000);
    await page.locator('.en-tabs button').nth(2).click(); await page.waitForTimeout(900); await ctx.shot('S1.png');
    await page.locator('.ts-case', { hasText: 'PATCH' }).click(); await page.waitForTimeout(500); await ctx.shot('S2.png');
    await page.locator('.dv-tabs button', { hasText: '录制回放' }).click(); await page.waitForTimeout(300);
    await page.locator('.ts-timeline > button').click(); await page.waitForTimeout(3300); await ctx.shot('S3.png');
    await page.locator('.dv-tabs button', { hasText: '接口' }).click(); await page.waitForTimeout(300);
    await page.locator('.dv-api-req .rh-btn').click(); await page.waitForTimeout(700); await ctx.shot('S4.png');
    await page.locator('.ad-suggest button', { hasText: '分析' }).click(); await page.waitForTimeout(1500);
    await page.locator('.ad-suggest button', { hasText: '390' }).click(); await page.waitForTimeout(500);
    await page.locator('.dv-tabs button', { hasText: '矩阵' }).click(); await page.waitForTimeout(500); await ctx.shot('S5.png');
    await page.waitForTimeout(2000);
    await page.locator('.ts-mx-head .rh-btn').click(); await page.waitForTimeout(1000); await ctx.shot('S6.png');
    await page.locator('.ad-suggest button', { hasText: 'AC-3' }).click(); await page.waitForTimeout(300);
    await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(1500); await ctx.shot('S7.png');
    // 带到开发面
    await page.locator('.ts-case', { hasText: '窄屏下列表竖排' }).click(); await page.waitForTimeout(400);
    await page.locator('.ts-stack .rh-btn.is-solid').click(); await page.waitForTimeout(1200); await ctx.shot('S8.png');
  },
};
