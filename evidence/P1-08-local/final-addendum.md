# 本地化末轮增量独立复核

结论：指定增量源码复核通过，未发现新增实现阻断项。真实9项集成仍以父任务最终执行报告为准；本评审未运行任何真实资源操作。

## CLI 启动重试

- `tooling/local/supabase-start.ts:1–13` 最多调用 start 三次，只有错误 message 精确等于 `LOCAL_COMMAND_FAILED` 或 `LOCAL_SERVICE_UNHEALTHY` 才等待后重试。等待依次为2000、4000毫秒；第三次失败直接抛出原错误。其他错误、timeout、命令不可用、明确端口/磁盘/镜像错误均不重试；wait 自身失败也直接退出。
- `tooling/local/up.ts:37` 传入回调仅包含固定参数 `pnpm exec supabase start --workdir infra`；没有把 Auth、数据库业务事务、provision/upgrade 或模型请求放入重试块。单次 CLI 仍有 quietCommand 的既有 deadline。
- 独立使用 Node22.23.3 执行现有 `supabase-start.test.ts`：2/2通过，见 `supabase-start-cross.json`。核对了开发者保留的 red/green 文件存在；没有新增复现或修改实现。
- 本机出现过 CLI start 泛型失败，稍后同命令成功。当前证据没有确定根因；VM resize/重启只是发生背景，不能据此写成根因已查明。

## 真实验证脚本增量

- `services/control/scripts/verify-local.ts:130–153` 只在现有账户镜像不同于目标时调用 `lifecycle.upgrade(...,'wait',operationID)`；目标镜像及随机 operationID 先保存到受保护身份文件，再提交升级，符合未知结果保留同一操作身份的意图。两次 ensure 后比较同账户 envelope 不变、账户稳定 ID 集合不变，并读取升级前写入的真实卷标记。
- `verify-local.ts:154–159` 从真实账户容器内以1000:1000运行固定 Node fetch，访问 `http://host.docker.internal:3001/health`，设置5秒 fetch/10秒命令 deadline，断言200。这证明账户容器到宿主控制面的网络路径；不承担控制进程 IPC 身份握手的证明。
- 增量没有读取模型 key 或请求 prompt；报告仍只输出稳定结果/代码，不输出 envelope/token。

证据范围限制：升级项允许镜像已相同时复用，并仍记该项通过，因此最终9/9本身不能单独证明本次真的进入了 upgrade 分支。需要结合本轮已知旧镜像状态/执行证据，或在结果中记录非敏感 upgraded/reused 数量，才能宣称本次实际执行了升级。此限制已告知父任务；不影响当前分支的代码正确性结论。

本轮只读源码与普通临时 fixture 测试，未访问 Docker/Colima、PG、真实Auth/模型、外网、3001/3002或用户 secret/state raw。未修改生产实现。本人实现的 startup 部分仍不在本独立批准范围内。
