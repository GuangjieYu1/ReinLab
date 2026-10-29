> **第二次授权已消费：禁止再执行真实smoke CLI。** 第二次真实1/1成功、专用key核账¥0.002766/误差0%，见[报告](real-smoke-second-authorization/README.md)、[CSV](real-smoke-second-authorization/cost-reconcile.csv)、[账本](real-smoke-second-authorization/ledger.jsonl)。两次marker保留；第一次仍unknown/unpriced。最新代码36f854d无新增生产改动，最新CI在PR描述。下一步仅Claude关闭审查及用户凭据轮换处理，不进入P1-11。

> **最新停止点：第二次计划等待明确授权，普通复验禁止运行真实CLI。** B-6/B-7/B-8修复及1347/1347双版本回归见[thinking-fix](thinking-fix/README.md)，第二次使用独立固定目录，详见[计划](thinking-fix/SECOND_SMOKE_PLAN.md)。第一次旧marker不删除，旧入口仍拒绝再发。

> **本次真实授权已消费：禁止再执行smoke-local.ts。** 北京时间2026-10-22 02:31唯一真实转发返回400，usage未知、hold unpriced，临时配置清理成功；P1-10保持未关闭。最新证据见[真实执行](real-smoke-execution/README.md)。普通fixture回归不会读取真实key。

# P1-10 本批操作与复验（未关闭）

项目目标Node22，pnpm11.5.2；Node24只做兼容回归。以下普通up/verify/test/T-REG不调用真实模型。**真实smoke是独立显式命令，只允许root本次唯一一次执行；当前已执行且失败，不因本文件存在而授权任何人再跑。** 最终送审状态见 [README.md](README.md)。

## 本地up / 基础设施verify

在本工作树根目录，使用Node22：

```sh
pnpm install --frozen-lockfile
pnpm local:up
REINLAB_EVIDENCE_OUT=evidence/P1-10/local-infrastructure-recheck pnpm local:verify
```

macOS复用专属Colima `reinlab` profile，不切换/清理共享Docker。完整Supabase API54321、Studio54323；control health为127.0.0.1:3001/health，3002仅启动互斥。重复up只复用本任务已归属资源，未知/foreign资源拒绝。实际本轮报告local-infrastructure-final为9/9、两个applied镜像升级保具名卷与Vault envelope。

受保护setup/runtime/账户身份文件在仓库外的localPaths.state（默认`~/.local/state/reinlab/<工作目录摘要>/`），不要cat、上传、加入Git或复制到证据；HTTP不持管理员DB/JWT签名/service_role。应用ES256走JWKS。本地配置说明另见 [P1-08-local README](../P1-08-local/README.md)。

## Node22 / Node24全仓与静态检查

先确认本机fixture PG16在127.0.0.1:55432已按项目准备，勿把真实Supabase业务库用作单元测试。不要与另一套native全量并行。

```sh
# 先在PATH中选择Node22.23.3，核对版本后运行
node --version
pnpm --version
pnpm test --reporter=json --outputFile=/tmp/reinlab-p110-node22.json
pnpm lint
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec tsc -p services/control/tsconfig.json
VITE_BACKEND=mock pnpm build

# 切到Node24.14.1后，确认版本再运行兼容全仓
node --version
pnpm test --reporter=json --outputFile=/tmp/reinlab-p110-node24.json
```

本机Node22绝对bin为`/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin`；Node24按已安装版本显式选取，不将engine警告误当测试失败。中期修复后最新归档两版本均1284/1284、0失败/跳过，metadata见README链接。普通测试不要设置REINLAB_EVIDENCE_OUT，动态报告默认temp；显式归档才指定唯一输出目录。不要覆盖旧红灯或首PR归档。

## T-REG（mock，不是真实模型）

一个终端起自有端口前端，另一个终端跑原样runner：

```sh
VITE_BACKEND=mock pnpm dev --port 5198 --strictPort
REINLAB_URL=http://127.0.0.1:5198 E2E_OUT=/tmp/reinlab-p110-treg pnpm e2e:legacy
```

默认包括全部18场景；Playwright1.64.1已冻结依赖。环境无Chromium时按既定安装/已授权CHROME_PATH配置，不改场景找绿。当前18/18与全源字节一致报告在evidence/T-REG/baseline-refresh；大截图存仓库外，聚合报告/截图SHA与代表截图已归档。

## 真实冒烟：已执行失败，禁止重发

用户在第三批中期明确要求先确认计划，再执行唯一一次真实模型请求。具体时段、CNY价格来源、模型API别名、¥1上限与对账方法见 [SMOKE_PLAN.md](interim/SMOKE_PLAN.md)。用户无需填写UTC，Codex在获确认后核对官方价格与当前北京时间并生成执行参数。普通复验不执行smoke-local.ts。

早先real-smoke/只是一份前置失败：provider forwards=0、bytes=0、usage为空，原运行及unknown费用保留。B-1已用真实npm/本地fixture验证修复，但不是实际DeepSeek成功证明。新的admission.env保留新确认意图，旧identity.env及其失败RUN_KEY/RUN_ID不清除、不重发。付费唯一授权仍是相同私有目录的model-forwarded.marker；路径、O_EXCL、fsync、单次转发均不变。存在marker即停止，绝不删除或换state目录绕过。

本批修复已提交；当前唯一真实执行失败，非正式关闭。draft PR https://github.com/GuangjieYu1/ReinLab/pull/16 ，已知CI终态见 ci-terminal-index.json；最新head的完整终态也会更新到PR描述。本次失败材料及对账限制一并送Claude，P1-10保持未关闭，不进入P1-11。
