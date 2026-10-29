# L1 / L2 启动流程交叉独立评审

结论：**通过本轮限定范围评审；未发现阻断项。** 我没有实现 startup-lock、control-process 或 main IPC。本次只读检查代码，并复跑既有普通本地 fixture 回归；没有新增风险复现或测试场景，没有修改生产实现或默认测试证据行为。

## 范围与结果

- `tooling/local/startup-lock.ts`：内核监听锁、冲突拒绝、幂等释放、owner crash 后释放。
- `tooling/local/control-process.ts`：自有 child IPC 身份、record 原子发布、失败清理、已记录进程停止和 PID 复用复核。
- `tooling/local/up.ts`：全流程锁覆盖、旧 control 停止、新 child 启动及 finally 释放。
- `services/control/src/main.ts`：真正 listen 完成后的 ready IPC。

Node 22.23.3 独立复跑 `startup-lock.test.ts` 3 项 + `control-process.test.ts` 15 项，**18/18 通过**。机器可读报告为 `startup-independent-report.json`，success=true、0 failed。

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:$PATH
pnpm exec vitest run tooling/local/startup-lock.test.ts tooling/local/control-process.test.ts --reporter=default --reporter=json --outputFile=evidence/P1-08-local/startup-independent-report.json
```

输出文件由这条显式复验命令指定；默认测试仍只操作临时目录。

## L1：全程锁与内核释放

`up.ts` 在首个目录/容器/数据库 mutation 前 acquireStartupLock，覆盖 Colima、Supabase、迁移、凭据文件、镜像pin、旧 control 停止、新 control IPC ready与record发布，最终由 finally 释放。错误路径同样经过 finally，没有在中途步骤提前释放。

锁依赖 127.0.0.1 独占 TCP listener，竞争者只收到 LOCAL_SETUP_BUSY，不关闭或发送信号给占用者。release 共用同一 promise，重复调用不会重复删除/处理外部资源。操作系统在 owner 进程退出时释放监听，不需要依据过期时间或 PID 删除锁文件。

现有三项 fixture 测试分别覆盖竞争、外国监听不受影响、fixture owner SIGKILL 后随机端口可重新取得锁；均通过。

## L2：启动身份、record 与失败清理

`startControlProcess` 固定 process.execPath、tsx、指定script、随机instance，使用保留的 ChildProcess IPC channel。waiter 不调用 fetch；必须同时匹配 frame type、自有 child.pid、该次 instance 和期望port。`main.ts` 只在 serve 的 listen回调后发送实际 info.port，因此外国HTTP健康响应不能冒充本次启动完成。

record 仅在 IPC ready 后发布；字段只含 pid、instance、executable、script。目标读取使用 O_NOFOLLOW，检查普通文件、owner、mode600、单硬链接和大小。写入同目录随机 O_EXCL 临时文件，写完整并fsync后rename，finally清理临时文件；不会把部分JSON当成新record，也不跟随目标符号链接写入无关文件。正常路径发布前后还复核child未退出。

启动超时、child退出/报错、record发布失败时只清理手中持有的本次child及其detached进程组。持久记录不构成清理任意PID的授权。既有fixture证明未ready child被清理、ready但record不安全时child被清理且外国文件原值未改。

停止已有control时，先验证record，再检查当前进程组ID等于记录PID，命令后缀精确匹配script和nonce，executable也匹配；旧格式record仅在同样精确活进程身份满足时迁移。TERM后的轮询及KILL前重新检查身份，看到PID对应其他进程就停止，不将旧record授权传给新进程。fixture覆盖外国PID不发信号、TERM后PID重绑不发KILL、真实自有probe停止、旧私有格式精确识别。

## 保证边界与小项

- PID检查使用 ps + kill，是带nonce和重复身份检查的常规本地进程管理；它不是kernel pidfd式原子句柄，不应宣称从内核层消除了检查与signal之间所有调度窗口。本轮没有新增针对同UID攻击者或PID调度的风险复现。
- 原子rename保证record完整发布；不将其描述为整台主机突然掉电后的文件系统事务。启动失败后残留的完整旧record仍须经过活进程身份检查。
- control record helper验证直接parent及目标；真实up路径先经过更严格的private-env祖先路径校验。没有把本次只读范围扩大到新路径攻击。
- 非阻断清理建议：up.ts的createHash/readFile import在镜像hash移到image helper后未使用，已通知父任务；本次只读未修改。

## 与真实运行隔离

本次没有运行 up.ts、control.ts 或 main.ts，没有打开真实runtime/setup文件、Docker socket、数据库或Supabase API。startup-lock fixtures使用port=0随机端口；control-process fixtures只通过IPC声明port=3001，不真正监听3001；未占用或信号处理真实3001/3002进程。全部停止/kill操作仅由现有测试针对其自建的普通fixture子进程执行。
