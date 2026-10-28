# 交付说明 · DSH 精读改造（交 Claude 验收 B1–B4）

分支 `slim/backend`（基线 `0298c89`）。spec 见 [SPEC-slim-dsh.md](SPEC-slim-dsh.md)。
前端目录一行未改；`AGENTS.md` 的既有未提交改动保留。

## 1. 怎么跑

真实模型需要 `~/.config/reinlab/local.env`（`DEEPSEEK_API_KEY`，0600），然后：

```sh
pnpm --dir <后端工作树> local:up22 --real-models
```

`local:up22` 走 `tooling/local/start.sh`：固定用项目工具链的 Node 22
（`~/.local/share/reinlab/toolchains/node-v22*/bin/node`，可用 `REINLAB_NODE_BIN` 指定），
不依赖 PATH 上的 `node`；内核拉起的 `dsh` 子进程也固定用同一个 Node。
在 Electron 运行时（例如从 DSH 桌面应用里跑 `pnpm local:up`）会直接报
`LOCAL_ELECTRON_RUNTIME_FORBIDDEN` 并退出——dsh 不接受 Electron 的运行时指纹。

- 可选环境变量（都不填也能跑）：
  - `OPENALEX_API_KEY`：有 key 时 OpenAlex 走自己的额度，没有就吃共享额度（429 属于正常现象，模型会换源）
  - `REINLAB_UNPAYWALL_EMAIL`：Unpaywall / Crossref 的礼貌邮箱，默认 `research@reinlab.app`
  - `DEEPSEEK_WEB_FEE_CNY`：网页检索/抓取每次成功请求的记账单价，默认 `0.005000`（官方 ¥5/千次）
- 控制面 `http://127.0.0.1:3001`，前端 `http://127.0.0.1:5183`，Supabase `54321`
- 只有新内核：启动不会再起 OpenScience / Hatchet / worker，也不再构建账户镜像
- 启动输出里 `image:"host"`、`kernelTransport` 表明**没有构建账户镜像、没有起 OpenScience/Hatchet/worker**
- 本机 Docker Hub 不通，已用公共镜像站（colima `registry-mirrors`）拉起 supabase；这是本机环境配置，不在仓库里

## 2. 后端提供什么语义

| 语义 | 入口 | 说明 |
|---|---|---|
| 建一次精读运行 | `POST /v1/kernel/runs` `{dossierId, query, chosenPaperId?}` | 建 run 后提交内核；返回 `{id, sessionId, resume}` |
| 运行状态 + 用量 | `GET /v1/kernel/runs/:id` | `state`、`session{state,errorCode}`、`usage{known,requests,unknownRequests,knownCny}` |
| 运行事件 | `GET /v1/kernel/runs/:id/events?after=` | 按 `seq` 游标；`kind='dsh'`，`action` 是内核事件名 |
| 取消 | `POST /v1/kernel/runs/:id/cancel` | 只关该轮子进程；**确认进程消失**才返回 `cancelled`，否则 `cancel_unconfirmed` |
| 唯一审批 | `GET /v1/approvals?state=pending` / `POST /v1/approvals/:id/decide` | 一次具体动作一张卡（`effect_key` 绑定参数哈希），批准后仅能消费一次 |
| 插件工具入口 | `POST /kernel/tool`（运行令牌，插件内部用） | 只接受 `papers.search/fetch/pages`、`cards.*`，其他一律拒绝 |

契约说明：字段名与路由**以 Claude 的新契约为准**；本轮没有改前端、也没有按旧契约去猜。上面的路径是后端现有实现，供你映射或改造。

## 3. 已验证（真机，非 stub）

- 真 `dsh --profile sdk` → 控制面 `/llm/anthropic/v1/messages` → 真 DeepSeek，返回中文精读答复；模型可见工具只有精读工具（无 bash/edit/write）。
- 多步工具循环：`papers_search` → 候选 → `papers_fetch` 出**一张**审批卡 → 批准后真实下载 → `papers_pages` 读页 → 继续。
- **真机走查（2026-10-28，改动后重跑，19 步全过）**：说想读哪篇 → 真实候选（arXiv）→ 用户选择卡
  （`clarify_question(kind=paper_pick)`，带真实候选，模型不代选）→ 选定 → 只有一张下载审批 →
  批准后真实下载 → `papers_pages` 读页 → 完成，用量 `known=true`；同档案追加线索复用同一
  session（`resume=true`）。
