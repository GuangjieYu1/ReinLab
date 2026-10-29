# 先跑通、后再做的事项

- 决定日期：2026-10-20
- 决定人：用户

第一阶段先求简单：**全部模型用 DeepSeek V4 Flash，服务器全部在本地部署**，等整条链在本地跑通以后，再逐项做下面的事。

## 当前阶段的约定（Codex 照此执行）

| 项 | 现在怎么做 | 要求 |
|---|---|---|
| 模型 | 三档都填 `deepseek/deepseek-v4-flash`：`MODEL_ROUTE_CHEAP` / `MID` / `STRONG` | 分档逻辑保留，只是三个值一样。以后换模型只改配置、不改代码 |
| 汇率 | `MODEL_USD_CNY_RATE=7.2`，固定写在配置里 | 每次计费在账本里记下当时用的汇率 |
| 费用预估 | 按每轮输入 1 万 / 输出 3 千 token，再乘 2 倍余量（Q-025 已接受） | — |
| 数据库 / 认证 / 存储 / Vault | 本地用 Supabase CLI（`supabase start`）起完整一套，不只是裸 Postgres | Auth 注册触发器、Vault、Storage 的代码路径都要在本地真实跑过 |
| 账户容器 | 本地 Docker 跑同一个账户镜像，一个账户一个容器，一个具名卷 | provisioner 抽出一个「驱动」接口：现在用 `docker` 驱动，以后加 `fly` 驱动。上层代码不感知差异 |
| 长流程 | Hatchet 本地自托管（Docker），或在做到长流程时再接 | 等做到长流程任务时再定 |
| GPU | 暂不接 Modal | 需要 GPU 的自研任务只做提议，不实际执行 |
| 会员接入 | 暂不接 | — |

## 跑通之后再做（按大致顺序）

1. **云端部署**：Fly 东京 + Supabase 东京 staging（步骤见 [STAGING_SETUP.md](STAGING_SETUP.md)），包括：
   - 补做 P1-08 的「注册后 3 分钟可用」；
   - 真实 Auth / Vault / Storage 的复验；
   - 私网隔离；
   - 夜间快照的调度。
2. **模型分档**（2026-10-25 补充：澄清对话最影响体验、成本又极低，接上更强模型后，**第一个就把精读的澄清位置调到强档**）：
   - 中档：考虑换 DeepSeek V4 Pro；
   - 强档：用用户的会员。
3. **会员接入**，分两路：
   - ChatGPT Plus、GitHub Copilot：走 OpenScience 内置的登录，当模型用；
   - Claude Code Pro、Gemini 会员：只用官方命令行（`claude`、Gemini CLI）作外部执行器，在各人自己的容器里登录。
   - 不使用把会员转成 API 的第三方代理（违反服务条款，有封号风险）。
4. **多模态**：DeepSeek V4 Flash 不支持看图。凡是需要读图的场景（PDF 图表、OCR 验收数据 `infra/fixtures/ocr/`），先标为「待多模态模型」，到时接入一个视觉模型。
5. **Modal GPU**：按需接入，验收预算里的 GPU 30 分钟到时启用。
6. **上游功能请求**：给 OpenScience 提「运行接口支持指定 agent」，是否提交由用户决定。

## 对验收的影响

最终验收拆成两段：

- **本地验收（先做）**：按 [ACCEPTANCE_RESEARCH.md](ACCEPTANCE_RESEARCH.md) 执行，但有三处调整：
  - E3 改为「本地 Supabase CLI 全套 + 本地 Docker 账户容器」；
  - E6 只算 DeepSeek 费用，验收预算 ¥150 不变；
  - 依赖多模态或 GPU 的检查项，记为「待补验」，不判失败。
- **云端补验（后做）**：上面第 1、3、4、5 项做完后，在 staging 上复跑：
  - 准入条件 E3、E6；
  - 全部 SEC 和 CH 检查；
  - 本地阶段记为「待补验」的检查项。
