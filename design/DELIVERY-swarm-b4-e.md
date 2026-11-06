# 交付 · E1–E4（D 批复测）

分支 `codex/swarm-4`，一个提交。契约没动。前端 `SwarmMode.tsx` / `swarm.css` / `swarm-live.ts` 我没碰。
`services/control + packages + tooling` **889 条全绿**，栈已重起（迁移已应用）。

## E1（阻塞）D4 写库失败 —— 已修，并改成同一事务

- 根因：`swarm_run_end_reason_check` 里没有 `user_wrote_disputes`，收尾那次 UPDATE 直接失败；
  而卡片的更新在那之前已经提交，于是「卡片已处理、运行没收尾」。
- 两处改动：
  1. 迁移 `202611060002_swarm_end_reason_disputes.sql` 把 `user_wrote_disputes` 加进约束；
  2. `decideCard` 的分歧分支重写成**一个事务**：卡片状态 + 干预关闭 + 运行收尾 + 系统消息 + 报告 + 运行快照，
     要么全成功要么全回滚（`approve` 的「再查一轮」也走同一个事务）。
- 回归测试（跑在真库上）：把运行置 `awaiting_review`，插一张 `swarm_divergence` 卡，
  调 `decideCard({decision:'reject'})`，断言 `state=partial`、`end_reason=user_wrote_disputes`、`ended_at` 非空、
  卡片状态是 rejected。

**给 Claude 复验用的现成运行（已备好）**：`0a5d1090-6e85-4ac1-bcc0-fd42a9a697bc`

- 运行已置回 `awaiting_review`（`end_reason`/`ended_at` 清空，`state_reason` 写明「报告前还有分歧…E1 复验用」）；
- 收件箱里有一张 **pending** 的 `swarm_divergence` 卡 `399464c3-c10d-4fab-9d19-c77efa8e3ca9`（「报告前还有分歧」）；
- 这张卡点「按有争议写入」走的就是这次改的单事务路径：卡片关闭 + 运行 `partial` + `end_reason=user_wrote_disputes`
  + 重发报告与快照，全部一个事务；
- 约束已验：事务内试写 `end_reason='user_wrote_disputes'` 通过（回滚未落库）。
- 之前那张 `fd69dfae-…`（已 rejected、运行没收尾）保持原样，作为历史记录。

## E2 覆盖名单噪声 —— 规则重写，用 0a5d1090 真实数据调过

- **已查证**只取：证据来源的站点名 / GitHub owner（`siteNamesOf`）、标题里的专名。
- **专名形态**（其余一律不收）：2–4 个首字母大写的词、驼峰连写、2–6 位全大写缩写、含数字的产品名；
  **单个首字母大写的普通词不再算**（Actors / Adding / Article / Changelog / Creating 就是这类）。
- **名字里不能有**标点、URL、引文残片（`— : ; ( ) [ ] { } , . § 换行`）、超过 4 个词、超过 40 字。
  「ref 其实是一整句引用」的情况：只有长得像域名（`^[a-z0-9.-]+$`）才当站点解析——之前的
  「… — Wikipedia https:」「§3、」就是这么漏进来的。
- 常见虚词/缩写进停用表（AI / BY / AND / OF / CC / ARXIV / API / …）。
- 中文只收：书名号引号里 ≤12 字且不带句读和 `+ → /` 的、数字开头的产品名（51码字）；
  带「的/是/与/和/或/能否/是否/怎么/如何/哪些」的描述性短语一律不收。
- **空轴不显示**（路线改名后留下的空轴，E2 里那条 r2）。

0a5d1090 重算后的样子：

```
checkedTotal 312 / mentionedTotal 38 / 4 个轴
世界这一层怎么存 → 已查 Additional Pages、ConnectingAreas、DataView… | 没查 App Store、Simple Calendar、Timelines Elements API…
空间与时间怎么动 → 已查 AI Town、Agent Simulations、Azgaar Fantasy Map Generator… | 没查 GPU、Journeys CSV…
内容进出 → 已查 3D 生成 API、ACE、Animation Mocap、BERT、BiLSTM… | 没查 Entity F1、SMT…
```

**还剩的噪声**（如实说）：`Additional Pages` / `Development Status` / `Feature Requests` 这类**界面栏目名**
仍会被当成名字（它们形如 2 个大写词）；`CC BY`、`CDLA` 这类许可证缩写也在。要再干净就得引入「产品名词典」，
那就得喂外部词表了，我先停在这里。

## E3 网关 429 —— 加了带抖动的退避，外加一个建议

- `messages-proxy` 的重试：**3 次 → 5 次**，间隔 **0.5s / 1s / 2.2s / 4s**，每次加 0–300ms 抖动；
  网关若给 `Retry-After` 就按它等（最多 8s）。这样 6 人并发时不会整队同时重试、把限流打得更狠。
- **建议**：先用退避（已上）。如果复测里 429 仍多，两个选项——
  1. 群研成员上限从 6 降到 5（少一个并发）；
  2. 群研单独回官方 `deepseek-flash`（`REINLAB_SWARM_MODEL=deepseek-flash`，代码已支持按档位配型号），
     你说过官方余额紧张，所以我**没有自动切**，等你定。

## E4 来路少算了 —— 按站点/仓库比对

`inferDiscovery` 现在先按「站点 / 仓库」比：
- GitHub 取 `owner/repo`（`github.com/OnlyWorlds/OnlyWorlds` 与 `raw.githubusercontent.com/OnlyWorlds/OnlyWorlds/...`
  是同一个 key，命中就是 search）；
- 其他站点取域名。
命中 `search` 记 search、命中 `citation` 记 citation，都没有才记 known-url。

## 验证

`services/control + packages + tooling`：**889 条全绿**。新增：E1 的驳回即收尾（真库）、
E2 的专名形态断言（单个大写普通词不再算名字）。
