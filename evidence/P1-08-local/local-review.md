# P1-08 本地启动编排独立评审

当前结论：**暂不通过。** 已有Docker驱动通过结论不变；以下本地编排重入/进程归属问题须关闭。评审只读实现，不执行本地栈、Docker/Colima、模型或注册操作，不读取secret文件或Supabase状态raw，不修改生产代码。

范围：tooling/local、local-bootstrap、auth-worker、main、新001/002迁移及verify-local。只记录当前实际实现问题；不把已修复的旧版本行为重复列为缺陷。

## L1 / P2：local:up缺少覆盖全流程的单实例锁

up.ts在读取setup密码、修改数据库角色密码、写setup/runtime文件、停旧control、生成control进程记录之间没有单实例锁。两个同目录local:up可同时读空setup并生成不同密码，互相truncate运行配置；也可互停新启动的control或覆盖control.json。迁移锁仅保护迁移DDL；末尾端口探测不保护前面的状态修改。

建议在任何基础设施/凭据状态修改之前获取按本地状态目录绑定的独占启动锁，活owner冲突失败关闭，异常退出有明确恢复方式。此问题涉及真实首次启动和重复运行正确性，不是同UID恶意进程假设。

## L2 / P2：readiness未证明本次child身份，失败也可能遗留后台child

up.ts关闭端口probe后再spawn detached child，中间仍存在端口占用窗口。随后仅以127.0.0.1:3001/health任意2xx作为成功，当前应用health固定返回status ok，没有本次instance绑定；并发场景可使B把A的health误认为自己的，而进程记录指向B失败退出的PID。先检测child.exitCode只能排除已经观察到退出的情况，不能建立响应归属证明。

另外30秒未ready后只抛错；本次新spawn的child不在catch中清理。如果child仍卡在数据库或启动等待，它会留在后台并可能之后绑定端口。建议由本次子进程的安全CONTROL_READY/instance握手证明已成功绑定，并在失败时只清理本次持有child；不得为修复而停止任意端口进程。

## L3 / P2：quietCommand超时后code0会被当成成功

process.ts设置timedOut后向子进程组发SIGTERM，但close回调先以code===0直接resolve。命令超过deadline后优雅退出0，会被计作成功而继续下一启动步骤。应仅在未超时且code0时成功；deadline触发后保留LOCAL_COMMAND_TIMEOUT语义，不打印原始输出。

## L4 / P2：验证用户首次signup未应用时无法重入

verify-local.ts先持久化EMAIL/PASSWORD再发signup是正确的未知结果防重准备，但下次看到EMAIL便永久只走login。如果首次请求在Auth创建用户之前失败或未抵达，后续验证只会login失败，无法用相同身份完成注册。需要同一email/password的恢复流程，区分可恢复的未注册/未知响应；不能简单换随机用户制造第二账户。

## 已确认的正确边界

- local:up通过独立Colima profile与明确DOCKER_HOST操作，不切默认context，不包含停止/清理共享Docker资源的指令。命令为固定程序和参数，无shell拼接；stdout/stderr只在内存处理，向外只返回稳定错误码。
- 私密env文件拒绝symlink、多硬链接、非普通文件、宽权限及其他uid；使用O_NOFOLLOW/O_NONBLOCK与mode600。当前INTERNAL_SIGNING_KEY已写入setup并在重入复用，没有每次启动轮换旧缺陷。
- 实际Auth使用ES256：本地runtime不再注入SUPABASE_JWT_SECRET，既有createVerifier走JWKS，并保留issuer/audience/role/exp/iat/sub校验及ES256/RS256限定，不降为解码或伪验证。
- bootstrap仅对loopback PostgreSQL连接切换supabase_admin执行既有不可变迁移；应用和worker分别得到非特权角色连接，行政连接不注入HTTP运行时。SQL密码插值先限制为生成的base64url字符，原始错误被稳定码替代。
- Auth trigger生产账户及私有provision job；专用worker仅能调用窄队列函数，reinlab_app不能直接读队列或claim。worker角色初始化失败会关闭pool，后台pool error有安全错误码监听。
- 002迁移补齐第八次尝试崩溃后的过期lease终结：attempts>=8的pending/过期leased变failed，不重放资源变更；正常领取仍使用FOR UPDATE SKIP LOCKED及owner/lease校验。
- verify-local实际代码使用Auth、RLS、Vault、账户卷与专用Storage身份验证，不调用模型；输出仅检查名称、布尔值和稳定错误码。不把测试脚本存在视为其真实基础设施检查已经全部成功。

## 待修复复审

已将L1～L4逐项反馈父任务；等待修复后只读增量复核及相应证据。当前不将本地化整体标为完成。

## L1/L2 实现交付（待另一位评审者复核）

父任务随后明确委派本评审者开发L1/L2，因此本节是实现者说明，不作为独立复审批准；原问题历史保留。L3/L4由父任务负责，此处不自行关闭。

- 新增startup-lock，以127.0.0.1固定3002做宿主级排他锁。local:up在首次状态/基础设施修改之前获取，在finally释放；所有workspace共用控制面3001，因此选择同宿主固定锁端口。foreign监听直接LOCAL_SETUP_BUSY，不删除任何锁文件、不终止foreign进程。进程崩溃由内核释放端口，避免文件锁的陈旧PID解锁问题。
- 新增control-process，启动使用本次持有的ChildProcess IPC通道；必须匹配ready类型、launch nonce、child PID和3001端口。main仅在serve成功绑定的回调中发送安全IPC摘要。移除up对任意HTTP health 2xx的信任与端口预探测空窗。
- 启动失败或受保护记录发布失败，仅有界清理本次持有的子进程组；不根据端口寻找或杀进程。成功后断开IPC并unref，保留正常后台运行。
- control.json按owner/mode600/普通单链接文件检查，拒绝symlink、硬链接和宽权限；在owner私有目录内暂存、fsync后原子发布。仅兼容旧版pid/instance/startedAt私有格式；停止旧进程前严格匹配完整Node命令、script、nonce及PGID，TERM/KILL前均重新核验，PID重新占用不继承授权。
- up的镜像段未改；main仅增加ready回调IPC发送所需静态node:process导入及回调逻辑，没有更改HTTP鉴权、应用路由或模型权限。

ToTDD：startup-red.json保留初轮行为特征化红灯（11项中9失败2通过，针对旧无锁、通用health判断和不安全记录写入行为，不是setup/导入失败）。最终startup-test-report.json为18/18通过；只使用临时路径、动态测试端口及本测试持有的探针子进程，不访问真实Docker/Colima、模型或用户凭据。服务control tsc、显式本地helper/up tsc、依赖边界检查均通过。实现已交父任务，等待另一agent独立复审后再关闭L1/L2。
