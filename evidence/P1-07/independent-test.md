# P1-07 R2 独立测试

状态：**通过，62/62**。本独立agent亲自执行28项原创测试和34项开发方测试。R1的40项通过仅为历史证据，本结论基于三维层级实现与迁移0010～0012后的重新执行。

## 环境与执行

本机真实PostgreSQL 55432，应用角色reinlab_app通过安全角色检查，所有新fixture使用随机账户、档案、运行ID。测试JWT是本地临时生成；未读取真实凭据，未调用任何模型。故障注入触发器只匹配本人的随机run，finally删除；深度验证事务整体回滚。其余随机测试数据保留便于审计，未清理他人对象。测试由Node22执行。

命令：`PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH ./node_modules/.bin/vitest run services/control/test/independent-budget.test.ts services/control/test/budget.test.ts --reporter=json --outputFile=evidence/P1-07/independent-test-r2-final-vitest.json`。

最终原始报告：`independent-test-r2-final-vitest.json`。R2先独立执行24/24，再扩展至60/60，补数据库环与深度后62/62，记录分别为`independent-test-r2-first.json`、`independent-test-r2-pre-depth-vitest.json`和最终报告。最终结构化结果及16个实现/测试/迁移SHA-256见`independent-test.json`。原创测试位于`services/control/test/independent-budget.test.ts`，证据副本为`independent-budget.source.txt`。

## 本agent原创覆盖

R1原创14项仍全部通过：六位定点输入边界；人民币尾额十并发仅一次授权；六并发同request/结算不双计；新增三表RLS读写和权限；同账户错误run/hold来源FK；旧月自身reserved/unpriced禁止续月；UTC边界；父reserved/unpriced不可二次划拨；子追加扣父在途费用并增长祖先；父续月检查子树reserved/unpriced。

R2新增14项全部通过：

- 根档案未明确会员/GPUcap为null；有限父cap严格限制自身在途预留和子授予。
- 未知人民币费用已报告的会员/GPU实际量已计入累计，原hold只保留剩余最大量。
- 子三维实际用量逐级累计至祖先run和allocation；五并发同收据结算仅产生一条实际调用run的cost，不双计。
- 会员/GPU尾额十并发仅一次获准，结算达到父和子100%时两者暂停。
- 同一用户三维追加同步所需祖先，受影响run预算版本各只加一次。
- 子树费用未对账时追加不能恢复祖先；真实对账后显式追加可恢复符合条件祖先及子run。
- 故障注入导致所有祖先的人民币/会员/GPU累计和hold收据回滚；修复后重复结算仍只计一次。
- paused_budget、completed、cancelled、failed、interrupted祖先均阻止新的子工具授权。
- 应用角色无法更改allocation来源/月份或hold原始人民币/会员/GPU上限与run身份。
- UTC新月明确重授后新allocation量归零、额度仅为本月重授量；同run保留旧月累计。
- 跨档案委托明确父来源，三维实际量向上累计；追加同步委托request.budget、委托限额及所需祖先；账本仅实际调用run记cost。
- 嵌套运行必须先父确认新月，再子确认；旧用量保留且不占新月授予。
- 数据库触发器拒绝本人的来源环，失败不改变原来源。
- 数据库允许32层来源，拒绝第33层，并将整次插入事务回滚。

## 开发方套件独立复跑

34项由开发方编写，本agent重新执行全部通过，覆盖价格目录/失效配置/非目标模型、估算有效期与模式角色/账户/消费约束、真实queued但不执行模型、输入脱敏、80%提醒/100%停、预留超额真实记账、结算幂等、故障事务、人民币与会员/GPU追加、账户/档案视图、跨档案委托、三维层级、祖先恢复和合法多笔大费用累计。这些测试使用本地HTTP目录，仅为测试数据。

## 历史与边界

R1发现的三个阻断（父在途费用重复划拨、子追加误用父预留、祖先续月漏查子在途）及修复前失败原始JSON均保留。旧签署报告和哈希分别归档为`independent-test-r1.md`、`independent-test-r1.json`，旧原创测试副本为`independent-budget-r1.source.txt`。R1所述“会员/GPU仅运行级”已被R2三维层级实现及本次测试取代。

本次确认人民币、会员额度和GPU秒都支持运行/委托层级约束及祖先累计。账户只定义人民币月总额；未指定的根档案会员/GPUcap为null，不代表任意运行/委托不受限。全仓测试、覆盖率统计、双tsc/lint和构建由父agent另行验证；开发方报告不计作本agent亲测。未进行真实模型执行、提供方扣款或每日账单对账；公开models.dev下载只检查了已有开发方证据，未独立再次下载。X7仅覆盖本次合成测试身份/凭据安全及相关输入脱敏测试，不等于完成全仓真实密钥扫描。
