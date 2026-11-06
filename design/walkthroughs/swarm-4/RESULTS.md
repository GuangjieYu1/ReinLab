# 群研返工第一批 · 真实页面验收（Claude，2026-11-05）

分支 `codex/swarm-4`，后端 `c88a67e`，前端改动见本批未提交的文件。试用账户，模型是 opencodego 网关上的 deepseek-v4.1-flash。
- 复测运行：`f7bd65fe`，档案 `80d74a0e`「群研返工复测：世界观底座」。
- 题目原文和上次三方对比用的那段一模一样。
- 澄清时选了：半实测、全景版、4 轮 / 60 分钟；编制是研究员 3 人，共 6 人。

## 结论：四项里三项通过，成稿不通过（工具没注册）；另有两个后端问题

| 项 | 结果 |
|---|---|
| 1 审查记录里的读全 / 部分 | 通。每条核实都带 `readCompleteness`，页面显示「读全了原文 / 只读了部分」。**但门禁有漏洞，见 B2** |
| 2 成稿 `report.narrative` | **不通（B1）**。负责人推理里写着「research_narrative isn't in my function list」，只好把成稿写进 `team/lead/narrative.md`（21KB），`narrative` 字段是空的。前端用这份真实成稿在浏览器内存里注入验过：渲染正常，有 3 张表、47 个引用标签，点开就是对应结论（截图 10–13） |
| 3 队员能用 bash / read | 通。全程 bash 548 次：`git clone` Azgaar、装 pip、用 curl 下载论文 PDF 存进核实员资料目录、写 python 统计脚本复跑 |
| 4 读黑板变小 | 通。`research_query` 每次约 1.2k 字，上次是 2.3 万字 |
| 关键错结论 | 修好了。Generative Agents 这次写的是「论文在『局限』一节自述『花费数千美元 token 额度、耗时多天』」，核实员标「读全了原文」，判已核实 |

## 给 DSH

- **B1（阻塞）`research_narrative` 没注册给负责人。** 人设里写了「结束前交 research_narrative」，可负责人的工具表里没有它。负责人最后把成稿写进文件，`swarm_run.narrative` 为空。修好以后，最好让这条运行的负责人把 `team/lead/narrative.md` 补交一次，前端就能直接验。
- **B2 核实门禁只拦带 `negative` 的结论。** 结论 `af7b43dc`（「四家里只有 World Anvil……」）v2 的核实记录里，verdict 是 `verified`，read_completeness 是 `partial`，理由第一句却是「这条我核不了，如实写『打不开』」。因为这条没标 negative，门禁没拦，结论被判成已核实。负责人在成稿里自己发现了，写了「平台状态字段一度误记为 verified，以核实意见为准」。建议：任何核实只要 `partial`，或理由里有「核不了 / 打不开 / 截断」，都不能判 `verified`。
- **B3 网关不稳。** 第 1 轮中途暂停一次，原因是「模型服务暂时连不上（上游 5xx，已重试过）」，点继续后恢复。另外换成 opencodego 后 `cost_cny` 一律为 null，账本只能记 token。要么拿到 opencodego 的计价，要么回官方 `deepseek-flash`。
- **观察：只搜了 11 次，广度还是不够。** web_search / web_fetch / papers_search 加起来 11 次，bash 548 次。研究员基本是 curl 已经知道的网址，很少去搜「还有谁」。所以上次漏掉的 OnlyWorlds、articy、Aeon Timeline、51码字，这次一个都没找回来。DSH 单人搜了 19 次，每次网关内部还能连搜 5 次。
- **观察：队员的系统提示开头是「你是 ReinLab 群研的负责人」**（研究员 `8f44c272` 的 system/message）。角色大概是靠后面的任务消息再交代的，但开头先说「你是负责人」容易让它把自己当负责人，值得看一眼。

## 前端本批（Claude）

