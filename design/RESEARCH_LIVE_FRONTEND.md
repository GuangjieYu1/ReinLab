# 研究台精读 · 真实模式前端（Claude 负责，2026-10-25）

用户已定的四点：
- **先做精读**；
- **同一套界面，只换数据源**；
- **以结果为主，过程可展开**；
- **每次先显示预估，你确认后才运行**。

## 结构

| 文件 | 作用 |
|---|---|
| `src/components/workbenches/research/read/readTypes.ts` | **数据接口** `ReadAdapter` 和事件 `ReadEvent`。界面只认这一层 |
| `read/useRead.ts` | 把「快照 + 事件流」合成界面状态。mock 和 live 共用 |
| `read/mockRead.ts` | mock 数据源。开局是「已经读完的一次精读」；「新建精读」会完整回放一次运行：检索 → 下载全文需要你批准 → 逐页读取 → 分层讲解逐层出现 → 检查题 → 发现卡 → 结算 |
| `read/ReadMode.tsx` | 界面。新增的部分：<br>• 空档案时的起始卡：输入论文、预算上限、预估、确认；<br>• 运行中卡片上直接显示审批；<br>• 运行状态条：状态、当前步骤、已花 / 预算、停止；<br>• 讲解「正在写第 N 层」的占位；<br>• 发现卡区；<br>• 只有摘要时的提示；<br>• 动画、复现在真实模式下显示「第二期」说明 |

**回归场景：**
- `e2e/legacy/scenarios/20-read-run.mjs`（新）；
- 原有的 `rd` 不变，仍然通过。

## live 适配器怎么接（交给 Codex）

在 `src/data/` 实现 `liveReadAdapter(dossierId)`，满足 `ReadAdapter`，并在 `ResearchStudio` 里当 `liveBackend` 为真时把它传给 `ReadMode` 的 `adapter` 参数。**不要改界面组件的样式和交互。**

**模式入口（2026-10-25 定）：** live 下给 `ResearchStudio` 传 `available={['read']}`。群研、自研的入口保留，但会置灰，并标出在哪一期接入（群研第三期，自研第一期末），点不进去。「派给群研 / 交给自研」只记下待办、不切换过去，所以 live 下不会显示示例数据。mock 不传这个参数，三个入口照常可用。预览方式：`?modes=read`。

### 先对话澄清，再预估（2026-10-25 用户定）

发起精读的第一步，是在右边对话里说想读什么。助手检索，拿不准就追问，再把候选论文做成卡片放进对话，由你选一篇。之后才按这篇的长度预估、你确认、正式运行。**AI 不替你决定读哪篇。**

- **澄清对话：** 用便宜档模型，**上限 ¥0.05，不单独确认**，超过就停下问你。只允许 `papers.search` 这一项能力（只读公开元数据，不下载），最多 6 轮。
- **后端需要新增：** 一个澄清角色（例如 `research-clarify`），预算固定 ¥0.05、自动批准、不弹确认；工具只有 `papers.search`；候选通过原生 question 交给你选（对应 `pick` 事件）。
- **选定以后：** `estimate(candidateId, budget)` 按这篇的页数预估；正式运行直接从「下载全文需要批准」开始，不再检索。

### 各方法的对应关系

| 方法 | 后端 |
|---|---|
| `kind` | `'live'` |
| `load()` | 档案详情 + 已读论文资产（`papers/<assetId>` 的元数据）+ 账本里的 card.layer / quiz / finding + 最近一次运行 + 用来恢复助手面板的历史事件（按下面的事件映射） |
| `subscribe()` | 档案事件流（SSE `/v1/dossiers/:id/events`），按下表映射成 `ReadEvent` |
| `clarify(text)` | 澄清角色的一轮对话：推送 `user`，检索，必要时推送一句追问（`agent`），再推送候选（`pick`）。更新 `run.clarifySpentCny`，达到 `clarifyCapCny` 就停下并说明 |
| `pick(pickId, candidateId \| null)` | 回答这条原生 question。选中后设置 `run.chosen`（含页数）；选「都不是」时助手请你再描述一下 |
| `unchoose()` | 清除 `run.chosen`，回到澄清对话 |
| `estimate(candidateId, budget)` | 按选定论文的页数调用预估 API；返回 `{ id, model, maxCny, steps, note }` |
| `start(estimateId, budget)` | 用 `confirmed: true` 提交运行，运行目标是 `run.chosen` 这篇；第一步就是 `papers.fetch` 的审批 |
| `cancel()` | 取消当前运行 |
| `decide(id, approve)` | 现有的单次审批 API（只用 once） |
| `ask(text)` | **读完之后**的追问属于 P2-05（读完之前，对话走 `clarify`）。在那之前，先推一条 `user` 事件，再推一条 `agent` 事件说明「追问将在第二期接入」，**不要编造回答** |
| `grade(quizId, answer)` | 评分属于 P2-06。在那之前直接 throw，界面会显示「评分暂时不可用」，**不要假装评分** |
| `newReading()` | 新建一个研究档案（research@1.1.0），然后切换到它 |

