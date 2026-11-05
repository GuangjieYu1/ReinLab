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