- 汇总面最上方加了「成稿」：用 markdown 渲染，支持标题、列表、表格；正文里的结论和证据 id（完整 uuid 或 8 位前缀，如〔af7b43dc〕）变成可点的小标签，点开走同一个抽屉；宽表格横向滚动。
- 审查记录里加了「读全了原文 / 只读了部分」标记。
- 契约 `Review` 加了 `readCompleteness?`（后端已经在返回）。
- 修了计划卡的 bug：研究员按路线分成几行时，卡面只算了第一行，7 人的计划被显示成「研究员 1 · 4 人」，现在按角色加总。

## 广度返工（B4）复测（2026-11-06，后端 `e766d99`）

运行 `fe243151`，档案 `3a67ffb8`「群研广度复测：世界观底座」。题目和设置都和上次一样：6 人，4 轮 / 60 分钟，半实测，七问都查。
- 第 4 轮遇到分歧卡，用户选「再查一轮」；第 5 轮用满额度后又出了同一张分歧卡，用户选「按有争议写入」，Claude 点了「结束」。
- 实际干活 54 分钟，**¥12.77**（输入 308 万 / 输出 57 万 / 缓存读 1.01 亿 token）。预算原定 ¥6–8，多出来的主要是用户选的第 5 轮。

| 项 | 结果 |
|---|---|
| 成稿工具在运行现场交出 | 通。负责人运行中调了 `research_narrative` 7 次，最终 11,531 字、142 个引用标签，页面正常渲染（截图 50） |
| 发现类证据占比 | **不通。** 297 条证据全部是 `known-url`，发现类 0 / 297 |
| 找回漏掉的 4 个对象 | **0 / 4**（OnlyWorlds、articy、Aeon Timeline、51码字）。新找到 Watabou、Inkarnate |
| 账本含缓存读 | 通。¥12.77，页面和账本一致 |
| Generative Agents 成本 | 对。原文是「花费数千美元 token 额度、耗时数天」 |

### 给 DSH

- **D1（阻塞）web_search 和 web_fetch 全部 401。** 换到 opencodego 以后，搜索代理（`registerWebToolsProxy`）拿模型网关的 key 去调 DeepSeek 的 search / fetch，每次都回 `DeepSeek search 返回 401：Authentication Fails, Your api key: ****vyVj is invalid`。f7bd65fe 7 次、fe243151 6 次，全部失败；最早的 93f8527c 用官方 key，搜索 18 次、抓取 141 次全部成功。所以 `swarm_source_hit` 是空的，297 条证据全记成 known-url，①③ 根本没被测到。修法：搜索和抓取继续用 DeepSeek 官方 key（宿主 `DEEPSEEK_API_KEY`），和模型网关的 key 分开配置。另外，错误信息里带出了 key 的末 4 位，而且落进了事件表，请不要回显 key，打码的也不要。
- **D2 负责人一次都没调 `research_coverage`。** 只给负责人、又不提醒，它就不用。要不要在快照或报告里被动展示覆盖情况（不经过负责人调用），你出方案。
- **D3 到额度后还在开新活。** 用满 60 分钟、进入 `awaiting_review` 之后，队员还领了 task-17，接着 curl 可灵的定价页。PRD §3 要求到限就停止新增任务。
- **D4 选了「按有争议写入」以后不收尾。** 卡片记成 `rejected`，运行却一直停在 `awaiting_review`，不出正式报告，最后靠用户点「结束」才停下。
- **D5 反驳满 2 轮后的死锁。** 负责人原话：Watabou 那条（4c913f59 v3）「仍挂着第一轮针对旧版证据的未解决反驳，反驳已达 2 轮上限不能再发，核实两次被 VERIFY_OPEN_REFUTE 拦下」。针对旧版本的反驳不应该挡住新版本的核实。
- **D6 内核事件接口太重。** `GET /v1/kernel/runs/:id/events?after=…` 在这条运行上一次返回约 0.8MB，前端每 2.5 秒拉一次。运行中的时候请求越积越多，把浏览器连接耗光了（`ERR_INSUFFICIENT_RESOURCES`），连「结束」按钮都发不出去。前端已经加了「上一次没回来就不发、失败退避」；后端请给这个接口加分页上限，或者让它能按 action 过滤（前端只要 turn/start、turn/end、assistant/message）。
- **观察**：运行进行中，页面底部显示的费用（¥4.91）一度明显低于账本（¥8.15），结束后两者一致，都是 ¥12.77。看一下快照里的费用是不是更新慢了。

