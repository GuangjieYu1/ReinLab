# 走查结果（给 AI）：研究台 · 精读 · 真实模式 · 2026-10-26

- 计划：[PLAN.md](PLAN.md)
- 脚本：`scripts/walkthrough/research-read.mjs`
- 环境：Codex 工作树 `9b7f64e` + 入口接线 `09eb123`，`pnpm local:up --real-models`，http://127.0.0.1:5183 ，验证账户 A
- 录像：`video.mp4`（run1 104 秒 + run2 109 秒）；逐步截图在 `run1/shots`、`run2/shots`，原始判定在 `run*/results.json`
- **结论：入口与外壳通过；对话澄清第二轮断裂，并且断裂后整个账户的澄清都被围栏挡住。预估、下载审批、正式精读、发现卡这些步骤都没走到（0 步）**

## 花费核对（数据库 `event.kind='cost'`）

| run | 角色 | 已定价调用 | 已定价合计 | 在途未定价 | run.state / spent_cny |
|---|---|---|---|---|---|
| `bf2d57b5…`（run1） | research-clarify | 2 次（输入 2079/164+缓存 2176，输出 102/233） | ¥0.007253 | 1 笔，hold 上界 ¥0.033029 | `running` / `0.000000` |
| `f19ca5f5…`（run2） | research-clarify | 2 次 | ¥0.007071 | 1 笔，hold 上界 ¥0.032856 | `running` / `0.000000` |

已知 ¥0.014324；最坏情况 ≤ ¥0.08（两个 ¥0.05 上限之内），远低于授权的 ¥3。两个 run 都停在 `running`，没有结束。

## 逐步结果

判定：✓ 符合 / △ 部分符合 / ✗ 有差距。归属：**C** = Claude（前端），**X** = Codex（后端 / 适配器）。

| ID | 预期 | 实际 | 判定 | 原因 / 定位 | 归属 |
|---|---|---|---|---|---|
| E1 | 错误密码进入封锁画面并提示，之后恢复 | 符合，提示「核验未通过：请核对邮箱和密码」 | ✓ | — | — |
| E2 | 邮箱留空提示先填身份，不发请求 | 提示「请输入用户名或邮箱」 | ✓ | live 适配器的 label 是「用户名或邮箱」。run1 判 ✗ 是因为计划里预期的措辞写得太死，已改 | — |
| E3 | 登录后出现选台 | 符合 | ✓ | — | — |
| E4 | 进入研究台，登录状态不丢 | 符合（页内导航） | ✓ | — | — |
| W2 | 收件箱没有测试残留，内容可读 | 自动弹出澄清提问，证据区显示原始 JSON（`{"source":{"time":…,"type":"question.asked"…`） | ✗ | ① 澄清角色的 `REINLAB_CLARIFY` / `REINLAB_PAPER_PICK` 提问也进了全局收件箱（它们只属于对话），② 证据区把原生事件原样塞进 `EvidenceView`。前端 `InboxPanel` 对 Json 证据只做 kv 展开 | X（①：精读的澄清提问不要推送到收件箱）；C（②：未知 Json 证据折叠为「原始记录」） |
| W1 | 群研 / 自研置灰，点击不切换 | 符合 | ✓ | — | — |
| W3 | 新建精读后没有预估按钮，澄清显示 ¥0.000 / ¥0.05 | 符合 | ✓ | — | — |
| C1 | 发出后显示「工作中」，数秒内列出候选，AI 不代选 | run1：约 12 秒后列出 3 篇候选（search 返回 3 条，`question.asked`）。run2：模型已调用 2 次（有 cost 事件），对话里却显示「另有澄清在途或未知用量，已停止新转发」 | run1 ✓ / run2 ✗ | run2 被 run1 留下的在途未知用量挡住：网关围栏是**账户级**的，跨档案生效 | X |
| C2 | 候选包含 Toolformer | 没有。查询词是模型把口语翻成英文后的一句话（`LLM learns when to call tools calculator search tool use self-taught`），`limit=3` | ✗ | 提示词 `prompts/research/research-clarify.md` 规定 `limit=3`、只搜一次，并且不让模型先用自己的知识猜标题再按标题检索；检索源只有 OpenAlex | X（提示词与检索策略，见下文「修复建议」第 3 条） |
| C3 | 点「都不是」、补充 Toolformer 之后，第二轮找到它 | 点「都不是」后，模型用 `REINLAB_CLARIFY` 追问「请补充线索」；用户在对话框打的补充被当成**新的** `POST /read/clarify` 发出，后端回「澄清未受理或结果尚未核对」 | ✗ | live 适配器的 `clarify(text)` 没判断当前有没有待回答的 `REINLAB_CLARIFY` 提问。有的话，应该把文字作为这个提问的回答（native question reply）发回同一个 run | X |
| C3b | 新开一份精读、直接说出完整标题，能找到 | 「澄清未受理」 | ✗ | 同 C1 run2：账户级围栏。卡住的 clarify run 一直是 `running`，用户在界面上**没有任何办法结束它**（澄清阶段没有「停止」按钮，「新建精读」也不会关闭旧的） | X（主要）；C（澄清阶段加「停止澄清」入口，等适配器提供 `cancel`） |
| C4 | 花了钱之后，澄清金额大于 0 | 两轮都显示 ¥0.000 / ¥0.05；数据库里已定价 ¥0.007 | ✗ | `run.clarifySpentCny` 取的是 `run.spent_cny`（未结算投影，一直是 0），没用已定价的 cost 事件累加。这违反「花了钱不能显示 0」 | X |
| C5–C6、S1–S3、R1–R6 | 见计划 | **没走到** | — | 澄清阶段始终选不到论文 | — |
| X1 | 已知问题：刷新后回到登录页 | 符合已知问题 | △ | 会话只保存在内存里。以后要换成可以安全续期的会话 | X（待定） |

