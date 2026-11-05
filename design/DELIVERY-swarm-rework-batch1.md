# 交付 · 群研返工第一批（工具开放 / 核实门禁 / 黑板减负 / 成稿）

分支 `codex/swarm-4`（从 main `195a4aa` 拉出），一个提交。契约 13 只按 brief 加了 `report.narrative` 一个字段，其余没动；前端没动。

## 1) 工具完全开放（用户 2026-11-05 定，推翻 11-03 的决定）

- 队员（研究员 / 反驳 / 核实）现在拿到和 DSH 单人默认一样的工具：**bash、read、write、edit、grep、glob、read_image、job_*、skill、todo_write、ask_user_question**，加上 **papers_search / papers_fetch / papers_register / papers_pages**（`reinlab-read-plugin` 在 `mode=swarm` 下也注册下载与登记）。
- 唯一保留的限制：`present` 仍只给负责人（它是交付出口，不是研究工具）。
- `web_fetch` 截断后落盘的整篇（`/tmp/dsh-spill…/web_fetch.txt`）现在能被 `read` / `grep` / `bash` 打开——这正是上次漏掉「Generative Agents 成本」那句的原因。
- 账户容器里能装依赖、跑开源项目试用（bash 已开放，容器本来就有网络）。
- **写黑板的入口仍然只有 `research_submit`**：控制面的 `swarm.submit` 是唯一写入路径，别的工具写文件不算结论。
- 密钥：容器里拿到的 `DEEPSEEK_API_KEY` 一直是**运行令牌**（不是宿主 key），宿主 key 只在控制面进程内存里；队员用 LLM 走同一个网关，`usage_record` 照记。

## 2) 核实门禁补一条（否定式结论）

- `research_review_claim` 新增 `read_completeness: full | partial`，落进 `swarm_review.read_completeness`——**审查记录里能直接看到**（结论详情 → 审查记录）。
- 否定式结论（`negative` 非空）判 `verified` 时：
  - `read_completeness` 不是 `full` → 409 `VERIFY_NEEDS_FULL_TEXT`（「读不全就判 not_verifiable」）；
  - 理由里出现「截断 / 读不全 / 无法穷举 / 只读了摘要 / 打不开」→ 同样拒；
  - 正确做法是判 `not_verifiable`，结论进「证据不足」。
- 人设底线里加了一句：核实尽量换一种读法或来源（PDF、另一版本、bash 全文搜索），不要和反驳读同一份截断文本。

## 3) 黑板减负

- `research_query` 默认只回**摘要**（id / 版本 / 状态 / 路线 / 作者 / 证据条数 / 一句话前 140 字）+ **自上次读取以来的增量**（游标 `swarm_cursor.seen_at`，按成员记）。
- 要看全文和证据：`research_query({ claim_id })` 取那一条；`include: "full"` 是全量导出（忽略游标）。
- 依据：上次运行每次读黑板平均 2.3 万字、最多 5 万字——现在是每条约 140 字 + 增量。

## 4) 成稿

- 新工具 `research_narrative { markdown }`（负责人专用）→ `swarm_run.narrative` → **`report.narrative`**（契约 §2 新增字段，markdown）。
- 校验：少于 40 字或超过 6 万字拒；文中出现的 UUID 会和黑板比对，对不上的放进返回值的 `unknownCitations`（不拦，但要让人知道）；只有负责人能写。
- 人设底线第 7 条：结束前必须交成稿（框架 → 判断 → 建议 → 能照搬什么 → 要自己做什么 → 风险；引用只写黑板上真实的 id，未核实的要标）。

**narrative 样例**（测试里用的形状）：

```markdown
# 结论
第一条（<claim-id>）可信。

## 缺口
- 还没有等预算的对照实验。
- 引用 <evidence-id> 的那句话只核到摘要。
```

## 5) 模型：需要你定一个（阻塞项）

- 官方 API 只有 **`deepseek-flash`、`deepseek-v4-pro`** 两个型号；直接传 `deepseek-v4.1-flash` 会被拒：
  `The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash`。
- 你的 DSH 是经 **opencodego** 用的 `deepseek-v4.1-flash`。要换过去需要：**base URL** 和 **key**（key 只进 `~/.config/reinlab/local.env`，不进环境变量/日志）。
- 代码已经就位：新增 `REINLAB_SWARM_MODEL`（群研单独型号）与 `KernelService.swarmModel`，群研那一档的 launch 用它、其他档位不变；`usage_record.model` 记的是真实型号，`cost_cny` 按网关回传的用量算。你把 opencodego 的地址和 key 给我，改一行 env 就能切。

## 验证

`services/control` + `packages`：**614 条全绿**。新增三条：
- 否定式结论「读不全却想判已核实」被拒（两种写法）、正确判 `not_verifiable` 进证据不足、读全 `full` 可判已核实；
- 黑板默认只回摘要 + 增量、`claim_id` 取全文带证据、成稿进 `report.narrative`、只有负责人能写、对不上的引用被指出；
- 插件工具面：队员的 deny 列表里**不再有** bash / read / grep，只剩 `present`；
- 运行补丁里的三条新底线（工具开放、否定式结论 read_completeness=full、结束前交 research_narrative）确实写进了 persona。
