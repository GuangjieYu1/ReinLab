# 第四批审查（P1-11 MCP 能力层）

- 日期：2026-10-23
- 审查方：Claude
- 被审对象：Codex 工作树 `research-foundation`，分支 `codex/p1-11-mcp-capabilities`
  - 提交：`49c4879`（自 `bc995fe` 起 7 个提交，123 个文件，+10443 / −475）
  - PR：GuangjieYu1/ReinLab#17
- 依据：[CODEX_BRIEF_BATCH4](CODEX_BRIEF_BATCH4.md)、[MCP_LAYER.md](../MCP_LAYER.md)

## 结论

**通过。P1-11 的代码部分关闭。** 有两项必须在 T-MCP-10（真实端到端）之前完成：
1. 用户轮换泄露的 key，并删除 `.zshrc` 里的自动导出行（第 3 节）；
2. 按第 2 节发布含卡片 schema 的 `research@1.1.0`。

P1-12（审批卡与收件箱的前端 live 接入）可以开始。

## 1. 审查方亲自复核

| 项 | 方法 | 结果 |
|---|---|---|
| 全量测试 | Node 22.23.3，环境里去掉 key | **1385 / 1385**；跑完后工作区仍为 0 改动 |
| 依赖边界 / 类型 | `pnpm lint`、两个 tsc | 通过 |
| 能力令牌 | 读 `mcp/token.ts`、`mcp/authority.ts` | Ed25519 自签；签发时间必须早于过期时间，且相差不超过 7200 秒；每次调用都在线核对运行快照、有效配置摘要、能力目录摘要、作用域摘要和吊销状态；旧运行没有快照时**不会**套用当前配置 |
| 单次审批 | 读 `mcp/approval-bridge.ts`、`mcp/engine.ts` | 审批绑定能力名、请求编号、参数哈希；只接受 once；用过就标记 consumed；参数哈希不一致就拒绝 |
| papers 联网 | 读 `mcp/papers.ts`、`paper-http.ts` | 只连 `https://api.openalex.org`；逐跳复核；把公开 IPv4 固定到实际连接上（防 DNS 重绑定） |
| 外部客户端绕过插件 | 看测试索引与独立安全报告 | HTTP 外部客户端同样受服务器端检查约束（T-MCP-2） |
| 清单不可变 | 读 Q-069 | `research@1.0.0` 的字节、旧 registryHash 都没变；新能力目录单独计算摘要、只追加 |

Codex 自报的 T-REG 18/18、容器 11/11、CI 8/8 没有逐一复跑。本批前端文件与 P1-10 逐字节一致（253 个文件），所以 T-REG 的风险很低。

## 2. 决定：发布 `research@1.1.0`（Q-069 / Q-072）

审查方批准发布新版本，内容是在 1.0.0 的基础上**只新增 `cards` 段**，其他字段不变。版本号按 HARNESS.md 的规则走次版本号。卡片的字段**对齐前端已有的数据形状**（`src/components/workbenches/research/`），这样以后 P1-12 接前端时不用二次转换：

| 卡片 | 必填字段 | 对齐的前端类型 |
|---|---|---|
| `layer`（精读分层讲解） | `paperId`、`no`、`title`、`en`、`body: [{ text, refs: [anchor] }]`，可选 `anim` | `read/paper.ts` 的 `Layer` |
| `quiz`（检查题） | `paperId`、`layer`、`q`、`keys: string[][]`、`hint`；`keys` 只存进档案，不回显给模型 | `read/paper.ts` 的 `Quiz` |
| `finding`（发现） | `text`、`evidence: [anchor]`（至少 1 条）、`confidence: low/mid/high`、`status: hypothesis/supported/refuted` | `ResearchBench.tsx` 的 `Finding`；前端的 `n` 与 `at` 由服务器生成 |
| `answer`（问答回复） | `questionRef`、`text`、`citations: [anchor]` | 精读里的带定位问答（P2-05 会用到） |

`anchor` 统一为 `{ paperId, page, quote }`，其中 `quote` 不超过 300 字，`page` 必须是 `papers.pages` 返回过的页码。

**档案升级：** 已有档案仍钉在 1.0.0。升级收件箱（T-HAR-4）还没实现，所以 T-MCP-10 **用一个新建在 1.1.0 上的档案**来跑，不改旧档案的钉住版本。

## 3. 凭据：情况在变严重

审查方复查：`.zshrc` 里的自动导出行**还在**，当前 key 在 Codex 本机日志里的命中**从 2 处增加到 4 处**（Codex 报告的是 5 处）。原因是 Codex 每开一个新终端，都会继承这个环境变量，并被写进它的终端快照。

要求：
1. **用户：** 先删掉 `.zshrc` 里那一行，再轮换 key。顺序很重要：不删那一行，新 key 一样会漏进去。
2. **Codex：** 旧部署鉴权和本地 `runtime.env` 的环境变量传递（Q-068 / Q-072 / Q-073），排进下一批第一项，迁移到「进程内从文件读取」。

## 4. 观察（不阻塞）

1. **纯 IPv6 来源不可用：** `papers` 只把公开 IPv4 固定到连接，纯 IPv6 来源目前用不了。OpenAlex 有 IPv4，不影响使用；记录在案。
2. **Poppler 依赖：** PDF 文本层依赖宿主机装的 Poppler。账户镜像和 CI 里都有；本机开发需要 `brew install poppler`，已写在复跑说明里。
3. **GPG 签名：** 本批提交是单次关闭 GPG 签名后提交的，没有修改全局配置，可以接受。以后如果要求签名，需要用户配置一个不需要交互输入密码的签名方式。
4. **红灯文件名有误导：** 证据里 `red/client-transactions-green.json` 名字带 green，内容其实是失败，Codex 已经主动说明。以后命名请和内容一致。

## 5. 下一步

1. 用户：删除 `.zshrc` 里那一行，然后轮换 key（第 3 节）。
2. Codex 第五批：
   - **先**做凭据的环境变量迁移（第 3 节第 2 条）；
   - 再发布 `research@1.1.0`（第 2 节）；
   - 然后做 P1-12：审批卡与「上线时待批准」收件箱的 API 和前端 live 接入；
   - 用户重新授权后，做 T-MCP-10，预算 ≤ ¥1。