mock 空跑另外发现两条前端问题（真实模式还没走到这两步）：
- **C6**：点「换一篇」以后，旧候选卡被锁住，只能再说一句话让助手重新列一次（多花一轮）。归属 C。
- **R2**：拒绝下载后，标题显示「已完成」，容易被误解为已经读完。归属 C。

## 修复建议（按优先级）

1. **X：同一个 run 里回答澄清追问。** 有待回答的 `REINLAB_CLARIFY` 提问时，`clarify(text)` 应该把文字作为这个提问的 `answers` 发回同一个 run，而不是新建 run。前端不用改（对话框照常调 `clarify`）。
2. **X：允许结束卡住的澄清。**
   - 新建精读或重新澄清时，自动关闭同一档案里还在等回答的 clarify run；
   - 适配器提供 `cancelClarify()`；
   - 网关围栏只挡**同一个 run** 的并发转发，不挡整个账户。在途用量未知的情况，在账本里照实记为「未知」即可。
3. **X：澄清提示词与检索。**
   - 先让模型用自己的知识猜 1～3 个可能的标题（只用来检索，不当作答案）；
   - 用这几个标题，加上用户原话，分别检索，每次 `limit` 8 条，去重后最多列 5 篇；
   - 每轮输出上限提到 512 token。
   - 预计一次澄清仍然不到 ¥0.01。「AI 不代选」的约束保持不变。
4. **X：** `clarifySpentCny` 改为按已定价的 cost 事件累加；有在途未定价的调用时，显示「+ 未知」。
5. **X：** 澄清提问不推送到全局收件箱。
6. **C：**
   - 收件箱里的原始 Json 证据折叠显示；
   - 澄清阶段加「停止澄清」；
   - 「换一篇」之后旧候选卡恢复可选；
   - 被拒绝的运行，标题改为「已停止 · 未下载」。

修完以后用同一个脚本复跑：

```
PLAYWRIGHT_MODULE=<…/playwright/index.mjs> node scripts/walkthrough/research-read.mjs --base http://127.0.0.1:5183 --creds <verification-users.env> --out <目录> --cap 3
```

---

## 复跑 run3（PR #26，`d5e7b4f`，research@1.2.1）· 2026-10-26 16:07

录像：`run3/video.mp4`；截图和判定在 `run3/`。真实模型调用 **0 次**，花费 ¥0。

| ID | 判定 | 实际 |
|---|---|---|
| E1–E4、W1、W3 | ✓ | 和上次相同 |
| W2 | ✓（已修） | 收件箱不再自动弹出澄清提问 |
| C1 | ✗ | 第一次转发模型时，宿主网关返回 **401 `CAPABILITY_TOKEN_INVALID`**（`https://reinlab-model.invalid/v1/chat/completions`）。run `88b61243…` 进入 failed，界面显示「澄清已停止或被取消」 |
| C3b | ✗ | 新开一份档案也一样（run `742a2df2…`），**不是偶发** |
| C4 | ✗ | 失败后底栏找不到澄清金额 |

**原因定位（事件 2193–2208）：**
1. 网关预留 hold 之后，拒绝了这个 run 的模型令牌。最可能的原因是：PR #26 的「运行关闭 / 账户内核升级」改动之后，新 run 拿到的模型令牌和网关校验对不上，比如 audience、run 绑定或令牌代次。**这是回归：上一批同一条路径是能调通 DeepSeek 的。**
2. 记账错误：令牌被拒时请求根本没发到 DeepSeek，用量是确定的 0。系统却记成「模型用量未知，保留预留」（`reason: usage_unknown`, `unknownCost: true`），预算会被白白占住。被拒在转发之前时，应该释放 hold，记为已知 0。

**新增验收项：** 改完之后，新建精读、发一句话，必须看到真实候选卡；事件里要有 `kind='cost'` 且状态为 `priced`。

---

## 复跑 run4（PR #26 之后的修复，research@1.2.2）· 2026-10-26 17:19

截图：`run4/candidate-card.png`（候选卡）、`run4/read-view.png`（精读视图，底栏 `澄清 ¥0.012 / ¥0.5`）。

**run3 的 401 不是令牌问题。** 模型令牌的签发和网关校验完全对得上（audience `reinlab-runtime-model`、run 绑定、hold、版本 1.2.1 都通过）：网关先把 hold 预留下来并落了 `model_http_reserved`（事件 2193），才去转发。用户看到的 401 是**重试**那一次的回执，不是第一次请求的结论。

真实链路是三步断的，都出在 PR #26 把澄清输出上限从 256 提到 512 时没有同步的两处「旧代次」：

| # | 断点 | 证据 |
|---|---|---|
| 1 | 模型正常返回（DeepSeek 200、115 KB SSE、`finish_reason=length`、`completion_tokens=512`），网关的 `receipt()` 把「撞到输出上限」当成不可信响应，抛 `MODEL_RESPONSE_UNKNOWN` → 409，钱已经花掉但记账记成未知 | 复测时抓到的响应摘要：`status 200 / bytes 115480 / done true / finish ["length"] / usage {prompt 2185, completion 512}` |
| 2 | 失败后 hold 被标 `unpriced`，OpenCode 自动重试的同一个 run 过不了 hold 状态校验，回显成 **401 `CAPABILITY_TOKEN_INVALID`** —— 于是看起来像令牌失效 | run3 日志：attempt 1 = 409 Conflict（可重试），attempt 2 = 401 Unauthorized（不可重试） |
| 3 | 换到 257–511 token 的响应时，旧回执校验函数 `reinlab_clarify_receipt` 还硬编码 `o>256`，抛 `CLARIFY_RECEIPT`，同样在付款之后丢账 | 复测：`finish ["tool_calls"]`、`completion 411` → `CLARIFY_RECEIPT`（23514） |

**改了什么（三处代码 + 三条迁移/版本）**

