# B-2 tunable 执行白名单

8项有效行为红灯（纯resolver不拒与真实HTTP201），修复后相关7文件33/33；独立安全边界11项与原8/HTTP2项共21/21通过，见 ../../observation-independent/B-2-review.md。

每个实际叶字段（含空数组/空对象/同值/混合patch）在candidate生成前核对tunable，未列入返回400 FIELD_NOT_TUNABLE，事务不产生proposal/override/ledger/http_request收据。中间*单段，末尾*覆盖声明子树；未知后缀不授权。其后原安全底线、预算和审批规则不变。

研究台清单完全未扩白名单，write_targets/memory/dossier_note仍不开放。原通用写目标/附加说明测试改用显式声明对应字段的独立测试清单，保留所有原权限、收紧/审批、提示词隔离断言；新增真实research拒绝测试。没有修改RLS或迁移。
