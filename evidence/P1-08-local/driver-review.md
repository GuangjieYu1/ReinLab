# P1-08 本地 Docker 驱动独立评审

结论：**通过本次本地 Docker 驱动代码正确性复审；先前发现已关闭，无剩余阻断项。** 此结论不代表真实 Docker/Colima、镜像启动、本地 Supabase 全套或整批 P1-08 已验收。

范围：AccountDriver、Docker/Fly实现、provisioner/lifecycle/runtime、账户入口及健康检查、现有驱动测试与报告。按父任务最终要求仅做本仓库只读核对，不新增攻击用例、不操作共享Docker/Colima、不执行模型、不读取用户密钥、不修改生产实现。Supabase及queue的未完成部分不在评审范围。

## 发现历史与修复依据

### R1：Docker 开户预校验使用 Fly 占位卷 ID

初轮 index.ts 在任何资源创建前调用 `driver.plan`，固定传 `volumeId: vol_validation`；Docker计划要求卷名为账户专属 `rl_<account无横线>`，所以真实Docker开户路径会提前失败。已同步父任务及开发agent。

修复：AccountDriver增加validateDeployment；Fly适配器仍以原machinePlan及Fly占位卷校验，Docker实现构造本账户合法卷名校验。AccountProvisioner.ensure现调用validateDeployment，不再把Fly占位ID传给Docker计划。对应新增实际PG编排+fake Engine的ensure/reuse测试。R1关闭。

### R2：复用检查遗漏启动命令及非命名空间环境变量

初轮normalized仅逐元素允许Entrypoint、允许空Entrypoint，忽略Cmd；Env只排查REINLAB_/OPENSCIENCE_命名空间，NODE_OPTIONS、PATH等篡改可被归一化隐藏。外层编排无法补查已丢失字段。已同步父任务及开发agent。

修复：Entrypoint必须精确为node与固定账户入口两项；Cmd只允许null或空数组。读取容器实际不可变image digest的image inspect Env作为基础配置，叠加dockerPlan安全Env后，要求实际Env键数和值全部一致，拒绝重复Env、额外NODE_OPTIONS/PATH或值篡改；账户凭据同时由外层与数据库预期比较。Docker默认隔离字段也已收紧，包含ExtraHosts、附加网络、DeviceRequests、DNS/Sysctls、SecurityOpt、Tmpfs/Mounts/Userns/Uts/PublishAllPorts等。现有负例覆盖启动命令、Env及独立测试发现的控制面地址重映射、附加网络、额外安全选项和设备请求。R2关闭。

### R3：可变账户名与不可变容器 ID 的操作分工

初轮start/update在inspect校验后仍用名称发变更请求。建议避免名称在校验后被重新绑定，使变更落到另一个对象。

修复：稳定 `rl-<account无横线>` 名称继续作为数据库可跨重建复用的账户机器标识；start及update先inspect和完整校验，再取检查为64位hex的raw.Id，使用不可变ID执行start/stop/delete。升级只删除本次验证的容器，不删除卷，之后按同一账户名重建。该加固建议已落实。

## 最终一致性核查

- Fly runtime计划的原始镜像、私网URL、令牌、区域和卷校验未放宽；FlyMachines仅移出接口类型，HTTP行为仍保留原校验。中立适配保留Fly endpoint的机器ID/app校验。
- Docker仅显式Unix socket、固定Engine API版本和结构化JSON；没有shell执行、凭据进入命令行或输出Engine原始敏感错误的路径。请求有期限，响应体有界，错误清洗保留。
- 账户容器与卷的名称必须与managed/account labels一致；foreign label、额外挂载及其他容器借用账户卷均拒绝。外层继续检查重复资源、数据库记录、镜像、账户Env和卷归属。
- 创建仅本账户命名卷挂载到/data，无host network、privileged、socket挂载或额外卷；只发布4097到宿主127.0.0.1随机端口。复用先验证实际隔离配置，endpoint再校验实际loopback端口。
- 未知create结果保留数据库创建阶段，重启后先对账现有资源；看不到结果则indeterminate，不再create。upgrade保留操作ID/请求hash与pending/indeterminate状态，结果未知不盲目重放，确认目标镜像的现有容器后才记applied。
- Docker账户代理显式监听容器IPv4 4097，宿主发布范围保持loopback；Fly默认IPv6 4096不变。原有Bearer、Origin/Sec-Fetch-Site与WebSocket拒绝逻辑未删除。账户健康检查随显式Docker模式选择127.0.0.1:4097，其余保留::1:4096。
- 生命周期本地Storage/control URL例外仅在显式Docker驱动下生效，Storage仍要求专用snapshot-writer身份；Fly原有私网与HTTPS规则保持。这是明确的校验例外，没有为抽象统一而放宽安全条件。

## 测试与证据边界

初轮评审者只运行既有docker-driver fake协议测试（排除真实PG项）：7通过、1跳过，未访问Docker。之后按父任务收窄要求不再增加测试或外部操作，仅核对最终实现与已有报告：

- driver-green.txt：5文件72/72通过；开发agent报告类型检查通过，driver-types.txt没有错误输出。
- docker-independent-report.json：现有独立测试最终13/13通过，0失败。
- docker-independent-red.json：初轮12项中8通过4失败；对应配置校验已在最终normalized中补齐。
- 既有测试包含Unix HTTP协议错误/敏感内容清洗、外国卷使用、同卷重启/升级、未知volume/container创建结果的恢复与隐藏结果拒重放，以及未知升级响应的同操作对账。

这些测试使用fake Engine或临时Unix HTTP服务，部分编排测试使用测试PG；评审者没有亲自运行真实Docker、没有将fake结果视作账户镜像真实启动证明。真实镜像及本地全套仍须由独立环境验收。

## 入口锁版本增量复核

只读确认入口写入的全局openscience.json新增autoupdate:false，spawn子进程环境在展开调用方env之后强制设置OPENSCIENCE_DISABLE_AUTOUPDATE为1，外部传入0不能覆盖。既有plugin、可选默认model及provider配置路径未改变，原有server.ready版本核验保留。

新增account-entrypoint-lock.test.ts使用测试专用探针子进程读取实际写入配置和实际子进程Env，检查两种关闭通道，同时断言插件及默认模型保留。已核对既有红灯driver-version-lock-red.txt与最终driver-green.txt（6文件74/74）；本轮未运行Docker或真实内核。该增量维持驱动代码通过结论。
