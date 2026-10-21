# P1-10 CR-3 只读 runtime 观察器

## ToSpec

`observeRuntime({reader: RuntimeObservationPort, sessionID, runID, signal, sink}): Promise<void>` 只持已绑定的读端口。sessionID/runID 是原生 runtime 的本次运行身份。无 SDK 第二实现、prompt、decide 或 cancel 能力。

导出 `ObservationSnapshot = Awaited<ReturnType<RuntimeObservationPort['snapshot']>>`，sink 接口为：

```ts
interface ObservationSink {
  cursor(): Promise<number>;
  ingest(raw: unknown, pendingSnapshot?: ObservationSnapshot): Promise<void>;
  gap(latest: number, reason: 'CURSOR_EXPIRED' | 'CURSOR_GAP'): Promise<void>;
  failed(code: string): Promise<void>;
  synchronize(snapshot: ObservationSnapshot): Promise<void>;
}
```

每次连接先读取 snapshot，随后从 DB 已提交 cursor 回放，逐条 await ingest（携带 snapshot 供真实 pending 核对），再从重新读取的已提交 cursor 订阅 SSE。snapshot 本身不得移动 cursor。replay 后 synchronize 由 sink 独立记录快照来源、pending 消失及恢复中断；不能造历史 eventsequence。sink 会验证本次 binding 的 request 身份。观察器只对匹配 session/run 的真实 terminal 停止，不因其他运行结束而停止。

EOF/普通读错误最多总共连接3次，退避500ms/1000ms，重连必须重新 snapshot/replay；不自动提交 prompt。CURSOR_EXPIRED 无论来自 replay 或 SSE，都读取新 snapshot，再 await gap(latest,'CURSOR_EXPIRED')：只有 sink.gap 的事务可以记录真实缺口/error/未知费并移动 DB cursor。随后 synchronize 并从提交后的游标重连，不造历史事件。CURSOR_AHEAD 调用 failed('CURSOR_AHEAD')并停止，禁止回退 cursor。达到重试上限仅持久化稳定码，不保存原错误文本。

terminal event 必须先 await ingest 成功再停止；snapshot 已有匹配本次 session/run 的 terminal 且 replay 没有 terminal 时，synchronize 当前状态并停止。signal abort 是正常退出，不记服务故障；退避也可 abort。sink 故障不冒充网络断线重放，直接稳定失败。普通测试使用读端口与 sink fixture，不声称真实内核/数据库集成验证；root 负责最终 native+DB integration。

## ToTDD

先落空实现 red，再实现：顺序与提交游标、backpressure、恢复回放/两次退避/三次上限、replay及SSE过期、cursor ahead、匹配与非匹配终态、snapshot终态来源、sink失败、abort预取消/等待期间取消。测试不得依赖真实模型或 SDK。

## 验收结果

空实现 red：17 failed/1 passed；实现首轮18/18。补充 replay/SSE 的 permission/question asked 前 fresh snapshot（同步也使用最近快照）、gap快照不能倒退已提交游标、同run异session不得视终态、非法session快照稳定拒绝，以及ingest后abort，合计 **25/25**。sink持久化故障以 `OBSERVATION_SINK_FAILED` 稳定拒绝，不自动重放原事务。快照结构/作用域失败为 `OS_OBSERVATION_INVALID`。未知读错误仅记录 `OS_UNAVAILABLE`。

Node22 的 pnpm lint、control tsc、diffcheck通过。组合定向回归含observer、settlement、既有budget和mapping；精确计数及命令见本次证据README。独立审查已请求，作者报告不预先声明通过。

root确认后补充：可信sink.ingest抛CURSOR_GAP/CURSOR_EXPIRED时，按同样freshsnapshot→sink.gap事务→synchronize恢复；其他sink错误不重试。最终27/27，独立27/27通过。