1. `receipt()`：`finish_reason=length` 不再当未知，照 usage 定价并在回执里写 `truncated`；`content_filter` 仍然拒绝。
2. 回执/预留的「输出上限」一律跟行上记录的 `max_output` 走（迁移 `202610260003`），旧行按历史 256 处理，不再出现「代次对不上」。
3. run 被围栏（上一笔用量未知、运行已结束、澄清已关闭）时，运行时模型网关回 **403 `MODEL_FORWARDING_FENCED`** 并写明原因，不再伪装成令牌无效；`/mcp/clarify-model` 老路径保持原判。
4. 澄清 run 上限按 1.3.0 卡改为 **¥0.5**（`202610260004`、`read-clarify` 划拨额与文案、bench `model_cap`、插件与 `role-project` 白名单、前端底栏）。¥0.05 装不下「检索一轮 + 列候选」两次调用：第一次调用后只剩 ¥0.041，而第二次调用的最坏预留（3 路×8 条检索进上下文）本来就超过它——即使回执全部修好，run 也会在真实检索成功之后被预算围栏掐断。
5. 版本按不可变规则升到 **research@1.2.2**（新提示词 `research-clarify-v1-2-2.md` 写 ¥0.5，1.2.1 原样冻结），版本列表同步。

**验收结果（真实模式，账户 A，句「我听说 GPT 写了 700 多篇数学论文」）**

| 验收项 | 结果 |
|---|---|
| 新建精读、发一句话 | ✓ 新档案 `023fd385…`，run `44df478e…` |
| 真实候选卡 | ✓ `run4/candidate-card.png`：`REINLAB_PAPER_PICK`，5 个真实 OpenAlex 候选（W7212247152 等，标题为检索实际返回），带「都不是」；库内 `read_candidate` 48 条 |
| `kind='cost'` 且 `priced` | ✓ 事件 2456 `¥0.007192`、2489 `¥0.004874`，两次调用都 `status=priced`，无 `unknown` |
| 金额显示 | ✓ 底栏 `澄清 ¥0.012 / ¥0.5` |
| 澄清提问没被误推收件箱 | ✓（沿用 run3 的修复） |

**花费**：本次验收 run 已定价 ¥0.012066；复测期间另有 4 次真实调用（3 次撞在上面的断点上，1 次被预算围栏截断），实际约 ¥0.035 已由 DeepSeek 计费，合计约 ¥0.047，仍在本次授权 ¥0.05 之内。

**run3 两个 run 的占用（`88b61243…`、`742a2df2…`）没有更正成已知 ¥0**：日志证明它们的第一次请求**已经转发**（attempt 1 收到 200 响应、耗时 3.4 s、DeepSeek 已计费），只是网关拒绝记账。按「用量未知不记 0」的底线，这两笔保持 `hold=unpriced`、预留 ¥0.05 保留、`unknownCost: true`；把它们标成 ¥0 会少报已发生的支出。要真正结清，只能等 DeepSeek 侧账单对账（`providerInvoiceReconciled`），或者按最坏界结算。

**测试**：改动涉及的 9 个用例文件全部通过（`local-model-gateway`、`batch7-model/contract/api/security-review`、`local-model-native`、`role-project`、`research-release`、`research-pin`）。全量 `services/control/test` + `tooling`：1435 通过 / 3 失败，3 个失败在改动前的 `d5e7b4f` 上同样失败（`batch7-native` 2 个、`read-lifecycle` 1 个），不是这批引入的。

---

## 复跑 run5（DeepSeek 修复，未提交；research@1.2.2；前端已同步 Claude 最新 7 个文件）· 2026-10-26 18:25

录像：`run5/video.mp4`。真实花费：澄清 ¥0.022，另有在途的未知用量；正式精读没走到，¥0。

| ID | 判定 | 实际 |
|---|---|---|
| E1–E4、W1–W3 | ✓ | 全部符合 |
| C1 | ✓（已修） | 14 秒列出 5 篇真实候选，**第一篇就是 Toolformer** |
| C2、C4、C5 | ✓（已修） | 有 Toolformer；底栏澄清金额 > 0（¥0.007 / ¥0.5）；选定后的卡片信息完整，作者缩写为「前 3 位 等」 |
| C6 | △ | 「换一篇」后旧候选卡锁住，要再说一句才能重选（多花一轮）。需要设计：已答过的 pick 允许改选，不必再调模型 |
| S1 | ✓ | 预算填 0 被拦下 |
| S2、S3 | ✗ | **预估一律失败**，提示「预估没有成功」，并且根本没发出 `/v1/runs/estimate` 请求 |
| R1–R6 | — | 选不出预估，没走到 |

**S2 / S3 原因（已定位到代码）：** `src/data/read-live.ts` 的 `estimate()` 只接受 `harness.version` 为 `["1.1.0", "1.2.0"]`，并且只在 `=== "1.2.0"` 时才带 `candidateId`。新档案是 1.2.2，所以直接 throw。这次把版本升到 1.2.1 / 1.2.2，这里却没跟着改。建议改成「1.2.x 及以上都走 candidateId 路径」，不要再写死版本号列表；同时全仓库搜一遍其他写死 `"1.2.0"` 的地方。

**本轮验收结论：** 澄清（C 段）通过；预估不可用，阻断了后半段。

---

## S2 / S3 修复后复测（research@1.2.2）· 2026-10-27 00:28

截图：`run5/estimate-after-fix.png`。

**改了什么（前端一处）**：`src/data/read-live.ts` 的 `estimate()` 不再写死版本列表，改成数值比较——`1.1.x` 起仍可预估，`1.2.x` 及以上一律走 `candidateId` 路径（后端从 1.2.0 起就要求「必须由人选定论文」）。全仓库前端只剩这一处写死 `"1.2.0"`。

**真实模式复测（账户 A，档案 `d36faa64…`，选定 Toolformer `W7133214447`，13 页）**

