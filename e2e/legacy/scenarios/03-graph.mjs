// 由前端阶段的 /tmp/rl-prof/gx.mjs 整理而来：步骤与等待时长保持原样。
export default {
  id: 'gx',
  title: '自动化台节点图：排队、写入批准、缓存、缺模型、一句话搭图、发布',
  async run(ctx) {
    const { page } = ctx;
    const shot = n => ctx.shot(`G${n}.png`);
    await page.goto(ctx.url('/?preview=workbench&studio=automation&file=2'), { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2200);
    await page.getByRole('tab', { name: /节点/ }).click(); await page.waitForTimeout(1300); await shot(1);
    // WFG-03：排队 → 写入节点等批准
    await page.locator('.gq-run').click(); await page.waitForTimeout(3000); await shot(2);
    await page.waitForTimeout(4500); await shot(3);
    await page.locator('.ad-approval .rh-btn.is-solid').last().click(); await page.waitForTimeout(1200); await shot(4);
    // 再排一次：缓存
    await page.locator('.gq-run').click(); await page.waitForTimeout(1500); await shot(5); await page.waitForTimeout(4000);
    await page.locator('.ad-approval .rh-btn').last().click().catch(() => {}); await page.waitForTimeout(500);
    // WFG-01：缺模型
    await page.locator('.au-item', { hasText: '夏尔插画' }).click(); await page.waitForTimeout(800);
    await page.locator('.gq-run').click(); await page.waitForTimeout(800); await shot(6);
    await page.locator('.gm-card .rh-btn').first().click(); await page.waitForTimeout(3000); await shot(7);
    // 一句话搭图
    await page.locator('.ad-input textarea').fill('搭一张竖版赏枫海报，4 张'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500); await shot(8); await page.waitForTimeout(3500); await shot(9);
    // 双击搜索
    await page.locator('.gf-act button', { hasText: '节点助手' }).click(); await page.waitForTimeout(300);
    const box = await page.locator('.gx').boundingBox();
    await page.mouse.dblclick(box.x + 120, box.y + box.height - 120); await page.waitForTimeout(300); await page.keyboard.type('预览'); await page.waitForTimeout(300); await shot(10);
    await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    // 发布弹层
    await page.locator('.gf-popwrap > button').nth(1).click(); await page.waitForTimeout(300); await shot(11);
    await page.keyboard.press('Escape');
    // 编排面 WF-05 打开节点图
    await page.getByRole('tab', { name: /编排/ }).click(); await page.waitForTimeout(900);
    await page.locator('.au-item', { hasText: '作品定稿归档' }).click(); await page.waitForTimeout(400);
    await page.locator('.au-graphtool').scrollIntoViewIfNeeded(); await shot(12);
    await page.locator('.au-graphtool button').click(); await page.waitForTimeout(1200); await shot(13);
  },
};
