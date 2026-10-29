# P1-13 真实恢复验证

状态：本地最终配置混沌9/9通过；Node22/24全量各1498/1498，新增响应反射用例已在定向24/24覆盖，尚待最终提交CI；云端补验。

- 固定 Hatchet core v0.110.5 / SDK 1.43.0，镜像摘要见 infra/hatchet/versions.json。真实 Lite/PostgreSQL/worker登记3个任务。
- 专用发现角色只跨账户读取 account.id，没有业务表/其他列、双向角色成员、owner/超级权限。启动拒所有应用 schema CREATE、额外表列/序列权限和可调用 SECURITY DEFINER。000只收紧两诊断视图 PUBLIC SELECT；001已应用字节未改，002追加 schema 检查。
- account.discover 每分钟自主发现，UUID ceiling固定、每页100、每轮从头开始，确认入队后推进。account.reconcile/run.observe 每账户并发1，状态幂等，只处理已接受绑定，不重发prompt/批准/派发模型子agent。
- 每轮最多1000原始事件，以持久游标续读，不开SSE。只校验已有角色文件，不prepare或重新grant；缺失/修改均失败。
- 实际测试先批准fixture文件一次、保留另一次待批准写入，再SIGKILL账户容器并重启；以数据库行锁与pg_blocking_pids证明真实worker已到持久检查点后SIGKILL worker，再启动新worker。控制面进程停止，无测试HTTP访问或手工任务触发，仅RLS数据库读等结果：Hatchet cron主动发现、run interrupted、原始序列连续且不重复、未批准文件不存在、批准文件无重复副作用、模型fixture请求不增加、重复终态对账不增加账本，网关清理成功。真实模型调用/key读取均0。
- permission/question pending在终态过期；保留已批准和indeterminate，费用未知产生的budget卡保留。独立数据库故障注入证明审计与状态更新同回滚。
- 新建及复用容器都核immutable镜像、argv/ENV、只读单卷、单网络、loopback端口、去能力/无新权限。配置卷精确3个600/root/单链接常规文件，O_NOFOLLOW读取，私有宿主状态保存摘要，拒绝漂移。
- 真实部署暴露宿主/容器MCP client路径不同：固定部署路径，不跳过摘要。Docker随机宿主端口重启后变化：清理仅接受同token同角色fresh resolver；独立越权及实际清理均通过。

复跑（仅模型fixture）：

```sh
unset DEEPSEEK_API_KEY
pnpm local:up
pnpm local:hatchet
pnpm exec tsx services/worker/scripts/verify-recovery.ts
```

常驻worker另开终端运行 `pnpm dev:worker`。本地结果不冒称云端验收。
