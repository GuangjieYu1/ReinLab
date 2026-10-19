// 由前端阶段的 /tmp/rl-prof/au.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'au',
  title: '自动化台：编排歧义 → 预演 → 一句话新建 → 运行批准 → 维护修复',
  async run(ctx) {
    const { page } = ctx;
    const shot = n => ctx.shot(`A${n}.png`);
    await page.goto(ctx.url('/?preview=workbench&studio=automation&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2200);
    await shot(1);
    // 编排：说清歧义 → 预演
    await page.locator('.au-amb-card').first().locator('button').first().click(); await page.waitForTimeout(300);
    await page.locator('.au-head-act .rh-btn', { hasText: '预演' }).click(); await page.waitForTimeout(3200); await shot(2);
    // 一句话新建
    await page.locator('.au-new').click(); await page.locator('.ad-input textarea').fill('每周五下午 5 点把本周实验整理成周报'); await page.keyboard.press('Enter');
    await page.waitForTimeout(1600); await shot(3); await page.waitForTimeout(3500); await shot(4);
    // 运行：选 WF-01，批准
    await page.locator('.au-item', { hasText: '每日资料整理' }).first().click(); await page.waitForTimeout(200);
    await page.getByRole('tab', { name: /运行/ }).click(); await page.waitForTimeout(1200); await shot(5);
    await page.locator('.au-step-line', { hasText: '为 12 份' }).click(); await page.waitForTimeout(300);
    await page.locator('.au-step-act .rh-btn.is-solid').click(); await page.waitForTimeout(500); await shot(6);
    // 立即运行
    await page.locator('.au-matrix .au-mx-row', { hasText: '明日接续清单' }).click(); await page.waitForTimeout(200);
    await page.locator('.au-head .au-run').click(); await page.waitForTimeout(1300); await shot(7); await page.waitForTimeout(2500);
    // 维护
    await page.getByRole('tab', { name: /维护/ }).click(); await page.waitForTimeout(1200); await shot(8);
    for (let k = 0; k < 3; k++) { await page.locator('.au-head .au-run').click(); await page.waitForTimeout(k === 2 ? 1500 : 2000); if (k === 2) await shot(9); await page.waitForTimeout(k === 2 ? 4500 : 0); }
    await shot(10);
    await page.locator('.au-review .rh-btn.is-solid').click(); await page.waitForTimeout(700); await shot(11);
    await page.getByRole('tab', { name: /编排/ }).click(); await page.waitForTimeout(1200); await shot(12);
  },
};
