# P1-10 账户作用域观察调度

## ToSpec

本批只实现已认证账户的恢复：新运行显式提交、用户SSE/GET可调用recoverAccount(account)，进程重启后无人访问时的全局自动恢复不宣称完成；P1-13再引入全局长流程queue。无跨租户扫描、bypass角色、模型提交、自动批准或取消。

ObservationScheduler(access,sinkFactory,{maxConcurrent=4})：start(account,run)立即按账户+运行去重并排队，返回是否新排队；后台读取accepted binding、校验run仍在运行态且未ended，再取窄reader。observeRuntime仅收到原生session/run、reader、sink与AbortSignal。总并发有限；每项observer三连接上限结束后不在外层无限重启。recoverAccount仅查询本account RLS作用域run IDs并start；shutdown终止排队/活动项、await订阅退出，之后不接新项。

createObservationAccess(db,{runtime})在一次短DB事务校验binding完整性/作用域，SDK runtime构造和restore在事务之外；reader工厂唯一返回(await runtime(...)).reader()，不将prompt/decide/submit/cancel交给调度器。sinkFactory由root接ObservationStore的cursor/ingest/gap/failed/synchronize；本模块不改store/main/app。

## ToTDD

先stub red，再实现：同项去重、跨run并发上限、shutdown取消活动/排队且不记服务故障、仅本account恢复、拒不就绪/已结束binding、adapter真实PG/RLS和reader facet、普通失败稳定报告且无外层无限重连。普通测试只用read-port fixture；本批不声称全局无人值守恢复。

## 实现与验收

导出 ObservationScheduler、createObservationAccess、ObservationAccess/ObservationTarget/ObservationSinkFactory/ObservationSchedulerOptions。constructor最大并发1～32，默认4。start返回新排队boolean；recoverAccount返回新排队数；shutdown幂等且await全部活动订阅。reader adapter先RLS/hash复核，再事务外restore/runtime→reader，observer无mutation能力。后台异常仅报告固定OBSERVATION_SCHEDULER_FAILED，不写原始错误，也不包无限重试。

8项有效stub red（8 failed/0 passed）后实现，**8/8**；包含真实PG绑定/强制RLS/已结束排除与reader facet，及调度去重、并发、排队停机、恢复作用域、错误作用域拒绝、观察器重试上限。最终组合定向回归 **182/182**（decisions32、scheduler8、observer27、settlement31、旧budget34、mapping50）；control tsc、pnpm lint、diffcheck通过。

sinkFactory由root接ObservationStore，main/app接入不属于本子任务；全局无人访问自动恢复仍留待P1-13。本任务没有新增DB角色/全局队列/跨租户枚举。独立评审由root转交sourceaudit，作者不先声明独立通过。
