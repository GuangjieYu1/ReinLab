# 第二次授权：真实模型冒烟成功，专用key账单对平

用户明确确认SECOND_SMOKE_PLAN.md后，在北京时间2026-10-22 03:19执行一次。执行源码36f854d，push/PR CI均completed/success。先在后台筛选ReinLab专用key并导出零用量基线，通过宿主受保护配置与可见遮盖标识的布尔比对确认对应，不保存key值。

- **真实模型1次，运行completed，回复“链路已通”。** 真实Auth→HTTP确认→默认生产Pipeline→npm OpenScience2.0.150 SDK→严格单次守卫→DeepSeek→持久观察→账本→预算结算。未注入fixture/model transport。
- 输入2754、输出3、cacheRead0、reasoning0；按确认的CNY空闲价格，账本费用**¥0.002766**，小于¥1；hold settled，usage_uncertain=false。产品路由deepseek/deepseek-v4-flash，SDK配置API别名deepseek-flash；账本actualModel为上游返回的逻辑deepseek-v4-flash，不能据此伪改成API wire id。
- 新requestID与第一次不同，见execution-summary.json。新marker已消费保留；第一次marker和失败运行/unknown费用未改变。没有追加请求；临时auth/config清理成功。
- real-smoke.json为脚本wx写入的原始证据，providerInvoiceReconciled=false代表采集当时尚未后台核账，不事后覆盖原始报告。后台结果将另附billing-reconciliation.json与cost-reconcile.csv。
- ledger.jsonl为全部真实账本事件的逐条导出。authorization-and-baseline.json记录第二次授权、CI、空闲窗口与专用key零用量基线；原始后台ZIP留仓库外0600，仅SHA和必要脱敏本次结果入库。

本次成功是模型运行链路成功，P1-10仍须后台核对、最新CI和Claude关闭审查。未进入P1-11，云端为云端补验。

## 凭据事件说明

首次进入Safari时，前台为用户尚未关闭的新key创建弹窗，初始工具AX响应自动包含敏感明文。未复制至仓库/业务日志/账本/证据；本说明不包含值或片段。但对话工具输出已包含敏感内容，因此不能宣称本轮全程未暴露凭据。已向用户说明，建议核账后由用户轮换；后续AX返回前遮盖key形态。此事件交审查方如实评估，不以成功运行替代凭据安全要求。

## 专用key后台对账完成

北京时间03:24:44（提供方完成后约323秒）刷新，确认筛选仍为ReinLab：1请求、2757tokens。导出明细显示未命中输入2754、输出3，费用¥0.002766；与账本完全一致，误差0%，低于¥1。后台零基线到本次只有该key的一次调用，可单独归因。见billing-reconciliation.json与cost-reconcile.csv。总计13项运行/账单核对通过，0失败（success-checks.json）。

原始real-smoke.json、业务用量元数据和账本事件仍保留采集时providerInvoiceReconciled=false，未回写篡改历史；实际对账结论在独立报告明确标true，业务结算本身已settled。这两类时间快照不混用。

原始ZIP与截图仅在本机仓库外0600目录，不上传含账号其他财务信息的原图。验收方可按billing-reconciliation.json给出的本机绝对路径读取截图并核SHA-256；CSV原始文件在同目录before.zip/after.zip。账本导出33事件随本任务证据入库。前端/legacy未更动，既有T-REG截图证明的是mock交互，不能当成这次真实模型回复证明。

本次源码未变化；两版本各1347/1347与独立安全35/35结果沿用36f854d已归档报告。最新证据提交的CI终态见PR #16描述，之后交Claude关闭审查；凭据工具输出事件亦须评估，不能因对账成功忽略。P1-10不自行宣布验收通过，P1-11未启动，云端补验未完成。
