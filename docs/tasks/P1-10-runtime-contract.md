# P1-10 Runtime 持久化翻译研究合同

状态：ToSpec 源码研究；以下“应/必须”为后续实现约束，**不是已实现或已完成验收的声明**。本次没有运行 OpenScience、模型、真实账户 API，也没有读取任何 secret/state 文件。

## 1. 版本与源码依据

- 本仓库真实包名为 **`@synsci/sdk`**，`services/control/package.json:16` 精确锁定 `2.0.150`，不是 `@syntsci/sdk`。导入入口为 `@synsci/sdk/v2`。
- 下文 `SDK/` 指绝对目录 `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab/node_modules/.pnpm/@synsci+sdk@2.0.150/node_modules/@synsci/sdk/dist/src/v2/`。
- 下文 `OS/` 指只读目录 `/Users/guangjieyu/Documents/DeepSeekPlugin/OpenScience/backend/cli/src/`；研究时仓库 HEAD 为 `539bff49900b302e3e96df8c50e1668fbd02228e`。这是本地源码依据，不是对 npm 二进制逐字节同源的证明。锁定 SDK 类型与以下核心接口一致；真实部署还应读 capabilities 检查协议和服务版本，不能由源码 HEAD 推断正在运行的服务版本。
- 当前 `services/control/src/bridge/openscience/role-runtime.ts` 只有 createSession/prompt/snapshot/messages/children；会话许可依赖内存 `Set`。下面的持久化恢复、subscribe/decide/cancel/翻译仍需实现，不能以现有包装器已支持它们为前提。

## 2. 锁定 SDK 的真实调用形状

创建客户端：`createOpenScienceClient({baseUrl,directory,headers:{Authorization:'Bearer …'}})`。`SDK/client.js:6–43` 设置 directory header 和默认 JSON Accept；默认 fetch 不提供应用级 deadline，调用方必须注入 signal。目录必须来自可信角色绑定，不能从观察/决定请求体中接受任意目录。

| 方法 | SDK 参数（第二参为 options） | 返回/HTTP与依据 |
| --- | --- | --- |
| `session.create` | `{directory,id?,parentID?,title?,permission?,workspace?:'isolated'|'project',workingRoot?}` | 默认 `{data,error,response,request}` 包装；200 Session。`SDK/gen/sdk.gen.d.ts:1173`、`SDK/gen/types.gen.d.ts:9146` |
| `runtime.prompt` | `{directory,sessionID,requestID?,messageID?,message?或parts?,effort:'normal'|'ultra',model?:{providerID,modelID},variant?,tier?,context?,delegation?,delegationSettings?}` | 202 `{runID,acceptedAt}`；404 session不存在；409有不同错误体。`SDK/gen/sdk.gen.d.ts:1547`、`types.gen.d.ts:10681` |
| `runtime.getRun` | `{directory,sessionID,runID}` | 200 durable RuntimeRun；404。`sdk.gen.d.ts:1602`、`types.gen.d.ts:10797` |
| `runtime.snapshot` | `{directory,sessionID}` | 200 RuntimeSnapshot；404。`sdk.gen.d.ts:1612`、`types.gen.d.ts:10820` |
| `runtime.replay` | `{directory,sessionID,afterSequence?}` | 200 `{events,oldestSequence,latestSequence}`；409 cursor JSON。`sdk.gen.d.ts:1621`、`types.gen.d.ts:10842` |
| `runtime.subscribe` | `{directory,sessionID,afterSequence?}`, `{signal,onSseError?,onSseEvent?,sseMaxRetryAttempts?,fetch?,…}` | `await` 得 **`{stream:AsyncGenerator}`**，再 `for await (const event of stream)`；不是 `.data`，也不等待连接成功才 resolve。`sdk.gen.d.ts:1631`、`gen/core/serverSentEvents.gen.js:1–129` |
| `runtime.decide` | **`{directory,runtimeDecisionInput:{…}}`** | 200 RuntimeDecisionResult；400 invalid_answer；409 decision_conflict/decision_expired。不能把 kind/requestID 直接放参数顶层。`sdk.gen.d.ts:1587`、`sdk.gen.js:2980–3000` |
| `runtime.cancel` | `{directory,sessionID,runID}` | 200 当前 durable RuntimeRun；404 session/run不存在。`sdk.gen.d.ts:1577`、`types.gen.d.ts:10729` |
| `runtime.capabilities` | `{directory}` | `{protocolVersion:'1.0',serverVersion,idempotentPrompts:true,richInputs:true,runSnapshots:true,eventRetention:2048,crashRecovery:'interrupt',decisionScope:'connected_runtime'}`；`OS/server/routes/runtime.ts:69–81,190–213` |

