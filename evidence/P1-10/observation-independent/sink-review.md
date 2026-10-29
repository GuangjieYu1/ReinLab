# Observation sink 独立审查

当前有1项P2待修，不标最终通过。限定新增sink18+core3+原独立7+observer27真实PG/fixture独立55/55，sink-regression.json；随后新增晚到step独立8项7绿1红，late-step-red.json。未改production/原tests/迁移，无真实账户或模型操作。

P2：正常step→runtime.completed后费用已settled，新的顺序cursor priced step仍追加os_usage+cost ledger；独立结果usage2、ledger0.005600、run.spent0.002800。后续同终态finishTerminal因ended直接return，不能消除账差。应对已结束运行的新billable event明确拒绝/忽略或受控对账，不得继续落明细却不更新预算。本测试不强求错误码，允许拒绝或no-op，仅断言closed账一致。root已收到。

已核对：sink冻结且无prompt/decide；cursor仅读binding已提交值；snapshot严格核session/run/request及唯一匹配，latest不能回退，snapshot不推进cursor不造observation序号。only completed且无historygap/uncertain/消失pending才可已知结算；其他真实failed/cancelled/interrupted保持实际终态、未知hold。历史gap永久unknown，消失pending/indeterminate过期并interrupt非终态run，已有known-settled run的failed no-op。stable错误白名单去重、不存raw exception；同账户ledger→binding→run锁序，snapshot audit/hold/uncertain/state整体rollback，继发terminal矛盾拒绝。

这不替代pipeline原生集成；sink运行后未知observer异常仍不具备重新send权限。

## 晚到用量修复独立复核

P2已关闭，sink22+core3+独立8+observer27+scheduler8共68/68通过，late-step-final-green.json。旧事件dedupe仍先返回；ended后的新step-finish（含坏tokens）在任何写入前拒LATE_USAGE_AFTER_TERMINAL409，runtime.accepted也拒终态冲突，不再产生usage/ledger/spent失配。原late-step-red.json保留。限定sink最终通过。