- 取消：`cancel` 6.07s 返回 `cancelled`，内核进程确认消失。
- 一次性清空旧业务数据已执行：42 张业务表 `TRUNCATE`（不带 CASCADE），账号 18 条保留，`dossier/run/credential` 归零；旧 `rl-*` 容器与 18 个旧卷已删除。
- 自动化：`kernel-*` 共 14+ 文件用例全绿，含真进程端到端（真 dsh + 本地 Messages stub + 插件工具回填 + 取消确认）。
- **2026-10-28 修的三处**（都跑过真机，不只是单测）：
  1. **检索 500 的根因**：OpenAlex 自 2026-10 起按 IP 共享额度计费，本机匿名请求稳定返回
     `429 Insufficient budget`（宿主直连也一样，不只是内核里）；旧代码把这种响应当异常冒成
     `INTERNAL_ERROR`，页面只剩 `KERNEL_TOOL_HTTP_500`。现在检索默认走 **arXiv**（Atom 接口，
     候选编号 `arxiv:…`，全文走 `arxiv.org/pdf/…`），同一套只读白名单不变；`OPENALEX_API_KEY`
     存在时仍走 OpenAlex。长问题全 AND 匹配不到会自动从整句收窄到词头，不急着答「没找到」。
     连续 5 次 `papers.search` 5/5 成功（约 1.2–2.6 s，每次 3–4 篇真候选）。
  2. **工具失败带错误码和原因**：`POST /kernel/tool` 现在回 `{code,message}`（如
     `PAPERS_UPSTREAM_STATUS`「检索来源返回 429，暂不可用。」），其他异常记 `KERNEL_TOOL_FAILED`
     并带原因，不再只有 HTTP 500。
  3. **讲解层兜底**：读轮正常结束后数本轮 `card_layer`，不到 5 层就在同一会话再提醒一次补写；
     补完还不够就照实结束（`KERNEL_LAYERS_SHORT` 记层数），界面写「讲解只生成了 N 层」，
     不写「已完成」。真机实测：模型首轮只写 4 层 → 提醒后补到 7 层，用量 ¥0.053。

## 4. 能力与提示词（本轮按新要求重做）

**工具全部交给模型自己决定用不用、先用哪个**（提示词里没有任何操作步骤）：

