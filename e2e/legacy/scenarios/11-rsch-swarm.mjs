// 群研（模拟适配器）：计划卡确认 → 真实形状的事件回放 → 四个面 → 暂停 → 回放只读。
export default {
  id: 'sw',
  title: '研究台：群研计划确认、通信与干预',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=research&file=1'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.sw-plan').waitFor(); await ctx.shot('W1.png');
    await page.locator('.sw-plan .rh-btn.is-solid').click();
    await page.locator('.sw-roster button', { hasText: '核实 01' }).waitFor({ timeout: 8000 });
    await page.waitForTimeout(10000); await ctx.shot('W2.png');
    if (!(await page.locator('.sw-sub', { hasText: 'r1' }).count())) throw new Error('任务树应按路线分组');
    if (!(await page.locator('.sw-blocked').count())) throw new Error('被挡住的任务应写出原因');
    await page.locator('.en-tabs button').nth(1).click(); await page.waitForTimeout(800);
    await page.locator('.sw-log li button').first().click(); await page.locator('.sw-inspect').waitFor(); await ctx.shot('W3.png');
    await page.locator('.sw-roster button', { hasText: '研究员 01' }).click(); await page.locator('.sw-member li').first().waitFor(); await ctx.shot('W4.png');
    await page.locator('.sw-member header .rh-btn').click();
    await page.locator('.sw-track').click({ position: { x: 80, y: 12 } }); await page.locator('.sw-replay-note').waitFor(); await ctx.shot('W5.png');
    await page.locator('.sw-live').click();
    await page.locator('.en-tabs button').nth(2).click(); await page.waitForTimeout(600);
    await page.locator('.sw-post input').fill('@lead 只看相同总 token 预算下的比较'); await page.locator('.sw-post .rh-btn').click(); await page.waitForTimeout(600);
    if (!(await page.locator('.sw-cols li[data-you]').count())) throw new Error('你的留言应出现在留言板');
    await page.locator('.sw-ctl button', { hasText: '暂停' }).click(); await page.waitForTimeout(1200);
    if (!(await page.locator('.sw-ctl button', { hasText: '继续' }).count())) throw new Error('暂停后应能继续');
    await page.locator('.en-tabs button').nth(3).click(); await page.waitForTimeout(800);
    if (!(await page.locator('.sw-candidate').count())) throw new Error('核实未接通时汇总应标明全是候选');
    await ctx.shot('W6.png');
  },
};