| 检查 | 结果 |
|---|---|
| 选定 Toolformer | ✓ 左侧「新的精读」，中间卡片：「Toolformer: Language Models Can Teach Themselves to Use Tools」· Timo Schick、Jane Dwivedi-Yu、Roberto Dessì 等 · neural information processing systems · 13 页 · 有开放全文 |
| 点「预估费用」 | ✓ 不再提示「预估没有成功」，请求 `/v1/runs/estimate` 发出并返回（harness 版本 1.2.2、预估 ¥0.617760） |
| 能看到金额 | ✓ 面板：模型 `deepseek/deepseek-v4-flash` · 最多 48 步 · 最多约 **¥0.62** · 预算上限 ¥5 · 备注「按公开书目估计的 13 页预估，尚未下载核验」 |
| 能确认开始 | ✓ 「确认开始」按钮存在且可点（未超预算，无禁用） |

**没有真的按「确认开始」**：那会启动正式精读，预估上限 ¥0.62，本轮没有这笔授权。按钮可用即视为 S3 通过；等你点头再点，或直接授权我点。

**测试**：`services/control/test/batch7-adapter.test.ts` 扩成 `1.2.0` 与 `1.2.2` 两个版本都跑「预估只带 candidateId」的断言；`batch7-adapter`、`read-live-adapter`、`read-security` 三个用例文件 15/15 通过，前端 `tsc -p tsconfig.json --noEmit` 通过。

---

## 复跑 run6（真实模式 R1–R6，research@1.2.2，账户 A）· 2026-10-27 01:19

截图在 `run6/`。这一轮真按了「确认开始」，把正式精读跑到结束。

| ID | 判定 | 实际 |
|---|---|---|
| R1 | ✓ | 确认开始后运行条出现「开始读 运行中《Toolformer…》· 预算 ¥5 · 已花 —」，「等你批准：下载论文全文 / 只处理这一次请求；参数变化后需要重新批准」，主面板和助手面板都能看到，同时收件箱弹出「上线时待批准」（`run6/R1-approval.png`） |
| R2 | △ | 点「不下载」后运行确实停了，已花照实显示 ¥0.006；但状态写「已完成」、消息是「澄清另有待核用量…」，没有一句「因你拒绝下载而停止」。这是首次走查就记下的前端问题（拒绝下载显示「已完成」），归属 C |
| R3 | ✗ | 第二次走完「重新开始 → 澄清 → 选 Toolformer → 预估 ¥0.62 → 确认开始 → 批准下载 → 读原文」整条链，但读的是**只有摘要**的 Toolformer：`papers.fetch` 返回 `abstract_only`（OpenAlex 无开放全文、license 空），模型如实停下并给出三个选项（①你放 PDF ②按摘要讲解并标注「解读／非本 run 原文」③换来源），**没有编造页码和分层讲解** |
| R4 | ✗（原因同上） | run `ff7ae015…` 正常收尾：`runtime_completed` + `os_usage_settled: provider_usage_reported`，已定价 **¥0.014197**（4 次调用，无未知用量），状态条「解析 0/5 层 · 理解 0/0 · 已完成 · ¥0.014」。没有讲解层就没有发现卡、没有检查题（`run6/R4-after-run.png`） |
| R5 | ✓ | 追问「为什么要自监督地插入 API 调用？」，如实答「追问未接入，将在第二期 P2-05 接入；这里没有生成研究回答」，没有编答案（`run6/R5-followup.png`） |
| R6 | — | 没出检查题（0 层），检验页没内容可提交 |

**R3/R4 卡在「论文没有开放全文」，不是链路断。** 换成有开放全文的候选会被 `换一篇` 的已知问题挡住（C6：得再说一轮才能重选）。下一步要么在 `papers.fetch` 加 arXiv/落地页兜底，要么由 Claude 修 C6 之后用 OA 论文再跑一遍。

**这一轮修掉的一个真问题（已在测试里验证）**：`papers.pages` 连续 5 次 `CAPABILITY_INPUT_INVALID`——模型只能看到插件的泛化工具说明（「args 遵守对应能力参数」），拿不到每个能力的入参 schema，于是按 REST 习惯发了 `{assetId, cursor}`，而契约要 `{assetId, pages:[1,2,…]}`。现在 `.role-policy.json` 随 run 下发每个已授权能力的 input schema，插件把它写进工具描述；复测 `papers.pages {pages:[1]}` 一次成功。

**还查明一个记账/观测问题（未改，需 Codex 定）**：本轮之前那次读 run（`94c5e9c5…`）收尾时 `os_usage_settled` 报 `provider_usage_missing`，直接把 run 判成 `paused_budget / USAGE_UNKNOWN`；同一批事件里 `session.request.progress` 被观测映射以 `invalid_event_properties` 拒收（`unmapped_event`）。映射表跟不上运行时事件字段，会让「用量未知」误判、把 run 假停。

**花费（全部已定价，取自 `event.kind='cost'`）**：本轮 R2 ¥0.005720 + R3/R4 ¥0.014197 + 期间澄清 runs ¥0.013123 / ¥0.008995 / ¥0.017652 / ¥0.008184 + 早前一次被判停的读 run ¥0.012552 ≈ **¥0.080**。仅 R3/R4 这次正式精读是 ¥0.0142。

---

## live 接上三件事（结束原因、改选候选、access 如实）· 2026-10-27 01:33

前端已同步的接口（`design/RESEARCH_LIVE_FRONTEND.md`「2026-10-27 追加」）现在在 live 里都有来源了。

**1. `RunView.endReason`（前端投影算，后端只给素材）** — `src/data/read-projection.ts`
- `failed/interrupted → failed`、`cancelled → cancelled`、已结束的 `paused_budget → budget`（这类 run 现在映射成终态 `cancelled`，标题写「预算用完，已暂停」，不再是「等你批准」）；
- 结束的 run 里如果有 `papers.*` 审批被驳回 → `rejected`；
- 已下载资产是 `abstract_only` → `abstract_only`；其余 `completed`。
- 实测：Toolformer 那次读 run 的标题从「已完成」变成「没拿到全文」（`run7/end-reason-abstract.png`）。

