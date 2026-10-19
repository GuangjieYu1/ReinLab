# 给 Codex 的开场（第三批：P1-10 其余部分 + 本地化）

你好，Codex。第二批审查已经结束，这份是下一批的完整说明。下文说的「主仓库」都指 `/Users/guangjieyu/Documents/DeepSeekPlugin/ReinLab`，里面的 `design/`、`e2e/` 没有提交，按绝对路径读取。

## 一、先读这几份（主仓库）

1. `design/reviews/BATCH2_REVIEW.md`：第二批审查结论和缺陷 D-3、D-4。
2. `design/DEFERRED.md`：用户的新决定，第一阶段全部本地、全部用 DeepSeek V4 Flash。**它优先于** `CODEX_SPEC_RESEARCH.md` 里与云端、模型分档有关的条款。
3. `e2e/legacy/README.md`：前端无头回归基线，也就是 T-REG。
4. `CODEX_SPEC_RESEARCH.md` 和 `ACCEPTANCE_RESEARCH.md` 仍然有效。审查方只在里面加了指向上面文件的说明，正文没改。

## 二、第二批的结论

**通过。** D-1、D-2 关闭，T-ROLE-1 ～ 5 通过，可以继续 P1-10 其余的翻译层功能。

审查方亲自复核过：
- 在 Node 24 下跑全量，连续 3 次都是 714/714；
- lint、类型检查通过；
- 亲手跑了 `review-toctou.ts`，exit 0，没有泄漏；
- 读了 `model-requests.json`，两个角色各自只收到自己的 system；
- 读了 `database.ts`、`role-project.ts`、`role-runtime.ts` 和插件的实现。

你们的独立评审抓出了 R1 ～ R4，尤其是 R4（插件其实没加载），这一点值得肯定。

## 三、用户的新决定（2026-10-20）

| 项 | 现在怎么做 |
|---|---|
| 模型 | `MODEL_ROUTE_CHEAP`、`MODEL_ROUTE_MID`、`MODEL_ROUTE_STRONG` 都填 `deepseek/deepseek-v4-flash`。分档逻辑保留，以后换模型只改配置 |
| 汇率 | `MODEL_USD_CNY_RATE=7.2`，固定写在配置里，账本里记下每次用的汇率。**Q-021 关闭** |
| 费用预估 | 每轮输入 1 万、输出 3 千 token，再乘 2 倍余量。**Q-025 关闭** |
| 云端 | 暂不开通 Fly 和 Supabase 云端。Q-006、Q-012、Q-029，以及 P1-08 的「3 分钟可用」，统一记为「云端补验」，不阻塞后续开发 |
| 本地 Supabase | 用 Supabase CLI（`supabase start`）起完整一套：Auth、Storage、Vault 都要有，不能只有裸 Postgres。Auth 注册触发器、Vault 信封、快照桶的代码路径都要在本地真实跑过 |
| 账户容器 | provisioner 抽出驱动接口，先实现 `docker` 驱动：一个账户一个容器，一个具名卷，同一个账户镜像。保留 `fly` 驱动的位置，上层代码不感知差异 |
| 多模态 | DeepSeek V4 Flash 不能看图。需要读图的功能（PDF 图表、P1-16 的 OCR）标为「待多模态模型」，不要用假数据冒充 |
| GPU | 暂不接 Modal。需要 GPU 的任务只做提议，不执行 |
| 会员接入 | 暂不做 |
| Hatchet | 做到 P1-13 时，在本地用 Docker 自托管 |

**红线不变：**
- `live` 路径里不能出现 fixture 或桩模型；
- 凭据不进仓库、不进证据、不进日志；
- DeepSeek 的 key 由用户放在本机受保护的环境变量里，你只按变量名读取，不打印。

## 四、本批要做的事（按顺序）

### 1. D-3（Sev3，第一个提交就修）

`role-runtime.ts` 里的 `prompt()` 写死了 `delegation:true`，要改成：
- 生产默认 `delegation:false`；
- 只在测试里，通过一个构造参数打开它。

两种情况各留一个测试：
- 关闭时：不能派发子 agent；
- 打开时：仍然被 `task: deny` 拒绝。后者证明拒绝来自权限规则，而不是靠这个总开关。

### 2. Q-005 → T-REG 入库

把主仓库 `e2e/legacy/`（`run.mjs`、`README.md`、17 个场景）原样带进你的分支：
- 在 devDependencies 里加 `playwright`，并加上 `e2e:legacy` 脚本；
- 在 `mock` 模式下跑一遍，附上 `report.json`。审查方实测是 17/17。
- 之后每次送审都要附上 T-REG 的报告。
- 场景失败时，先确认前端的改动是不是有意的，**不要为了变绿去改场景**。

### 3. 本地化

- 接上本地 Supabase CLI 全套；
- 实现 provisioner 的 `docker` 驱动；
- 写一个一条命令起本地全套的脚本（例如 `pnpm local:up`），在 `HANDOFF.md` 写清楚怎么用。

### 4. P1-10 其余部分：会话、提交、事件映射、决定回填、费用

**事件映射：** 把内核事件翻译成 ReinLab 账本事件，并持续订阅事件。订阅出错时的处理路径里**不得**调用 `prompt`（CR-3）。

**决定回填：** 审批卡的决定只能由控制面回填。不能自动批准，也不能替用户回答待定的决定。

**费用：** 按 DeepSeek V4 Flash 的价格记账。会员额度这个字段保留，但当前不用。

**幂等补测**（BATCH2 的观察 1），三种情况都要证明「拿回原收据，不重复执行」：
- 控制面重启后，恢复会话绑定；
- 请求还在进行中时被重放；
- 内核重启后重放。

**D-4（Sev4）：** 测试默认把证据写到临时目录，只有设置了 `REINLAB_EVIDENCE_OUT` 才写进 `evidence/`。审查方跑一次普通的 `pnpm test`，就会改写 3 个已提交的证据文件。

**可读性：** `role-project.ts` 和插件这类安全模块，按正常的换行和缩进排版，不改逻辑，单独一个提交。以后审查会把可读性算进 Sev4。

### 5. 真实模型冒烟（P1-10 收尾时做一次）

用 DeepSeek V4 Flash 真实跑一个最小研究角色回合：
- 证明整条链能通：提交 → 事件 → 账本 → 费用；
- 费用要和 DeepSeek 后台的账单对得上；
- 冒烟只做一次，预算上限 ¥1；
- 证据里不能有 key。

## 五、停止点与送审

P1-10 全部完成后停下来送审，**不要继续做 P1-11**。送审时要有：

1. `evidence/P1-10/README.md` 更新，包括：
   - 本地全套怎么起；
   - 全量测试结果，Node 22 和 Node 24 各一次；
   - T-REG 报告；
   - 真实模型冒烟的证据。
2. 一份 D-3 / D-4 / 观察 1 ～ 2 逐条关闭的说明。
3. 所有 CI 运行的终态，包括第二批遗留的 run 39279672175（审查方本机没有 `gh` 登录，无法亲自核对）。
4. 新的问题照旧写进 `docs/questions.md`。需要用户决定的事，单独列在送审说明的最前面。

前端源码和用户原有的改动保持不动，跟之前一样。
