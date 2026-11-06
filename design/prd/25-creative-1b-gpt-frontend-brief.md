# 25 · 创作台 1B 前端与验收 · 给 GPT 的开场

日期：2026-11-07。Claude 这周额度不够，1B 的前端和真实页面验收先交给你；下周 Claude 回来再验一遍。

## 先读

1. `AGENTS.md`：规矩，优先级最高。
2. `design/prd/19-creative.md` §5、§6、§11：1B 要做到什么。
3. `design/prd/20-creative-contract.md` §5：接口、类型、页面（§5.4 是小说面的布局）。
4. `design/walkthroughs/creative-1a/RESULTS.md`：1A 怎么验的，验收记录照这个格式写。
5. DSH 交付 1B 后会写一份前端开场，比如 `design/prd/26-creative-1b-frontend-brief.md`，里面是后端的实际形状和要避的坑。**以它为准。**

## 要做的

接小说面，代码放在 `src/components/workbenches/creative/live/`，照 1A 的写法来：
- 适配器加在 `src/data/creative-live.ts` 和 `live/adapter.ts`；
- 新组件放在 `live/` 下；
- 样式加进 `live/live.css`。

1A 的世界观面在 `LiveWorld.tsx`，小说面接在同一个 `BenchFrame` 的 `novel` 面上，把锁解开。具体要接：
- 作品列表、建作品（从世界观写 / 导入小说）、导入向导（上传或粘贴 → 看分章 → 开始，能暂停、续做）；
- 大纲确认卡；按场景生成，能停；AI 改动按差异显示，接受、改后接受、不要；
- 正文编辑：作者直接写的，停顿 2 秒后自动保存；按 `marks` 画实体下划线、红黄冲突、过期出处；
- 待确认清单：按批次、种类、疑点筛选；明确的项可以批量接受，每批不超过 40 条；有歧义的项单独处理，显示候选和原句；
- 「加人物」的经历提议卡；
- 和世界观面互相跳转；
- 导出。

**设置页（`design/prd/24-settings.md`）**：DSH 交付后端以后也由你接，入口放在左上角菜单。

## 怎么验（真实页面，像用户一样用）

- 本机栈已经在跑，不要另起实例：
  - 前端 http://127.0.0.1:5183
  - 控制面 :3001
  - 改了后端要重启时，用 `pnpm local:up22 --lan --real-models`
- 登录账户 B：凭据在 `~/.local/state/reinlab/803a04fcd69a/verification-users.env`（`B_EMAIL` / `B_PASSWORD`，shell 格式，用 source 读进来）。**不要打印，不要写进日志或聊天。** 切换账户之前先 `POST /backend/auth/lock`。
- 浏览器驱动：`scripts/walkthrough/driver.mjs`；Playwright 在 `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab/node_modules/playwright/index.mjs`。
- 按 19 §11 的 1B 验收一条条点：
  - 原创短篇：从想法 → 设定入账 → 大纲 → 按场景生成 → 续写、改写 → 正文的新事实抽回待确认 → 导出；
  - 加人物；
  - 导入《聊斋》选篇：抽取能回到原句；别名、共指、年号、古地名都有依据；拒绝的不会再冒出来；改了原文以后，旧出处标成过期。
- 判断标准是「意思到了」，不写固定脚本，不拿示例数据冒充真实结果。
- **花钱前先报预算**，按 `design/COST_LEDGER.md` 的经验值估；跑完以后追加一行明细。

## 交付

1. 能跑的命令。
2. `npx tsc --noEmit -p .` 不能新增报错；`npx vitest run src` 要通过。
3. `design/walkthroughs/creative-1b/RESULTS.md`：一张验收表（通 / 不通，断在哪），一节「给 DSH」，一节「前端本批」。和 1A 一样，写简短。

小问题直接修；后端的大问题写进「给 DSH」，不要自己大改后端。

## 不要做

- 不改世界观面、其他工作台的视觉和交互，不改契约 20 的接口和语义；要改就写一行 question。
- 不写审计类测试，不造模拟验收数据，不在前端推断冲突、路程、历法、版本。
- 不提交到 main：提交到 `codex/creative-1b` 上，用 `--no-gpg-sign`；要不要合并，由用户决定。
