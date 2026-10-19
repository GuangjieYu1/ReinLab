# P1-08 独立测试：修复回归通过

测试日期：2026-10-19。测试者为独立子 agent；只新增测试与本报告，未修改产品实现。已阅读 CODEX_SPEC_RESEARCH §7、docs/tasks/P1-08.md、docs/questions.md Q-028/Q-029。

## 执行与结论

- Node 22，Vitest 4.1.11；真实本地 PostgreSQL `127.0.0.1:55432/reinlab_test`，应用角色 `reinlab_app`，管理员仅迁移与插入随机测试账户。
- 先亲跑开发方 `pnpm exec vitest run services/control/test/provisioner.test.ts`：13/13 通过。
- 新增 `services/control/test/independent-provisioner.test.ts`，beforeAll 调用 applyMigrations；只创建随机账户，不更改或删除其他测试的数据。
- 首次修复回归命令：`pnpm exec vitest run services/control/test/provisioner.test.ts services/control/test/independent-provisioner.test.ts --reporter=default --reporter=json --outputFile=evidence/P1-08/independent-test.json`。
- 初轮结果：独立 15 项中 11 通过、4 失败，退出码 1；4 个失败连续两次复现，及时通知父 agent。
- 实现方修复后最终回归：开发方 13 项与独立 15 项合计 **28/28 通过**，退出码 0。本测试 agent 未更改实现。该通过轮随后由生命周期扩展回归更新为 55/55，见下文。
- 最初执行中有一项测试期望无 scope 直接读返回零行，但 PostgreSQL 复用会留下空自定义 GUC、RLS UUID cast 报 22P02；已调整为认可零行或 22P02，二者均失败关闭，不作为实现问题。

## 初轮发现与修复回归

### F1 [P1] 对账接受带公网服务的机器并标为 ready

初轮位置：`services/control/src/provisioner/index.ts`（旧对账校验行 51）。先成功创建账户资源，再给已有机器加入 `config.services=[{protocol:'tcp',internal_port:4096,ports:[{port:443,handlers:['tls','http']}]}]`。再次 ensure 健康返回 true 时，实际返回 `{state:'ready', machineId:...}`，期望拒绝 `PROVISIONING_CONFLICT`。§7 与 Q-028 要求无公网 services，健康通过无法证明该约束。现有校验仅覆盖 region、账户 metadata、挂载关系，未检查公网服务。

### F2 [P2] 对账接受镜像及常驻配置漂移

同一位置，两个独立样本：把已有机器镜像改成 `registry.fly.io/reinlab-accounts:unexpected-version`；把 restart 改成 `{policy:'no'}` 且 `auto_destroy=true`。再次 ensure 均实际 ready，期望冲突关闭。分别破坏部署镜像锁定与一账户常驻机器契约。以上测试使用注入健康检查隔离配置验收；健康只证明运行时探针，不能证明镜像包含约定工具或重启策略正确。

### F3 [P1] 并发达到池容量会形成嵌套连接饥饿

初轮位置：`services/control/src/provisioner/index.ts:29-33` 与 `tokens/save` 的嵌套 `withAccount`。两连接应用池、同账户两请求并发：每请求先占连接；一条取得 advisory transaction lock 后再申请嵌套连接，另一条占着连接等待同一 advisory lock。为避免测试无限挂起，设置 connectionTimeoutMillis=250；实际一成功一失败，期望两者成功且仅建一机一卷。两个执行次序不同但均复现。生产连接池若无获取超时，同模式可无限等待，175 秒业务 deadline 不会中止数据库取连接。需要改变连接/锁使用方式后回归；只放大池不能消除达到容量时的问题。

## 修复验证

F1/F2：实现方增加 image、services、auto_destroy、restart 以及 env 对账校验，三个配置漂移测试均拒绝并通过断言。F3：实现方改用数据库行租约，每个数据库操作短事务，不在持连接等待期间嵌套取连接；原两连接双并发回归通过，两请求 fulfilled 且一机一卷。最终测试运行发生在这些修复落盘后。

## 已通过的独立覆盖

跨账户 secret 插入被 RLS 拒绝；跨账户 machine 更新零行；无 scope secret 不能读取、Vault 映射不可直读；丢失卷响应且对账不见资源时连续重试不再创建；重复卷与卷挂在别机拒绝；健康故障重试复用资源和密文；两账户并发相互隔离；GCM nonce 随机，IV/tag/ciphertext 单位篡改拒绝；畸形就绪 PID/schema/非 loopback 拒绝；Fly POST 的加密卷参数与私网机器计划；网络和畸形 JSON 错误脱敏；非法 machine ID 在请求前拒绝。

## 证据边界

Fly 为明确 test 文件内的协议样例，未调用真实云 API，不是云资源创建或三分钟 SLA 的证明。未读取 .env 或真实凭据。未创建模拟 Vault 并冒充真实 Vault。真实容器构建由父 agent 独立执行，本测试未并行启动 Docker 构建。Auth 注册、Vault、Storage/Hatchet 调度及云 SLA 仍受 Q-029 外部条件限制。

