# P1-11 第四批送审证据

## 待决定 / 待补验（不能视为全部验收通过）

1. **T-MCP-10 待授权**：旧 DeepSeek key 尚未确认轮换，先前两次授权均已消费。本批真实模型请求 **0**，真实模型费用 **¥0**。需用户确认轮换并重新授权后才可进行 ≤¥1 端到端及专用 key 核账。
2. **卡片清单版本**：已发布 `research@1.0.0` 的 `cards={}` 保持不可变，因此该版本实际发卡明确拒绝 `UNDECLARED_CARD`。通用卡片正向测试使用独立 fixture bench。建议审查方批准新版本的 finding schema 后再做 T-MCP-10，见 Q-069 / Q-072。
3. **T-MCP-9 部分通过**：新增 MCP 令牌不进入 ENV / argv / 角色 project；实际值扫描另见 `security/credential-scan.json`。既有部署鉴权和 local runtime.env 凭据传递迁移待处理（用户已接受旧部署令牌单列），历史泄露日志不删除、不掩盖。扫描为字节级，不含历史截图 OCR；不能声称整机或所有历次临时 token 均零泄露。
4. Fly / Supabase 托管环境统一 **云端补验**；本批容器与完整本地 Supabase 不能替代云验收。不进入 P1-12。

## 范围与结果

能力目录、Ed25519 短期令牌与运行吊销、服务器侧权限/参数检查、files/memory/cards/papers、once 审批桥接、账本与写入幂等已实现。HTTP 外部客户端绕过插件仍受同一服务器边界限制。原生写入工具全部拒绝，清单 / 上游源码 / 前端不改。

| 验证 | 通过 / 失败 / 跳过 | 证据 |
|---|---:|---|
| Node 22.23.3 全量 | 1385 / 0 / 0 | green/full-node22.json |
| Node 24.14.1 全量 | 1385 / 0 / 0 | green/full-node24.json |
| T-REG mock | 18 / 0 / 0 | t-reg/report.json；每场景末张截图及 SHA256 索引 |
| 独立 MCP 安全 / HTTP / papers + 原生 fixture | 16 / 0 / 0 | green/pre-freeze-security.json；其中独立安全 agent 亲跑 15 项，原生 1 项由主 agent 执行 |
| 真实 Linux 账户镜像 | 7 / 0 / 0 | container/container-test-report.json |
| Linux MCP 原子补丁 / 撤销 / stdio / 配置清理 | 4 / 0 / 0 | container/mcp-container-test-report.json |
| 值扫描器纯 fixture | 7 / 0 / 0 | security/scanner-unit.txt；security/reinlab-p111-scan-review.md |
| 新增 fixture 账本导出 | 1 / 0 / 0 | green/native-ledger.json；native-fixture/mcp-ledger.jsonl |
| 类型检查 / 依赖边界 / mock 构建 | 通过 | green/validation.json；green/mock-build.txt |
| CI | 见独立终态记录 | ci/README.md |

全量已包含定向项，不把定向项再加到全量总数中。T-MCP 逐项对应 `test-index.csv`。`frontend-baseline.csv` 逐文件验证 253 个 src / e2e/legacy 文件相对 P1-10 `bc995fe` 完全一致。

## 核心边界

- 权限从已冻结 run 快照与能力目录摘要求交；旧 run 没快照不会套 current。research@1.0.0 与旧 registryHash 不变。
- 令牌每次在线核验 hold / 身份 / run / 吊销，最长两小时；DB 仅持久化摘要。配置在档案/角色之外，父0700、文件0600，结束与过期清理，备份不包含临时凭据。
- once 绑定 run、能力、请求号、参数摘要与 scope；HTTP 用户决定同幂等事务。执行结果未知留围栏，不自动再执行；同号同内容返回原收据，异内容409。
- files 使用 descriptor-relative/no-follow 检查，拒绝越权、符号链接、多硬链接与特殊文件。档案目录原子交换提交，失败不降级顺序 rename；保留最近50版。单文件1MiB、补丁4MiB/32项、档案64MiB/4096项，超限拒绝。
- memory.propose 只建待批准收件箱，L3/L4 不变；Q-060层级/refs（包括空集合）与 assigned-citations 范围不放宽。
- papers 仅白名单 HTTPS，逐跳复核并将公开 IPv4 固定到连接；仅 OA+license 全文，其他 abstract_only。共享缓存只存公开 PDF；控制面固定路径写入账户档案。Poppler 文本层保留原 PDF 页码锚点。生产外网可用性与纯 IPv6 来源未验。

## 红绿与修复说明

`red/` 原样保留失败，包括能力目录尚未实现、继承属性授权、原生写权限合同更新、Zod4 工具 schema 接口、账户 ledger/run 锁反序与单连接池借连接问题。`red/client-transactions-green.json` **名称来自当时临时文件，实际含失败，不是通过报告**；最终以 green 全量为准。独立安全 agent 发现的迁移检查、授权与扫描器问题及修复见 security/。RLS、引用约束、沙盒没有放宽。

Docker Desktop 数据库无响应后，用户授权重启。共享数据库恢复；最终全量使用 55432，镜像验证使用任务专用 Colima。测试期间没有启动真实模型调用。

## 复跑

```sh
# Node 22 或 Node 24；不 source 真实凭据，不导出模型 key / 能力令牌。
unset DEEPSEEK_API_KEY
pnpm install --frozen-lockfile
pnpm db:up
pnpm test --reporter=json --outputFile=/tmp/p111-tests.json
pnpm lint
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec tsc -p services/control/tsconfig.json
pnpm exec tsc --noEmit --strict --skipLibCheck --esModuleInterop --moduleResolution bundler --module ESNext --target ES2022 --lib ES2022,DOM --types node tooling/local/up.ts
VITE_BACKEND=mock pnpm build
python3 tooling/security/test-scan.py
# PDF fixture 需要 pdftotext：macOS brew install poppler；Linux apt install poppler-utils。
# Mock 前端另起：VITE_BACKEND=mock pnpm dev；使用 fresh headless profile：
REINLAB_URL=http://127.0.0.1:5173 E2E_OUT=/tmp/p111-treg node e2e/legacy/run.mjs
# Linux disposable Docker，完全无真实模型：
docker build -f infra/fly/account.Dockerfile -t reinlab-account:p1-08 .
node services/account-runtime/verify-container.mjs
node services/account-runtime/verify-mcp-container.mjs
# 完整本地 Supabase / Auth / Vault / Storage / 账户容器：
pnpm local:up
REINLAB_EVIDENCE_OUT=/tmp/p111-local-integration pnpm local:verify
```

确切 T-REG 命令与扫描方法见各目录说明；值扫描只能传配置文件路径，不可把值传入 argv / ENV。真实模型命令本批不提供或执行。PR 基于已审 P1-10 分支，未经用户授权不合并前序 PR 或 main。
