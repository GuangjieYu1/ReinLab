# RT-1 invalid_answer 修复独立复核

结论：**RT-1已关闭；该精确修复通过。** 原runtime-review.md中RT-1的待修状态由本复核更新。这里只关闭此P2错误语义问题，不把后续binding/事件/费用/真实模型验收标为完成。

源码核对：RoleRuntime.responseFailure只对HTTP400且body.error精确为invalid_answer生成稳定INVALID_ANSWER/status400；不传回原始message。call的语义错误保留表同步加入INVALID_ANSWER，避免catch再包装为OS_UNAVAILABLE503。其他未知400和传输错误仍走原稳定503路径，409/404语义、决定范围及不重试行为没有放宽。

作者证据核对：runtime-invalid-answer-red.json为旧实现上的有效3通过/1失败，失败项正是新增“invalid question answers preserve a client error and are never retried”，原返回OS_UNAVAILABLE而非预期400；runtime-invalid-answer-green.json为4/4通过。该红灯不是环境或模块导入失败。

本人以Node22.23.3独立执行既有测试：

```sh
pnpm exec vitest run services/control/test/runtime-observation.test.ts
```

结果4/4通过。新增第4项使用普通本地fakeHTTP与真实锁定SDK，确认无效问题答案抛INVALID_ANSWER/status400，并且/runtime/decision恰好一次请求；其他三个观察/游标/决定边界回归也保持通过。没有新增场景、真实模型或账户资源操作，没有改生产/测试/原评审报告。

## Binding store后续独立审查准备

已读docs/tasks/P1-10-complete.md与P1-10-runtime-contract.md。待父任务明确模块绿灯后再运行binding测试；当前不执行尚未完成的binding实现或迁移。

后续审查重点为：account+run+dossier+logical/physical role归属与RLS；DB先保存固定session/request与完整角色/内容摘要；同请求同内容复用、异内容冲突及租约并发；恢复不能把DB JSON强转WeakMap能力；远端receipt/全局插件与session目录/父子/workspace重验；未知提交结果只查询原编号、不由观察路径prompt；三类重启/在途重放的真实fixture请求与副作用次数；失败事务及lease fencing不能覆盖其他worker的绑定。
