# 第六批交接（恢复进行中，等待最新CI与单次真实链路）

范围：E-1/E-4、Claude 收件箱 live 数据适配、P1-13、已授权单次 T-MCP-10。不进入后续批次。PR #19 基于已审但尚未合并的 #18；未修改主仓库或自动合并。

| 项目 | 当前证据 |
|---|---|
| E-1/E-4 | E-1/；web 构建后原生31通过、0失败、0跳过；缺失二进制红灯与CI强制要求均保留 |
| 收件箱 | inbox/；逐文件哈希、19场景报告、实际Auth/API/浏览器9项与截图、账本、安全评审 |
| P1-13 | recovery/；最终配置真实混沌9项、检查点中杀worker、无人访问主动恢复、ledger.jsonl、sequence-comparison.csv |
| 安全与迁移 | recovery/independent-security.md、runtime-credential-audit.json、credential-prepush-scan.json；所有秘密只在私有文件/进程内存，进程可读范围明确记录 |
| T-MCP-10 | T-MCP-10/；计划/守卫准备完成，尚未执行；预算≤¥1、唯一工作流、失败不重试 |
| 最终 CI | a7737ab：4成功/1失败，legacy为17通过2失败；见ci/preflight-a7737/status.json |

本地已通过 Node22/24 全量各1498项；其后增加响应反射安全用例，a7737ab的CI两版均1506通过、0失败、0跳过。五文件守卫/证据定向31项通过。历史全量容量超时的红报告保留；只将并行worker上限4降至2，52次真实写盘的保留版本测试单独设30秒，全部断言保持。

## 复跑命令

Node22为主版本，Node24兼容验证；测试前确保环境没有自动导出的真实key。不要source私有配置。

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
VITE_BACKEND=mock pnpm dev
# 另开终端，运行全部原样19场景
pnpm e2e:legacy
```

全量单元/原生测试需现有测试PostgreSQL 55432。完整本地链路另用私有配置管理的Supabase 54321/54322和Docker，互不替代：

```sh
unset DEEPSEEK_API_KEY
pnpm local:up
pnpm local:verify
pnpm local:hatchet
# 常驻生产骨架；不要求用户访问HTTP才能发现账户
pnpm dev:worker
# 独立终端运行真实机器/worker重启验证，只使用模型fixture
pnpm exec tsx services/worker/scripts/verify-recovery.ts
```

真实冒烟执行器不加入CI，单次授权被消费后不可复跑、删除marker或更换requestID规避围栏。验收复跑使用fixture；真实报告和账单只读核对。诊断日志/原始配置不得直接打印。

## 待办与边界

- 云端补验：Fly实机文件权限/生命周期、托管Supabase与staging；没有云环境，不标完成。
- Q-085：Claude的InboxAdapter暂未定义question答案与来源跳转接口，数据层保持拒绝无答案批准；后续由Claude决定接口扩展，当前不改组件样式和交互。
- 币种人民币，模型三档统一deepseek/deepseek-v4-flash，wire别名deepseek-flash，汇率7.2。日期窗口及计价来源见T-MCP-10/PLAN.md。

## 本轮停止原因与下一步

CI的trip进入19帧、trip-en进入15帧，原要求至少20帧；返回均77帧，原要求至少15帧。此为现有场景红灯，尚未证明是CI图形性能或前端行为差异。按用户明确的非live回归停止条件暂停，等待Claude/用户确定仅改善CI执行环境的处理范围；前端和19场景均不修改，不靠放宽帧数断言交付。唯一真实冒烟尚未执行，admission目录不存在，当前专用key当日基线0请求/0tokens/¥0.00。

完整CI report.json和截图位于[legacy artifact](https://github.com/GuangjieYu1/ReinLab/actions/runs/40109294202/artifacts/12566037887)；连接器下载本次未返回文件URI，本地保存了完整原始job日志、作业终态及失败参数，没有伪造完整report.json。CI全量报告和真实基础设施报告已保存。

## 用户确认恢复（2026-10-25）

Claude已修转场与question UI；用户指定七文件原样同步，哈希见inbox/claude-question-sync-hashes.json。question映射与答案保真已补齐，安全49/49、真实本地收件箱9/9通过。旧暂停原因仅作历史记录；本轮全量19场景和CI进行中，成功后执行原单次冒烟授权。为避免完整截图归档过大无法取出JSON，CI另上传原report.json小归档，不改任何场景或断言。