| 能力 | 入口 | 说明 |
|---|---|---|
| 论文检索 | `papers_search{query, source?, limit?}` | 来源可选 `arxiv` / `openalex` / `crossref`，不指定就三家一起查。每个来源的成功/失败都随结果返回（`sources[]`），失败带 `{code,message}`，模型据此换源或问用户 |
| 网页搜索 / 抓取 | `web_search` / `web_fetch`（DSH 自带） | 走 DeepSeek 官方 Search / Fetch API（[官方计费：每千次成功请求 ¥5](https://api-docs.deepseek.com/guides/search/)），控制面代理持有宿主密钥，成功调用按 ¥0.005/次如实记账 |
| 下载全文 | `papers_fetch{paperId}` | 支持 `arxiv:` / `W…` / `doi:`；只允许下载**用户选定的这一篇**，且必须批准一次（同一次下载只有一张卡，重复调用返回已有资产） |
| 按页读取 | `papers_pages{assetId, pages}` | 页码回执落在 `paper_page_read`，卡片引文按它核验 |
| 讲解 / 发现卡 | `card_layer` / `card_finding` | 内核自己的写入器：research 卡片规范 + 「引文必须来自本轮读过的页」+ `card_created` 事件；讲解层不足 5 层后端提醒一次，补不回来就照实写层数 |
| 问用户 | `clarify_question` | 带候选时是 `paper_pick` 选择卡，用户不选就不下载 |

**出站**：改用系统解析器 `dns.lookup`（IPv4/IPv6 全局单播都认），单次请求 15s 超时；超时、解析失败、连接失败、上游 4xx/5xx 都会把错误码和一句原因原样返回给模型。

**提示词只剩三条底线**：下载全文/写文件要用户批准一次；不编造论文、作者和页码；候选论文由用户来选。其余流程规则全部删除。

**检索为什么之前「不稳」**：OpenAlex 现在按 IP 共享额度计费，匿名请求经常 429；arXiv 有速率限制。现在三家并行、每家各自重试一次、同一查询 60 秒内走本地缓存，全失败才报错并带上每家的原因。

## 5. 测试与已知问题

`services/control` 全量：167 文件 / 1207 用例全绿。验收脚本 `scripts/walkthrough/research-read.mjs` 保持原样（Claude 自己跑）。

已知/刻意保留：
- 澄清轮只给 `papers_search` + `clarify_question`（网页工具在这一轮关闭），候选 15–25 秒出来；要它澄清阶段也能查网页，把 `launch.ts` 里那行 `tool-web disabled` 去掉即可。
- 单轮工具调用上限 40 次（`MAX_TOOL_CALLS`），到顶返回 `TOOL_CALL_LIMIT`。
- 模型把工具参数写成不合法 JSON 时，同一次运行里自动让它重发一次。

## 6. B2：OpenScience 退役（本轮）

- **代码**：删掉 `services/control/src/bridge/openscience/`（整目录）、`plugins/reinlab-os-plugin/`、
  `services/account-runtime/`（含 OpenScience 二进制构建）、`services/worker/`（Hatchet worker）、
  旧的能力层（`mcp/engine`、`mcp/authority`、`mcp/data-handlers`、`mcp/protocol`、`mcp/account-port`）、
  旧澄清链（`clarify/`、`api/read-clarify`、`api/runtime`、`api/gates`、`api/budget`、`api/promotions`、
  `api/ledger`）、bench 发布（`harness/`）、账户机器供给（`provisioner/`）、`tooling/local/{worker,hatchet,image}`。
- **依赖**：`@synsci/*` 全部移除（workspace 与 lockfile）；`pnpm-workspace.yaml` 不再列 `@synsci/openscience`。
- **本地启动**：`local:up22 --real-models` 只起 supabase + 控制面 + 前端；不再构建账户镜像、
  不再起 Hatchet/worker（`image:"host"`）。数据库迁移走 `services/control/src/db/bootstrap.ts`。
  遗留的 `reinlab-hatchet-803a04fcd69a` 容器已停掉并删除。
- **旧表**：新迁移 `202610280001_retire_openscience.sql` 删掉 os_binding/os_usage/mcp_*/run_harness/bench_*
  /read_candidate/read_clarification/promotion/memory_item/thread/gate/artifact/delegation/
  account_machine*/credential* 等，并补上 `role_def('research-read')` 种子（干净库也能直接建运行）。
  现在 public 只剩：account/approval/budget_*/card_decision/dossier/dsh_*/event/http_request/
  paper_asset/paper_page_read/role_def/run/usage_record。
- **旧测试**：随旧路径一起删（能力层、bench、机器供给、docker、hatchet、旧澄清）；论文与内核用例
  改用新的 `test/kernel-fixture.ts`。`services/control` 44 文件 / 551 用例、`tooling` 15 文件全绿，
  仅 `tooling/local/control-process.test.ts` 一条在本机沙箱里不稳定（`5fde2c2` 基线同样失败）。

## 7. 验收后顺手修的三处（B2 同批）

1. `user/message` 里 `source.kind = runtime-context` 的消息不再显示（工作目录/沙箱策略，含本机路径）。
2. 审批卡：待办里没有对应权限卡时，本地那张同步收成已批准；点了批准/拒绝后立即消失，
   不再一直挂「右边有 1 个审批等你」。
3. 讲解层按 `no` 排序（`useRead` 里排序，模型写卡顺序不再影响显示）。
4. 澄清阶段也开放 `web_search` / `web_fetch`（纲领第 9 条）：用不用由模型决定。
5. 另外给内核补了稳定的取消/收尾：模型把工具参数写成不合法 JSON 时同轮重发一次；
   单轮工具调用上限 40 次（`TOOL_CALL_LIMIT`）。

## 8. 未做 / 待你确认

- 前端接线（Claude 负责）。前端目录本轮只动了两处，都是为了上面第 3 条在页面上如实显示：
  `src/data/read-live.ts`（适配器本体）与 `src/components/workbenches/research/read/ReadMode.tsx`
  的一行（结束标题优先用 `run.message`，其余 `endReason` 文案不变）。UI 组件的结构没有动。
- OpenScience 全量退役（`bridge/openscience/`、旧插件、`@synsci/*`、旧表）：按 PRD 在 B1 验收通过后做，本轮未删，以免验收期间无对照。
- 账户镜像路径（`REINLAB_KERNEL_TRANSPORT=container`）代码保留但本机未验证（Docker Hub 受限）。
- 发现卡（`card_finding`）：路由已由 `kernel-dispatch` 用例锁定（`cards.card.finding` → 现有卡片层 → 回执），
  卡片本身仍由现有 `dataHandlers` 校验冻结 schema 与页码依据（旧套件覆盖）。真机走查里模型未主动产出卡片，
  角色指令已加「至少一条」，仍属模型行为，建议 Claude 验收时在页面侧确认。