普通 HTTP 包装器在 `SDK/gen/client/client.gen.js:134–163` 解析失败 JSON 至 `.error`，保留 `.response.status`；默认不抛。不得把所有409都映射成同一幂等错误：prompt 的 `request_conflict`/`session_busy`、decision 的 `decision_conflict`/`decision_expired`、cursor 的两个错误语义不同。传输失败和超时是不确定提交结果，不表示服务端一定没执行。

### 2.1 Prompt 与收据

`OS/runtime/runs.ts:20–57`：输入严格对象，message 与 parts 必须且只能有一个；message trim 后1～1000000字符，requestID trim 后1～200字符；messageID 若提供，必须符合 `^msg_[0-9a-fA-F]{12}[A-Za-z0-9]{14}$`。SDK 的 string 类型没有替调用方完成这些校验。生产角色调用继续固定 `delegation:false`，只接收批准的文本输入，不能顺带开放 parts 中的 agent/subtask。

`RuntimeRun`（`SDK/gen/types.gen.d.ts:2407–2421`、`OS/runtime/runs.ts:46–61`）：

```ts
{runID,sessionID,requestID?,messageID,
 state:'accepted'|'running'|'completed'|'failed'|'cancelled'|'interrupted',
 acceptedAt,updatedAt,completedAt?,resultMessageID?,error?:{code,message}}
```

`OS/runtime/runs.ts:178–290` 用 session+requestID（未提供则 messageID）确定 runID，持久化规范化输入 fingerprint；同ID同内容返回原收据，异内容 ConflictError。先持久化收据才执行模型；`prompt:375–383` 仅首次 admission 启动 execute，replayed 不重启。**忙碌 session 的新请求可能作为 follow-up 加入现有 run**（199–246），返回同 runID；不能假定一个 requestID 必定对应独占新 run，也不能靠服务端忙碌409保证上层 run 隔离。控制面需在自身事务/租约中禁止非预期第二份工作加入同角色 session。

`getRun/list/reconcile:122–173` 的收据独立于2048条事件窗口。owner进程已死的 accepted/running 被标为 interrupted（`runtime_stopped`），不会自动重提。事件 journal 恢复时也可能产生 `runtime.failed {recovered:true}` 或有取消意图的 `runtime.cancelled {recovered:true}`（`OS/runtime/events.ts:436–472`）。观察器只查询/翻译；即便发现 interrupted、收据缺失或连接中断，也不得自动调用 prompt。

### 2.2 指定 session ID 与恢复

`OS/session/index.ts:231–254,369–458` 支持调用方指定 `id`；跨进程 FileLease 保护整个记录/工作区初始化。已有 ID 返回既有 session，校验 canonical directory 和显式 workspace 一致；**不会重新应用新的 title、parentID、permission、workingRoot，也不是对所有 create 参数做完整fingerprint冲突检测**。`OS/id/id.ts:18–43` 的 session ID 校验仅 startsWith('ses')，控制面应产生固定安全格式并持久化。

后续应先在数据库持久化 `(account,dossier,role,roleproject,sessionID,policy/version/hash)` 绑定，再用固定ID create；超时后仍用同ID读取/恢复，不随机创建第二个。恢复先核对已存绑定、目录/manifest/全局插件及必要 session filesystem grants；不能把调用方给的 sessionID加入内存Set即视为合法，也不能用 create 返回既有对象推断所有安全配置已吻合。进程重启不是新账户授权。

## 3. RuntimeEvent 的实际开放协议与当前全部可达类型

`OS/runtime/events.ts:15–24` 与 `SDK/gen/types.gen.d.ts:2463–2472`：

