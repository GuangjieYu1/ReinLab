# HarnessStore T-HAR2/T-HAR5 独立审查

当前一项已保存override预算cap P2待修，其余限定T2/T5独立通过。原store3+独立5真实PG8/8，independent-store-report.json；新增第6项独立cap用例有效红，independent-store-cap-red.json。未改production或迁移。

通过：tighten直接apply；mixed有loosen整体pending，不改effective；账户调优先合并且不能直接loosen或approved布尔；proposal绑定账户/档案/基线摘要/patch/candidate，决定时持账户ledger锁+proposal行锁并CAS重算candidate。6并发提议和6并发approve只生成一份收据、一条harness.loosen；异决定/异patch重放409；更新账户tuning或档案有效配置后旧proposal stale。foreign tenant隐藏/决定404。

T5：全局bench_version由admin发布，应用只读；同版本bundle/registry/prompt变化拒409；发布时核prompt SHA、registry摘要及bundle digest。append-only版本与effective trigger，应用禁止写globalversion或改effective快照；proposal的身份/patch/摘要及已有收据冻结。对账户调优变更后的旧override选择报stale，没有静默覆盖用户已批准权限。

P2红：cap300时档案budget.default=200保存后，把当前cap降100；基础默认/模式30均低于cap，但读取override未重新核cap，仍返回200。resolver已修的candidate检查不会覆盖该持久读取分支。需验证保存快照后再对当前cap核全部预算。

这仅验收当前T2/T5模块，不声称T4全生命周期升级收件箱、运行中配置切换或HTTP认证接线已完成。

## 修复独立复核

旧override上限P2已关闭。effectiveClient读取已保存snapshot后，按当前registry与当前account cap再调用空patch最终候选校验；不会静默截断原预算。原store3+独立6真实PG9/9通过，和decisions32组合为41/41，independent-store-cap-decision-green.json。原有效红independent-store-cap-red.json保留。当前限定T2/T5审查通过，无剩余P1/P2。
