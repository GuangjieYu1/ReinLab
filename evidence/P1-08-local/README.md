# P1-08 本地化证据

本地实现与独立复验通过；云端统一「云端补验」。本目录只证明完整本地基础设施，不代替尚待 P1-10 完成的真实模型链路。

## 启动与复跑

要求 Node22（本机22.23.3）和 pnpm11.5.2；本机使用 Colima0.10.3，Linux 使用本地 Docker Engine。冷启动建议至少20GiB宿主空闲空间，镜像下载及构建需联网。不得清理用户已有容器或卷来腾空间。

```sh
pnpm install --frozen-lockfile
pnpm local:up
REINLAB_EVIDENCE_OUT=evidence/P1-08-local/recheck pnpm local:verify
```

macOS 的启动命令创建/复用独立 `reinlab` profile（4CPU、4GiB内存、20GiB稀疏数据盘），不激活默认 Docker context。Linux 或指定既有独立 Engine 时设置 `DOCKER_HOST=unix:///受控socket`。CLI固定2.121.0、完整PG17/Auth/Storage/Vault；Studio、Realtime等也实际启动。业务迁移由原有摘要校验器在CLI内置服务初始化后执行。原PG16测试库55432及共享DockerDesktop保持不动。

控制面 `http://127.0.0.1:3001/health`；Supabase `http://127.0.0.1:54321`；Studio `http://127.0.0.1:54323`。3002仅是启动互斥端口，不提供业务API。重复启动需等前一次完成；内核会在启动进程退出时释放锁。

生成凭据在仓库之外的 `~/.local/state/reinlab/<工作目录摘要>/`，普通单链接mode600；不要输出或上传该目录，也不要上传Supabase `.temp`。HTTP进程仅持有应用/专用队列连接与专用Storage身份，不接收迁移管理员连接、JWT签名密钥或service_role。ES256登录使用JWKS严格验签。此基础设施测试不加载DeepSeek key，不发模型请求。

## 结果

- `local-regression-node22.json`、`local-regression-node24.json`：各146/146，无失败或跳过；包括Docker/Fly原有相关测试及本批测试，不冒充全仓回归。
- `integration-final/local-integration.json`：真实9/9；`integration-repeat/local-integration.json`：重复启动后的真实9/9，明确applied=0/reused=2。
- `upgrade-execution.json`：应用角色按账户读取的两笔真实applied升级操作，目标 `reinlab-account:local-011124769f8e`。这补足条件升级分支仅凭9/9不能证明本次执行的限制。升级保留具名卷、探针文件与原Vault凭据信封。
- Auth注册触发账户/队列/实际容器；真实JWT跨账户读档案返回404、数据库RLS隐藏；Vault信封可解密但应用不能直读Vault/私有元数据；专用快照写入真实Storage并下载核对卷中字节，两个普通账户读取均拒绝；实际容器重启保卷。
- `local-up-repeat.txt`：一条命令重复启动成功、0待应用迁移；`control-health.png`：真实无头浏览器健康页截图。
- `ledger-export.json`：本次基础设施验证的真实空账本，0研究运行/模型请求；不伪装成P1-10模型账本。
- `local-independent-test.md`：独立26/26；`startup-independent-review.md`：交叉评审18/18；`local-cross-review.md`及`final-addendum.md`：其余交叉评审通过。
- lint、控制面与本地编排严格类型检查通过。前端src无diff；mock基线仍见 `../T-REG/report.json`，第三批最终送审再附最新T-REG报告。

## 真实失败与处理

1. CLI拒绝PG16 → 本地PG17，保留PG16回归。CLI postgres执行旧ALTER ROLE失败42501 → 仅初始化使用已验证的本地supabase_admin；旧迁移不改，运行时低权限角色不变。
2. 实际Auth签发ES256，旧配置限定HS256 → 不向HTTP进程下发JWT_SECRET，沿现有JWKS验证；见integration-attempt-1。
3. 同tag重复build导致containerd丢旧镜像元数据 → 内容hash覆盖全部COPY输入，独立pin固定image ID，漂移/缺失失败关闭，不回退当前tag基线。见real-image-review、image-pin-review。仅本任务最初两个无run/无dossier的测试容器显式重建，卷和凭据未删，记录test-image-repair.json。
4. Storage真实重复上传返回400+KeyAlreadyExists → 只接受该精确错误码（响应至多4096字节），其他400仍失败。最初新测试错误地在fixture构造后才替换transport，已纠正；storage-duplicate-fixture-error及local-regression-node22-before-fixture-fix保留该准备错误，不能当产品红灯。storage-duplicate-red为纠正fixture后对旧行为的有效红灯；local-fixes-attempt也是历史失败尝试，不是绿灯结论。
5. 独立评审发现启动互斥、就绪身份/失败清理、超时exit0、未知注册重入；均补有效红绿测试并交叉复核。独立测试发现DB URL后缀、祖先链接、env无损编码问题，也已修复。所有历史红灯保留。
6. VM数据盘12GiB仅余约905MiB；用户释放宿主空间后，仅扩本任务profile到20GiB，保留全部服务/卷。重启后首次CLI start泛型失败、稍后同命令成功，具体根因仍不确定；仅CLI基础设施启动对两类失败最多3次有界恢复，绝不重放业务/Auth/模型请求。见Q-048。

诊断Storage协议时曾在全零UUID下创建一个空的测试对象；它没有登记为研究artifact或账本输出，不用于任何成功证明。真实快照证明始终核对实际账户卷中的探针字节。

本地CI增加独立local-stack job，执行同一真实启动/验证命令；终态将在第三批CI索引补齐。D-4的全仓证据默认输出清理属于下一步P1-10，尚未在此标关闭。
