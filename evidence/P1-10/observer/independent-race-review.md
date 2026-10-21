# 观察器竞态独立复核

结论：修复符合恢复合同，未见P1/P2。Node v22.23.3，observer27+竞态3共30/30通过，见independent-race-green.json；无native并发执行、无真实模型/凭据读取。

只读核对：replay逐条持久化后重新取snapshot并重读已提交cursor；fresh latest<cursor稳定CURSOR_AHEAD，等于cursor才synchronize，大于cursor则从已提交cursor订阅补齐真实历史。没有拿首次过期快照做状态结算，没有用gap跳过尚可重放的费用事件。终态事件仍先await ingest后停止，asked仍刷新pending快照，gap/失败重试边界未扩大。

复验：设置Node22 PATH后执行`pnpm exec vitest run services/control/test/observer.test.ts services/control/test/independent-observer-stale-snapshot.test.ts`。本次JSON筛自同一次156/156定向组合运行；原作者red/native证据保持原样。本独立验收仅本地read-port/sink fixture，不冒充第二次native结果。

追加：按root授权独占运行原pipeline-native.test.ts一次，Node22原fixture未修改，1/1通过（independent-native-green.json / independent-native-evidence.json）。实际原生npm2.0.150+本地provider+PG16+HTTP认证全管线，只有测试provider响应；真实模型请求0、真实key读取0。命令：`REINLAB_EVIDENCE_OUT=/tmp/reinlab-independent-pipeline-native-final pnpm exec vitest run services/control/test/pipeline-native.test.ts --reporter=json --outputFile=/tmp/reinlab-independent-pipeline-native-final-report.json`。native槽已释放。
