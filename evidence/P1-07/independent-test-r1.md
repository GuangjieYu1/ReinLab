# P1-07 独立测试

状态：通过。开发方修复三个独立发现的阻断后，独立agent亲自复验40/40通过（原创14项，开发方套件26项）。本报告仅评价P1-07预算控制面，不声称模型已执行或提供方已真实扣款。

## 亲自执行

测试连接本机真实PostgreSQL 55432，应用角色`reinlab_app`通过安全角色校验。全部新增fixture使用随机账户/档案/运行ID；未读取真实凭据，未调用任何模型。独立测试源为`services/control/test/independent-budget.test.ts`，以本机Node22运行Vitest。保留随机测试记录便于审计；未删除他人fixture。

- 首次证据目录试跑因`pg`包解析失败，0项执行，保留`independent-test-initial.json`；改从控制面测试目录运行。
- 独立原创9项首跑7通过、2失败：`independent-test-before-fix.json`。
- 扩展12项首跑9通过、3失败：`independent-test-expanded-before-fix.json`。
- 独立复跑开发方预算套件时已增加回归项，26项25通过、1失败：`independent-rerun-parent-suite.json`。该套件作者为开发方，执行人为独立测试agent。

## 阻断与复现

1. 父运行预算10元，工具已原子保留8元，仍可给子运行划拨8元。预期拒绝`BUDGET_EXCEEDED`，实测成功。`allocateBudget`可分余额未扣父运行自己的reserved/unpriced hold。
2. 父运行预算10元，子预算2元，父工具保留8元；子追加3元后祖先预算仍10元。预期先为祖先增加至13元后支持子预算5元。`growPath`把父工具已保留费用误作未分配余额。
3. 上月父运行预算10元→子预算8元，子工具保留1元未结清；父运行可以直接确认本月5元并建立新月划拨。预期按Q023先结清旧月在途费用。续月只检查自身run_id，未检查所续期预算子树。

## 已通过的独立断言

六位定点精度/上限/非有限拒绝；十工具并发尾额仅一获准；六并发同request只生成一个hold且结算只产生一次费用；三新增表跨租户读写隔离与DELETE/TRUNCATE撤销，估算UPDATE撤销；hold不能借同账户其他run的allocation；自身旧月reserved/unpriced费用阻止新月；UTC月份边界。

开发方曾报告25/25、191/200行覆盖、双tsc和lint通过。这些为交接信息，不替代本独立测试。后续修复后会重新记录最终亲测与源码哈希。`independent-source-hashes-before.json`为首批失败执行后的源码快照，非原子执行时快照。

## 修复后最终亲测

命令：`PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH ./node_modules/.bin/vitest run services/control/test/independent-budget.test.ts services/control/test/budget.test.ts --reporter=json --outputFile=evidence/P1-07/independent-test-final-vitest.json`。

40项全部通过，其中14项由本独立agent编写、26项由开发方编写并由本agent独立执行。原有失败历史保留。开发方用统一父节点未分配余额计算扣除子剩余划拨与父自身reserved/unpriced费用，并将续月检查扩大到旧预算子树；上述三种复现以及父/子未知费用变体均已转绿。本agent未修改实现。

最终结构化签署及12个实现/迁移/测试源码SHA-256见`independent-test.json`；原始逐项结果见`independent-test-final-vitest.json`；最终原创测试副本见`independent-budget.source.txt`。测试运行与哈希采集间没有再通知的实现修改，后续实现若变更应重新验证。

最终开发套件也亲测通过：本地HTTP目录读取与价格不可用、非目标embedding不干扰、估算有效期/租户/模式/角色/消费限制、真实queued且输入脱敏、80%提醒/100%停、实际超预留真实记账、结算幂等和事务故障回滚、独立会员/GPU计量及追加、账户/档案视图、跨档案委托来源与祖先限额、UTC续月保留历史费用。以上HTTP目录为测试数据，未被用于live，不证明真实模型执行。

## 验证边界

规格明确人民币逐级划拨；会员/GPU明确单独计量、独立门禁及分别追加，未给出账户月额度或父子共享配额的明确合同。当前验证的是人民币层级共享和运行级会员/GPU门禁，不声称会员/GPU也具有父子共享上限。若需要该行为，须另行明确ToSpec。

本agent未运行全仓测试、覆盖率统计、构建或tsc/lint；相关结果由父agent另行提供。`live-pricing-catalog.json`为开发方真实公开目录下载证据，本agent只检查文件与代码路径，未独立重复下载。未进行真实提供方账单对账；X7仅验证本次测试使用随机合成身份与临时合成JWT、无真实凭据读写，不等同于完成全仓凭据扫描。