### 前端本批（Claude）

- 证据详情显示来路；汇总的来源区先统计全部证据的来路，再按来路分组列出报告引用的来源。
- `swarm-live` 的侧边轮询加了「上一次没回来就不发」和失败指数退避，最长 60 秒。

## D 批（D1–D6 + 覆盖）复测（2026-11-06，后端 `f0890e3`）

运行 `0a5d1090`，档案 `fc5cff18`「群研搜索修复后复测：世界观底座」。题目和设置都和前两次一样。
- 4 轮用满 60 分钟后出了分歧卡，用户选「按有争议写入」；因为下面的 E1，Claude 点了「结束」。
- 实际干活 52 分钟，**¥9.37**（输入 140 万 / 输出 57 万 / 缓存读 7371 万 token）。

| 项 | 结果 |
|---|---|
| D1 搜索 | 通。web_search 25 次（共 68 条关键词）、web_fetch 45 次成功，0 次 401；`swarm_source_hit` 有 407 条搜索命中。另有 7 次抓取 404、3 次 30 秒超时 |
| 发现类证据 | 116 / 336 条是搜出来的（35%），前两次都是 0 |
| 找回漏掉的 4 个对象 | **2 / 4**：OnlyWorlds、articy，都是搜出来的。Aeon Timeline、51码字没找到。还新找到 ConStory-Bench、Obsidian Leaflet、Foundry VTT |
| D3 到限不开新活 | 通（没看到违规）。进入等待后没有新任务，费用停在 ¥9.37 不再涨；全程没出现 LIMIT_REACHED，说明也没人去试 |
| D4 分歧决定后收尾 | **不通（E1）** |
| D5 旧反驳挡核实 | 这次没触发，全程没有 VERIFY_OPEN_REFUTE |
| D6 + 前端轮询 | 通。页面全程没卡，「结束」一点就生效 |
| D2 覆盖块 | 能显示，不需要点任何工具；**但名字噪声大（E2）** |
| 成稿 | 通。负责人交了 6 次，最终 12,147 字 |

### 给 DSH

- **E1（阻塞）D4 写库失败。** `POST /v1/approvals/fd69dfae…/decide` 报 `new row for relation "swarm_run" violates check constraint "swarm_run_end_reason_check"`：新的结束原因 `user_wrote_disputes` 不在数据库约束里，要补迁移。现在卡片被标成 `rejected`、`decided_at` 也写了，但 `decision_sent=false`，运行一直停在 `awaiting_review`。决定和收尾要么一起成功，要么一起失败，不能出现「卡片已处理、运行没收尾」。
- **E2 覆盖名单噪声。**
  - 「提到但没查」里大多是短语，不是名字：「人物是地图上的点」「某地/某时刻有谁」「能否反查」。
  - 「已查证」里是英文标题拆出来的普通词：Actors、Adding、Additional、Article、Changelog。
  - 还有一条空轴「r2 空间与时间：…」显示「已查 0 · 没查 0」，像是路线改过名以后，旧名字没合并进来。
  - 建议收紧规则：「已查证」只取证据来源的站点或仓库名，以及标题里的专名；「提到」只取能对上证据里专名的，或者中文书名号里的。
- **E3 网关 429。** 日志里有好几次 `MODEL_UPSTREAM_429` 和 `Client connection prematurely closed`，对话框里显示成「服务暂时无法处理请求」。opencodego 有限流；群研 6 人并发时容易撞上，要么退避重试，要么回到官方 deepseek-flash。
- **E4 来路少算了。** 先搜到 OnlyWorlds 的仓库，再去读 `raw.githubusercontent.com/.../schema/event.yaml`，后一步被记成 known-url。同一仓库或同一站点下、由搜索结果延伸出来的抓取，应该算 search 或 citation。

