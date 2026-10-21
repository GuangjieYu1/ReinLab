> 用户随后已明确授权并执行本计划：真实转发1、回复“链路已通”、费用¥0.002766、专用key后台误差0%。授权已用尽，不得依据本文重跑。执行与事件说明见../real-smoke-second-authorization/README.md。以下保留原计划正文及当时的待确认状态。

# 第二次授权：真实冒烟计划（已确认并执行成功）

**本文件是第二次冒烟的待确认计划，不是第二次授权本身。本轮真实模型请求0；不得因key已更换、代码修复或CI变绿自动执行。P1-10尚未关闭。**

## 前提与本次限制

用户已确认换成ReinLab专用DeepSeek key，仍在权限600的~/.config/reinlab/local.env中，变量DEEPSEEK_API_KEY。本轮仅stat检查文件权限，未读取其值。执行时只由宿主守卫读入内存；账户容器仍只拿随机临时token，任何证据/日志不保存key。执行前须再次确认最新提交的push和PR CI全绿，以及用户对本计划的明确第二次授权。

B-6 / B-7 / B-8分别在118d1d0 / a3f4466 / a40f25f提交；严格fixture的原生实际出站JSON在B-8/native-green/native-catalog.json，model=deepseek-flash、thinking={type:disabled}、max_tokens=1024。独立安全评审35/35、无P1/P2。修复后的本地回归与最新CI终态分别见regression/与PR #16描述；fixture结果不代表线上成功。

产品路由仍为deepseek/deepseek-v4-flash；SDK API id为deepseek-flash。2026-10-22重查[DeepSeek官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，空闲价CNY/百万token：缓存输入0.02、未命中输入1、输出4；FX固定7.2留账，CNY不二次换汇。工作日非中国法定节假日09:00–12:00、14:00–18:00为高峰，其余为空闲。

本计划只选**2026-10-22北京时间02:00–08:50、12:05–13:50、18:05–23:50中，收到第二次授权后最早可执行的一个窗口**。Codex执行前重核日期与官方价目，并自行转换UTC，无需用户填时间。若已过当天全部窗口或价目/模型有实质变化，更新计划后先报告，不能沿用过期确认自动执行。

第二次预算上限**¥1**，仅一次最小文字回合；文字请求<=65536字节、<=32messages，输出<=1024token，角色steps=1，关闭思考与标题辅助调用，不使用搜索/抓取/业务工具。守卫¥0.5是保守预留估算，不是官方token数学保证；实际费用须用usage和专用key账单证明。第一次费用仍unknown/unpriced，本次绝不冲销或改成免费。

## 新标记与新requestID

- 第一次目录~/.local/state/reinlab/803a04fcd69a/p110-one-shot/及其已消费model-forwarded.marker、identity/admission和失败账本全部保留；本轮已核marker仍存在。
- 第二次仅使用固定目录~/.local/state/reinlab/803a04fcd69a/p110-second-authorization/，其中model-forwarded.marker为**新标记**；不允许任意路径或第三次selector。该目录/marker/admission目前尚未创建。
- CLI仅在第五参数精确为second-authorization时选择此固定目录；报告必须记录authorization.id=second-authorization及label=第二次授权。默认入口仍指向第一次旧marker，不能因此复活第一次。
- 未来获授权后才建立独立identity/admission和新账户/档案，随机生成新的HTTP幂等键；生产pipeline为新运行生成新的OpenScience requestID，并在提交前持久化。事后报告以binding.request_id为准，核对与第一次91a26c24-fef5-479d-96f8-6af7545bedc2不同。本轮未虚构或预记已执行requestID。
- 新marker仍为O_EXCL创建并fsync，验证thinking严格disabled后才可能消费。失败、结果未知、进程重启、另一个等价API名或新requestID都不能获得第二次付费转发；不删除marker，不换目录绕过。

获授权后执行形态（**现在不执行，复验人员也不要运行**）：

```sh
REINLAB_EVIDENCE_OUT=<全新第二次证据目录> pnpm exec tsx services/control/scripts/smoke-local.ts CNY offpeak <Codex核对的UTC开始> <UTC结束> second-authorization
```

## 真实运行与按专用key核账

1. 获得明确第二次授权后，先做只读后台导出基线，并在API Key筛选中选中与ReinLab专用凭据对应的key；无法确认对应关系就不发送。只查看用量，不打开/复制完整key、不充值或改账号配置。若该key同小时有其他ReinLab调用，要保留基线并检查是否还能可靠归因。
2. 走真实Auth、控制面HTTP确认、默认生产Pipeline、SDK、严格单次守卫、DeepSeek、持久观察和账本。先核实际配置及thinking=disabled；模型真实回复只允许一次，成功也不追加验证回合。
3. 任何发送后错误或未知立即停发，保留failed/unknown及预算状态。清理临时auth/config/守卫，保留新marker。成功必须同时具备completed、唯一forward=1、真实usage、已知成本<¥1和settled预算；不放松成功判据。
4. 等后台最多5分钟延迟后，仍按**同一专用key**导出本次时段。原始ZIP/CSV留仓库外0600；对比token类别/单价/原币成本，账本差异目标<5%，仅入库本次所需脱敏结果。若小时聚合内还有其他调用或无usage，明确未对平，不把缺行、钱包差额或fixture价格当成0元证明。
5. 归档写明第二次授权的真实JSON、账本JSONL、费用对账CSV与清理结果，更新PR全部CI终态后送Claude。若仍失败则只报失败，不擅自第三次尝试。

本计划的停止点：**修复与CI已完成，等待用户明确第二次授权。** 未进入P1-11；云端仍为云端补验。