```ts
{sequence:number /*positive int*/,sessionID:string,runID:string,
 type:string,properties:Record<string,unknown>,time:number /*epoch ms*/}
```

**type 是开放字符串，properties没有discriminated union验证。** `OS/bus/index.ts:42–56` 把每次 Bus.publish 交给 journal；`OS/runtime/events.ts:706–750` 只捕获拥有活动 run 的 session 或后代事件：优先顶层 properties.sessionID；仅 message.updated 从 info.sessionID、message.part.updated 从 part.sessionID取值。根 journal envelope 的 sessionID/runID属于根 run，properties仍保留子 sessionID。因此不能把 envelope.sessionID无差别当成工具/决定真正的请求 sessionID。

以下是本次扫描原生 BusEvent 定义和 capture路径得到的 **26种当前已知可达 type**，不是从配置枚举推测出的协议。具体业务启用条件会决定某次 run 是否实际发出；未来增加type必须走未知分支。

| type | properties 的实际形状 | 定义/发出依据（OS/） |
| --- | --- | --- |
| runtime.accepted | `{acceptedAt,effort:'normal'|'ultra'}` | runtime/events.ts:447–458 |
| runtime.completed | `{messageID}` | runtime/events.ts:476–486 |
| runtime.failed | `{message,messageID?}`；恢复分支另有 `{recovered:true}` | runtime/events.ts:434–443,488–510 |
| runtime.cancelled | `{source:'user'|'runner_timeout',messageID?,recovered?:true}` | runtime/events.ts:434–443,540–546,668–680 |
| message.updated | `{info:UserMessage|AssistantMessage}` | session/message-v2.ts:505–572 |
| message.removed | `{sessionID,messageID}` | session/message-v2.ts:573–579 |
| message.part.updated | `{part:Part,delta?:string}` | session/message-v2.ts:580–586 |
| message.part.removed | `{sessionID,messageID,partID}` | session/message-v2.ts:587–594 |
| permission.asked | `{id,sessionID,permission,patterns:string[],metadata:record,always:string[],tool?:{messageID,callID}}` | permission/next.ts:168–188,210–211 |
| permission.cancelled | `{sessionID,requestID}` | permission/next.ts:212–218 |
| permission.replied | `{sessionID,requestID,reply:'once'|'session'|'project'|'always'|'reject'}` | permission/next.ts:190,219–227 |
| question.asked | `{id,sessionID,questions:[{question,header,options:[{label,description}],multiple?,custom?}],tool?:{messageID,callID}}` | question/index.ts:11–47,64 |
| question.replied | `{sessionID,requestID,answers:string[][]}` | question/index.ts:65–72 |
| question.cancelled | `{sessionID,requestID}` | question/index.ts:73–79 |
| question.rejected | `{sessionID,requestID}` | question/index.ts:80–86 |
| session.status | `{sessionID,status:{type:'idle'|'busy'|'compacting'}或{type:'retry',attempt,message,next}}` | session/status.ts:11–40 |
| session.idle | `{sessionID}`；已弃用但仍为已知事件 | session/status.ts:41–47 |
| session.diff | `{sessionID,diff:FileDiff[]}` | session/index.ts:215–221 |
| session.error | `{sessionID?,error:AssistantMessage.error}`；没有sessionID时不会进入本journal | session/index.ts:222–228 |
| session.filesystem.changed | `{sessionID,projectID,grant:{id,path,access:'read'|'write',scope,source,time},narrowing?}` | session/filesystem.ts:29–60,169–179 |
| session.context | `{sessionID,tokens:{system,text,reasoning,tool,skills,image,document?},images,total,budget?:{total,newest,history,usable,soft,hard}}` | session/telemetry.ts:101–128 |
| session.compaction | `{sessionID,trigger:'proactive'|'overflow'|'manual',mechanism:'prune'|'summary',before?,after?,reclaimed}` | session/telemetry.ts:131–143 |
| session.request.progress | `{sessionID,messageID,attempt,agent,providerID,modelID,phase,since,elapsedMs,retryAfterMs?,detail?,firstOutputMs?,lastOutputAt?,stalls}`，phase为preparing/connecting/waiting_first_token/streaming/conflict_wait/retry_wait/done/error | session/telemetry.ts:31–66,146 |
| session.compacted | `{sessionID}` | session/compaction.ts:30–37 |
| todo.updated | `{sessionID,todos:[{id,content,status,priority}]}` | session/todo.ts:8–27 |
| command.executed | `{name,sessionID,arguments,messageID}` | command/index.ts:28–38 |

