# P1-11 独立安全与迁移最终复核

## 对象与结论

- 工作树：`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`
- 分支：`codex/p1-11-mcp-capabilities`
- 本次核对 HEAD：`d5975f0837502005f6e6152ddffa596653737b87`
- 范围：能力目录与旧摘要兼容、Ed25519 令牌、服务器鉴权、租户与范围固定、一次审批与幂等、账户文件边界、论文网络/缓存边界，以及两份新增数据库迁移。

**结论：在上述已读实现与定向 fixture 验证范围内，没有未解决的已确认 P1/P2 安全缺陷。先前发现的缺陷已修复并复核。该结论可以作为 P1-11 安全与迁移独立评审证据，不等于真实模型端到端、部署容器或实际凭据扫描的完成证明。**

本 agent 只修改获授权的独立测试文件和 `/tmp` 审查报告，未修改实现。所有命令使用 `login:false`；执行测试前去除 `DEEPSEEK_API_KEY`。未读取任何真实凭据文件、未使用浏览器、未调用真实模型；papers 网络完全使用 fixture/mock。

## 安全边界复核

### 不可变目录与运行授权

旧 v1 registry 的核心 tools/mcp/delegations 保持原有投影与摘要语义，未借新增 capability metadata 改写已发布 bench。新增 catalog 的 revision、capabilities 和 aliases 独立计算摘要并在创建 run 时绑定。旧 run 没有能力快照时拒绝签发，不能套用当前目录。

别名编译保留清单限制；专用写别名与 write_targets 求交，literature.fetch 的最低权限为 ask。卡片仍须已发布 manifest 明确声明 schema；research@1.0.0 的空 cards 声明没有被静默补齐。继承属性不能作为已登记能力。

### 令牌、租户与吊销

Ed25519 验签固定算法/格式及 issuer/audience，校验有效期上限两小时。在线验证同时核对 live run、已登记 jti/claims_hash、scope/catalog/effective 摘要、身份和 reserved hold；失败不退回离线授权。validateClient 接受原始令牌并重新验签，不接受普通 claims 对象。

控制面持有签发私钥，账户运行配置只接收对应短期凭据。完整令牌不进入 DB、角色 project 或新建环境变量接口；DB 保存 jti、声明摘要与必要身份/时间/吊销字段。私有运行配置位于项目外，采用 0600 文件和 0700 父目录。旧部署鉴权 ENV 接口是用户单列的迁移例外，不构成新 MCP 令牌进入 ENV 的授权。

run 级吊销记录不可撤销，签发与吊销通过 run 锁和 account budget 首锁协调，吊销后不能重新签发。独立测试覆盖并发 issue/revoke、跨租户验证、未登记签名 claims、声明对象冒用，以及身份/FK 不匹配。

### once 审批、HTTP 幂等与锁顺序

ask 调用必须具有稳定 requestId；审批绑定 run、capability、参数摘要、scope 和请求号。批准与消费是不可回退状态；同请求成功重放返回原结果，参数变化或跨请求复用审批拒绝；未知结果保留 indeterminate 围栏，不自动重执行。

原生插件在服务器返回 APPROVAL_REQUIRED 后发起 synthetic permission。真正用户决定必须为 once，fresh native pending 与持久化绑定精确一致，并符合冻结 mcp grant；普通历史 replied、session 授权或参数摘要变化不能替代此次用户批准。MCP 配置保留在不可变执行 binding 的 definition/input hash 链中。

新 HTTP decision/revoke 使用 Idempotency-Key，Client 方法复用 mutate 传入的数据库连接，副作用与 HTTP 收据同事务提交。单连接池测试通过，关闭此前嵌套借连接导致的池耗尽/事务分离问题。

涉及调用 admission、事件账本、用户决定、data 写 handler、authority issue/validate/revoke 的路径统一以 account budget 为首锁，再进入运行/审批等行锁及 ledger；与 observer 的顺序一致。invocation finish 只更新自身状态，没有再取 ledger/budget 的反向等待链。此前真实 fixture 暴露的 run/ledger 死锁已由 root 修复；本 agent 核对了修后的锁顺序。

### files 与 papers

files 使用 descriptor-relative 路径遍历、NOFOLLOW、普通文件/单硬链接检查、档案 flock、stage copy 与原子目录交换。撤销必须覆盖版本中全部原始 paths，并保留后续无关修改；历史保留最近 50 个版本。独立测试覆盖并发写入、precommit 故障回滚、链接/特殊文件、撤销范围及历史淘汰。UTF-8 stdout 分块损坏已改为 Buffer 合并后解码。

papers 对初始 URL 和每次重定向执行域名、协议、端口及全部 DNS IPv4 地址检查，实际 TLS request 固定已核验地址，family:4 与 Node 22 lookup 契约一致。生产禁止注入 test dns/wire。无 OA/许可证证明时不取全文，并明确返回 abstract_only。

