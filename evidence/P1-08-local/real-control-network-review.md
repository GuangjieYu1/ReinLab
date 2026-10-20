# 真实账户容器到宿主控制面的只读网络补验

结论：**通过，无需修改 Docker driver 或放宽 ExtraHosts。** 在当前 Colima 0.10.3 / reinlab profile，固定 `host.docker.internal:host-gateway` 已解析到 macOS 入口 `192.168.5.2`，而非 VM Docker bridge。父任务确认 control 已 IPC ready 后，专用账户容器以 uid1000 请求宿主 `/health`，得到 HTTP 200。

## 实测

受授权专用容器：`rl-e301c34958544f83b3077b578bcfe779`。Socket：`unix:///Users/guangjieyu/.colima/reinlab/docker.sock`。

| 检查 | 结果 |
|---|---|
| 本机 Colima | 0.10.3，commit 00f6c297e92a82c04a4ab507db0a61435650d7e8 |
| 容器 HostConfig.ExtraHosts（仅此字段） | `["host.docker.internal:host-gateway"]` |
| 容器 /etc/hosts 的精确目标条目 | `192.168.5.2 host.docker.internal` |
| 容器 DNS lookup host.lima.internal | 192.168.5.2，IPv4 |
| 容器 DNS lookup host.docker.internal | 192.168.5.2，IPv4 |
| uid1000 fetch http://host.docker.internal:3001/health | status=200 |

健康请求只在父任务发出“control3001已IPC确认ready”后执行；使用 5 秒 deadline、redirect=error。仅输出status或稳定失败code，没有读取响应body。测试时该专用账户仍使用旧内容tag，父任务将另行进行显式生命周期升级；本补验不操作升级、启动、停止或删除。

复验健康请求（仅当该专用账户容器仍存在且controlready）：

```sh
DOCKER_HOST=unix:///Users/guangjieyu/.colima/reinlab/docker.sock docker exec --user 1000 rl-e301c34958544f83b3077b578bcfe779 node -e 'fetch("http://host.docker.internal:3001/health",{redirect:"error",signal:AbortSignal.timeout(5000)}).then(async r=>{console.log(JSON.stringify({status:r.status}));await r.body?.cancel();}).catch(e=>{const raw=e.cause?.code??e.name;console.log(JSON.stringify({code:typeof raw==="string"&&/^[A-Za-z0-9_]+$/.test(raw)?raw:"NETWORK_HEALTH_FAILED"}));process.exitCode=1;});'
```

## 精确版本源码与官方机制

Colima v0.10.3 的 `getHostGatewayIp` 从guest的host.lima.internal条目取得host地址；`addHostGateway` 将该地址填入Docker systemd启动参数 `--host-gateway-ip`。因此当前的固定ExtraHosts语义由Colima配置的daemon映射到macOS入口，不依赖Docker默认bridge地址。[Colima v0.10.3 daemon.go](https://github.com/abiosoft/colima/blob/v0.10.3/environment/container/docker/daemon.go)

同版本Docker runtime的Provision调用addHostGateway；本机实际/etc/hosts与HTTP200进一步证明本次profile的映射生效，不能只凭源码推断运行状态。[Colima v0.10.3 docker.go](https://github.com/abiosoft/colima/blob/v0.10.3/environment/container/docker/docker.go)

Docker官方说明host-gateway默认指向default bridge，但daemon可用host-gateway-ip/host-gateway-ips显式覆盖。Lima官方说明默认用户网络的192.168.5.2是宿主loopback入口，通过host.lima.internal访问。[Docker host gateway](https://docs.docker.com/reference/cli/dockerd/#configure-host-gateway-ip)、[Lima用户网络](https://lima-vm.io/docs/config/network/user/)

## 最小正确方案与边界

- 当前环境保留唯一固定ExtraHosts：`host.docker.internal:host-gateway`；保持精确控制面URL和现有全部normalized隔离校验，不新增IP或额外hostname白名单。
- 未来若某一Colima版本/profile实际退化成172.17.0.1，应先检查/修正专用Colima daemon的host-gateway配置并再次只读health补验；不能让driver接受任意ExtraHosts，也不应直接硬编码某个Mac LAN地址或改host网络。此次无需任何配置修复。
- 该结果证明容器到宿主健康路由可达，不替代认证回调、角色调用、Storage或模型链路验收。没有读取容器Env、runtime/setup文件、凭据或健康响应内容；没有写容器数据或操作生命周期。