**2. 「换一篇」之后改选候选：不调模型** — `services/control/src/api/read-clarify.ts`
- 已回答（`approved` + 已发）的候选卡再 `pick` 时走本地换选：校验候选属于该卡、当前没有别的选定，然后更新 `read_clarification.chosen_id/chosen_approval`（沿用那张已答卡，不新建审批、不派模型），写一条 `clarify_repick` 事件。
- 顺带修掉一个会挡住「换一篇」的漏洞：`noFormal` 只看 state、不看 `ended_at`，已结束（`ended_at` 有值）的 `paused_budget` run 会一直报「正式精读尚未停止」；现在只看还没结束的 run。
- 实测（真实库、档案 `39d23846…`）：`unchoose` 200 → 对已答卡改选 Graph-ToolFormer → 201 `repicked:true`，`chosen` 换成 `W4366999191`，`selection_revision` 递增，**模型调用次数不变**，随后 `estimate` 201。

**3. 候选 `access` 与实际能不能下载一致** — `services/control/src/clarify/candidates.ts`
- 以前只看 `open_access.is_oa` 就标「有开放全文」，而 `papers.fetch` 需要「OA + `best_oa_location` 可下载 PDF + 有许可」才给全文，于是 Toolformer 被标成有全文、下载时才只有摘要。
- 现在用同一套判据：拿不到可下载 PDF 就标 `abstract_only`，并在卡片备注里写明「标了开放获取但没有可直接下载的 PDF」。

**测试**：`read-lifecycle`（新增 endReason 四种情形的断言）、`batch7-api`（新增「已答卡改选不调模型 + 改选后能预估」；候选还断言了 `access: 'abstract_only'`）、`mcp-papers`、`batch7-adapter`、`read-live-adapter` 全过。全量 `services/control/test`：1137 通过 / 3 失败，3 个失败在改动前的 `d5e7b4f` 上同样失败（`batch7-native` ×2、`read-lifecycle` 的未知档案那条），不是这批引入的。前端 `tsc -p tsconfig.json --noEmit`、控制面 `tsc -p services/control/tsconfig.json --noEmit` 均通过。

**留给前端的一条**：`abstract_only` 的「换一篇」按钮写在 `Start` 面板里，而有资产存在时中间渲染的是 `Explain`（`paper` 不为空），所以那个按钮实际点不到。live 这边已经把「`unchoose` 之后回到起始卡（`state: idle`，卡片解锁）」备好了，前端把按钮挪到 `Explain` 或让 `Start` 在 `endReason === 'abstract_only'` 时也渲染即可。

---

## 设计卡 02 实施：事件兼容与费用完整性分离 · 2026-10-27 01:47

按 `design/backend/02-runtime-event-compatibility.md` 实施（01、03 未动）。

**映射层（`mapping.ts`）**
- 每个映射结果新增 `accountingImpact: none|uncertain` 与 `diagnostic:{code,eventType,fieldPaths}`；**默认 none**，不再靠 `kind==='error'` 推断。
- 进度事件只取展示字段：`phase` 接受未知字符串（照样映射，不再是 unmapped），耗时等辅助值给错/缺失就省略；缺可选字段不记诊断，「给了但用不了」和「未知 phase」各留一条有界诊断（`progress_field_tolerated` / `unknown_phase`）。身份（session/message/游标）仍严格。
- 未知事件类型 / 未知 part 仍是 `unmapped_event`，但带上脱敏诊断（只留类型与字段名，原始载荷不落库）。
- 用量：`step-finish` 缺 usage 或解出 `status:'unknown'` 才标 `uncertain`。

**观察层（`observation-store.ts`）**：只有 `accountingImpact==='uncertain'` 或「step-finish 没带 usage」才置 `usage_uncertain`；未知类型/未知 part/被容忍的进度字段一律不碰费用完整性。

**结算层（`budget/index.ts`）**
- 收尾核对改用网关收据对原生用量：读运行的 `runtime_model_request`（真正转发过的）多于 `os_usage` 就判不完整，`totalCny=null`，`os_usage_pending.reason='provider_usage_missing'`；网关上界不另记一笔费用。澄清沿用自己那条预留路径。
- 运行状态与结算状态分开：用量未知不再把已结束的运行改成 `paused_budget`（内核 completed 就保持 completed，预留保留）。
- 新增 `runAccounting()`：`{status: pending|settled|unknown, knownCny, totalCny, reason}`，未核全时 `totalCny=null`。

**接口与投影**：`/v1/dossiers/:id/read-state` 的 `run` 与 `/v1/runs/:id` 都带 `accounting`；数据投影把它透传成 `RunView.accounting`。

**验收核对（真实模式）**

| 验收项 | 结果 |
|---|---|
| 1. 失败 run 的 progress 差异，修完真实再走一遍 | ✓ 新 real run `905bd0ba…`：19 条进度事件、**0 条 unmapped**，结束 `completed`（不再 `paused_budget`） |
| 2. 补字段 / 未知 phase / 未知类型 → 留诊断、游标继续、不新增费用批准模型请求 | ✓ 单测 `mapping.test.ts` / `observation-store.test.ts` 覆盖；真实库里 unknown 事件只写 `unmapped_event` + 诊断 |
| 3. 多轮运行全部用量核齐才 settled；部分用量 `totalCny=null` | ✓ `905bd0ba…`：网关 4 笔 = 用量 4 笔 → `settled`，`knownCny=totalCny=¥0.014786`；旧的缺用量 run `94c5e9c5…` → `unknown`、`knownCny=¥0.012552`、`totalCny=null` |
| 4. 已有缺用量/失败 run：已知金额保留、缺项未知；结束的 run 不再伪装成暂停等待 | ✓ 同上；`paused_budget` 且 `ended_at` 有值的 run 现在映射成终态 |
| 5. 断线重连只从持久游标补读，跨会话/坏审批参数仍拒 | ✓ 沿用既有 `CURSOR_GAP` / `SCOPE_DENIED` / `DEDUPE_CONFLICT` 用例，未改动 |