不应误列为此runtime流必有事件：`session.created/updated/deleted` 的 sessionID只在 `info.id`，capture没有为这些类型解嵌套；`file.edited` 没有sessionID；experiment.*的session只在run/study等嵌套对象，capture也没有该路径。project/mcp/pty/server心跳等通常无合格sessionID，不因它们存在于SDK全局Event union就进入RuntimeEvent。SDK全局 `/event` 也不等于 `/runtime/events`。

### 3.1 Part/工具和文字

`SDK/gen/types.gen.d.ts:586` 的13种 Part为 `text,subtask,reasoning,file,tool,step-start,step-finish,snapshot,patch,agent,conversation,retry,compaction`。翻译层应对已知子类型逐种定义处理/有界记录或明确忽略原因，未知子类型和结构错误也进入 ledgererror。tool part (`SDK…types.gen.d.ts:480–489`) 为 `{id,sessionID,messageID,type:'tool',callID,tool,state,metadata?}`；state.status为 pending/running/completed/error，不存在原生 RuntimeEvent `tool.completed`。应从part状态翻译，并以part/callID去重。

文字/推理 delta通过 message.part.updated 发出。`OS/runtime/events.ts:322–367,729–737` 在50ms窗口内合并相邻同part文本/推理delta；session.request.progress相邻同message进度也可能被替换。因此事件数量不等于token数量，不能按delta条数计费。message.updated携带完整assistant对象也不能每次重加累计费用。

## 4. Cursor、SSE与持久化观察要求

- 每个根session独立递增sequence，保留最近2048条；replay返回严格 `sequence > afterSequence`。`OS/runtime/events.ts:770–786`：after小于oldest-1 => CursorExpired，after大于latest => CursorAhead；未给cursor取所有保留事件。刚好oldest-1有效。游标不能跨session、跨账户/数据根使用。
- `OS/server/routes/runtime.ts:16–32,276–298`：409体分别为 `{error:'cursor_expired',message,oldestSequence}`、`{error:'cursor_ahead',message,latestSequence}`。subscribe同样409；非法 Last-Event-ID为400 invalid_cursor。`Last-Event-ID`优先于查询afterSequence（317–328）。SSE `id=sequence,event=type,data=完整RuntimeEvent`；30秒heartbeat只是注释，无data、不产生typed event（346–376）。
- snapshot先取cursor再读runs/live pending（247–273），为竞态保留回放机会；subscribe先注册再回放并排队去重，闭合snapshot→live空隙（330–365）。消费方仍须对重放/断线去重，不能假设每个事件恰好一次到达。
- 锁定 SDK SSE 的陷阱：`SDK/gen/core/serverSentEvents.gen.js:5–20,33–36,92–123` 默认无限错误重连，HTTP409只变为普通 `Error('SSE failed: 409 …')`，不会保留JSON体；默认3秒指数回退、最大30秒，SDK内部lastEventId在yield前推进；正常EOF直接结束而不重连，onSseEvent为同步void回调、不await持久化。故不能把“await subscribe成功”当连接已建立，不能用异步onSseEvent提交ledger，也不能靠外层try/catch区分cursor409。
- 建议后续使用 `for await` 顺序消费；SDK重试有界（如sseMaxRetryAttempts:1），每次中断由控制面从**数据库已提交cursor**重建订阅。通过SDK options.fetch受控包装识别HTTP状态，或用replay先取得普通JSON409并在subscribe竞态409后重做snapshot/replay；处理时不要引入第二个业务HTTP实现。必须在onSseError记录失败信号，流静默结束也进入观察状态机。由控制面的abort停止stream；普通单次10秒HTTP超时不能原样用于永久SSE。
- 每事件的ledger写入、衍生状态更新、cursor checkpoint应处于同一数据库事务。键至少隔离account+role绑定+OS session+sequence；同键异内容不得覆盖。只有成功提交后推进cursor；重连/worker重启从已提交cursor恢复。unknown type、错误shape必须写 `kind:'error'` 的 **ledgererror**（本仓库 LedgerEvent kind没有字面量ledgererror，`packages/contracts/src/index.ts:30–35`），建议action `runtime_unknown_event`/`runtime_invalid_event`，保留有界脱敏type、来源ID、sequence、schema版本/摘要，绝不静默丢弃或猜成message。
- 未知事件处置建议：error及cursor在同事务提交，并将观察标为需核查，避免毒事件无界重复；不要据未知类型改变审批/终态/费用。不能仅更新cursor而无ledgererror；无法安全读取envelope时不伪造sequence。具体“核查后继续还是阻断”由实现规格固定，不让默认分支自行吞掉。
- cursor_expired必须生成缺口ledgererror并snapshot/getRun恢复**当前权威状态**，不能宣称补齐丢失历史。必要时用session.messages恢复有ID的最终parts/用量（去重），不重造缺失逐token事件。cursor_ahead意味着绑定/数据根/恢复异常，不能直接清零并当正常，须核对绑定和服务身份并留证。

