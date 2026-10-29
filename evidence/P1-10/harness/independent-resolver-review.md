# Pure resolver 独立审查

当前一项 P2 待修，非最终通过。原3+独立4共5通过/2有效红，independent-resolver-red.json；未改实现。

P2：planBenchPatch只检查patch中显式金额，不检查最终candidate遗留金额。研究base swarm=30，accountCap=10时，budget.default_cny=4或仅model偏好均产出swarm=30的有效候选。账户上限应约束全部候选预算，不能因未修改该字段而放过。请在合并完成后核对default/by_mode全部非null金额。

通过边界：默认deny的新工具→ask按loosen；allow→deny按tighten；混合tighten+loosen仍requiresApproval，base冻结未改；写目标按目录边界子集判定、path安全floor终审；memory只收窄；dossier note拒file/env；strict patch不接受approved布尔或prompt/gates/steps，task ask也拒；只返回proposal/candidate不执行批准。digest包含base bundle/registry/prompt/notes，candidate递归freeze。

verifyEffective是可信持久化快照完整性入口，不是外部审批能力；真实DB发布、proposal身份和approved决定需要后续HarnessStore独立验收。

## 上限修复独立复核

原P2已关闭：合并完成后枚举candidate全部default/by_mode非null预算核对账户cap，而非只看patch输入。原3+独立4共7/7通过，independent-resolver-green.json；原red保留。后续发现的已保存override在cap降低后读取绕过，属于HarnessStore读取边界，另见独立store cap报告。