共享 cache 只含公开 PDF；论文访问仍由 paper_asset 的租户/档案记录控制。cache 通过完整私有临时文件写入/fsync 后原子发布，对残留损坏缓存使用本次已验证公开 PDF 修复。页码锚点对应原 PDF 页码；缓存篡改拒绝。控制面 binary importPaper 仅写固定 papers/UUID 文件名，不能使用调用者提供的任意目标路径。

## 新增迁移审查

### 202610230001_mcp_authority.sql

已在本次最终只读复核中重新读取完整迁移。

- `mcp_run` 通过 account/dossier/run/effective_digest 复合 FK 指向 run_harness；scope 与 catalog 固定并有摘要字段。
- `mcp_credential` 通过复合 FK 同时绑定对应 mcp_run 和 budget_hold，期限约束不超过两小时；无完整令牌列。
- `mcp_approval` 绑定同 run 的原审批与请求，唯一请求号，并用非空语义明确保证 consumed 只能对应 approve。
- `mcp_invocation` 的主键为 account/run/request，审批 FK 含相同 account/run。
- 上述租户表及 `mcp_run_revocation` 均启用并 FORCE RLS，策略同时约束 USING/WITH CHECK。
- 应用角色仅有 SELECT/INSERT 与必要列级 UPDATE；身份/摘要/参数等授权字段不可 UPDATE，DELETE/TRUNCATE 撤销。
- mcp_run 与 run revocation append-only；credential 吊销、approval 决定/消费、invocation 终态由分表字段分支的 trigger 阻止回退。
- anonymous denial 只允许插入固定格式审计，不接受未验签身份作为租户依据；应用角色不可读取、更改或删除这些匿名记录。

实际 PostgreSQL fixture 已覆盖正常 credential 吊销、审批消费、调用终态、空决定消费拒绝、错误档案 FK、跨租户可见性，以及不可回退和权限撤销。先前 trigger 跨表字段访问及 nullable CHECK 缺陷均已关闭。

### 202610230002_paper_assets.sql

已在本次最终只读复核中重新读取完整迁移，明确确认：

- `paper_asset` 启用并 FORCE RLS；应用角色的 USING/WITH CHECK 均限定 app.account_id。
- account_id/dossier_id/run_id 复合 FK 指向同一 mcp_run，不能仅凭全局 UUID 跨账户/档案挂接。
- 状态限定为 full_text/abstract_only；full_text 必须具有 is_open_access=true、非 NULL license 和 sha256；摘要字段受格式约束。
- 应用角色仅获 SELECT/INSERT，UPDATE/DELETE/TRUNCATE 撤销；append-only trigger 额外阻止 UPDATE/DELETE。

论文独立 PG fixture 实测跨账户行不可见、同账户错误档案 pages 拒绝、UPDATE 权限拒绝。未声称该测试逐项动态覆盖了迁移的所有 FK/CHECK；其余上述条目由源码核对确认。

## 独立执行证据

最近一轮由本 agent 在 Node 22.23.3、默认本地 PostgreSQL 55432 实际执行：

| 独立测试文件 | 结果 | 核心范围 |
|---|---:|---|
| independent-mcp-security.test.ts | 7/7 | 验签/租户、吊销并发、schema、once、并发重放、未知结果、FK/状态权限 |
| independent-mcp-integration.test.ts | 3/3 | 冻结 mcp binding、真正用户 once 桥接及篡改拒绝、单连接 HTTP 同事务幂等 |
| independent-mcp-papers.test.ts | 5/5 | Node lookup 契约、逐跳 DNS、OA 降级、租户/页码/cache、固定 binary deposit |
| **合计** | **15/15** | 完整针对性复核，无真实模型或 papers 外网访问 |

此外，本 agent 较早实际执行的 files 独立测试在 Node 22/24 均为 6/6，覆盖并发、回滚、范围撤销、链接/特殊文件和 50 版本；不将其混记为最近 15 项中的部分。没有独立认领未经本 agent 执行记录确认的“16项”计数。

完整测试/CI 通过由 root 报告；本报告没有重复执行全量。真实锁定 OpenScience + fixture provider 的原生 once 主链由 root 报告通过；本 agent 提供的 native pending 模拟/DB 桥接证据与 root 的真实内核 fixture 证据应分开归档。

## 凭据扫描器复核与证据限制

扫描器 7/7 纯 fixture 单测通过。额外独立实际 chmod000 子目录复现已变为 incomplete/readErrors=1，关闭假通过；FIFO/符号链接非阻塞拒绝、缺 required scope、Git stderr 秘密输出路径均已修复。详细报告：`/tmp/reinlab-p111-scan-review.md`。

**未由本独立 agent 证明完成：**

- T9 对真实选定凭据值、真正日志/历史/证据/快照的扫描；本 agent 未读这些真实来源。
- 容器镜像部署、Linux 原子交换的最终运行验证、终态私有配置清理完整链、备份恢复或掉电场景；应引用 root 的独立证据，不能由本报告代替。
- T-MCP-10 真实模型端到端及其 key 轮换/重新授权要求。
- OCR、被排除目录或未被选择的历史 token 值；扫描器结论只能覆盖其声明范围和所选值。

这些是证据范围与验收停止点，不是本报告新确认的实现安全漏洞。
