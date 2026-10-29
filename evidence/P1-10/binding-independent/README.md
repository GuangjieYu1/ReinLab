# BindingStore 独立评审与真实fixture PG边界测试

结论：**004修复后通过本模块审查，未见剩余P1/P2。** 当前只持久化DB绑定，不代表service/真实模型接线已完成。本人未修改生产store或migration；只新增independent-binding-store.test.ts与本目录证据。独立测试直接SQL探针始终finally rollback，包括首次意外成功，不留下坏binding。

首轮first-report.json：独立9项8通过/1有效失败。发现应用角色能插入与父run request不一致的binding；003只绑account/dossier/run，未绑logical role/request，也未校验role_options dossier。已通知父任务；父任务新增004_binding_identity迁移，未篡改已应用003摘要。plugin版本hash固定路径的早期拼写也已确认在当前store修正为file:///opt/reinlab/plugin/index.js。

修复后green-report.json：Node22.23.3，独立11项 + 作者3项，**14/14通过**。独立文件strict tsc通过。原有效red保留。

## 独立覆盖

- 8并发同内容prepare仅1binding/1session，run.os_session_id与binding一致；两份不同内容并发1成功/1冲突。
- 8并发claim仅1成功；过期lease可换新token，旧baseline/send CAS均拒绝，新token只发送一次意图。
- submitting在新store实例与过期时间后仍不能claim；receipt只解析一次发送意图，同收据幂等、异收据冲突，accepted不能重claim。
- foreign账户get/prepare/claim/baseline/send/receipt均遵循既有RLS隐藏404（RLS_DENIED）；SQL读取/更新0行，应用角色DELETE/TRUNCATE无权限。
- account/dossier/run/logicalRole/request/session/roleOptions/definitionHash/message/inputHash十项不可变字段逐个拒绝更新，原整行不变；cursor不得回退、send fence不得退回preparing、已接受receipt不得重写。
- 同账户同request不能变成另一个run（父run唯一约束），另一账户可用同request而不共用session。
- 004新增身份约束独立分拆验证：错request期待23503、错logicalRole拒绝、role_options dossier与父run不符期待23514。所有直接INSERT探针rollback。

## 复验

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:$PATH
pnpm exec vitest run services/control/test/independent-binding-store.test.ts services/control/test/binding-store.test.ts --reporter=default --reporter=json --outputFile=evidence/P1-10/binding-independent/green-report.json
```

使用既有127.0.0.1:55432/reinlab_test及受RLS应用角色，或显式TEST_DATABASE_URL/TEST_DATABASE_URL_APP；不访问真实账户容器、模型、secret/state，不操作生产资源。测试默认不写证据，JSON由上述显式命令指定。

边界：holdId字段当前只是预留单列FK，store尚无设置/结算方法；预算hold归属及不可变性须在后续service计价接线时一并核验，不能据本模块审查推断已完成跨run预算身份验收。
