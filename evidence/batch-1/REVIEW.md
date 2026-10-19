# 第一批送审清单（非三期最终交付）

范围：P1-01～P1-08、P1-09的SPIKE-1/2及提前P2-01的SPIKE-3。已到本批停止点，未进入P1-10。所有实现均在独立工作树；原前端未提交改动保留。子agent均按GPT 6.1 Sol / medium完成并行测试与评审。

## 任务、证据与PR

| 任务 | 本批状态 | 证据 | Draft PR |
|---|---|---|---|
| P1-01 工作区/边界/CI | 本地及CI通过；既有无头脚本入口待提供 | ../P1-01/README.md | https://github.com/GuangjieYu1/ReinLab/pull/1 |
| P1-02 契约 | 本地及CI通过 | ../P1-02/README.md | https://github.com/GuangjieYu1/ReinLab/pull/2 |
| P1-03 迁移/RLS/角色 | 真实Postgres越权测试通过；Supabase专属能力待云复验 | ../P1-03/README.md | https://github.com/GuangjieYu1/ReinLab/pull/3 |
| P1-04 控制面/JWT/幂等 | 本地及CI通过；实际Supabase Auth待云复验 | ../P1-04/README.md | https://github.com/GuangjieYu1/ReinLab/pull/4 |
| P1-05 账本/SSE/审计 | 本地及CI通过 | ../P1-05/README.md | https://github.com/GuangjieYu1/ReinLab/pull/5 |
| P1-06 门禁 | 本地及CI通过 | ../P1-06/README.md | https://github.com/GuangjieYu1/ReinLab/pull/6 |
| P1-07 三维预算/预估 | 本地及CI通过；真实模型路由/汇率/账单待配置 | ../P1-07/README.md | https://github.com/GuangjieYu1/ReinLab/pull/7 |
| P1-08 镜像/provisioner/生命周期 | 本地实现与独立Linux真实容器7/7通过；**云DoD未完成** | ../P1-08/README.md | https://github.com/GuangjieYu1/ReinLab/pull/8 |
| P1-09 SPIKE-1/2 | 源码与真实npm二进制实验通过；**验收方确认待完成** | ../P1-09/README.md | https://github.com/GuangjieYu1/ReinLab/pull/9 |
| 提前P2-01 SPIKE-3 | 一次真实单场景生成与严格iframe交互通过；不是生产Provider | ../P2-01/README.md | https://github.com/GuangjieYu1/ReinLab/pull/10 |

每项单独分支、单独PR，按编号堆叠；PR1基于保存的ios/capacitor前端基线，后续逐项以上一项分支为base。未合并、未推main。最新分支codex/p2-01-openmaic-spike包含本批全部改动。

## 验证结果与证据界限

最终本地全仓657通过、0失败、0跳过，详见../P2-01/all-test-report.json；共享契约类型、控制面类型、依赖边界、VITE_BACKEND=mock构建通过（checks.json）。原前端测试包含在全仓套件中；这不代表尚未找到的既有无头脚本已通过。250份前端文件及原目录318份保存清单全部哈希一致（baseline-check.json）。常见密钥/JWT模式扫描未发现匹配，扫描范围与限制见secret-pattern-scan.json；未读取实际.env值。

P1-08真实原生运行时6项、独立Linux镜像/容器7项通过；不把协议fixture、本地PG或CI容器当作Fly/Supabase云验收。没有真实云项目，注册事件认证、夜间调度、Vault/Storage专属权限、新账户3分钟SLA还需完成部署和故障复验；可信函数/运维CLI不等于已部署Webhook/调度器。

SPIKE-3相关21项、独立评审通过；一次真实生成HTTP200/109252ms/HTML32426字节，内部模型调用次数及费用未知，均为null。没有保存完整原始HTTP JSON；响应形状来自当时处理观察与源码，不能凭HTML重造原始响应。独立数值测试的Node子进程支架不是不可信HTML安全沙盒；实际浏览器iframe仍仅allow-scripts。截图/该样本不代替生产T-SEC、引用核对或完整live链路。临时服务和测试页已关闭。

失败历史均保留：P1-07数据库清理故障、P1-08容器UID探针转义错误，以及SPIKE-3防重/保存红灯和独立测试node:vm边界拒绝；已修原因，不降低校验。每个任务README列有详细测试与独立评审。

## 三个SPIKE及待决定项

1. SPIKE-1：runtime.prompt硬编码research且拒绝agent，原default_agent回退不适用。推荐角色独立project覆写research定义；仅配置加载已实测，实际模型执行与隔离仍需P1-10以后验证。**Q-032需用户/Claude确认候选方案**。
2. SPIKE-2：优先识别AGENTS.md，其次CLAUDE.md/CONTEXT.md，并可能聚合全局和额外instructions。推荐过滤后的project AGENTS.md；文件目录不能充当执行沙盒。范围/上限细节见docs/spikes/SPIKE-2.md。
3. SPIKE-3：现有scene-content可直接单场景生成，推荐OpenMaicAnimProvider直连，无需课程适配。仍需后续正式鉴权、费用、引用上下文及HTML安全门禁。

待外部条件/决定：Q-005无头回归脚本入口；Q-006/012/029真实Fly与Supabase staging、Vault/Storage、注册/调度；Q-021模型路由及USD/CNY配置，Q-025预估政策可调整；Q-032角色别名方案确认。其余推荐和后续验证边界完整记录于docs/questions.md。无凭据需粘贴到聊天或证据。

## 复验命令

使用Node22、pnpm11.5.2，进入包含全部改动的独立工作树后：

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate:local
pnpm lint
pnpm test --reporter=json --outputFile=/tmp/reinlab-review-tests.json
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec tsc -p services/control/tsconfig.json
VITE_BACKEND=mock pnpm build
node services/account-runtime/verify-native.mjs
docker build -f infra/fly/account.Dockerfile -t reinlab-account:p1-08 .
node services/account-runtime/verify-container.mjs
node tooling/spikes/openscience-probe.mjs
node tooling/spikes/verify-upstream.mjs /Users/guangjieyu/Documents/DeepSeekPlugin/OpenScience
node tooling/spikes/openmaic-viewer.mjs
```

本机Docker Desktop新建/构建IPC故障仍存在，已有PG可用；新环境可走上述Docker命令或现有GitHub research工作流，不重启用户共享Docker。OpenScience探针只执行锁定npm二进制，上游目录仅核对源码摘要。OpenMAIC viewer只显示保存的真实HTML、不再次计费；交互验证结束自行关闭。需重验真实生成时先按用户现有部署方式安全启动服务，再查P2-01 README，必须显式指定新证据目录；不自动重试/覆盖旧证据。

云部署与维护前提/命令见infra/fly/README.md、docs/tasks/P1-08-lifecycle.md及P1-08证据。不把缺少项目的云步骤写成已执行。三期最终evidence/final/HANDOFF.md、ac-matrix.csv、deploy.md、cost-reconcile.csv留到三期完成后交付，本文件不代替最终验收。

本批最终代码CI：PR10/run39228020915，代码提交9bcded2da7660d0e7fdc1bab3deea3ed0f0bffa3，完整套件657/657及容器7/7均通过，artifact已下载并校验ZIP摘要（../P2-01/ci.json）。本清单由独立评审只读复核，与任务状态/报告/脚本一致；不消除上述云验收和方案确认待办。