### 前端本批（Claude）

- 汇总面加了「覆盖」一节：按路线两列，「提到但没查」高亮。目录里加了覆盖。
- 侧边轮询改成只拉 turn/start、turn/end、assistant/message 三种事件，一页 200 条。

## E 批复验（2026-11-06，后端 `b52cb5c`）

在 `0a5d1090` 上验；DSH 把它置回 `awaiting_review`，换了一张新的分歧卡 `399464c3`。

| 项 | 结果 |
|---|---|
| E1 分歧决定即收尾 | **通。** 点「按有争议写入」后 5 秒内：运行变 `partial`，`end_reason=user_wrote_disputes`，`ended_at` 写入；卡片关闭；汇总面显示「正式报告（部分完成）」，两条分歧进了「有争议」一节 |
| E2 覆盖名单 | **好了一半。** 「已查证」里有了真名字：LegendKeeper、AI Town、Azgaar、BookNLP、ConStory、Generative Agents、Fable Studio、Foundry VTT。但还混着：缩写（GPL、HTTP、README、SDK、JSON、CSV、OSI、FAQ、BERT、CRF）、半句话（Each Campfire、Uses Foundry、Does Intangible）、栏目名（Additional Pages、Development Status）。「没查」里仍有带引号的短语（「同一时间在两地」「找出情节漏洞」「演得像」）。「未归到路线」那一栏 30 个名字也大多是栏目名 |
| E3 429 重试 / E4 来路 | 没法在旧运行上验，要新跑一条 |

小问题：「有争议」一节里的两条结论，状态标签显示的是「已证伪」。用户选了「按有争议写入」，报告分区和结论状态各说各的，看的人会糊涂。建议要么分区按结论状态分，要么写入时把状态一起改成 disputed。

前端：覆盖块过滤空白名字，两列都空的轴不显示（兜底）。

## E 批新跑复测（2026-11-06，后端 `b52cb5c`）

运行 `7cfe5d63`，档案 `b5471fc2`「群研 E 批复测 2」。题目和设置照旧。4 轮后出了分歧卡，用户选「按有争议写入」。实际干活 72 分钟，**¥8.84**（输入 125 万 / 输出 53 万 / 缓存读 9256 万）。

| 项 | 结果 |
|---|---|
| E1 真实运行里分歧决定即收尾 | 通。5 秒内变 `partial` / `user_wrote_disputes`，出了正式报告，费用不再涨 |
| E3 429 | 通。开跑后 control.log 里 `MODEL_UPSTREAM_429` 为 0；7 次「prematurely closed」都被重试接住 |
| E4 来路 | 通。165 / 395 条是搜出来的（42%，上次 35%）。剩下 22 条 raw.githubusercontent 是题目里点了名的仓库（Azgaar、BookNLP、Kanka），记成 known-url 是对的 |
| 广度 | **不稳定。** 漏掉的 4 个对象这次 0 / 4（上次 2 / 4），ConStory、Obsidian 也没出现。同一题目，每次找到什么取决于路线怎么切、哪个研究员勤快 |
| 结果 | 36 条已核实，1 条有争议，1 条证伪，8 条负结果；成稿 11,506 字 |

### 给 DSH（不阻塞合并）

- **F1 超时：** 额度 60 分钟，实际干活 72 分钟（active_ms），多跑了 12 分钟才进入 awaiting_review。到点要停止新增模型调用、进入收尾。
- **F2 内核冷启动：** 这次开跑前失败了两次。第一次是 `initialize timed out after 10000ms waiting for dsh profile "sdk"`，10 秒上限偏紧；第二次在同一档案里重开，报 `KERNEL_SESSION_RESTORE_FAILED`，被第一次留下的半截会话连累。用户只看到「失败」，不知道要换档案。建议放宽初始化超时；初始化失败的会话不要留给下一次去恢复。
- **F3** 「有争议」一节里的结论，状态标签显示「已证伪」，和分区标题对不上（E 批复验时记过）。
- **F4** 覆盖名单还有缩写、半句话、栏目名（E2 没收干净）。
