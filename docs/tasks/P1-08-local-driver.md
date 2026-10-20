# P1-08 本地账户驱动

## ToSpec

- 账户编排只依赖 AccountDriver：资源列表/创建/启动/更新、计划、区域和认证代理 endpoint。旧 Machines 构造保持兼容，默认 Fly 的校验不变。
- PROVISIONER_DRIVER=docker 显式选择本地驱动。仅 Unix Docker Engine socket；不执行 shell，不输出 Engine 错误/Env。请求限时、限响应体。
- 一个账户一个受控 label 的容器和具名卷，卷只挂 /data；重用时校验身份、完整 Env、镜像、卷及隔离设置；拒绝冲突及未知创建结果。数据库 fly_machine_id/fly_volume_id 历史列存驱动资源 ID，保留兼容。
- Docker 镜像为显式本地 tag；控制面仅 http://host.docker.internal:3001/。认证代理 Docker 显式模式监听 IPv4 4097，宿主仅映射 127.0.0.1 随机端口。Fly IPv6 4096 不变。
- 升级保留具名卷、重建同名容器；操作结果未知进入 indeterminate，禁止盲重放。快照复用认证代理，仅 Docker 允许本地 Supabase HTTP，JWT 必须是 reinlab_snapshot_writer。

## ToTDD

先以测试专用 fake Engine 验证协议：Unix socket 配置拒绝 TCP、严格计划、受控创建与端口、敏感错误清洗、冲突资源拒绝。再跑原 Fly provisioner/lifecycle 回归。真实 Docker 镜像及 Supabase 集成由独立环境完成，测试 fake 不进入 live 路径。

## 锁版本增量 ToSpec / ToTDD

账户入口写全局 openscience.json 时固定 autoupdate:false，启动真实运行时子进程时最终覆盖 OPENSCIENCE_DISABLE_AUTOUPDATE=1，禁止调用方环境解除锁定；保留 plugin/model 和原 provider 行为。先用测试专用探针子进程读回配置及环境，证明两个锁定通道和模型/插件保留，再实现两个入口属性。

## 本地镜像 pin 增量 ToSpec / ToTDD

内容 hash tag 仍是可变 Docker 名称。启动时固定保存 tag 对应 image ID，后续 tag 覆盖或消失必须失败关闭；没有 pin 的旧环境也必须比对容器保存的 Config.Image 与不可变 Image ID，存在同 tag 旧容器而镜像缺失/ID 不同时不得重 build 或接受新基线。只在无 pin、无相关容器、镜像确实缺失时允许首次构建。CLI 固定参数，仅格式化读取镜像/容器 ID 与镜像引用，禁止读取 Env。由父任务全程启动锁串行化；本 helper 不另加启动锁。先补纯决策和 fake CLI+临时pin文件测试，再实现；不对真实 Docker 执行任何操作。

镜像hash补充ToSpec/ToTDD：纳入Dockerfile全部COPY输入与workspace manifests，用路径+长度分帧；先增加解析COPY源及逐文件变更的纯回归红灯，再实现accountImageTag。测试临时目录realpath canonical化，保留private-env祖先symlink拒绝。
