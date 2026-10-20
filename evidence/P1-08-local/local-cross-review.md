# P1-08-local 交叉独立评审

结论：本轮指定范围通过，未发现待修复阻断项。此结论不包含本人实现的 startup-lock/control-process/up 启停段及 main ready IPC；这些部分由另一评审者独立验收。未修改生产实现。

## 核对结果

| 范围 | 源码依据与结论 |
| --- | --- |
| 镜像内容 hash | `tooling/local/image.ts:5–28` 明列 Dockerfile、各 COPY 源及工作区 manifests/lock；路径及字节长度分帧后加入实际内容。`image.test.ts` 从真实 Dockerfile 检查 COPY 覆盖，并逐项验证改变输入会改变 tag。内容 tag 不是可重复构建的声明：apt 外部仓库本身不受本地 hash 固定；真正的复用边界由保存的 image ID 保证。 |
| 镜像 pin | `image.ts:41–70,87–167,170–219` 区分镜像不存在与读取失败；已有 pin 的 tag 丢失/变更、同 tag 容器引用其他 image ID 一律拒绝，不隐式 build/修复。首次 pin 随机临时文件写完后 link 无覆盖发布。构建前后复验 tag/容器身份；仅 CLI 固定格式读身份字段，不读取容器 Env。本轮使用 fake runner，未调用 Docker。 |
| DB URL 与 privateEnv | `tooling/local/config.ts:17–27` 与 `services/control/src/provisioner/local-bootstrap.ts:7–13` 均只允许显式端口的 loopback PostgreSQL `/postgres` 且拒绝 query/hash，避免 pg 重解连接后缀。`config.ts:32–84` 校验普通文件、单 link、当前用户、mode600、无符号链接祖先，使用 NOFOLLOW/NONBLOCK，读限128KiB；写值先以 parseEnv 验证逐字节往返，再截断写入并 sync。现有 quote/backslash/dollar 回归通过。 |
| 本地管理员边界 | `local-bootstrap.ts:14–37` 仅 setup 使用 `supabase_admin` 执行既有迁移并设置已验证 base64url 角色密码，finally 关闭 pool；返回分别降权的 app/provisioner URL 和专用 snapshot writer JWT。`up.ts` runtime 环境不含管理员 DB URL/JWT 签发密钥，setup 私有文件与 runtime 分开。本结论没有读取任一实际凭据文件。 |
| 验证账户恢复 | `tooling/local/verification-auth.ts:4–26` 限 loopback、本地产生邮箱/密码，始终先用同一身份登录；只有未标记注册且得到明确 invalid_credentials 才以相同身份 signup。已注册身份的错误或暂时故障不变成新注册。`services/control/scripts/verify-local.ts:41–55` 先持久化身份再请求，成功后持久化 registered，关闭了保存意图但请求未到达时无法恢复的问题。 |
| 验证脚本范围 | `verify-local.ts:59–153` 检查真实账户/卷数量、JWT 控制面身份及跨账户 RLS、Vault 包裹与私表拒绝、真实卷标记、Storage tar 实际字节及重启保卷。没有 prompt 调用或模型 key 加载；报告只含稳定代码和统计（155–162）。该脚本会操作真实测试资源，所以本轮只读，没有运行它。 |
| Auth worker/001/002 | `auth-worker.ts:8–44` 启动先校验非特权数据库身份，失败关闭 pool；后台只调用窄 claim/finish 函数，错误日志仅稳定代码。001 创建 FORCE RLS 私有队列，撤销直接业务/worker 表权限，Auth 触发器为唯一正常 producer；SECURITY DEFINER 使用固定 search_path、完整限定队列表。claim 使用 SKIP LOCKED 和5分钟租约，finish 同账户、同 worker、live lease fencing。002 只终结已耗尽的 pending/过期 lease，保留第八次仍有效的 lease，不重放不确定资源操作。 |
| Storage 重复兼容 | `services/control/src/provisioner/lifecycle.ts:11–18,87–88` 保留原409语义；新增400仅接受 JSON 的精确 code `KeyAlreadyExists`，最多读取4096字节，超限取消，其余错误/坏JSON返回失败。无通用400成功化；新增 lifecycle 回归覆盖精确值、其他 code、坏JSON、超限。 |

## 验证证据

本轮独立运行 Node 22.23.3，无真实基础设施操作：

```text
node node_modules/vitest/vitest.mjs run tooling/local/image.test.ts tooling/local/config.test.ts tooling/local/verification-auth.test.ts
16/16 pass -> local-cross-unit.json

node node_modules/vitest/vitest.mjs run services/control/test/local-independent.test.ts -t 'rejects DB URL suffix|treats timeout|keeps child error|rejects hardlinks|rejects a symlink ancestor|roundtrips accepted'
9 pass / 7 skipped -> local-cross-config.json
```

第二条仅执行现有纯本地配置/子进程/临时文件测试；7个真实PG测试跳过，未访问PG或3001/3002，也未新增风险复现用例。全部25项通过。

已只读核对他方证据：`local-independent-report.json` 26/26、`queue-test-report.json` 3/3；`integration-attempt-4/local-integration.json` 报告真实基础设施7/7、completed=true、modelRequests=0。最后一份是他方实际执行结果，不能视为本评审亲自重新执行。Storage兼容和privateEnv的历史红灯保留在既有证据中，本轮不覆盖。

## 边界

本结论适用于当前本机 CLI/单宿主受保护状态目录场景。未对同用户恶意并发文件替换、管理员主机失陷、跨主机可重复镜像构建作额外保证。没有读取 secret/state raw、运行模型、外网请求、Docker/Colima操作，也没有修改生产文件。startup 仍需他方独立结论后才能统一标完成。
