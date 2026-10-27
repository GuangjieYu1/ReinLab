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
- **8 步剧本真机走查（2026-10-27）**：说想读哪篇 → 真实候选（OpenAlex）→ 用户选择卡
  （`clarify_question(kind=paper_pick)`，带真实候选，模型不代选）→ 选定 → 只有一张下载审批 →
  批准后真实下载 → `papers_pages` 读页 → 完成，用量 `known=true`；同档案追加线索复用同一
  session（`resume=true`）。
- 取消：`cancel` 6.07s 返回 `cancelled`，内核进程确认消失。
- 一次性清空旧业务数据已执行：42 张业务表 `TRUNCATE`（不带 CASCADE），账号 18 条保留，`dossier/run/credential` 归零；旧 `rl-*` 容器与 18 个旧卷已删除。
- 自动化：`kernel-*` 共 14+ 文件用例全绿，含真进程端到端（真 dsh + 本地 Messages stub + 插件工具回填 + 取消确认）。

## 4. 已知失败

**本轮最终全量（node 22.23.3，本地 PG 55432，`REINLAB_REQUIRE_NATIVE=1`）：1668 passed / 2 failed（1670）。**
两条失败都是改造前就在的、随旧内核退役删除的用例，不是本轮回归：

1. `services/control/test/batch7-native.test.ts > native2.0.150 candidates=true/false ...` — 期望
   `{questions:1, requests:2}`，实得 `{questions:0, requests:6}`：OpenScience 原生澄清行为漂移。

改造前基线（`0298c89`）另有 2 条，本轮环境与改动后自然恢复/不再触发：
- `account-entrypoint-lock.test.ts`（旧账户入口锁，期望退出码 17 得 1）——本轮全量中通过。
- `tooling/local/control-process.test.ts`（`process.kill(pid,0)` 在 50ms 后仍成功）——本轮全量中通过。

`pnpm lint` 另有 5 条改造前就存在的越界告警（`verify-*-live.ts`、`worker/src/main.ts`），非本轮引入。

## 5. 未做 / 待你确认

- 前端接线（Claude 负责）。
- OpenScience 全量退役（`bridge/openscience/`、旧插件、`@synsci/*`、旧表）：按 PRD 在 B1 验收通过后做，本轮未删，以免验收期间无对照。
- 账户镜像路径（`REINLAB_KERNEL_TRANSPORT=container`）代码保留但本机未验证（Docker Hub 受限）。
- 发现卡（`card_finding`）：路由已由 `kernel-dispatch` 用例锁定（`cards.card.finding` → 现有卡片层 → 回执），
  卡片本身仍由现有 `dataHandlers` 校验冻结 schema 与页码依据（旧套件覆盖）。真机走查里模型未主动产出卡片，
  角色指令已加「至少一条」，仍属模型行为，建议 Claude 验收时在页面侧确认。
