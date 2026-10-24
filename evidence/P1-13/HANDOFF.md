# 第六批交接：T-MCP-10失败，尚不能关闭批次

范围为E-1/E-4、Claude收件箱live适配、P1-13、用户授权的单次T-MCP-10。未修改主仓库，未修改OpenScience checkout，不推进后续批次。PR #19基于已审未合并的#18。

## 当前状态与证据

- E-1/E-4：原生输出移至.artifacts/account-runtime；缺失/不可执行必须失败，不跳过；CI强制，先web build再原生31/31。E-4仅恢复排版。见E-1/。
- 收件箱：按用户指定逐字节同步Claude四个inbox文件及三个场景，见inbox/claude-question-sync-hashes.json。question映射question/header/options/multiple/custom；answers二维数组原样交已有决定API；后端fresh snapshot/CAS/答案校验不变。当前无真实对话定位路由，source.href/evidence.href保持空。独立安全49/49，实际Auth/API/浏览器9/9，本地与CI19/19。见inbox/及ci/preflight-26e4940/。
- P1-13：固定Hatchet core/SDK、文件凭据、最小账户id发现角色、账户RLS对账，有限重放/持久游标；不重发prompt/批准。实际账户容器SIGKILL、worker在已证实检查点SIGKILL、控制面停止/无人HTTP访问时cron恢复9/9；事件无丢失/重复，未经批准文件不存在。见recovery/、sequence-comparison.csv、ledger.jsonl与独立评审。
- T-MCP-10：26e4940的push/PR全部10个CI检查成功后执行一次。预估503，实际模型0请求，原生papers/files/cards链路未发生；控制面恢复，清理0失败。Safari专用key账单0请求/0tokens/¥0.00，差额0。见T-MCP-10/。遵照“单次、失败不重试”，没有再次启动执行器。
- 503修复：单次执行器漏传文件价格配置，已提取createSmokeApp显式注入原PricingService；503 fixture复现后按原201合同通过，6/6；只读真实公共价格目录预估成功。没有用fixture冒充live，修复尚未真实重验。最终HEAD CI结果以PR #19 checks和Actions JSON为准，所有报告可复取。

## 复跑命令（fixture/本地基础设施）

Node22为主，Node24兼容；不要source真实key。单元/原生测试使用PostgreSQL55432；完整本地Supabase使用54321/54322。工具路径按本机配置调整。

```sh
unset DEEPSEEK_API_KEY
pnpm install --frozen-lockfile
node services/account-runtime/build.mjs
REINLAB_REQUIRE_NATIVE=1 pnpm test:native-after-build
REINLAB_REQUIRE_NATIVE=1 pnpm test --reporter=json --outputFile=test-report.json
pnpm lint
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec tsc -p services/control/tsconfig.json
pnpm exec tsc -p services/worker/tsconfig.json
python3 tooling/security/test-scan.py
python3 tooling/security/test-scan-p113.py
VITE_BACKEND=mock pnpm dev --port 5180
# 另一个终端
REINLAB_URL=http://127.0.0.1:5180 E2E_OUT=/tmp/reinlab-acceptance-treg pnpm e2e:legacy
```

```sh
unset DEEPSEEK_API_KEY
pnpm local:up
pnpm local:verify
pnpm local:hatchet
# 常驻恢复worker：无需用户HTTP访问触发
pnpm dev:worker
# 单独终端：仅模型fixture，实际账户机器/worker重启
pnpm exec tsx services/worker/scripts/verify-recovery.ts
# live数据适配浏览器验证（需VITE_BACKEND=live的5181前端）
pnpm exec tsx services/control/scripts/verify-inbox-live.ts
```

Actions检查与归档：[PR #19](https://github.com/GuangjieYu1/ReinLab/pull/19/checks)。调用前检查源提交26e49407ed56e138c6b2f5d9ce2205ce019c3834，run40116543409；最新修复提交检查附在同PR。每个check矩阵归档test-report.json/native-after-build-report.json；legacy-t-reg-summary单独归档原report.json，完整截图在legacy-t-reg，真实基础设施报告在local-infrastructure-test-report。不要把旧红灯或旧绿报告当成最新HEAD结果。

## 未完成、待决定与限制

1. **T-MCP-10未通过**。需要用户新的明确授权与新计划后才能真实复验；本批不重跑，不删除/替换旧私有状态来绕过单次约定。
2. 云端补验：Fly实机文件权限/生命周期、托管Supabase和staging；本地结果不替代云端。
3. Q-085/Q-093已由Claude和用户本次明确指令解决；没有真实对话路由时留空符合新接口。模型三档统一deepseek/deepseek-v4-flash，wire deepseek-flash，汇率7.2。
4. 进程审计仅覆盖可读的账户进程、Hatchet PID1与控制面；blocked数量如实保留。字节扫描只核选定实际值与JSON转义变体，不声称历史截图OCR/所有历史凭据均覆盖。
5. 全量早期容量超时红报告保留；worker上限4降至2仍并行，52次真实落盘测试单设30秒，断言未减少。源配置价格校验/引用核对/RLS/iframe沙盒均未放宽。
