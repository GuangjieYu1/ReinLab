# D-1 / D-2：真实HTTP入口恢复竞态

根因：用例pg_terminate_backend成功只表示服务端发出终止信号，不表示子进程pg-pool已消费socket错误并移除idle client。立即恢复请求可能借出旧client，BEGIN报57P01→500；全量并行改变时序，更容易显现。未发现随机账户、条件触发器或迁移锁交叉污染。问题不特属于Node24。

确定性证据：test/fixtures/idle-recovery.ts仅暂停自己专属PG连接的入站通知，释放idle后由父精确终止PID，再允许借出并恢复通知。修改前红灯red-test-report.json为57P01且workCount=0；修复后在新连接上重建账户上下文，业务只执行一次。测试socket暂停仅用于故障注入，不进入生产。

实现：Database.withAccount仅对BEGIN/账户上下文建立阶段的明确断连重借一次；每次重新BEGIN和set_config LOCAL。业务回调开始或COMMIT阶段失败一律向外返回，不自动重放；非断连错误不重试，仍强制RLS与非特权应用角色。原api.test.ts保留立即HTTP恢复200断言，未加等待/sleep/串行设置；子进程stderr收集到内存，失败时统一精确替换临时凭据+scrub并截断，打印phase/退出状态。评审发现并修复分chunk脱敏问题，发现历史保留。

复现（Node22/24，默认并行）：
```sh
pnpm exec vitest run services/control/test/idle-recovery.test.ts services/control/test/api.test.ts services/control/test/independent-d1.test.ts
pnpm test --reporter=json --outputFile=/tmp/reinlab-full.json
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json
```

独立边界测试22项包括重借上限、连接/监听器释放、业务和COMMIT不重放、非断连不重借，及真实JWT/PG/RLS换连接后的A/B和空上下文隔离。独立测试/评审见independent-test.md/json和review.md。版本基线与Node22连续五轮JSON、节点版本和退出码见full-suite-runs.json；原红灯不删除。没有为测试降低权限、跳过断言或重复外部业务副作用。

主仓库中期审查原样收录design/reviews/BATCH1_REVIEW.md，原目录未跟踪文件及其他用户改动均未改。原文审查日期2026-10-20与本轮客户端2026-10-19有一天差异，保留原文，不推测或改写。
