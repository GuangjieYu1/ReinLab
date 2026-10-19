// 由前端阶段的 /tmp/rl-prof/ex.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'ex',
  title: '探索台：拍照计划 → 机位视角 → 现场改计划 → 回顾与转交',
  async run(ctx) {
    const { page } = ctx;
    const shot = n => ctx.shot(`E${n}.png`);
    await page.goto(ctx.url('/?preview=workbench&studio=exploration&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2400);
    await shot(1);
    await page.locator('.dl-spot').nth(5).click(); await page.waitForTimeout(400); await shot(2);
    await page.locator('.ex-go').click(); await page.waitForTimeout(4600); await shot(3);
    await page.locator('.ex-book').evaluate(e => e.scrollTo(0, 900)); await page.waitForTimeout(300); await shot(4);
    await page.getByRole('tab', { name: /机位/ }).click(); await page.waitForTimeout(1200); await shot(5);
    await page.locator('.ex-acts .rh-btn.is-solid').click(); await page.waitForTimeout(1700);
    await page.locator('.ex-seg button', { hasText: '机位视角' }).click(); await page.waitForTimeout(400); await shot(6);
    await page.locator('.ex-spots button').first().click(); await page.waitForTimeout(400); await page.locator('.ex-seg button', { hasText: '环绕' }).click(); await page.waitForTimeout(300); await shot(7);
    await page.getByRole('tab', { name: /现场/ }).click(); await page.waitForTimeout(1200); await shot(8);
    await page.locator('.ex-sit button', { hasText: '下雨' }).click(); await page.waitForTimeout(1500); await shot(9);
    await page.locator('.ex-proposal .rh-btn.is-solid').click(); await page.waitForTimeout(500);
    await page.getByRole('tab', { name: /回顾/ }).click(); await page.waitForTimeout(1200); await shot(10);
    await page.locator('.ex-head .ex-go').click(); await page.waitForTimeout(2000); await shot(11);
    await page.locator('.ex-tabs button').nth(2).click(); await page.locator('.ex-lessons .rh-btn').first().click(); await page.waitForTimeout(300);
    await page.locator('.ex-hand button').first().click(); await page.waitForTimeout(300); await page.locator('.ad-approval .rh-btn.is-solid').last().click(); await page.waitForTimeout(500); await shot(12);
  },
};
