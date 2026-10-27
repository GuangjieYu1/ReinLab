# 第七批审查（精读对话澄清 + 前端同步 + T-MCP-10 计划修正）

- 日期：2026-10-26
- 审查方：Claude
- 被审对象：Codex 工作树 `research-foundation`
  - 分支：`codex/p1-read-clarify`
  - 提交：`1ee995f`（自 `adb8f17` 起 6 个提交）
  - PR：GuangjieYu1/ReinLab#20
- 依据：[CODEX_BRIEF_BATCH7](CODEX_BRIEF_BATCH7.md)、[RESEARCH_LIVE_FRONTEND.md](../RESEARCH_LIVE_FRONTEND.md)

## 结论

**通过。** 第七批五项都完成了，没有阻断缺陷。

## 审查方亲自复核

| 项 | 方法 | 结果 |
|---|---|---|
| 前端原样同步 | 8 个文件和主仓库逐个比对 SHA-256：read/ 下 5 个、`ResearchStudio.tsx`、`InboxPanel.tsx`、`20-read-run.mjs` | **8 / 8 字节相同** |
| 全量测试 | 先前端构建，再跑 `REINLAB_REQUIRE_NATIVE=1 pnpm test`（Node 22，环境里去掉 key） | **1567 / 1567**，0 失败 0 跳过；之后工作区 0 改动 |
| 依赖边界 | `pnpm lint` | 通过 |
| T-REG | Codex 分支，mock 模式，全部 20 个场景 | 第一次 17 / 20：`ex` 报 `ERR_NETWORK_CHANGED`（本机网络在运行中切换），`df` 和 `read-run` 在同一时段超时。**三个单独复跑都通过**，判定为环境偶发，不算缺陷 |
| research@1.2.0 澄清角色 | 读清单 + `manifest.ts` 校验 + `registry.ts` 授权编译 + `batch7-contract.test.ts` | `research-clarify`：便宜档，最多 6 步，`model_cap` 为 ¥0.05 / 6 轮 / 每轮 256 输出 token，不能写任何目录、不读记忆，`task: deny`，`question: allow`（用于让用户选论文）。工具虽然给的是 `literature: allow`，但 `capability_allowlist: [papers.search]` 在编译授权时取交集，**编译出的能力只有 `papers.search`**（契约测试已证明）；能力令牌由这份结果生成，服务器拒绝令牌以外的能力（T-MCP-2），所以澄清阶段无法下载全文。清单加载器还会硬校验这个角色的形状，偏离一项就拒绝加载 |
| 凭据扫描 | 用当前专用 key 的实际值，扫 Codex 本机日志、工作树、git 全部历史 | 全部 0 处 |

## 观察（不阻塞）

1. **补一条直接测试。** 「澄清角色调用 `papers.fetch` / `papers.pages` 被拒」目前靠「授权编译只有 search」+「T-MCP-2 的通用拒绝」两条推出来，没有一条直接覆盖它的测试。建议在下一批补一条原生或 HTTP 级测试：在澄清运行里强行调用 fetch，断言返回 `capability.denied`、并且没有落盘。
2. **T-MCP-10 历史核账 ¥0.00488924。** 这个数包含审查方那次运行里取消的第二个请求，原来账本的「未知」状态保留没动。这样记是对的，以后对账任务按「追加一条已核账事件」处理，不改历史记录。

## 下一步

1. **真实体验（需要用户授权）：** 在真实后端上走一次「对话澄清 → 选论文 → 预估」。这一段只用澄清角色，上限 ¥0.05，不会进入正式精读，也不会下载全文。
2. **T-MCP-10（需要用户授权）：** 按修正后的计划，执行一次「检索 → 批准下载 → 读页 → 批准写入 → 发现卡」，上限 ¥1。
3. **研究台第一期剩余：** P1-14 / P1-15（自研）。前端由审查方先做。