### 事件映射

| 后端 | `ReadEvent` |
|---|---|
| 运行状态：queued / running / 等待审批 / completed / failed / cancelled | `run`（state、step、budgetCny） |
| 用量结算 | `run.spentCny`。只要有任何一笔用量未知，就设 `unknownCost: true`，**不要把未知记成 0** |
| 澄清角色的候选（原生 question） | `pick`，候选里要带 title、authors、venue、access、pages |
| `capability.call` 的 `papers.search` / `fetch` / `pages` | `tool`。label 用人话，例如「检索：…」「下载全文 · …」「按页读取 · p.1–p.9」；detail 写命中数量、文件大小、许可证 |
| 审批请求（MCP `APPROVAL_REQUIRED` 或原生 permission） | `approval`。title、effects 用人话，risk 照搬 |
| 论文资产就绪 | `paper`。`access` 为 `full` 或 `abstract_only` |
| `paper_page_read` | `section`，其中 `id = p{页码}`，`no = 'p.{页码}'`，`gist` 放这一页里被引用的原文片段 |
| card.layer | `layer`。body 的 refs 由 anchor 转成 `p{页码}` |
| card.quiz | `quiz`。**不带 keys** |
| card.finding | `finding`（n 由服务器生成） |
| card.answer | `agent`，refs 同样由 anchor 转换 |
| 模型的中间文字 | **默认不推送**（以结果为主）；只有运行结束时的总结推一条 `agent` |

**真实模式下：**
- `anims` 是空数组：动画由 OpenMAIC 课堂引擎在 P2-07 生成；
- `hasRepro` 是 false：复现在 P2-09 接入。

## 已知后续（不阻塞）

- **改一下预算：** 预估卡还没有「改一下」按钮，现在要改只能停止后重新开始。以后会在 `RunView` 加一个 `revise` 状态。
- **多档案列表：** 资源管理器目前只显示当前档案。以后接档案列表 API 后，再做成可切换的列表。

## 2026-10-26 追加：预算余额、加预算、结束卡住的澄清

前端已在主仓库实现（`readTypes.ts`、`mockRead.ts`、`ReadMode.tsx`、`read.css`、`AgentDock.tsx`、`agent-dock.css`），Codex 原样同步后接 live：

| 接口 | live 要做的 |
|---|---|
| `RunView.clarifyUnknownCost` | 澄清有在途、还没定价的调用时为 true（界面显示「+ 未知」） |
| `RunView.clarifyBlocked` | 新的澄清发不出去时给出：`cap` = 用到上限；`stuck` = 上一段没结束 / 用量没核对。`text` 写人话原因。**不要再只推一条 agent 消息「澄清未受理…」** |
| `raiseBudget('clarify', add)` | 提高本档案的澄清上限（用户点按钮就算确认），解除 `cap` 阻塞 |
| `raiseBudget('read', add)` | 运行中追加本次精读的预算（对应后端 `budget_revision`） |
| `cancelClarify()` | 结束卡住的澄清 run：照实结算已用的、关闭 run、清掉 `clarifyBlocked` |

两个方法都是可选的：没实现时，按钮会显示「真实模式尚未接入」。

### 澄清改为聊天式（用户 2026-10-26 定）

- 澄清是自由多轮对话，像 ChatGPT 一样一步步确认；可以用模型自己的知识引导和猜标题，需要时检索、可以检索多次。
- **何时弹出确认卡（pick）由模型自己决定**；卡片上只放本次真实检索返回的论文，AI 不代选。
- 每轮输出上限默认 **8192 token**。按峰值价，一轮最坏约 ¥0.07，所以澄清默认上限从 ¥0.05 提到 **¥0.5**（守卫按最坏情况预留，没用完的释放；实际通常每轮几分钱以内）。仍然不单独确认，不够就用「预算余额」卡里的「+ ¥0.5」加。
- 轮数上限从 6 提到 20。

### 2026-10-27 追加：结束原因、改选候选

- `RunView.endReason`：`completed | rejected | cancelled | budget | abstract_only | failed`。运行结束时由 live 给出，界面据此写标题（例如拒绝下载 → 「已停止 · 没有下载」，不再一律「已完成」）。`abstract_only` 时界面提示换一篇，并给出「换一篇」按钮。
- `pick(pickId, candidateId)`：「换一篇」（`unchoose`）之后，已经答过的候选卡可以直接改选另一篇。live 要支持对已回答的 pick 再次选择：**不调用模型**，从已存的 `read_candidate` 里换掉选定的论文。
- 候选的 `access: 'full'` 必须和 `papers.fetch` 实际能不能拿到全文一致。拿不准就标 `abstract`，不要先说有全文、下载时才发现只有摘要。
