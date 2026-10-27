# 03 · 清单能力与发布版本解耦

状态：用户已确认；2026-10-27。实施顺序：02 → 01 → 03。来源：[走查 S2/S3 版本回归](../walkthroughs/2026-10-26-research-read/RESULTS.md)。

## 1. 要解决什么
版本白名单散在估算、澄清、令牌、网关等至少七处；新版本可能被拒，也可能跳过引用核对。前端的“≥1.2 就兼容”也会误接未来不兼容协议。

## 2. 定下来的决定
- 清单 version 只标识不可变发布内容、档案钉版和回放。业务按一个 `resolveReadProfile(effective,catalog)` 的结果执行；不能用版本大小或列表决定权限、模型上限、是否核对引用。
- 新清单声明 `interfaces.research_read:{protocol:1,input:candidate|paper_id,clarifyRole:string|null}`；解析器校验对应入口、角色、能力/契约确实存在。未知 protocol 返回 BENCH_PROTOCOL_UNSUPPORTED；声明缺失不默认为最新版。
- 已发布旧清单不改内容/摘要：只在该解析器里按已存在的角色及能力结构适配旧行为，无法识别则标 unsupported；不在调用点继续猜版本。结果在 run 创建时存入不可变 run_harness，恢复时读原快照。
- 模型轮数、输出和预算统一取该 run 冻结角色的 steps/model_cap，再与账户余额和用户预算取严值；schema 改为有界数值校验，不枚举 256/512。已定的 8192/20/¥0.5 由新清单表达，不靠版本分支。
- 引用核对属于工具实现的不变量：所有相关 cards 写入均调用 verifyCardSources，不因版本未知跳过。令牌仍核账户/run/摘要/受众/授权范围，功能声明本身不授予工具权限。
- 否决“每次发版补七个列表”和“所有 ≥1.2 自动兼容”：前者漏改，后者把发布号误当协议承诺。

## 3. 改哪里
新增 `harness/read-profile.ts`；`packages/contracts/src/bench.ts`、清单/release 增加接口声明。统一替换 `api/{app,budget,read-clarify}.ts`、`clarify/model.ts`、`mcp/token.ts`、`model/gateway.ts`、`bridge/openscience/run-definition.ts` 的版本分支，并检查 `mcp/{engine,data-handlers}.ts`。`harness/manifest.ts` 按合法 id@version 精确读 release，缺失即报错；`provisioner/local-bootstrap.ts` 发现并发布 release 文件，不列固定版本。新增 run_harness 字段迁移；旧行只读适配，不能改旧摘要或放宽限额。

## 4. 接口
`GET /v1/dossiers/:id/harness?view=read` 保留 version/digest，新增 `read:{supported,protocol,inputMode,clarifyRole,modelCap,reason}`。前端 `read-live.ts::estimate` 按 inputMode 带 candidateId 或 paperId；后端独立核对相同 profile 与选定状态。Claude 接字段，界面布局交互不改。协议不支持时禁止启动并给出原因；未批准不升级旧档案。

## 5. 验收项
1. 发布结构兼容的新 research 版本 → 不改任何业务版本列表，澄清→选择→预估→确认可通。
2. 新清单配置 8192/20/¥0.5 → 角色、网关和数据库预算约束读取相同冻结上限；超过仍拒绝。
3. 打开已钉 1.1/1.2 的档案，再重启恢复旧 run → 仍按原接口、权限和上限执行，不静默升级。
4. 请求不存在的 release 或未知 protocol → 明确拒绝；不能退回当前清单，也不能按“版本更大”放行。
5. 新发布版本下提交无效原文引用 → 仍拒绝；相同版本但内容改变发布失败。
6. 查本卡列出的入口 → 无业务版本白名单/semver授权分支，前后端采用同一 profile；验证 run 创建后改清单不影响它。

## 6. 不做的事
不改用户选择、不自动升级档案、不建设通用插件版本框架、不更改未知费用处理；与卡 02 分开实现、分别复验。
