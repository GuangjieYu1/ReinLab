# P1-10 关闭审查

- 日期：2026-10-22
- 审查方：Claude
- 被审对象：Codex 工作树 `research-foundation`，分支 `codex/p1-10-translation-complete`
  - 提交：`bc995fe`
  - PR：GuangjieYu1/ReinLab#16（待审）
- 依据：
  - [BATCH2_REVIEW](BATCH2_REVIEW.md)
  - [CODEX_BRIEF_BATCH3](CODEX_BRIEF_BATCH3.md) 与 [补充说明](CODEX_BRIEF_BATCH3_ADDENDUM.md)
  - [BATCH3_INTERIM_REVIEW](BATCH3_INTERIM_REVIEW.md) 及其追加部分

## 结论

**P1-10 关闭（代码与验证通过）。** 进入 P1-11 前，要先处理一项**凭据事件**（第 3 节），这件事由用户来做，不是代码缺陷。

## 1. 审查方亲自复核

| 项 | 方法 | 结果 |
|---|---|---|
| 全量测试 | Node 22.23.3，环境里去掉真实 key | **1347 / 1347，0 失败 0 跳过**；跑完后工作区仍为 0 改动（D-4 继续成立） |
| T-REG | 上次在 Codex 分支上跑过 | 18 / 18（之后前端没有改动） |
| B-1 / B-2 | 读提交 `42bbcd8`、`090d2fd` | 别名配置已核实生效；resolver 按 `tunable` 白名单逐个字段拒绝 |
| B-6 | 读 `role-runtime.ts` | SDK 模型配置里显式写了 `thinking: {type: "disabled"}`，并在提交前核对配置 |
| B-7 | 读 `one-shot-smoke-guard.ts` | `thinking` 字段缺失也拒绝转发 |
| B-8 | 读 fixture 截获的出站请求体 `B-8/native-green/native-catalog.json` | 确认含 `thinking: {type: "disabled"}`、`deepseek-flash`、`max_tokens`。这一项补齐了上一轮审查方没能亲自核到的部分 |
| 第二次真实冒烟 | 读 `real-smoke-second-authorization/`：执行摘要、账本、对账表、13 项检查 | 真实转发 1 次，运行 completed；输入 2754 / 输出 3 token；账本 ¥0.002766，按空闲价重算一致（2754×1 + 3×4，单位：元 / 百万 token）；专用 key 账单 ¥0.002766，误差 0%；13 / 13 项检查通过 |
| 第一次失败 | 同上 | 记录原样保留：unknown / unpriced，没有被冲销或改记成免费 |
| 凭据扫描 | 用当前专用 key 的值逐字搜索（只数命中次数，不打印 key） | 工作树 0、git 全部历史 0、主仓库 0。**Codex 本机日志有 2 处命中**（见第 3 节） |

## 2. 第三批要求逐项结果

| 要求 | 结果 |
|---|---|
| D-3、D-4、观察 1（三种重启下的幂等）、观察 2（排版） | 关闭 |
| 本地 Supabase CLI 全套 + docker 驱动 | 完成（本地基础设施检查 9 / 9） |
| T-REG 入库并更新到 18 个场景 | 完成 |
| P1-10：会话、提交、事件映射、决定回填、费用 | 完成 |
| harness：T-HAR-1、2、5、10 | 完成；T-HAR-4、6、8、9 按 HARNESS.md 的落地顺序留到后段 |
| 用真实模型跑通一次，费用 ≤ ¥1 | 第二次授权成功；费用 ¥0.002766，账单对平 |
| 所有 CI 终态 | Codex 报告最新两组共 6 / 6 jobs 全绿，遗留 run 39279672175 也已确认成功。审查方本机 `gh` 没有登录，无法独立核对；采信 PR 描述里的记录 |

## 3. 凭据事件（必须处理）

**发生了什么：**

1. **浏览器弹窗被读入对话：** Codex 操作 Safari 查账单时，前台还开着用户刚创建 key 时的弹窗，它的浏览器工具把弹窗里的 key 明文读进了 Codex 的对话输出（Q-067，Codex 主动报告）。这份对话会经过 OpenAI 的服务。
2. **shell 环境快照：** 审查方另外发现，key 出现在 `~/.codex/shell_snapshots/` 的一份环境快照里。原因是此前审查方建议在 `~/.zshrc` 里自动加载 `local.env`，于是 key 进入了所有终端的环境变量，包括 Codex 开的终端。**这是审查方此前建议的问题。**
3. **没有进仓库：** 仓库、git 历史、账本、证据里都没有这个 key。

**要求：**

1. **用户：** 在 DeepSeek 后台删除这个 ReinLab 专用 key，新建一个，用原来那条命令写进 `local.env`。**新建完成后先关掉显示 key 的弹窗**，再让任何工具去操作浏览器。
2. **用户：** 从 `~/.zshrc` 删掉自动加载 `local.env` 的那一行。冒烟脚本本来就直接读文件，不依赖环境变量。
3. **用户（可选）：** 删除含旧 key 的 Codex shell 快照。轮换之后旧 key 已经作废，删不删都不会再造成风险。
4. **Codex：**
   - 以后操作浏览器时，先确认前台没有显示凭据的弹窗；
   - 工具读到的页面文本一律先遮盖 key 形态，再输出；
   - 不在 shell 环境里导出 key，只在需要的进程里读取文件。

## 4. 留到后续的事项（不阻塞关闭）

- **harness：** 落地 T-HAR-4、6、8、9（版本升级收件箱、门禁钩子、卡片、回放）。
- **恢复：** 无人访问时的全局主动恢复，留到 P1-13，接 Hatchet。
- **网关：** 部署 LiteLLM 网关；云端补验（Fly、Supabase 东京）照旧按 DEFERRED.md 走。
- **账本标志：** 账本里第二次冒烟的原始报告仍是 `providerInvoiceReconciled=false`（那是采集当时的快照），真正的对账结论在独立报告里。以后再做对账任务时，在账本里追加一条「已对账」事件，不改历史记录。

## 5. 下一步

1. 用户完成第 3 节的轮换，并删掉 `.zshrc` 里那一行。
2. 用户确认后，Codex 才开始 P1-11（插件：卡片工具、记忆工具、权限钩子）。审查方会另外给出第四批的开场说明。
