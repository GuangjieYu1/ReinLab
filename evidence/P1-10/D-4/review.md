# D-4 独立只读评审

结论：**通过，未发现P1/P2缺陷。** 本人未实现本次D-4；审查只新增本报告，不修改生产、测试或其他证据，不提交。

## 依据与范围

已读 docs/tasks/D-4.md；检查新 test-evidence.ts / test-evidence.test.ts、role-runtime / independent-role / docker-independent / local-independent / ledger 的writer接线，以及review-toctou子进程与role-system-race父进程报告传递。

helper仅在REINLAB_EVIDENCE_OUT非空时resolve/mkdir指定目录，默认每次mkdtemp系统临时目录；没有读取REINLAB_EVIDENCE_TASK，因此旧TASK不能授权写仓库。各writer保留原报告文件名，但输出目录均来自helper。ledger也不再以TASK=P1-05授权旧路径。

race父进程显式用environment={}创建该次唯一临时目录，再覆盖子进程OUT为该目录；execFile只有成功返回后才读取该次reportPath，断言通过后才在父进程显式OUT下复制归档。子进程失败会直接抛出，不读取旧JSON；并行父进程各有独立mkdtemp路径，不互读。finally删除自己的临时目录。共享显式归档目录允许保留最后一次成功报告，但不影响每次测试断言使用自己的报告。

local-independent的连接释放断言改为expect.poll（1秒、20ms间隔）仅等待服务端pg_stat_activity异步可见，仍要求remainingConnections=0；没有修改生产角色检查或连接释放实现，也没有放宽最终断言。

## 独立复验

Node22.23.3运行：

```sh
pnpm exec vitest run services/control/test/test-evidence.test.ts
```

4/4通过，包括临时工作区实际Docker fake报告writer显式OUT、默认保留历史sentinel、旧TASK不改变目的地和唯一temp目录。测试嵌套使用现有fake Engine/fixture PG，不访问真实账户Docker。

另外只读核对作者本次JSON报告：red.json为有效1失败；helper-green.json 4/4；default-regression.json 76/76；explicit-regression.json 72/72。显式目录中实际存在7项预期报告：docker-independent-observations.json、independent-test.json、ledger-export.jsonl、local-independent-observations.json、model-requests.json、native-test.json、review-toctou.json。这些较大定向回归为作者执行结果，本人没有把它们表述为独立重复执行。

本人在独立helper复验后，对git ls-files evidence枚举的**303个已跟踪历史归档**逐个比较工作区字节SHA256与HEAD对应blob：303一致，0变化。git diff --name-only -- evidence为空。没有修改旧归档。

## 边界

显式OUT是用户选择归档目的地的授权，可写指定目录；本次不为该用户配置增加凭据级路径策略。默认temp报告未全部自动删除属于测试诊断保留策略，不违反“不改仓库归档”要求。没有运行新风险复现、真实模型或真实账户容器生命周期。
