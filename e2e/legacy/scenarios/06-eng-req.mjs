// 由前端阶段的 /tmp/rl-prof/rq.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'rq',
  title: '工程台需求：补全、校验批注、选项修正、并排、助手流程',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=engineering&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800); await ctx.shot('R1.png');
    // 补全：点 AC-6 末尾
    const ac6 = page.locator('[data-block="AC-6"] .rq-edit');
    await ac6.click(); await page.keyboard.press('End'); await page.waitForTimeout(500);
    await ctx.shot('R2.png');
    ctx.note('ghost:', await page.locator('[data-block="AC-6"] .rq-ghost').textContent().catch(() => null));
    await page.keyboard.press('Tab'); await page.waitForTimeout(400);
    ctx.note('AC-6 state:', await page.locator('[data-block="AC-6"]').getAttribute('data-state'), await page.locator('[data-block="AC-6"] textarea').inputValue());
    // 新段落 + 补全
    await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    ctx.note('new ghost:', await page.locator('.rq-ghost').textContent().catch(() => null));
    await page.keyboard.type('Given 选中'); await page.waitForTimeout(500);
    ctx.note('ghost2:', await page.locator('.rq-ghost').textContent().catch(() => null));
    await page.keyboard.press('Tab'); await page.waitForTimeout(300); await ctx.shot('R3.png');
    // 校验
    await page.locator('.rq-verify').click(); await page.waitForTimeout(500); await ctx.shot('R4.png');
    await page.waitForTimeout(1500); await ctx.shot('R5.png');
    ctx.note('notes:', await page.locator('.rq-note').count());
    // 选项修正 AC-4
    await page.locator('[data-block="AC-4"] .rq-options button').first().click(); await page.waitForTimeout(400);
    // 短提交 AC-5
    await page.locator('[data-block="AC-5"] .rq-reply input').fill('这里是故意的：在演示模式里档案场有尽头，产品要求保留。');
    await page.locator('[data-block="AC-5"] .rq-reply button').click(); await page.waitForTimeout(1200); await ctx.shot('R6.png');
    // 再校验
    await page.locator('.rq-verify').click(); await page.waitForTimeout(1900); await ctx.shot('R7.png');
    ctx.note('open notes r2:', await page.locator('.rq-note:not(.is-folded)').count());
    // 并排 + 目录双击
    await page.locator('.rq-seg button').nth(1).click(); await page.waitForTimeout(300);
    await page.locator('.rq-pane').nth(1).click({ position: { x: 100, y: 15 } });
    await page.locator('.xp-row', { hasText: 'REQ-021.md' }).first().dblclick(); await page.waitForTimeout(500); await ctx.shot('R8.png');
    // 助手流程
    await page.locator('.ad-suggest button', { hasText: '调阅档案' }).click(); await page.waitForTimeout(1200); await ctx.shot('R9.png');
    await page.locator('.rq-flow li button').nth(3).click(); await page.waitForTimeout(800); await ctx.shot('R10.png');
    // 收起目录
    await page.locator('.xp-head button').click(); await page.waitForTimeout(300); await ctx.shot('R11.png');
  },
};