## 5. Pending 决定及重启语义

`RuntimeDecisionInput`（`SDK/gen/types.gen.d.ts:2428–2443`，`OS/runtime/decisions.ts:15–43`）：

```ts
{sessionID,kind:'permission',requestID,reply:'once'|'session'|'project'|'always'|'reject',message?}
| {sessionID,kind:'question',requestID,answers:string[][]}
| {sessionID,kind:'question_reject',requestID}
```

结果 `{sessionID,requestID,status:'resolved'|'indeterminate',decidedAt}`。输入没有另一个decision操作ID；身份为sessionID+requestID，包含kind及答案的完整严格输入比较决定冲突。`OS/runtime/decisions.ts:72–137`：跨进程lease；先查持久收据，相同输入直接返回、异内容409；再查**当前进程**pending且精确sessionID/id匹配；先写indeterminate收据，再调用reply/reject，再写resolved。进程在任何中间点死去，旧indeterminate永久保持不确定，**重试同输入也只返回旧收据，不重复执行**。legacy端点可能抢先解决请求，applied=false也维持indeterminate。

pending不是可重建continuation：`OS/permission/next.ts:237–264`、`OS/question/index.ts:91–107,204` 保存内存pending，Instance.dispose/restart会清空并拒绝continuation；standing permission记录可持久化，但不是pending恢复。snapshot的decisionScope永远是 connected_runtime。历史 permission.asked/question.asked 只能用于审计/展示；只有fresh snapshot内仍存在的请求可操作。重连至另一活进程同样不能假定共享pending。

后续控制面应保存pending业务映射及决定意图；每次用户答复重新核对fresh snapshot，以真实request.sessionID提交（根snapshot可能包含后代请求）。无pending=>明确过期，不能从旧ledger重造后自动同意；resolved旧收据可显示已决，indeterminate显示待核查，不自动换新requestID或再次审批。question answers为按问题顺序的二维数组；源码额外校验数量、单选、重复项、custom=false的选项范围（decisions.ts:98–110）。

生产上游接口允许project/always，不代表角色边界允许新增长期授权。翻译/决定层必须继续限制产品批准范围，保持session-only filesystem grants和插件默认deny；观察器不得自动回复pending，更不得从工具文本提取“同意”执行决定。

## 6. 用量、价格与实际模型字段建议

真实可消费的用量在 `message.part.updated.properties.part.type==='step-finish'`，见 `OS/session/message-v2.ts:282–308`、`OS/session/processor.ts:1232–1271`、`SDK/gen/types.gen.d.ts:499–523`：

```ts
{id,sessionID,messageID,type:'step-finish',reason,snapshot?,tier?,
 usage?:{route:'managed'|'byok'|'chatgpt'|'subscription'|'local'|'custom',
         provider:string,model:string,time:number},
 cost:number,tokens:{input:number,output:number,reasoning:number,
                     cache:{read:number,write:number}}}
```

