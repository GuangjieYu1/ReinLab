# D-1 独立实现评审

评审范围：`services/control/src/db/database.ts`、真实 HTTP 用例、`idle-recovery.test.ts` 及其子进程 fixture。评审者未修改实现或测试，也未读取环境凭据、终止非本任务连接。

## 根因核对

`pg_terminate_backend` 的返回不构成应用进程消费 socket 断连通知的屏障。`pg-pool` 在 idle error handler 中移除连接，而重新借用 idle client 时没有健康探测。原用例紧接着发 HTTP 请求，可能先借到旧连接，再在 BEGIN 收到 57P01。故障与 Node 主版本无必然联系；全量并行负载改变时序即可暴露。

迁移通过固定 advisory lock 串行。检索到的故障触发器均使用随机账户、run 或 gate 限定，目标连接也通过随机 application_name 隔离；未发现另一个测试广泛终止应用连接的代码。现有证据支持连接通知竞态，未发现共享账户清理导致的污染。

## 实现核对

- 最多尝试两次。只有业务回调尚未开始且存在明确断连证据时才重借；普通 SQL 错误不触发重借。
- `workStarted` 在调用业务回调前设置。业务回调和 COMMIT 的失败不会重放回调，避免未知提交结果或外部副作用重放。
- 每次借用均重新执行 BEGIN 和事务局部 `set_config('app.account_id', ..., true)`，保持租户上下文。
- `continue` 仍执行 finally：销毁坏连接、移除本次连接监听器。重借不会绕过释放。
- 收尾追加核对：`if(lost)broken=true` 独立于是否允许重试执行，因此第二次前置断连、业务回调断连和 COMMIT 断连均明确 `release(true)`，即使模拟 rollback 成功也不会把已知坏连接放回池。此行只改变连接销毁，不放宽重试条件；业务与 COMMIT 仍不重放。
- 真实 PG fixture 暂停专属连接的入站通知，只终止该连接的精确 PID；恢复后验证 PID 已更换、账户上下文正确、业务回调只执行一次。已核对修改前 red report：57P01、workCount=0。

## 独立验证

使用指定 Node 22 二进制执行：

```text
node node_modules/vitest/vitest.mjs run services/control/test/api.test.ts services/control/test/idle-recovery.test.ts
Test Files 2 passed (2)
Tests 40 passed (40)
Duration 919ms
```

最终资源边界修正后，评审者另行使用同一指定 Node 22 执行 `independent-d1.test.ts`：1 文件、22 测试全部通过，退出码 0（308ms）。已逐项阅读该独立测试：两种第二次前置失败及 work/COMMIT 失败均直接断言 `release(true)`；无重借、原始错误、外部副作用仅一次等断言仍保留。已核对 `resource-red.json` 与独立记录，资源断言先红为 18 通过 / 4 失败；最终修正补齐的是资源处理边界。

## 评审发现

数据库实现未发现阻塞缺陷。诊断最初按 chunk 脱敏，在秘密跨 chunk 时可能漏掉完整字符串；改为拼接后逐次脱敏仍会因通用 scrub 提前去掉敏感前缀而暴露后续 chunk 的秘密后缀。已通知实现者，并回读确认最终实现只在内存保留原始 stderr 尾部 24KB，在失败打印前统一精确替换已知秘密、调用通用 scrub，再截取尾部 12KB。此发现已修正。

独立评审结论：本次数据库实现、确定性回归和诊断修正通过，无尚未解决的阻塞项。最终全量验收仍取决于下述父任务验证结果。

本评审不代替父任务要求的连续五次全量以及 Node 22/24 各一次全量验证；这些验证由父任务记录。

首次七轮全量属于资源边界追加前的实现，已由父任务以 `initial-` 前缀保存。最终验收应采用最终代码 hash 绑定的新 manifest 及重新执行的七轮结果，不将旧轮次计入最终连续结果。
