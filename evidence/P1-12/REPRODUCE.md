# 复跑（无真实模型）

使用Node22；Node24重复全量时忽略package要求22的版本提示。不要source模型key或runtime.env；仅传受保护文件路径。所有命令在隔离工作树执行。

```sh
unset DEEPSEEK_API_KEY
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate:local
# Bun固定1.3.14，构建固定2.0.150原始源码+自有文件鉴权transport adapter
node services/account-runtime/build.mjs
pnpm test --reporter=json --outputFile=/tmp/reinlab-p112-repeat.json
pnpm lint
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec tsc -p services/control/tsconfig.json
python3 tooling/security/test-scan.py
VITE_BACKEND=mock pnpm build
VITE_BACKEND=live pnpm build
```

Vite build会清理dist；全量之前重新执行账户build。Vitest排除生成dist中附带的第三方上游Bun测试；本仓库源测试全部执行，无skip。

```sh
# 终端1：全程冻结前端文件，避免HMR干扰原样T-REG
VITE_BACKEND=mock pnpm dev --port 5180
# 终端2
REINLAB_URL=http://127.0.0.1:5180 E2E_OUT=/tmp/reinlab-p112-reg-repeat pnpm e2e:legacy
```

完整真实本地基础设施需要Docker Desktop或本任务Colima（4CPU/6GiB），用户无云项目不影响本地复跑。私有配置自动写入仓库外任务状态目录。

```sh
pnpm local:up
REINLAB_EVIDENCE_OUT=/tmp/reinlab-p112-local-repeat pnpm local:verify
# 对曾使用旧ENV形态的本任务4个账户，一次性维护入口；未知状态只对账，不盲目重做
pnpm exec tsx services/control/scripts/migrate-local-credentials.ts
# 已知e044e46预检拒绝的受限专用恢复仅在审计/proof全匹配时允许
# pnpm exec tsx services/control/scripts/migrate-local-credentials.ts --confirm-known-preflight-rejection
```

真实浏览器：另一终端 `VITE_BACKEND=live pnpm dev --port 5181`，然后 `pnpm exec tsx services/control/scripts/verify-inbox-live.ts`。需先local:verify生成真实Auth验证用户。脚本只人工录入审批/上线条目，不调用模型；登录表单清除后才截图，无HAR/trace/登录录像。`pnpm exec tsx services/control/scripts/audit-runtime-credentials.ts` 核对实际4账户可读ENV/日志与control ENV，blocked计数保留。

完整凭据扫描：`pnpm exec tsx services/control/scripts/prepare-credential-audit.ts`只输出仓库外受保护fixture路径/签名key路径/账户凭据目录，签发验证并吊销一个真实能力令牌，不调用模型。把这些**路径**传给`python3 tooling/security/scan-mcp-credentials.py --root <工作树绝对路径> --deepseek-file ~/.config/reinlab/local.env --signing-key-file <输出signing路径> --capability-fixture-file <输出file路径> --account-credential-root <输出credentialDirectory路径> --task-prefix reinlab-p112- --output /tmp/reinlab-p112-scan-repeat.json`。报告只计数；实际4账户时accountCredentialFiles必须4。私有fixture可在扫描后删除，不上传。运行CI的机器不需要真实模型key；只跑合成scanner测试。

CI含Node22/24、真实账户镜像、本地完整栈+真实浏览器、18个mock T-REG；Actions artifacts保存完整报告。无任何真实模型步骤。云端补验与T-MCP-10保持待验/待授权。
