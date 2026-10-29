// 研究台精读 · 发起一次运行（mock 数据源回放，与 live 共用同一套界面，design/RESEARCH_LIVE_FRONTEND.md）：
// 新建精读 → 先在对话里说想读什么（模糊的「react」会被追问澄清）→ 对话里的候选卡片由你选一篇 → 按这篇的长度预估 → 确认 →
// 批准下载全文 → 讲解一层层长出来 → 完成并结算 → 追问 → 检验；
// 另走一遍：选了示例没备讲解的论文，要如实说明，而不是拿示例论文冒充。
export default {
  id: 'read-run',
  title: '研究台精读：对话澄清选论文、预估确认、批准下载、逐层生成、完成、追问',
  async run(ctx) {
    const { page } = ctx;
    const talk = async t => { await page.locator('.ad-input textarea').fill(t); await page.keyboard.press('Enter'); await page.waitForTimeout(1300); };
    await page.goto(ctx.url('/?preview=workbench&studio=research&file=0'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2000);
    if (!(await page.locator('.rd-runbar').textContent()).includes('已完成')) throw new Error('打开已有档案时应显示「已完成」');
    await page.locator('.rd-new').click(); await page.locator('.rd-start').waitFor(); await ctx.shot('RR1.png');
    if (await page.locator('.rd-start .rd-go').count()) throw new Error('没选定论文之前不应能预估');
    // 模糊说法：追问澄清，候选里是 ReAct，不冒出 Attention
    await talk('react');
    await page.locator('.ad .rd-pick').last().waitFor();
    const pick1 = await page.locator('.ad .rd-pick').last().textContent();
    if (!pick1.includes('ReAct') || pick1.includes('Attention Is All You Need')) throw new Error('搜 react 应只列出 ReAct');
    if (!(await page.locator('.ad').textContent()).includes('前端框架')) throw new Error('react 有歧义，应先追问');
    await ctx.shot('RR2.png');
    await page.locator('.ad .rd-pick').last().locator('.rh-btn', { hasText: '都不是' }).click(); await page.waitForTimeout(800);
    // 换个说法，选 Attention
    await talk('Transformer 的原始论文 attention');
    await page.locator('.ad .rd-pick li button', { hasText: 'Attention Is All You Need' }).last().click();
    await page.locator('.rd-chosen').waitFor(); await ctx.shot('RR3.png');
    await page.locator('.rd-start .rd-go').click(); await page.locator('.rd-estimate').waitFor({ timeout: 5000 });
    await page.locator('.rd-estimate .rd-go').click();
    await page.locator('.rd-start-ap').waitFor({ timeout: 8000 }); await ctx.shot('RR4.png');
    if (!(await page.locator('.ad-approval').count())) throw new Error('助手面板里也应出现审批卡');
    await page.locator('.rd-start-ap .rd-go').click();
    await page.locator('.rd-runbar[data-state="running"]').waitFor({ timeout: 6000 });
    await page.locator('.rd-writing').waitFor({ timeout: 8000 }); await ctx.shot('RR5.png');
    await page.locator('.rd-runbar[data-state="done"]').waitFor({ timeout: 20000 });
    if ((await page.locator('.rd-layer').count()) !== 5) throw new Error('完成后应展开 5 层讲解');
    if (!(await page.locator('.rd-finding').count())) throw new Error('完成后应有发现卡');
    if (!(await page.locator('.rd-run-cost').textContent()).includes('¥0.11')) throw new Error('完成后应显示实际花费');
    // 追问：回答带原文定位；新档案没有交互动画（真实模式第二期由 OpenMAIC 提供），不应出现「打开动画」
    await talk('为什么要除以根号d');
    await page.locator('.rd-source section[data-on]').first().waitFor({ timeout: 4000 });
    if (await page.locator('.ad-ref', { hasText: '打开动画' }).count()) throw new Error('没有动画时不应出现「打开动画」');
    await ctx.shot('RR6.png');
    await page.locator('.en-tabs button').nth(1).click(); await page.locator('.rd-later').waitFor(); await page.waitForTimeout(300);
    await page.locator('.en-tabs button').nth(3).click(); await page.waitForTimeout(600);
    await page.locator('.rd-q textarea').nth(0).fill('维度大了点积数值太大，softmax 会饱和，梯度没了'); await page.locator('.rd-q .rh-btn').nth(0).click(); await page.waitForTimeout(500);
    if ((await page.locator('.rd-q').nth(0).getAttribute('data-s')) !== 'ok') throw new Error('答到要点应判为理解到位');
    // 选了示例没备讲解的论文：如实说明
    await page.locator('.en-tabs button').nth(0).click(); await page.waitForTimeout(500);
    await page.locator('.rd-new').click(); await page.locator('.rd-start').waitFor();
    await talk('LoRA 低秩微调');
    await page.locator('.ad .rd-pick li button', { hasText: 'LoRA: Low-Rank' }).last().click();
    await page.locator('.rd-start .rd-go').click(); await page.locator('.rd-estimate .rd-go').click();
    await page.locator('.rd-start-ap .rd-go').click(); await page.locator('.rd-empty').waitFor({ timeout: 6000 });
    if (!(await page.locator('.rd-empty').textContent()).includes('真实模式')) throw new Error('应如实说明这篇要在真实模式下生成');
    await ctx.shot('RR7.png');
  },
};
