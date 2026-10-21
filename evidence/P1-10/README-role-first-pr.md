# P1-10 首个PR：角色边界前置验收

范围只含T-ROLE-1～5及最小角色project生成器、SDK提交/观察封装、原生工具安全补闸。此PR不是P1-10整体完成；不会继续其余事件映射/审批回填/费用/记忆服务/前端live接线。用户/Claude批准决定见docs/spikes/SPIKE-1-decision.md，主仓库审查文件已原样收录。

## 结果与证据

- 最终Node22全仓714通过/0失败/0跳过，all-test-report.json；本PR相关34/34，test-report.json。
- 原生核心9/9：native-test-report.json/native-test.md/native-test.json；实际npm OpenScience2.0.150＋仅测试loopback OpenAI-compatible fixture，不执行上游源码或真实模型。model-requests.json保存T1实际HTTP messages/tools样本，已移除临时路径，不含认证请求头或密钥。
- 独立攻击9/9：independent-test.md/json；另独立评审复跑模型回合篡改与FIFO两例2/2，review.md。
- 两个桥接TS模块行覆盖62/62、100%，语句96%/分支89.28%，coverage目录与coverage-test-report.json。此覆盖不冒充Bun内核或整个插件覆盖；插件使用原生执行与直接特殊文件回归。
- lint、contracts/control类型、VITE_BACKEND=mock构建通过，checks.json。250个前端文件及原目录318份清单不变，中期审查复制字节相同，baseline-check.json。常见密钥模式扫描范围/限制见secret-pattern-scan.json，0命中。

T-ROLE-1：同档案alpha/beta不同project，真正发给provider的system包含自己prompt及AGENTS快照、不含另一角色；不能只看/agent。

T-ROLE-2：先正向读取当前档案，再证明其他档案/其他role AGENTS/文件与目录symlink/多硬链接均不可泄漏。额外人为给该session添加外档案及其他role的read grant，仍被path规则与插件拦截。AGENTS在提交前换链会拒绝；模型回合间换链也在下次provider HTTP之前拒绝，review-toctou.json实际hook日志与非空首回合断言为证。role目录是控制面独占的三个普通单链接管理文件，拒绝额外配置与配置引用展开。

T-ROLE-3：上游默认*allow被生成定义最终*deny覆盖。fixture无视offered tools强行请求bash/write/webfetch/todowrite，没有文件/observer/成功执行。编辑别名必须先成功read，再强制未经授权edit，证明拒绝不依赖FileTime前置条件；正向授权write/edit与精确write_targets另有独立原生证明。

T-ROLE-4：内部delegation=true，task仍不可委派，children为空；桥接拒绝显式parts.subtask/agent/model/directory等额外字段，不走上游显式委派旁路。

T-ROLE-5：真实runtime同requestID同内容返回原runID/acceptedAt，provider请求不增加；异内容409映射IDEMPOTENCY_CONFLICT。SDK有deadline、未知结果不自动重提，真实HTTP stall证明只提交一次且编号不变。

## 红灯与修复历史

project-red.json/red-test-report.json为最初模块缺失红灯；config-injection-red.json与reference-injection-red.json为配置入口和{file:}/{env:}展开负例。review-toctou-red-system.json保留运行中跨角色泄漏的测试sentinel；review-toctou.json是修复后实际全局hook阻断证据。独立hardlink、先read后的edit别名及stall红灯发现/修复详见independent-test.md及review.md，未删除发现来制造全绿。

最初fixture仅在project配置注册插件，sandbox开启时上游会跳过，导致插件相关证明无效。现已复现原有account-entrypoint的可信全局注册；角色配置不注册project plugin，桥接创建/提交前核验全局精确URL，缺失失败关闭。**没有关闭sandbox或切换full模式。** 当前档案read及精确写目标只用session scope授权，不回答pending permission或授予project/installation范围。

## 复验

Node22、pnpm11.5.2，Postgres本地测试实例按既有说明初始化后：

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run services/control/test/role-project.test.ts services/control/test/role-runtime.test.ts services/control/test/independent-role.test.ts services/control/test/role-system-race.test.ts services/control/test/role-special-file.test.ts
node --import tsx services/control/test/fixtures/review-toctou.ts
pnpm test --reporter=json --outputFile=/tmp/reinlab-p110-all.json
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json
pnpm exec tsc -p packages/contracts/tsconfig.json
VITE_BACKEND=mock pnpm build
```

每个原生fixture独立临时HOME/XDG/config/data/cache、随机端口、环境白名单，只启锁定npm二进制、回环fixture provider和可信自有插件；停止自己的进程组并清理临时目录。默认插件、自动更新、模型目录抓取、Claude注入、LSP下载均关闭。真实模型请求数0，实际模型费用0；fixture的usage不进入live费用账本。

本PR是后端契约/隔离集成测试，不是ReinLab业务T-E2E；未接业务账本和UI，不伪造ledger-export或界面截图。安全边界按受控role目录和已授权工具定义，不把同UID恶意宿主进程的任意并发换文件、所有内核工具或已复制文件的来源审计称为已验。完整记忆read_scope、其他翻译层、真实模型费用、Fly/Supabase云端都留在后续明确范围，云状态继续待补验。

## CI

实现提交 `df7a3bcd745904eb427d3ba94498c51ffa20d966` 的 [Research foundation #35](https://github.com/GuangjieYu1/ReinLab/actions/runs/39277895313) 已返回 completed/success。下载产物的全量测试为714/714，真实Linux账户容器检查为7/7，报告分别为ci-test-report.json、ci-container-test-report.json。ci.json保存run、head、artifact编号及下载ZIP摘要校验记录；临时签名下载地址未留存。单job状态查询曾滞后于工作流最终结果，该差异也已记录。

D-1最终提交4400385的CI #39238145035亦已成功。本次追加仅补证据，十个实现/测试文件摘要重新核对全部一致；最终证据提交的CI另在同一PR核对，不将前一提交的状态冒充后一提交。