没有名为runtime.usage或model.usage的原生runtime事件。`OS/session/usage-logging.ts:19–57,240–311` 的内部model.response具nullable provider_response usage/cost，但进入自有本地遥测队列，并非Bus.publish，不能把它当RuntimeEvent数据源，也不应为此读取账户usage日志/密钥文件。

`OS/session/index.ts:744–865` 的getUsage会把缺失/非法计数归零、input分离cache read/write，output规范为**包括reasoning**，reasoning只作其子集显示；费用优先可用wallet/provider reported，再fallback模型目录估算，目录缺失可成为0。**step-finish的cost字段没有声明计费来源，0不能证明已知免费；即便非零也不能声称等于真实账单。** AssistantMessage.cost为累加值，tokens是当前step覆盖值（processor.ts:1251–1252），不能把它当run逐步累计tokens，也不能与step-finish同时双计。

建议持久化分层（字段名供设计，不是现存schema）：

| 字段组 | 建议 |
| --- | --- |
| 归属/幂等 | accountId/dossierId/roleId/businessRunId + OS sessionID/runID/messageID/partID/sequence；以step-finish partID作唯一usage来源，保存sourceVersion=2.0.150及receivedAt/providerTime |
| 请求模型 | 从批准的prompt绑定保存 requestedProviderId/requestedModelId/requestedTier/routeAlias；不要从响应猜请求配置 |
| 实际模型 | 优先step.usage.provider/model/route、step.tier；兼存assistant.providerID/modelID作为observed message声明，字段缺失为null；两者不同留来源，不覆盖用户指定路由名 |
| Token | 保存规范化input/output/reasoning/cacheRead/cacheWrite及source='openscience_normalized_step_finish'；总量按input+cacheRead+cacheWrite+output，不能再加reasoning。没有step的用量为null，不能用context预估、delta数量或request.progress代替实耗 |
| 上游费用 | upstreamReportedCost与source='openscience_computed_or_reported_unknown'单独保存；不标成provider invoice。币种依据上游计算路径为USD计算口径，但不代表账户真实账单原生币种 |
| 本产品价格 | priceSource/priceVersion或目录摘要/effectiveAt/billingCurrency，input/output/cacheRead/cacheWrite单价（每百万），unit/模型匹配/价格未知标志；原生CNY不可先当USD再乘汇率，按Q045保留请求与实际模型 |
| FX与账本 | 锁定当次usdCnyRate=7.2及来源/时间；使用decimal按本仓库ledger最多6位小数落costCny，不用浮点逐事件累积。缺任一可信价格/用量/币种证据保持costCny=null，保留unpriced原因；不要把归零/双零catalog当已核实免费 |

`services/control/src/ledger/index.ts:9–18,64–76` 当前costCny允许null、最多6小数且有幂等冲突保护。应在首次usage落账时冻结价格/FX，回放不能按新目录重算导致同dedupeKey内容冲突；更正费用采用明确的新调整事件，不改写原事件。角色/后代费用去重归属先依绑定再入账，不允许模型提供account/dossier/role字段。

## 7. 后续最小验收建议（尚未执行）

1. 纯fake SDK协议：验证decide嵌套body、subscribe的stream/错误/正常EOF、两类cursor409、Last-Event-ID、heartbeat不产ledger；unknown type和未知part shape确实产ledgererror。
2. 持久化事务：同sequence回放一次生效、异内容冲突、ledger提交失败不推进cursor、观察worker崩溃恢复不prompt；会话/角色绑定和cursor隔离。
3. 不确定结果：指定ID create响应丢失恢复同session；prompt原request同内容恢复原run、异内容409；服务重启只interrupted、不自动执行；新业务请求不能意外加入现有run。
4. pending：fresh snapshot存在才可决，根snapshot后代sessionID正确；resolved同答重放、异答冲突、indeterminate不重复执行、重启历史asked无pending时过期。scope不升级到project/global。
5. 用量：step-finish幂等、assistant更新不双计、推理不二次加到output、价格不明为null、请求/实际模型分开、FX和价目冻结。只在父任务明确授权的fixture阶段使用锁定内核+本地无真实key provider验证，不由观察器触发真实模型。

本合同不包含P1-11业务插件工具，不修改OpenScience上游，不扩大角色工具、文件、委派或长期授权权限。
