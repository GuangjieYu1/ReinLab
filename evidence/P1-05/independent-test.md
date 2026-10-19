# P1-05 独立测试

最终结论：修复后通过。68 项检查全部通过、0 失败，其中独立安全/故障/真实 HTTP 样本 62 项全部通过。首轮凭据格式遗漏与 Zod3 金额精度缺口均已修复，历史保留在下文及 JSON `history`。

## 范围与环境

依据 `docs/tasks/P1-05.md`、实现规格 §4.1/§6/§8.2–3 和 SEC-6/CH-3。工作目录为 research-foundation/ReinLab，使用 Node v22.23.3、本地真实 pgvector/Postgres 与实际非特权 reinlab_app 连接。HTTP 验证通过当前 @hono/node-server 监听回环 TCP 端口，使用本地临时密钥签发的真实密码学 JWT；没有用应用内 request 调用替代独立串流测试。

未修改实现、迁移或原前端，只新增本报告和 `independent-test-report.json`。测试使用随机自建账户/档案/运行，结束后按这些账户 ID 精确清理，关闭 HTTP server、所有 reader、AbortController 和 PG pool；未改其他账户数据。独立脚本从标准输入运行，没有遗留仓库临时文件。

## 首轮失败与复测

初始 scrub 自选样本发现 OAuth 回调 URL 的 fragment 参数、明确的 refresh token 自由文本赋值及 Basic 认证文本可原样保留，已立即通知开发者。修复后，独立验证合成敏感标记在 appendEvent 后的原始数据库存储、审计 HTTP 和真实 TCP SSE 事件里均不存在；同时覆盖通用认证数据库 URI、嵌套敏感字段、Bearer 和 URL query 参数。SSE 检测等待目标事件 id 出现，避免仅检查初始注释便误判通过。

Basic 另单独检测其实际 Base64 编码值本身不再出现，避免只搜索编码前的合成标记而遗漏编码泄漏。

首次完整集成探针为 37 项中 36 通过、1 失败：`costCny=1e-7` 被 Zod3 multipleOf 接受。开发者改为明确的十进制有效位与 exponent 校验后，独立复测 1e-7、9e-7、0.1234567、0.0000011 均被拒绝；0、1e-6、0.123456、999999.999999 均原值保存，同键重放返回同一 seq，没有静默舍入。

## 并发、提交次序与隔离

- 8 路并发同键同内容只返回一个 seq；同键相同输入重放稳定，异内容返回 DEDUPE_CONFLICT。
- 先启动追加事务并在提交前等待，再启动第二事务；第二次追加被锁阻塞，第一事务提交后才得到更大 seq，按第一 seq 续读能读到第二事件。
- 事务故意回滚后无事件残留，同一去重键可再次成功追加。
- 跨账户档案、调用方与事务账户不一致全部拒绝；同账户跨档案 run 引用及其他账户 run 引用均被复合 FK 拒绝。
- 跨账户审计和 SSE 均为真实 HTTP 404，缺 JWT 均为 401。非法负数、前导零、小数、指数形式、超安全整数和带正号的游标均拒绝。

## 真实 HTTP SSE

第一次真实串流读到两个事件后取消；追加 111 个事件，再携带较旧 after 和较新 Last-Event-ID 重连，收到的 111 个 id 与数据库返回序列逐项一致、无重复，跨越 100 条批次。取消后所有连接空闲，没有 idle in transaction。

空档案 SSE 在约 20ms 返回 HTTP 200、text/event-stream 和 connected 注释；取消后再观察 550ms，新增数据库 acquire 为 0、忙连接为 0。

最终另补独立长时验证：

| 项目 | 实测结果 |
|---|---|
| 空流 15 秒心跳 | 15217ms 收到 keepalive 注释，连接此前已有 connected 注释 |
| 真实 TCP 断开约 30 秒 | 断开后 30441ms 完成重连与读取 |
| 断线期间追加 105 个事件 | Last-Event-ID 续读 id 逐项一致，105 个不同事件，无丢失/重复 |
| 心跳流和重连流取消 | 忙数据库连接 0 |

没有把业务事件的全局 seq 间隙误判为丢失：验证标准是本档案可见事件 id 序列逐项一致。

## 费用、未知与审计

独立写入 0.000001、0.100001 和 null，审计汇总精确为六位字符串 `0.100002`，未知费用事件单列 1；quota=7、gpuSeconds=15，额度和 GPU 没有混入人民币汇总。真实 JSONL HTTP 导出为 3 条事件加 1 条末行 summary，金额与数据库快照一致。

负数、非有限、越界和超六位金额均拒绝；quota/GPU 的负数、小数和 int32 越界均拒绝。以 kind=error、action=unmapped_event 追加的未知来源事件会保留，不会静默丢弃。

## 回归与外部报告核对

独立执行 lint、control/contracts 严格 tsc、原前端 20 文件 162 项测试、mock 构建均通过；250 个前端基线哈希一致。修复后重新执行 lint 与两项严格 tsc；未改的前端测试/构建沿用本任务首轮成功结果。

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec vitest run src
VITE_BACKEND=mock pnpm build
```

另独立核读父 agent 已保存的报告：ledger 套件 23/23、全仓 455/455，通过且失败数 0；行覆盖 57/58=98.27%，其中 ledger/index.ts 34/34、api/ledger.ts 23/24。上述长套件和覆盖率由父 agent 执行，本报告没有将其描述为独立重复执行；本测试自己的真实 TCP 心跳及 30 秒断线验证已单独完成。

## 验证边界

当前实现和测试文件 SHA-256 见 JSON `snapshot`。所有凭据探针都是本地合成字符串，没有读取或使用真实凭据；报告只保存检测布尔值。没有云 Supabase Auth 登录、模型调用、Vault/Storage 或 staging 验证；本地真实签名 JWT 不是桩模型。Q-005 既有无头浏览器回归入口尚未定位，不以 Vitest 冒充它已通过。
