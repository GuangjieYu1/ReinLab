# Replay/snapshot 时序修复（作者报告，待独立复核）

根因：观察器初始snapshot后replay可获得更新事件；持久cursor追过旧snapshot.latest后仍同步旧snapshot，Store正确拒CURSOR_AHEAD，却被persist包成sink failure导致观察停止。独立native失败诊断2明确provider SSE200/finish完成、native completed/latest28/replay完整、step-finish有usage，但DB cursor6/usage0且scheduler失败。因此不是模型响应SSE未结束或native未完成。

ToSpec与确定性ToTDD：见 stale-snapshot-ToSpec.md；3项先全部失败（stale-snapshot-red.json），后通过。修复仅observer.ts：非terminal replay后重新snapshot+读committedcursor；fresh<cursor仍稳定CURSOR_AHEAD，fresh=cursor才sync/允许snapshot terminal返回；fresh>cursor直接subscribe(after cursor)消费新增历史，不假记gap/unknown。未修改sink、SDK、prompt或费用逻辑。原observer fixture由不现实静态latest改随commit，明确terminal无event用相等cursor，没有删弱原覆盖。

结果：原27+新3=30/30；相关7文件78/78（stale-snapshot-regression.json）；control tsc无输出退出0，pnpm lint退出0。原pipeline-native仅一次修复后1/1通过（pipeline-native-fixed.json），capture native-fixed/pipeline-native-evidence.json：2.0.150、providerCalls1、usage1且costnull、holdunpriced，HTTP重放/recover无追加模型调用。原失败report/regression/final和两份诊断均保留，不以简单重跑替代定位。

作者与复核：docker_driver原为独立审查，root明确授权接管最小修复后转为作者；此文不自批，交root源码审查及role_independent_test独立测试。限定native是确定性loopback fixture，无真实DeepSeek/key/账户。

命令（Node22.23.3）：

```sh
pnpm exec vitest run services/control/test/observer.test.ts services/control/test/independent-observer-stale-snapshot.test.ts
pnpm exec vitest run services/control/test/observer.test.ts services/control/test/independent-observer-stale-snapshot.test.ts services/control/test/observation-sink.test.ts services/control/test/observation-store.test.ts services/control/test/independent-observation.test.ts services/control/test/observation-scheduler.test.ts services/control/test/pipeline.test.ts
pnpm exec tsc --noEmit -p services/control/tsconfig.json
pnpm lint
REINLAB_EVIDENCE_OUT="$PWD/evidence/P1-10/observation-independent/native-fixed" pnpm exec vitest run services/control/test/pipeline-native.test.ts
```

诊断副本仅用于此次定位，已归档 native-diagnostic-2/diagnostic-test-source.ts.txt（SHA256 47daa9424f0736fbb59b608f1a101afa4c5c458e3ac8ce20f09336a72949fcc4），从常规测试目录移除，避免默认测试重复启动原生。需要复验诊断可将原样文本恢复为 services/control/test/independent-pipeline-native.test.ts，再以显式REINLAB_EVIDENCE_OUT运行；正常回归使用原pipeline-native.test.ts。自有native/provider/认证fixture服务均已finally关闭。
