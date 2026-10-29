// 由前端阶段的 /tmp/rl-prof/rd.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'rd',
  title: '研究台：精读',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=research&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2000);
    await page.locator('.rd-para').nth(3).hover(); await page.waitForTimeout(600); await ctx.shot('R1.png');
    await page.locator('.ad-input textarea').fill('为什么要除以根号d'); await page.keyboard.press('Enter'); await page.waitForTimeout(1600);
    await page.locator('.an-toggle button').nth(1).click(); await page.locator('.an-slider input').first().fill('9'); await page.waitForTimeout(700); await ctx.shot('R2.png');
    await page.locator('.rd-lab-tabs button').nth(1).click(); await page.waitForTimeout(600); await page.locator('.an-heat canvas').click({ position: { x: 120, y: 200 } }); await page.waitForTimeout(400); await ctx.shot('R3.png');
    await page.locator('.rd-lab-tabs button').nth(2).click(); await page.waitForTimeout(600); await page.locator('.an-head').nth(2).click(); await page.waitForTimeout(400); await ctx.shot('R4.png');
    await page.locator('.en-tabs button').nth(2).click(); await page.waitForTimeout(1000); await page.locator('.rd-run').click(); await page.waitForTimeout(3200); await ctx.shot('R5.png');
    await page.locator('.en-tabs button').nth(3).click(); await page.waitForTimeout(1000);
    await page.locator('.rd-q textarea').nth(0).fill('维度大了点积数值太大，softmax 会饱和，梯度没了'); await page.locator('.rd-q .rh-btn').nth(0).click();
    await page.locator('.rd-q textarea').nth(1).fill('因为可以并行'); await page.locator('.rd-q .rh-btn').nth(1).click(); await page.waitForTimeout(500); await ctx.shot('R6.png');
    await page.locator('.en-tabs button').nth(0).click(); await page.waitForTimeout(1000);
    await page.locator('.rd-depth button').nth(4).click(); await page.waitForTimeout(500);
    await page.locator('.rd-dispatch').first().click(); await page.waitForTimeout(1500); await ctx.shot('R7.png');
  },
};
