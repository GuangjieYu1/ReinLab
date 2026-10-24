// 「上线时待批准」收件箱（design/BACKEND_MEMORY_SESSION.md §13，示例数据）：
// 展开依据 → 键盘批准 → 改一下再批准 → 只存本档案 → 驳回 → 批准一次动作 → 结果未知的动作不可操作 → 清空。
export default {
  id: 'inbox',
  title: '上线收件箱：依据、批准、修改后批准、只存本档案、驳回、单次动作、清空',
  async run(ctx) {
    const { page } = ctx;
    const press = async k => { await page.keyboard.press(k); await page.waitForTimeout(1000); };
    await page.goto(ctx.url('/?preview=inbox'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.ibx-row').first().waitFor(); await page.waitForTimeout(600); await ctx.shot('I1.png');
    const rows = await page.locator('.ibx-row').count();
    if (rows !== 8) throw new Error(`应有 8 条（5 条提议 + 3 个动作），实际 ${rows}`);
    // 依据展开
    await page.locator('.ibx-ev button').first().click(); await page.locator('.ibx-quote q').first().waitFor(); await ctx.shot('I2.png');
    await press('a');                                                     // 批准
    if (!(await page.locator('.ibx-row').first().getAttribute('data-done'))) throw new Error('批准后第一条应标为已处理');
    await press('e');                                                     // 改一下再批准
    await page.locator('.ibx-items textarea').first().fill('先看图表与结论，再看方法；实验密集的论文先看附录的超参数表。');
    await ctx.shot('I3.png');
    await page.locator('.ibx-actions .ibx-btn.is-solid').click(); await page.waitForTimeout(1000);
    await press('l');                                                     // 只存本档案
    await press('r');                                                     // 驳回
    await press('a');                                                     // 最后一条提议
    await ctx.shot('I4.png');
    await press('a');                                                     // 批准一次动作
    await press('r');                                                     // 驳回一次动作
    // 结果未知的动作：没有批准 / 驳回按钮
    await page.locator('.ibx-row', { hasText: '03-method' }).click(); await page.waitForTimeout(400);
    if (await page.locator('.ibx-actions .ibx-btn').count()) throw new Error('结果未知的动作不应能再次批准');
    await ctx.shot('I5.png');
    const done = await page.locator('.ibx-row[data-done]').count();
    if (done !== 7) throw new Error(`应处理 7 条，实际 ${done}`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    if (await page.locator('.ibx').count()) throw new Error('Esc 应关闭收件箱');
    if ((await page.locator('.ibx-open').getAttribute('data-n')) !== null) throw new Error('处理完后入口不应再有待办数字');
  },
};
