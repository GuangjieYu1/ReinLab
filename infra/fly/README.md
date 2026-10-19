# 账户运行时部署核对（P1-08，尚未部署）

需要真实Fly应用/东京容量、Supabase Auth/Vault/Storage、控制面私网地址及安全环境配置。凭据不得写入命令历史、仓库、账本或证据。读取平台秘密注入，不粘贴到聊天。当前没有这些云项目，下面不是成功部署证据。

1. 在Supabase项目启用Vault、确认Auth/Storage已就绪，以迁移身份执行全部未应用迁移。应用只用reinlab_app；不给应用Vault表直读或service_role。迁移0015创建私有dossier-snapshots桶及专用Storage角色；必须在真实Storage上验证角色/限桶/匿名拒绝。STORAGE_SERVICE_TOKEN须是由该项目签发、Storage可验签且role=reinlab_snapshot_writer的服务JWT；不能用通用管理员key替代。签发、轮换与刷新需按项目签名配置落地，不把本地解码当验签。
2. 创建Fly私有账户应用，不分配公网IP/服务；control/worker需处于相同组织私网。构建镜像并推带不可变tag或digest到该应用registry。ACCOUNT_IMAGE、FLY_APP_ACCOUNTS、FLY_API_TOKEN、REINLAB_CONTROL_URL通过平台secret注入，region固定nrt。provisioner实际为每个账户创建独立加密卷和常驻机器，不要用fly deploy创建共享账户实例。
3. 由可信注册事件调用registered运维入口或AccountProvisioner.ensure，账户UUID只能取已验身份事件。先确认公共account由现有Auth触发器创建。当前尚未部署Auth webhook认证/调度接线；不能把函数的source字段当验证。
4. 运维CLI（安全环境已注入）为 `pnpm exec tsx services/control/scripts/provision-account.ts <账户UUID>`。输出仅状态码，机器配置/令牌不打印。Fly内网健康为`http://<machine>.vm.<app>.internal:4096/global/health`，每次携带账户Bearer。该令牌只由服务从Vault信封读取，不用curl手工粘贴。三分钟从注册事件接收到认证健康成功计时，必须真实测量。
5. 夜间由可信scheduler逐账户运行`account-maintenance.ts snapshot <账户UUID>`，日期UTC。拒在途运行，不覆盖同日对象。云任务须有失败重试/告警；当前尚未部署cron。快照恢复必须另测tar内容与账户前缀，不能仅看HTTP200。
6. 升级用`account-maintenance.ts upgrade <账户UUID> <新image> wait|interrupt <操作UUID>`。wait有running就拒绝；interrupt原子中断并记账。收到UPDATE_REQUESTED只表示更新请求被接受；配置ACCOUNT_IMAGE为新镜像后ensure认证健康，使用真实健康runId调用reconcile，最后才可派发新运行。同operation异内容409，未知结果先对账不重发POST。
7. 后续P1-10/P1-13派发必须核对account_machine ready且无有效租约，再允许运行/工具；重启runId改变先中断对账，不能自动重交旧prompt。source machine和container secret认证属于后续插件接入，当前/internal路由保持拒绝。

本地`verify-native.mjs`与CI`verify-container.mjs`只检查真实运行时/镜像，不带模型凭据，不发模型请求，也不证明云端账户隔离或SLA。最终云验收仍须实际新账户、越权、故障与账本样本。
