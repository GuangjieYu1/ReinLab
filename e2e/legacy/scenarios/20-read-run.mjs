// 研究台精读 · 发起一次运行（mock 数据源回放，与 live 共用同一套界面，design/RESEARCH_LIVE_FRONTEND.md）：
// 新建精读 → 空档案的起始卡 → 预估 → 确认 → 运行中等你批准下载全文 → 批准 → 讲解一层层长出来 → 完成并结算 → 追问。
export default {
  id: 'read-run',
  title: '研究台精读：新建、预估确认、批准下载全文、逐层生成、完成、追问',
  async run(ctx) {
    const { page } = ctx;
    await page.goto(ctx.url('/?preview=workbench&studio=research&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2000);
    if (!(await page.locator('.rd-runbar').textContent()).includes('已完成')) throw new Error('打开已有档案时应显示「已完成」');
    await page.locator('.rd-new').click(); await page.locator('.rd-start').waitFor(); await ctx.shot('RR1.png');
    // 空输入不能预估
    await page.locator('.rd-go').click(); await page.locator('.rd-start-err').waitFor();
    await page.locator('.rd-start-eg button').first().click();
    await page.locator('.rd-go').click(); await page.locator('.rd-estimate').waitFor({ timeout: 5000 }); await ctx.shot('RR2.png');
    await page.locator('.rd-estimate .rd-go').click();
    await page.locator('.rd-start-ap').waitFor({ timeout: 8000 }); await ctx.shot('RR3.png');
    if (!(await page.locator('.ad-approval').count())) throw new Error('助手面板里也应出现审批卡');
    await page.locator('.rd-start-ap .rd-go').click();
    await page.locator('.rd-runbar[data-state="running"]').waitFor({ timeout: 6000 });
    await page.locator('.rd-writing').waitFor({ timeout: 8000 }); await ctx.shot('RR4.png');
    await page.locator('.rd-runbar[data-state="done"]').waitFor({ timeout: 20000 });
    const layers = await page.locator('.rd-layer').count();
    if (layers !== 5) throw new Error(`完成后应展开 5 层讲解，实际 ${layers}`);
    if (!(await page.locator('.rd-finding').count())) throw new Error('完成后应有发现卡');
    if (!(await page.locator('.rd-run-cost').textContent()).includes('¥0.11')) throw new Error('完成后应显示实际花费');
    await ctx.shot('RR5.png');
    // 追问：回答带原文定位；新档案还没有交互动画（真实模式第二期由 OpenMAIC 提供），不应出现「打开动画」
    await page.locator('.ad-input textarea').fill('为什么要除以根号d'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
    await page.locator('.rd-source section[data-on]').first().waitFor({ timeout: 4000 });
    if (await page.locator('.ad-ref', { hasText: '打开动画' }).count()) throw new Error('没有动画时不应出现「打开动画」');
    await ctx.shot('RR6.png');
    await page.locator('.en-tabs button').nth(1).click(); await page.locator('.rd-later').waitFor(); await page.waitForTimeout(300);
    // 检验：评分走数据源
    await page.locator('.en-tabs button').nth(3).click(); await page.waitForTimeout(600);
    await page.locator('.rd-q textarea').nth(0).fill('维度大了点积数值太大，softmax 会饱和，梯度没了'); await page.locator('.rd-q .rh-btn').nth(0).click(); await page.waitForTimeout(500);
    if ((await page.locator('.rd-q').nth(0).getAttribute('data-s')) !== 'ok') throw new Error('答到要点应判为理解到位');
  },
};