机器可读测试结果：`evidence/P1-08/independent-test.json`。本轮实现/测试 SHA-256：`evidence/P1-08/independent-source-hashes.json`；已按修复后的最终通过轮重新记录源码 hash；未来修改后仍须重新测试。


## 生命周期扩展独立回归（2026-10-19 16:18，Asia/Shanghai）

新增 `services/control/test/independent-lifecycle.test.ts`。先亲跑开发方 lifecycle.test.ts，16/16 通过；再亲跑独立生命周期 11/11 通过。最终合并命令：

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm exec vitest run services/control/test/provisioner.test.ts services/control/test/lifecycle.test.ts services/control/test/independent-provisioner.test.ts services/control/test/independent-lifecycle.test.ts --reporter=default --reporter=json --outputFile=evidence/P1-08/independent-test.json
```

最终 **4 文件、55/55 通过，exit 0**：开发方 13+16，独立 15+11。独立生命周期单跑 JSON 为 `evidence/P1-08/independent-lifecycle.json`，总回归 JSON 为 `evidence/P1-08/independent-test.json`。

独立生命周期 11 个场景均使用随机新账户与真实本地 PostgreSQL，不改其他测试账户：

1. 两条活动 run 阻止 wait；interrupt 原子逐条中断、写事件后才 Fly update。
2. 机器认证 env 与数据库信封不符时，在中断和 Fly update 前拒绝。
3. Fly list 期间租约被替换，旧升级 worker 被 fencing，不中断 run、不触发 update、不清理新租约。
4. Fly update 故障保留 starting/upgrade_pending 与中断事件；同 operation 重放不重复两条 run 的账本。
5. 第二条 run 的 ledger dedupe 内容冲突，前一 run 的中断和刚写事件均一起回滚，机器状态不改变。
6. 5 并发同 runtime boot 对账只产生每 run 一事件，另一账户仍 running。
7. snapshot 活动 run 拒绝且没有网络调用，释放自身租约。
8. snapshot GET 带账户 Bearer，POST 带专用 Storage 身份；目标严格固定 account/date，x-upsert=false，流内容保留；409 返回已存在；路径穿越与非法日期拒绝。
9. 源 tar ReadableStream 中途报错不返回成功，租约释放且同日恢复后可重试；不输出原始流错误。
10. 拒绝 service_role/authenticated/anon 与 sb_secret 令牌；真实 PG 检查 snapshot_writer 为 nologin、无 superuser/bypassrls/createdb/createrole。确认本地没有 storage.objects，仅验证 0015 条件迁移的普通 PG 分支，未创建伪 Storage 或声称云策略通过。
11. ensure 健康回调期间由新租约接管，旧 worker 拒绝 READY；新 worker 的 starting/phase/lease 保持不变。

本轮无新增失败。源码 hash 已包含 lifecycle.ts、0014 租约迁移、0015 Storage 条件迁移及两份生命周期测试。Docker 构建由父 agent 负责；其 backend.sock 故障与原生 runtime 探针不由本组本地单测证明，不能把 55/55 解读为镜像构建通过。真实 Supabase Storage policy、Vault、Fly API 与注册事件调度仍需环境补验。


## 0016 持久升级幂等最终补验（2026-10-19 16:20，Asia/Shanghai）

前轮 55/55 只证明中断账本未重复，未证明故障重放不重复调用 Fly POST。实现方新增 0016 account_machine_operation 及生命周期持久 operation 对账后，独立测试新增 8 项（共 19 项），明确使用 `FlyMachines` 的测试内 HTTP transport 统计 GET/POST，不仅统计 ledger。单跑 19/19 通过，再以同上四文件命令完成最终 **67/67 通过、exit 0**：开发方 provisioner 13、lifecycle 20，独立 provisioner 15、lifecycle 19。总 JSON 已更新为此轮，单跑生命周期 JSON 也已更新。

新增独立场景：

- 同 operation 改 image、改 mode 各一项：409 DEDUPE_CONFLICT，Fly 没有额外 GET/POST。
- HTTP 成功且数据库 applied，重建生命周期 service 对象后连续三次重放：返回 UPDATE_REQUESTED，仍仅一条 POST，重放没有 GET。
- POST 已实际应用目标 image 但响应丢失：首次 indeterminate；重建 service 后只发两条 GET 对账机器/卷、持久变成 applied；随后重放零网络，POST 总数一。
- POST 未应用且结果未知：连续三次重放只有六条 GET，持续返回 409 PROVISIONING_INDETERMINATE，保持 indeterminate，POST 总数一。
- 新 operation 在机器 starting 时拒绝，未 POST、未写新 operation。
- 机器虽 ready，但已有其他 pending、indeterminate 操作分别拒绝新 operation；未 POST、未插入新 operation，旧状态保留。

此前“Fly更新故障后同 operation 再 POST”的旧独立断言随新契约改为持续 INDETERMINATE 且 POST 总数一；两条 run 的中断账本仍只各一条。历史 55/55 段落保留用于说明当时覆盖边界，最新结论以本节 **67/67** 为准。此次仍只改独立测试与报告，不改产品实现。SHA-256 已重新记录并加入 0016，真实云及镜像探针仍由父 agent 另行验证。
