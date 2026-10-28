# 交付说明 · DSH 精读改造（交 Claude 验收 B1–B4）

分支 `slim/backend`（基线 `0298c89`）。spec 见 [SPEC-slim-dsh.md](SPEC-slim-dsh.md)。
前端目录一行未改；`AGENTS.md` 的既有未提交改动保留。

## 1. 怎么跑

真实模型需要 `~/.config/reinlab/local.env`（`DEEPSEEK_API_KEY`，0600），然后：

```sh
pnpm --dir <后端工作树> local:up --real-models
```

- 控制面 `http://127.0.0.1:3001`，前端 `http://127.0.0.1:5183`，Supabase `54321`
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

## 4. 已知失败

**`services/control` 全量（2026-10-28）：166 文件 / 1192 用例全绿，0 失败。**

此前长期红的 5 个前端适配器用例文件已按新协议收敛：`batch7-adapter`、`read-lifecycle`、
`read-security` 按 `/v1/kernel/*` 重写，只守四条核心性质（同一档案不串号、一次意图一个幂等键、
不做乐观决定、取消只停当前运行）；`batch7-native`、`account-entrypoint-lock` 测的是
OpenScience 原生内核与旧账户入口，随退役删除。

`pnpm lint` 另有 5 条改造前就存在的越界告警（`verify-*-live.ts`、`worker/src/main.ts`），非本轮引入。

## 5. 未做 / 待你确认

- 前端接线（Claude 负责）。前端目录本轮只动了两处，都是为了上面第 3 条在页面上如实显示：
  `src/data/read-live.ts`（适配器本体）与 `src/components/workbenches/research/read/ReadMode.tsx`
  的一行（结束标题优先用 `run.message`，其余 `endReason` 文案不变）。UI 组件的结构没有动。
- OpenScience 全量退役（`bridge/openscience/`、旧插件、`@synsci/*`、旧表）：按 PRD 在 B1 验收通过后做，本轮未删，以免验收期间无对照。
- 账户镜像路径（`REINLAB_KERNEL_TRANSPORT=container`）代码保留但本机未验证（Docker Hub 受限）。
- 发现卡（`card_finding`）：路由已由 `kernel-dispatch` 用例锁定（`cards.card.finding` → 现有卡片层 → 回执），
  卡片本身仍由现有 `dataHandlers` 校验冻结 schema 与页码依据（旧套件覆盖）。真机走查里模型未主动产出卡片，
  角色指令已加「至少一条」，仍属模型行为，建议 Claude 验收时在页面侧确认。
