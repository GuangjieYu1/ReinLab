// 由前端阶段的 /tmp/rl-prof/dev.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'dev',
  title: '工程台开发：窄屏预览、ToImpl 批准、Diff 评论、终端、Issue',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=engineering&file=0'), { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.locator('.en-tabs button').nth(1).click(); await page.waitForTimeout(900); await ctx.shot('D1.png');
    // 预览：窄屏 + 点选
    await page.locator('.dv-pv-tools button', { hasText: '390' }).click(); await page.waitForTimeout(600);
    await page.locator('.dv-pick').click(); await page.locator('.dv-app-list li').nth(1).click(); await page.waitForTimeout(1000); await ctx.shot('D2.png');
    // ToImpl
    await page.locator('.ad-suggest button', { hasText: 'ToImpl' }).click(); await page.waitForTimeout(300);
    await page.locator('.ad-approval button', { hasText: '批准' }).last().click(); await page.waitForTimeout(700); await ctx.shot('D3.png');
    await page.waitForTimeout(1500); await ctx.shot('D4.png');
    // Diff 评论
    await page.locator('.dv-line').nth(3).click(); await page.locator('.dv-comment input').fill('这里用 ref 保存 map'); await page.locator('.dv-comment .rh-btn').click(); await page.waitForTimeout(1000); await ctx.shot('D5.png');
    // 终端
    await page.locator('.dv-tabs button', { hasText: '终端' }).click(); await page.waitForTimeout(500); await ctx.shot('D7.png');
    // 刷新 issue + 切到 ISS-33
    await page.locator('.xp-sec-act button', { hasText: '刷新' }).click(); await page.waitForTimeout(500);
    await page.locator('.dv-issues button', { hasText: 'ISS-33' }).click(); await page.waitForTimeout(900); await ctx.shot('D8.png');
    // 双击文件 + 追溯视图
    await page.locator('.xp-row', { hasText: 'browser.css' }).dblclick(); await page.waitForTimeout(500);
    await page.locator('.xp-bar button').nth(3).click(); await page.waitForTimeout(500); await ctx.shot('D9.png');
  },
};
