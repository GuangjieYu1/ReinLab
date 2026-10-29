# 最终审计边界定向安全评审（最终定向通过）

范围：mcp-smoke-guard凭据反射/非2xx固定body、audit-runtime-credentials显式账户集与停止状态/Hatchet比较、scanner可选Hatchet与运行时token文件。未读取真实凭据、浏览器/容器ENV，未执行真实smoke/模型，全部shell login:false并先unset DEEPSEEK_API_KEY。

## Guard实测与修复

独立p113-final-guard-security-review.test.ts固定5项。第一轮raw-json/non2xx通过，JSON Unicode与SSE Unicode两项红；解析每帧键/值后两项转绿。随后标准tool_calls.function.arguments第二层JSON Unicode一项红；最新实现对JSON可解析字符串加入迭代队列，SDK二次解析反射缺口关闭。最终本agent亲跑1文件5/5绿；只布尔/计数断言，不输出合成token。测试范围冻结，未修改实现。

最新非2xx取消原body后固定错误码；未知/截断/error/解析失败固定502，不转原body。512KiB上限、6回合与原marker/fence、同scope批准规则均保留。

## Guard跨帧风险已关闭

原SSE每帧独立检查不能覆盖SDK跨帧拼接的content与tool arguments。主agent已修：按解析路径累计字符串，choices/tool_calls数组用显式child.index绑定同一流，累计值再走递归JSON字符串凭据检查；所有检查均在res.end原body之前，发现后固定502+永久unknown fence。

按本轮明确授权仅补2项：split content，split tool arguments（后者跨帧数组位置改变但index7保持，同时含index0干扰，验证使用SDK index语义）；二者均固定502、无原始choices/凭据返回、下一不同请求409、上游计数1。连原5项本agent亲跑1文件7/7通过；测试范围至此冻结，不扩其他范围。

## 运行时审计源码复核

--expected-accounts严格UUID/无重复/1..100，并排序等于完整机器账户集合；无参保留旧四账户入口。stopped明确scope=account_stopped_no_process_environment/processes0，只检查日志。运行账户PID模板转义正确、至少1可读进程、EACCES计blocked。Hatchet setup三值只内存精确比对，Config.Env公开DSN检查password为空与固定passfile；PID1 environ/配置Env/日志均比对。输出scope/计数，无私有值。

限制：Hatchet只PID1，账户只可读/proc；blocked不覆盖。/proc environ主要反映内核可见初始环境，不能独立证明语言运行时后续os.Setenv/任意内存无秘密，仍依赖Q091源码证明。URL片段检查不替代部署完整identity validator；严格image/Env/network由既有inspect guard负责。本轮未运行真实审计。

## Scanner合成实测

可选Hatchet/runtime文件走strict private_bytes：绝对canonical、NOFOLLOW|NONBLOCK、regular单link/currentuid/600/≤64KiB。仅进本进程内存，从不作为ENV/argv/报告值。仅报告selected计数及exact命中。

/tmp/reinlab-p113-final-scanner-fixture.py在临时repo、假HOME/CODEX_HOME、合成600文件亲跑5/5：干净7 selected、Hatchet/runtime两类exact命中、644拒、hardlink拒、symlink拒。最初fixture因macOS /var别名不canonical被正确拒绝，改realpath后通过，未改scanner。无真实key/会话扫描；临时数据结束删除。

## 最终状态

本次新增边界最终定向通过：guard已核原文、Unicode、二层JSON、跨SSE帧标准SDK重组与非2xx固定错误body，7/7亲跑通过；scanner隔离5/5通过；审计源码按上述可读进程与PID1范围限制通过。没有未关闭的本轮必要问题。

无全量/真实PG/模型测试，未import真实审计脚本、未读取任何真实凭据/容器Env/浏览器。此结论不承诺检测任意自定义编码，仅覆盖已审标准JSON/SSE/SDK解码与重组边界。
