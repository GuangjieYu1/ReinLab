# 第一批中期审查（P1-01 ～ P1-09 + 提前 P2-01）

- 日期：2026-10-20
- 审查方：Claude
- 被审对象：Codex 工作树 `research-foundation`，分支 `codex/p2-01-openmaic-spike`，提交 `e571828`
- 性质：中期审查，不是最终验收。依据 [ACCEPTANCE_RESEARCH.md](../ACCEPTANCE_RESEARCH.md) 的方法，范围限于本批

## 结论

**有条件通过，可以进入 P1-10**。前提是先满足下面「进入 P1-10 前」的三项。云端验收（P1-08 的 3 分钟可用、Supabase Auth / Vault / Storage）在用户开通环境后补做，不阻塞 P1-10 的本地开发。

## 审查方亲自复核的内容

| 项 | 方法 | 结果 |
|---|---|---|
| 依赖边界 | `pnpm lint` | 通过 |
| 类型检查 | contracts、control 两个 tsc | 通过 |
| 示例模式构建 | `VITE_BACKEND=mock pnpm build` | 通过 |
| 全量测试 | `pnpm test`（本机 Node 24.14.1；规格要求 Node 22） | **656 / 657**：1 个失败（见缺陷 D-1） |
| 失败用例单独复跑 | 同一用例单独跑 2 次 | 2 次都通过 → 判定为全量并行下的偶发失败 |
| RLS（数据库实查） | 查 `pg_class` / `pg_policy` / 权限 | 20 张表全部 RLS + FORCE + 策略；应用角色对所有表无 DELETE、对 `event` 无 UPDATE；非超级用户、不可绕过 RLS |
| 凭据扫描 | 已跟踪文件的常见密钥 / JWT / 私钥模式 | 0 命中；只有两个示例 env 文件，值为空 |
| SPIKE-1 | 读上游源码 | 属实：`server/routes/runtime.ts` 写死 `const agent = "research"`，并拒绝 `x-openscience-dev-agent` |
| SPIKE-2 | 读上游源码 | 属实：`session/instruction.ts` 的 FILES = AGENTS.md → CLAUDE.md → CONTEXT.md，另加全局来源 |
| SPIKE-3 | 读 OpenMAIC 源码 | 属实：`app/api/generate/scene-content/route.ts` 接受单个 outline、`allOutlines`、`stageId` |

## 缺陷

| 编号 | 级别 | 描述 | 要求 |
|---|---|---|---|
| D-1 | Sev3 | `services/control/test/api.test.ts`「Node22 真实 HTTP 入口验签与优雅退出」在全量并行时返回 500（期望 200），单独运行通过。该用例把子进程 stderr 设为 `ignore`，失败时无法定位原因 | 子进程 stderr 改为收集，失败时打印；查明全量下的干扰源（共享测试数据、并发迁移或连接池）并修复；全量连续跑 5 次全绿后附报告 |
| D-2 | 观察 | 本机审查环境是 Node 24，不是规格要求的 22。D-1 是否与此有关待 Codex 排查 | 在 Node 22 和 24 下各跑一次全量，结论写进 D-1 的修复说明 |

## Q-032（角色方案）的决定

**批准「角色独立 project + 覆写 `research` 定义」，附以下条件。** 理由：这是在不改上游、又保留运行收据（`requestID` 幂等）的前提下，唯一受支持的路径。

1. **目录布局：** 角色 project 放在档案目录**之外**，即 `/data/roles/<dossierId>/<roleId>/`，并且不是 git 仓库。
   - 读档案文件靠 `external_directory` 的路径级规则：`{"*": "deny", "/data/dossiers/<dossierId>/*": "allow"}`，写权限按 `write_targets` 再收紧。
   - 依据：上游 `agent/agent.ts` 的 `external_directory` 支持以路径为键的规则。
2. **默认拒绝：** 上游 agent 的默认权限是 `"*": "allow"`。生成的 `research` 覆写定义必须先 `"*": "deny"`，再逐项放行 `tool_grants`。必须用测试证明「白名单以外的工具被拒」。
3. **禁止内置委派：** 群研与独立审查类角色设置 `task: deny`，子 agent 只由控制面调度。
4. **进入 P1-10 后必须先通过的测试**（在实现其他翻译层功能之前）：
   - **T-ROLE-1**：同一档案的两个角色，实际发给模型的 system prompt 不同（用 fixture provider 截获请求核对，不能只看配置加载）。
   - **T-ROLE-2**：角色读不到其他档案的文件，也读不到其他角色的 AGENTS.md。
   - **T-ROLE-3**：白名单以外的工具（含上游默认允许的那些）被拒。
   - **T-ROLE-4**：配置了 `task: deny` 的角色无法派发子 agent。
   - **T-ROLE-5**：角色 project 下 `requestID` 幂等仍然成立（同内容返回原收据，不同内容 409）。
5. **长期：** 建议给 OpenScience 上游提一个功能请求：运行接口支持指定 agent。不阻塞本项目，是否提交由用户决定。

## 进入 P1-10 前

1. 修复 D-1（含 D-2 的排查结论）。
2. 按上面的条件 1–3 写一份《角色方案实施说明》（`docs/spikes/SPIKE-1-decision.md`），列出生成的 agent 定义样例和目录树。
3. P1-10 的第一个 PR 只做 T-ROLE-1 ～ 5 及其所需的最小实现，交审查方确认后再做其余翻译层功能。

## 需要用户决定或提供的

| 编号 | 事项 |
|---|---|
| Q-006 / 012 / 029 | 开通 Fly（东京）与 Supabase（东京）的 staging 项目，凭据只通过安全环境变量注入，不贴在聊天里。开通前，云端验收保持「待补验」 |
| Q-021 | 三档模型（便宜 / 中 / 强）各用哪个，以及美元兑人民币汇率的来源（建议：配置文件里的固定值，每月更新一次并记入账本） |
| Q-025 | 费用预估的假设（每轮输入 1 万 / 输出 3 千 token、2 倍安全系数）是否接受。审查方认为合理 |
| Q-005 | 「既有无头回归脚本」是审查方此前在前端阶段写在 `/tmp/rl-prof/*.mjs` 的 Playwright 脚本，不在仓库里。建议由审查方整理成可移植版本放进仓库的 `e2e/legacy/`，作为 T-REG 的基线 |