**花费**：验收那次读 run ¥0.014786（4 次调用，全部已定价）。

---

## 复跑 run7（卡 02 + endReason / 改选 / access，未提交）· 2026-10-27 01:58

录像：`run7/video.mp4`。真实花费：澄清 run `f61f724d…` ¥0.013354（已定价）。

| ID | 判定 | 实际 |
|---|---|---|
| E1–E4、W1–W3 | ✓ | 全部符合 |
| C1 | ✓ | 19 秒列出 5 篇真实候选 |
| C2 | ✗ | 这次 5 篇里没有 Toolformer（run5 是第一篇）。检索结果不稳定，属于卡 04（聊天式澄清 / 先猜标题）要解决的范围 |
| C3 | ✗ **回归** | 点「都不是」后，模型追问（事件 3373 `question.asked`）。用户在对话框补充后，run **被取消**（3375 `question.cancelled` → 3379 `runtime.cancelled`），没有把补充当作回答，界面回「澄清未受理…」。run5 时这条路径是通的（d5e7b4f 修过） |
| C3b | ✗ **回归** | 新建精读（档案 `f9e7a4ac…` 已建）后发话，**没有创建任何 run**，90 秒没回应。怀疑是上一档案关闭澄清时的 409 `IDEMPOTENCY_CONFLICT`（DeepSeek 已提过）挡住了新档案的澄清 |
| C4 | ✗ **回归** | 数据库 `spent_cny = 0.013354`，界面底栏却显示 ¥0.000 / ¥0.5。run5 时正常 |

**结论：卡 02 本身（进度事件不再假停、结算分离）在 run `905bd0ba` 上成立；但这一批同时改了「换篇 / 关闭澄清」，把澄清多轮、新档案澄清、澄清金额三处弄坏了。**

另外，`94c5e9c5…` 在数据库里仍是 `paused_budget`（历史行不回改），界面显示需要再确认。

---

## run7 三处回归的修复与复测 · 2026-10-27 02:15

提交：`2016dd8`（卡 02 一批）、`473da2f`（这三处修复）。以后每批一个提交。

| 回归 | 原因 | 修法 | 复测 |
|---|---|---|---|
| C3 「都不是」→ 补充后 run 被取消 | 补充说明的请求把界面上滞后的 `selectionRevision` 一起发了；后端以它判「澄清已切换」拒绝，run 里没有 `clarify_user`，界面回「澄清未受理」。run 的取消来自随后「新建精读」的关旧澄清 | 回答**已经存在**的提问以 `approvalId` 为准，滞后代次不再挡；前端回答时只带 `approvalId` | ✓ 补充请求 `202 {approvalId, runId:1779a68c…}`，**回到同一个 run**，「第二轮找到 Toolformer」 |
| C3b 新档案发话没有创建 run | 关旧澄清的清算与关闭绑在一起：旧账已结清时重算得出不同数额 → `IDEMPOTENCY_CONFLICT` → `cancel-clarify`/`换一篇` 回 409 → 新建精读的前置取消失败，后续发话被卡住 | 关闭与结算解耦：结算冲突只记 `clarify_settle_deferred` 事件、照常关闭；前端新建精读不再因关旧澄清失败而停 | ✓ 新建精读后发话 `201 {runId:…}`（修复前后端同样能建，但前端不再被 409 挡住） |
| C4 底栏澄清金额显示 0 | 复核未复现：run7 那次界面在新档案（`f9e7a4ac…`，spent 0）上，0 是对的；旧档案的 wire 与投影都是 ¥0.013354 | 加了一条投影回归：结清/取消的 run 仍带 `clarifySpentCny`/`clarifyCapCny` | ✓ 复测底栏 `澄清 ¥0.020 + 未知 / ¥0.5`（`run8/supplement-picked.png`） |

**真实模式复测（本轮验收要求的完整链路）**：说一句 → `201`（run `1779a68c…`）→ 5 篇真实候选 → 点「都不是」→ `202` → 模型追问 → 补充「是 Toolformer 那篇」→ `202` 回同一个 run → 第二轮候选**第一篇就是 Toolformer** → 选定 → `202`，「读这篇」卡片显示 Toolformer（13 页 · 只有摘要，并标注「公开元数据标了开放获取，但没有可直接下载的 PDF」）。

**花费**：本轮复测约 ¥0.05（两次完整多轮澄清 + 一次首轮失败的 run）。

**另外发现（未修，记录）**：首轮复测时模型调用了原生 `question` 工具但参数是 `{}`，运行时把「工具参数不合 schema」升级成 `session.error` 并直接把整个 clarify run 判 failed。这是模型偶发给出坏参数，但运行时把它当成致命错误；建议单独开卡让「坏工具参数」变成一次工具错误，而不是终止整次运行。

---

## 复跑 run8（Claude 验收；`2016dd8` + `473da2f`）· 2026-10-27 02:25

录像：`run8/claude/video.mp4`。真实花费：澄清 run `f7818207…` ¥0.011705；读 run `320794f3…` 暂时 ¥0，**但占着 ¥2.5 预留**。

