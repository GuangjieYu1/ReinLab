# 开发交接（2026-10-26 起：Codex 做架构设计，DeepSeek V4.1 Flash 1017 做实现，Claude 验收）

## 分工（用户 2026-10-26 定）

| 角色 | 负责 | 不做 |
|---|---|---|
| 用户 | 定方向；和 Codex 逐项讨论（grill）后端设计；授权真实花钱；操作账户和 key | — |
| **Codex（架构）** | 和用户逐项讨论后端设计，把定下来的结果写成**设计卡**（见下） | 不写实现代码，不跑实现测试 |
| **DeepSeek V4.1 Flash 1017（开发）** | 按设计卡实现后端和 live 接线，同步 Claude 的前端文件 | 不改设计卡的决定（有疑问写进 questions，问用户或 Codex）；不改界面样式和交互 |
| Claude（前端 + 验收） | 全部前端（主仓库 mock 版和数据接口）；按设计卡的验收项做测试和真实走查，交短片、RESULTS、REPORT | 不改后端业务代码 |

工作规则见仓库根目录 `AGENTS.md`（主仓库存档：`design/CODEX_RULES.md`）。一句话：**目标是尽快跑通真实全链路**。

## 设计卡（Codex 写，DeepSeek 照着做，Claude 照着验）

每个后端功能一张卡，放在主仓库 `design/backend/<编号>-<名字>.md`，**一页以内**：

1. **要解决什么**：一两句，引用走查里的问题编号（如 RESULTS C3）。
2. **定下来的决定**：和用户讨论后的结论，每条一行；被否决的方案和理由各一行。
3. **改哪里**：文件 / 表 / 接口 / 事件，写到函数或字段级。
4. **接口**：请求、返回、事件字段，前端会用到的写明字段名。
5. **验收项**：3～8 条可以真实操作的检查，写「做什么 → 应该看到什么」。Claude 按这些验收。
6. **不做的事**：明确排除，防止实现时扩大范围。

流程：用户和 Codex 讨论 → Codex 写卡 → 用户点头 → DeepSeek 实现（交命令 + 测试 + 10 行说明）→ Claude 按验收项测试和走查 → 有问题就回到 DeepSeek（实现问题）或 Codex（设计问题）。

## 代码在哪

**一个仓库、一条主线、一个 checkout**：`/Users/guangjieyu/Documents/DeepSeekPlugin/ReinLab`（`main`）。

2026-10-29 起前后端已用正常 Git 合并到一处（[PRD 02 第 1 项](prd/02-foundation.md)），不再有「前端源头 / 后端源头」两处长期分支，也不再复制文件同步。

| 目录 / 文件 | 职责 | 维护方 |
|---|---|---|
| `src/components/`、`src/styles/`、静态资源及页面入口 | 页面、交互、展示及前端启动接线 | Claude |
| `src/data/` | 浏览器请求、事件到页面状态的转换、前端数据适配 | Claude |
| `packages/contracts/` | 前后端共享的数据契约 | Claude 定义前端所需语义；DSH 落实服务端兼容，共同维护 |
| `services/control/` | API、登录、账户、档案、运行管理 | DSH |
| `plugins/` | DSH 工作台插件 | DSH |
| `tooling/`、`infra/` | 全栈启动、运行环境与基础设施 | DSH |
| 根依赖、workspace、构建及测试配置 | 保证同一 checkout 可安装、构建、测试和启动 | DSH 整合，涉及前端要求与 Claude 协作 |
| `design/` | PRD、接口说明、验收记录 | 按 WORKFLOW 的角色分工 |

以后功能分支从 `main` 开始，通过 Git 合并集成。临时工作树仍可用，但不再作为运行或同步源。

## 怎么跑

在统一 checkout 根目录：

```
pnpm local:up --real-models
```

- 一条命令起 supabase、控制面与真实模式前端：http://127.0.0.1:5183
- 前端、控制面与插件都取自当前 checkout，不引用另一个工作树
- DeepSeek key 只由宿主网关从 `~/.config/reinlab/local.env` 读进内存。**开发 agent 自己用的 key 要另开一个**，不要和实验室运行用的混在一起
- 本地实例标识由仓库派生：主目录与旧工作树共用同一个实例，原账号、Provider 配置和业务数据继续可用，不会静默换成空实例
- 测试：`REINLAB_REQUIRE_NATIVE=1 pnpm test`（Node 22）；类型：`pnpm lint` 和各包的 `tsc`
- 验证账户：`~/.local/state/reinlab/<实例>/verification-users.env`，内容不要贴进对话或日志

## 待办（按顺序；每项先由 Codex 出设计卡，第 8 项前端同步可以直接做）

来源：真实走查 [walkthroughs/2026-10-26-research-read/RESULTS.md](walkthroughs/2026-10-26-research-read/RESULTS.md)，以及 [RESEARCH_LIVE_FRONTEND.md](RESEARCH_LIVE_FRONTEND.md) 末尾两节「2026-10-26 追加」「澄清改为聊天式」。

1. **补充说明接回同一个 run**：有待回答的 `REINLAB_CLARIFY` 提问时，`clarify(text)` 把文字作为这个提问的回答发回同一个 run，不新建 run。
2. **卡住的澄清能结束**：
   - 新建精读时关掉旧的；
   - 实现 `cancelClarify()`；
   - 网关围栏只挡同一个 run，不挡整个账户；
   - 账户 A 现在卡着两个 `running` 的 clarify run（`bf2d57b5…`、`f19ca5f5…`），照实结算并关闭。
3. **澄清改聊天式**：
   - 自由多轮对话，可以用自己的知识引导、猜标题；需要时检索，可以多次（limit 8）；
   - 何时弹出 `REINLAB_PAPER_PICK` 由模型决定，卡上只放真实检索结果，不代选、不编造；
   - 清单 `research-clarify`：`output_tokens: 8192`，`rounds/steps: 20`，`cny: 0.5`，发布 `research@1.3.0`。
4. **金额照实显示**：`clarifySpentCny` 按已定价的 cost 事件累加；有在途调用时 `clarifyUnknownCost: true`。
5. **澄清阻塞给人话**：给出 `clarifyBlocked {reason: 'cap' | 'stuck', text}`，不再只推「澄清未受理…」那句话。
6. **加预算**：`raiseBudget('clarify' | 'read', add)`，对应后端已有的 `budget_revision`。
7. **澄清提问不推送到全局收件箱。**
8. **前端同步**（原样复制，来自主仓库）：
   - `src/components/workbenches/research/read/` 下：`readTypes.ts`、`mockRead.ts`、`ReadMode.tsx`、`read.css`
   - `src/components/workbenches/` 下：`AgentDock.tsx`、`agent-dock.css`
   - `src/components/cinematic/EntryComparison.tsx`（减少动态效果时直接出小票）

## 交付与验收

做完一批就停下，告诉用户「命令 + 测试结果 + 改了什么」。用户转给 Claude 后，Claude 用真实走查脚本复测：

```
PLAYWRIGHT_MODULE=<…/playwright/index.mjs> node scripts/walkthrough/research-read.mjs --base http://127.0.0.1:5183 --creds <verification-users.env> --out <目录> --cap 3
```

然后交短片、给 AI 的 RESULTS.md 和给用户的 REPORT.md。复测用的测试句：「我听说 GPT 写了 700 多篇数学论文」。
