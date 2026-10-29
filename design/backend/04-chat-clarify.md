# 04 · 聊天式澄清

状态：按用户要求补充，待确认后实施；2026-10-27。依赖：[卡 03](03-bench-capability-compatibility.md)；关闭与重开遵循[卡 05](05-clarify-close-idempotency.md)。来源：[走查 C2/C3](../walkthroughs/2026-10-26-research-read/RESULTS.md)、[聊天式澄清决定](../RESEARCH_LIVE_FRONTEND.md#澄清改为聊天式用户-2026-10-26-定)。

## 1. 要解决什么
当前提示词仍要求按固定流程猜标题、检索并列候选，且多处保留 6 轮/512 token 限制。改成自然多轮对话，直到模型认为有可供用户选择的真实候选。

## 2. 定下来的决定
- 允许用自己的知识解释、引导、猜标题和追问；猜测明确标为待核实，不把用户的转述当已证实事实。可以先聊、不立即检索；需要时多次 papers.search，每次 limit≤8，沿用只读检索权限。
- 由模型决定何时发出 REINLAB_PAPER_PICK；控制面只核对候选，不按轮数或“检索成功”强制弹卡。最多 5 篇去重候选＋“都不是”，必须来自当前澄清 run 已持久化的真实检索结果；标题、作者、全文状态由服务端记录填充。可解释匹配理由，最终选择只由用户作出。
- 需要补充时用 REINLAB_CLARIFY 等待自由文本；clarify(text) 回答当前待定问题并接回同一 run，保留上下文。“都不是”是继续澄清，不触发关闭/取消；用户选定后结束澄清，正式精读另经预估和确认。只有明确“停止 / 换一篇 / 新建精读”走卡 05。
- 用卡 03 的声明发布 research@1.3.0：`interfaces.research_read={protocol:1,input:candidate,clarifyRole:research-clarify}`；该角色 `steps:20`、`model_cap:{output_tokens:8192,rounds:20,cny:0.5}`。每轮指一次模型调用，工具结果后的继续生成也计数；参数由冻结清单统一下发，不写版本分支或另一套提示词常量。
- 8192 是每次输出上限，20 是该澄清 run 的调用上限，¥0.5 是默认预算上限，不保证跑满 20 轮。按峰值费率计入输入与最大输出做调用前预留，不足即停；沿用已确认加预算入口，不自动加额或新建 run 绕过限制。用量未知照实显示，不能补零。
- 否决“每次回答都立即搜、搜到就弹卡”和“凭模型记忆直接填候选”：前者打断澄清，后者无法核对来源。

## 3. 改哪里
`benches/research.bench.yaml`、对应 release 与新版 clarify 提示词；复用卡 03 的 read-profile、model_cap 校验与网关限额。后端 `services/control/src/api/read-clarify.ts` 的 registerReadClarify/clarificationView 接同 run 续聊并移除固定 6 轮判断；`clarify/candidates.ts` 的 pickView/候选读取按 run 核对。`plugins/reinlab-os-plugin/clarify-model.js::humanQuestion` 保留模型发卡时机和服务端候选校验，不强制推荐首项；`src/data/read-live.ts::clarify` 沿用待回答 approvalId。新声明不静默升级旧档案，界面布局交互不改。

## 4. 接口
沿用 `POST /v1/dossiers/:id/read/clarify {text,approvalId?}` 与原 Idempotency-Key；有待答问题时回填决定，不创建第二个 run。REINLAB_CLARIFY 为自由文本问题；REINLAB_PAPER_PICK 的原生 options.label 为真实 paperId，服务端关联候选 id，用户经 `pick(pickId,candidateId)` 选定。沿用 user/agent/pick 事件及 `clarifySpentCny`、`clarifyUnknownCost`、`clarifyBlocked {reason:cap|stuck,text}`；澄清问题留在本对话，不推到全局收件箱。

## 5. 验收项
1. 真实输入「我听说 GPT 写了 700 多篇数学论文」→ 能自然追问或提出待核实线索，不把“700 多篇”直接当事实，也不硬套预设论文。
2. 回答追问、纠正线索 → 同一待定澄清 run 继续，记得前文；不因每条消息新增 run 或丢掉补充内容。
3. 对话尚需澄清 → 可以不检索、不弹候选；模型决定列候选时，每项均可对应本 run 的实际检索记录，未点击前没有选定项。
4. 点“都不是”再补充 → 能继续检索或追问；用户明确选择后才写 chosen，且不会自动下载或启动精读。
5. 查看新档案的冻结角色、原生参数和网关约束 → 都为每轮最多 8192、最多 20 轮、默认 ¥0.5；旧档案保持旧限额。
6. 在已授权真实运行中遇预算/轮数上限或待核用量 → 清楚说明原因，下一次付费调用被挡住；已知花费保留，未知不显示为 0。上限边界在现有相关测试补查，不为验收故意花满预算。

## 6. 不做的事
不扩展下载、文件写入或子 agent 权限，不代选、不编造检索结果，不实现正文追问，不清理历史 run，不重做前端；本卡只规定聊天式澄清及其现有接口接线。
