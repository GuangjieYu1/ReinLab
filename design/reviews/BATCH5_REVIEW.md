# 第五批审查（凭据文件化 + research@1.1.0 + P1-12 收件箱）

- 日期：2026-10-24
- 审查方：Claude
- 被审对象：Codex 工作树 `research-foundation`，分支 `codex/p1-12-approvals-inbox`，提交 `90da196`，PR GuangjieYu1/ReinLab#18
- 依据：[BATCH4_REVIEW](BATCH4_REVIEW.md) 第 5 节；[BACKEND_MEMORY_SESSION](../BACKEND_MEMORY_SESSION.md) 第 13 节（收件箱）

## 结论

**通过，P1-12 关闭。** 后端和数据层面都符合要求。另有两项要跟进：
- **E-1（构建冲突）**：排进下一批第一项；
- **E-2（收件箱界面的视觉）**：改由审查方出界面设计，Codex 负责接数据。

## 1. 审查方亲自复核

| 项 | 方法 | 结果 |
|---|---|---|
| 全量测试 | Node 22.23.3，环境里去掉 key | 第一次跑：1401 通过、9 失败、23 跳过。**这 32 项全部是原生内核测试**，原因见 E-1：原生二进制被前端构建删掉了。重建二进制后，单独复跑这 32 项：**32 / 32 通过、0 跳过**。合计 1433 项，与 Codex 报告一致 |
| 依赖边界 / 类型 / mock 构建 | `pnpm lint`、两个 tsc、`VITE_BACKEND=mock pnpm build` | 通过 |
| T-REG | 用 Codex 分支的前端，跑 mock 模式 | **18 / 18** |
| 前端改动范围 | 读 diff：`LoginGate`、`main.tsx`、`ResearchStudio`、`vite.config.ts`、`vite-env.d.ts` | 所有改动都由 `liveBackend` 开关隔开；mock 分支的逻辑原样保留，只是把原研究台组件重命名为 `MockResearchStudio`。主仓库没有被改动 |
| 登录会话 | 读 `src/data/research-live.ts` | 会话**只放在内存里**，不写 localStorage、sessionStorage、cookie；刷新令牌合并成单次请求并带代数（防竞态） |
| XSS | 搜索 `dangerouslySetInnerHTML` | 0 处 |
| 收件箱的功能 | 对照第 13 节，看截图 `inbox-pending.png` | 四种操作齐全（批准 / 修改后批准 / 驳回 / 只存本档案）；依据可以点开回到来源对话；有过期时间，过期作废、不会默认通过。符合设计 |

## 2. 缺陷与观察

| 编号 | 级别 | 描述 | 要求 |
|---|---|---|---|
| E-1 | **Sev3** | 原生内核二进制放在 `dist/account-runtime/`，而前端 `pnpm build`（Vite）默认会清空整个 `dist/`。只要在跑测试之前先跑过一次前端构建，32 项原生测试就会坏掉：9 项失败、**23 项静默跳过**。Codex 的复跑顺序恰好是先测试、后构建，所以一直没暴露 | ① 把原生产物移出 `dist/`（例如 `.artifacts/account-runtime/`），或者把前端构建的输出目录改成 `dist/web`。② 原生测试在缺少二进制时**必须失败**，并提示怎么构建，不能静默跳过；CI 里设置 `REINLAB_REQUIRE_NATIVE=1` 强制要求。③ 补一个测试：先跑构建、再跑原生测试，两者都要通过 |
| E-2 | 体验 | live 收件箱功能完整，但视觉没达到莱茵生命的设计语言：<br>• 弹层压在页面中部，背后研究台的版式没有接好（AgentDock 被拉满全宽）；<br>• 卡片标题和元信息挤在一起（`L4.KNOWLEDGE人工审阅验证 1`）；<br>• 依据直接显示 `event:97`；<br>• 时间是原始 ISO 串；<br>• 分组标题用的是英文 ID（`research · 待处理`） | 不阻塞后端验收。分工改为：**审查方**在主仓库按设计语言出收件箱和审批卡的前端设计（mock 版，带固定的数据接口类型）；**Codex** 只做数据适配，把 live 数据接到这套组件上，不自己写界面样式 |
| E-3 | 观察 | 会话只在内存里，刷新页面就要重新登录 | 现阶段为了安全可以接受。以后改成由控制面托管的 HttpOnly 会话 cookie（BFF 模式），放到上云前再做 |
| E-4 | 观察 | `LoginGate.tsx` 新增的代码又写成了一行一个分支，和这个文件原来的风格不一致 | 按文件原有风格排版（不改逻辑），可以和 E-1 一起提交 |

## 3. 仍待用户的事项

- **T-MCP-10：** 用研究台 1.1.0 上的新档案跑一次真实端到端，预算 ≤ ¥1。key 已经轮换，但**还需要用户明确授权**这一次。

## 4. 下一步

1. **Codex 第六批：**
   - 先修 E-1、E-4；
   - 再做 P1-13：Hatchet worker 骨架、`account.reconcile`、机器重启的混沌测试（T-CHAOS），以及无人访问时的全局主动恢复；
   - 用户授权后，做 T-MCP-10。
2. **审查方（并行）：** 出收件箱和审批卡的前端设计（E-2）。完成后由 Codex 在第六批或第七批接上数据。