| ID | 判定 | 实际 |
|---|---|---|
| E1–E4、W1–W3 | ✓ | 全部符合 |
| C1、C2 | ✓ | 47 秒列出 5 篇真实候选，第一篇是 Toolformer（比 run5 慢：19 秒 → 47 秒） |
| C4 | ✓ | 底栏 ¥0.006 / ¥0.5（脚本已改为在新建档案之前检查；run7 的 C4 是脚本错位，DeepSeek 判断正确） |
| C5 | ✗ | 点选 Toolformer 后对话回「选择结果尚未核对，请刷新；未代选、未重复提交」，接着「澄清已停止或被取消」。clarify run 以 `Forbidden: 模型转发被拦截` 结束（事件 4228 / 4233，`failed`）。也就是说，**用户选完之后，模型下一轮转发被围栏挡住，整个 run 判 failed，选择也没确认** |
| C6 / S / R1 | △ | 「可以直接改选另一篇」生效（新的改选功能），脚本借此选定并完成预估，确认开始 |
| R3 | △ | 读 run `320794f3…` 起来了；`papers.fetch` 审批出现，脚本批准（事件 4271，once） |
| R4 | ✗ | 批准下载后，又冒出**第二个审批**：原生 `permission.asked`，`permission: reinlab_mcp_approval`，patterns 就是刚批过的那个 approvalId。它只出现在收件箱里，证据区显示**原始 JSON**（收件箱「执行权限等待你的决定」）；助手面板里没有可点的卡（脚本点了 19 次「批准」都没对上）。**run 从 02:30 一直挂到现在（7 小时以上），¥2.5 预留没释放** |

**需要修（DeepSeek）：**
1. **C5**：选定候选以后，clarify run 应该正常收尾（`completed`），选择要先确认落库；不要让模型的下一轮转发撞上围栏，再把整个 run 判成 failed。
2. **R4**：MCP 审批已经批过（`approval` 表 `papers.fetch` 状态 approved）之后，内核又发了一次 `reinlab_mcp_approval` 原生权限请求。要么由控制面按已批准的 approvalId 自动答复，要么根本不让它再发；不能让用户批两次，更不能只在收件箱里显示原始 JSON。
3. 现场保留，没有动 `320794f3…`：用来定位问题。修好之后照实取消它，并释放预留。

---

## run8 两处问题的修复与复测 · 2026-10-27 02:25

提交：`ce74845` / `91f22a2`（C5）、`7042f05` / `91f22a2`（R4）、`0298c89`（结清并释放挂住的 run）。每个问题一个提交；其中 C5、R4 各多一个提交，是真实复测里发现「先到的原生权限请求」「选定后还要不要取消」这两个细节后补的，PR 前可以 squash 成两个。

### 1. C5 · 选定后 clarify run 判 failed（`Forbidden: 模型转发被拦截`）

- **原因**：选定候选时 `prepareHumanPaperChoice` 会把 `read_clarify_run` 标记关闭；模型还要把这一轮答完，于是下一次转发被「澄清已关闭」围栏挡成 403，运行时把整次 run 判 failed。审批决定之后还会顺手 `cancel` 这次运行，等于把收尾也掐了。
- **修**：① 令牌校验不再因为「澄清已关闭」拒绝——关闭只表示不再开新轮次，运行终态与预留仍然是门禁（`ce74845`）；② 迁移 `202610270001` 让 clarify 限额触发器在「这一段还活着」时允许转发（`ce74845`）；③ 选定后不再立刻取消这次运行，让模型把这一轮答完（`91f22a2`）。
- **复测（真实模式，档案 `aa093296…`）**：发话 `201`（run `f4de7bd8…`）→ 列 5 篇候选 → 选定 `W4412929247` `202` → **clarify run 终态 `completed`**，选择已落库。

### 2. R4 · 批准下载后又冒第二次原生审批、收件箱显示原始 JSON

- **原因**：引擎的 `papers.fetch` 审批（人已批）和插件为同一次调用发的原生权限请求 `reinlab_mcp_approval` 是两张卡；后者没被作答就一直挂着，收件箱把原生事件原样塞进证据区。
- **修**：控制面按账本里已作出的决定自动答复这次原生权限——ingest 时判一次（`7042f05`）、人批准那一刻再判一次（`91f22a2`，覆盖「原生请求比批准更早到」的顺序）；不再给用户出第二张卡，并落 `mcp_permission_auto_reply` 事件。收件箱对原生权限卡改成「批准能力调用 <能力名>」+「只处理这一次请求」的人话，问题型载荷仍按去身份的原文显示。
- **复测（真实模式）**：选定 → 预估 ¥1.52 → 确认开始 → **只出现一次下载审批**（`/v1/approvals/:id/decide` 202）→ `papers.fetch` 返回 **full_text** 并真的读到了 p.1–7（`capability.call success:true`）→ 收件箱无原始 JSON。

### 3. 挂住的 run 已照实取消，预留已释放

- `320794f3…`（挂 7 小时）：`POST /v1/runs/:id/cancel` → `cancelled`；原生用量从未回来，但网关有一笔带收据的调用，按收据结清 **¥0.007656**，`budget_hold` 从 `unpriced ¥2.5` 变 `settled`，**¥2.5 预留释放**。
- 过程中我自己把收据的「微元」当成「元」记了一次（¥7656），当场用一次性、可审计的更正改回 ¥0.007656，并落 `settlement_units_corrected` 事件；代码在 `0298c89` 里已修正单位。

### 复测中撞到的下一个阻塞（不属于本轮两个问题）

读运行到了「下载全文 → 读 p.1–7」之后被 OpenScience 自己停下：`Compaction reached the model output limit before the handoff was complete`，随后按 `USAGE_UNKNOWN` 暂停。读角色的 `output_tokens` 是 1024，上下文压缩时不够用——属于计划里 `research@1.3.0`（output 8192）要解决的容量问题。

---

## 复跑 run9（Claude 验收；`ce74845`…`0298c89`）· 2026-10-27 10:44

录像：`run9/video.mp4`。真实花费：澄清 `2af5f55d…` ¥0.007384。

**账本核对（Claude）：** `320794f3…` 已取消，hold `settled`，实际 ¥0.007656；中途误记的 ¥7656 已有更正事件（seq 4292）。各预算表最大额 ¥0.055，没有残留。✓

