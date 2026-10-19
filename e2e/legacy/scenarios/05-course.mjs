// 由前端阶段的 /tmp/rl-prof/cu.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'cu',
  title: '课程台：备课门禁流水线 → 开课 → 课堂 / 精读 / 考核 / 收尾',
  async run(ctx) {
    const { page } = ctx;
    const shot = n => ctx.shot(`C${n}.png`);
    const tab = name => page.getByRole('tab', { name }).click();
    await page.goto(ctx.url('/?preview=workbench&studio=curriculum&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2400);
    await shot(1);
    await tab(/学习/); await page.waitForTimeout(1200); await shot(2);
    await tab(/备课/); await page.waitForTimeout(1200);
    await page.locator('.cu-fix .rh-btn').click(); await page.waitForTimeout(2800);
    await page.locator('.cu-fix .rh-btn').click(); await page.waitForTimeout(2800); await shot(3);
    await page.locator('.cu-pipe button', { hasText: '侦查' }).click(); await page.waitForTimeout(300); await shot(4);
    await page.locator('.cu-coregap .rh-btn').click(); await page.waitForTimeout(2300);
    await page.locator('.cu-pipe button', { hasText: '构建' }).click().catch(() => {});
    await page.locator('.cu-pipe button', { hasText: '单元备课' }).click(); await page.waitForTimeout(300); await shot(5);
    await page.locator('.cu-pipe button', { hasText: '开课' }).click(); await page.waitForTimeout(300);
    await page.locator('.cu-open').click(); await page.waitForTimeout(400); await shot(6);
    await tab(/学习/); await page.waitForTimeout(1500); await shot(7);
    for (let i = 0; i < 4; i++) { await page.locator('.cu-teacher-act > button').nth(1).click(); await page.waitForTimeout(150); }
    await page.waitForTimeout(2500); await shot(8);
    await page.locator('.cu-tabs button', { hasText: '精读' }).click(); await page.waitForTimeout(300);
    await page.locator('.cu-read aside button').nth(1).click(); await page.waitForTimeout(900); await shot(9);
    await page.locator('.cu-tabs button', { hasText: '考核' }).click(); await page.waitForTimeout(300);
    const opts = page.locator('.cu-exam li');
    await opts.nth(0).locator('.cu-opts button').nth(1).click(); await opts.nth(1).locator('.cu-opts button').nth(0).click();
    await opts.nth(2).locator('.cu-opts button').nth(1).click(); await opts.nth(3).locator('.cu-opts button').nth(1).click();
    await opts.nth(4).locator('textarea').fill('设 e 和 e′ 都是单位元。e = e·e′（因为 e′ 是单位元）= e′（因为 e 是单位元）。');
    await opts.nth(5).locator('textarea').fill('任意 a、b，每个元素是自己的逆，所以 a·b = (a·b)⁻¹ = b⁻¹·a⁻¹ = b·a，交换。');
    await page.locator('.cu-exam .cu-open').click(); await page.waitForTimeout(600); await shot(10);
    await page.locator('.cu-grade button').first().click(); await page.waitForTimeout(2000); await shot(11);
    await page.locator('.cu-tabs button', { hasText: '收尾' }).click(); await page.waitForTimeout(300);
    await page.locator('.cu-close .cu-open, .cu-locked .cu-open').click().catch(() => {}); await page.waitForTimeout(2000);
    await page.locator('.cu-close .rh-btn').click().catch(() => {}); await page.waitForTimeout(400);
    await page.locator('.ad-approval .rh-btn.is-solid').last().click().catch(() => {}); await page.waitForTimeout(1800); await shot(12);
    await page.locator('.ad-input textarea').fill('我想直接学 U3'); await page.keyboard.press('Enter'); await page.waitForTimeout(900); await shot(13);
    await tab(/备课/); await page.waitForTimeout(1200);
    await page.locator('.cu-pipe button', { hasText: '蓝图' }).click(); await page.waitForTimeout(300);
    await page.locator('.cu-unit button').first().click(); await page.waitForTimeout(900);
    await page.locator('.cu-canvas .rh-btn').click(); await page.waitForTimeout(400); await shot(14);
  },
};
