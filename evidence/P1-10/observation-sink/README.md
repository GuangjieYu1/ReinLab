# ObservationStore sink 作者验收

Node v22.23.3；专用PG16真实迁移及reinlab_app强制RLS。本测试不调用真实模型、Auth、Docker或外部目标。普通测试本身不写仓库证据；以下CLI明确outputFile归档。

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
pnpm exec vitest run services/control/test/observation-sink.test.ts --reporter=json --outputFile=evidence/P1-10/observation-sink/red.json
pnpm exec vitest run services/control/test/observation-sink.test.ts services/control/test/observation-store.test.ts services/control/test/independent-observation.test.ts --reporter=json --outputFile=evidence/P1-10/observation-sink/implementation-check.json
pnpm exec vitest run services/control/test/observation-sink.test.ts services/control/test/observation-store.test.ts services/control/test/independent-observation.test.ts services/control/test/observer.test.ts services/control/test/observation-scheduler.test.ts --reporter=json --outputFile=evidence/P1-10/observation-sink/green.json
pnpm exec tsc --noEmit -p services/control/tsconfig.json
pnpm lint
git diff --check
```

- red.json：**16 failed/0 passed**。3个实际终态被paused_budget覆盖的回归，13个缺sink接口的行为失败，真实fixture全部成功建立。
- implementation-check.json：新增16+原core3+独立7 =**26/26**。
- green.json：新增18+core3+独立7+observer27+scheduler8 =**63/63**。
- control tsc、lint、diffcheck通过。

覆盖冻结sink/cursor委托、失败稳定码脱敏/去重/未知暂停、late known-settled故障不改账；匹配快照已知/缺usage/缺history/非completed状态、独立snapshot gate、不造eventsequence；pending/indeterminate消失过期与未知费用、livepending保留；terminal冲突、cursor拒回退、严格session/run/request、RLS；审计/hold/不确定标记/run状态同事务回滚。独立审查由root另安排，本文不预先宣称独立通过。main/app生产接线及真实原生SDK+DB集成由root负责。

独立审查新增P2：../observation-independent/late-step-red.json（7绿1红）证明已settled终态后新step导致ledger与run.spent不一致。该红原样保留。修复后 late-step-green.json **68/68**（sink22+core3+独立8+observer27+scheduler8），含valid/缺tokens/坏tokens拒绝及旧event去重、accepted/矛盾终态不复活。Node22 control tsc/lint/diffcheck再次通过。

复验命令与前述最终green相同，仅outputFile改为evidence/P1-10/observation-sink/late-step-green.json。终态后新step是需人工核对的协议异常：store稳定LATE_USAGE_AFTER_TERMINAL409全事务拒绝，费用/usage/cursor不变；未自动重开hold、未将新费用静默记零。observer现有非cursor sinkfailure包装合同保持不变。已请独立作者再复验8项并另留green，不覆盖原红。