| ID | 判定 | 实际 |
|---|---|---|
| E1–E4、W1–W3、C4 | ✓ | 全部符合 |
| C1 / C2 | ✗ | 91 秒都没有候选。`papers.search` 两次 `CAPABILITY_FAILED`，分别耗时 **25.0 秒和 18.1 秒**（事件 5105、5183）。同一时间从宿主直接请求 OpenAlex，3 次都在 2.1–2.3 秒返回 200 |
| C3b | ✗ | 新档案的 run `ed2d1af4…` 检索同样失败后，**一直停在 `running`**，没有终态；界面显示「澄清已停止或被取消」 |
| C5–R6 | — | 没走到 |

**结论：** 检索这一环不稳定。run5 用了 14 秒，run8 用了 47 秒，这次 18–25 秒后失败。OpenAlex 本身不慢，问题在控制面的检索出站路径（DNS / 出站守卫 / 超时设置），或者失败后的处理。另外，检索失败以后 clarify run 没有收尾，又一个挂住的 run。

**需要修（DeepSeek）：**
1. 查 `papers.search` 在控制面里慢、并且失败的原因（记录每一跳的耗时：DNS、连接、首字节）。修完连续检索 5 次都要在 5 秒内返回。
2. 检索失败时：让模型拿到明确的工具错误，告诉用户「检索暂时失败，可以再说一次」，clarify run 正常收尾。**不能挂在 running。**
3. 照实结束 `ed2d1af4…`。

---

## 验收 run10（DSH 内核，`slim/backend` `45cf9bc`）· 2026-10-28 11:38

录像：`run10/video.mp4`。

| ID | 判定 | 实际 |
|---|---|---|
| E1–E4、W1–W3 | ✓ | 全部符合 |
| C1 / C2 | ✓ / ✗ | 11 秒列出 6 篇真实候选，第一轮没有 Toolformer |
| C3 | ✓ **（之前一直失败，这次通过）** | 点「都不是」并补充后，**同一段对话**第二轮就找到 Toolformer |
| C4–C6、S1、S3 | ✓ | 澄清 ¥0.006；选定、换一篇再选回、预算校验、预估面板都正常 |
| R1 | ✓ | 只出一张下载审批，写明只下载这一篇、只写一个文件、不批准就停 |
| R2 | ✓ | 「已停止 · 没有下载」，已花 ¥0.001 |
| R3 | ✗ | 第二次精读点「确认开始」后，**中间面板一直停在上一次的「已完成」**（截图 `run10/shots/R3.png`），所以 `.rd-start-ap` 没出来。审批卡其实出现在右侧助手面板里，脚本在 R4 点了批准，运行就继续往下走了 |
| R4 | △ | 后端真读完了：run 最终 `completed`，资源管理器里有 **2 张发现卡**；助手消息里是**带页码的真实讲解**（p.2 图 2、p.3、脚注 3）。但是：① 中间面板没有切到论文视图，没有分层讲解（「解析 0/5 层」）；② 中间状态仍是上一轮的「已完成」 |
| X1 | △ | 已知问题 |

**给 DSH 的判断（回答它的第 1 问）：** 页面停在的是**上一轮的「已完成」面板**，不是预估面板，也不是跳到新的已完成。原因是 `start()` 之后 `run.state` 没被重置，一直是 `done`。中间面板只在 `queued / running / waiting` 时显示「开始读 + 待批卡」，所以审批卡只出现在助手面板里。只有第二次精读才这样，第一次正常，和 DSH 的猜测一致。

**修复（DSH，`read-live.ts`）：**
1. `start()` 一开始就推 `run: {state:'queued', endReason:undefined, message:undefined, spentCny:0, unknownCost:false}`，再按事件推进到 `running` / `waiting` / `done`。
2. **论文视图**：`papers_fetch` / `papers_pages` 返回后推 `paper` 事件，带上标题、作者、页码章节（`sections`，原文取 `papers_pages` 的页文本）。这样中间面板会切到精读视图，引用可以点到原文。
3. **分层讲解**：精读角色要用 `cards.card.layer` 产出 5 层讲解（一句话 / 直觉 / 机理 / 证据 / 局限），每层带页码。现在模型只写了发现卡，讲解都写在聊天消息里。这一点按 PRD 的 B1 第 6 步「一层层出现讲解」验收。
4. 收尾：run `d6a1c7ed…` 在走查结束后还停在 `running`，照实结束它。

---

## 验收 run11（`6da25ec`；控制面 12:23 启动，代码是最新的）· 2026-10-28 13:26

录像：`run11/video.mp4`。

| ID | 判定 | 实际 |
|---|---|---|
| E1–E4、W1–W3、C4 | ✓ | 全部符合 |
| C1 / C2 / C3 / C3b | ✗ | `papers_search` 连续 3 次返回 **`KERNEL_TOOL_HTTP_500`**（事件 10842、10844、10850），没有附任何原因。模型处理得体：如实说「检索服务连续报错，不能凭记忆编一篇」，并用 `clarify_question(kind=text)` 请用户补充线索。这一步 60 秒没人回答 → `TOOL_TIMEOUT` → 这一轮结束。新档案（run `310a3467…`）也一样 |
| R* | — | 没走到 |

同一时间从宿主直连 OpenAlex：200，1.8 秒。run10（11:38）时检索还是好的。在这之后改过 `c1303c4`、`a14bb6e`（卡片 schema、论文视图），**很可能是这两个提交碰坏了 `/kernel/tool` 的 `papers.search` 分发**，也可能是控制面出站的问题。需要看控制面日志。

**修复（DSH）：**
1. 查清 `papers.search` 的 500。修完连续检索 5 次都成功。
2. `/kernel/tool` 出错时，工具结果要带上**错误码和一句原因**（比如 `PAPERS_UPSTREAM_TIMEOUT: OpenAlex 25 秒未响应`），不要只有 `KERNEL_TOOL_HTTP_500`。
3. **每次提交后，先自己用真实页面跑一遍「说一句 → 候选」再交付**。run10 → run11 之间就是因为这一步没做，回归了。
