# Docker 29 / containerd 镜像身份只读评审

结论：**保留 normalized 的失败关闭；当前故障无需放宽校验。** 本次更符合“同一 tag 重建覆盖后，containerd 不保留旧镜像可查询元数据”的已知行为，而非 Docker API 版本不兼容或把 config digest 当 manifest digest。内容 hash tag 已存在时不重复 build，是本地启动的正确最小预防。已有两容器引用的旧镜像对象目前不可查询，这项既存损伤不会因跳过后续 build 自动恢复。

本评审只读 Unix Engine API。没有构建、tag、pull、load、删除、重启、停止、启动容器或卷；没有访问任何 Env 字段，也没有输出完整 inspect/provider 响应。未改生产代码。

## 本机证据

Socket 为 `/Users/guangjieyu/.colima/reinlab/docker.sock`。Engine `/version` 返回 29.5.2，最高 API 1.54；`/info` 的存储后端为 overlayfs / `io.containerd.snapshotter.v1`。

两个受控账户容器的 `Image` 都为：

`sha256:5b61e5f2ee170808f78f063685b22e570d16e0a45dc389a9e8949cc8b646f183`

其 `Config.Image` 都为 `reinlab-account:local-4e8dae617c09`。仅抽取以上身份字段，无 Env。

| 只读查询 | API 1.41 | API 1.52 |
|---|---|---|
| `/images/sha256:5b61…6f183/json` | 404 | 404 |
| `/images/reinlab-account:local-4e8dae617c09/json` | 200 | 200 |

当前 tag 的 `Id` 与 `RepoDigests` 均指向新 digest：

`sha256:b9de724490862d10d79c1ad08f73eecbfaa17a06fff0a00b49bab56d3d9301e5`

API 1.52 的 `Descriptor` 明确显示它是 `application/vnd.docker.distribution.manifest.v2+json`，digest 同上；descriptor 的 `config.digest` 注解则是另一个值 `sha256:d3b68d5ccc36114ab7fe0ccc18ddb0d0d7d8e0a634aca285f869b8bf8ff91408`。因此本机的新 image ID 是 manifest 身份，config 身份另有字段，不能把新 tag 的 baseline 当成旧容器的 baseline。

API 1.54 的容器 `ImageManifestDescriptor` 进一步确认旧 image 是 arm64/linux 平台 manifest（digest 为旧 5b61…6f183）；旧 descriptor 的 `config.digest` 是 `sha256:0819f66e5ad7988312c8c469857abe74ef693f2b6c9e535c1396e2d8fa14c09c`，与新镜像 d3b68…1408 **不同**。因此也不能主张“只是manifest变化，但config完全相同”来复用新Env基线。

`/v1.52/images/json?all=true` 的 ReinLab image 条目也只见新 tag / 新 digest。旧 digest 在两个 API 版本下均 404，否定了“仅升级 inspect API 版本即可恢复”的方案。

## 上游依据与推断范围

Docker 官方说明 Engine 29 新安装默认使用 containerd image store，其后端采用 snapshotter；本机 info 符合此配置。[Docker containerd image store](https://docs.docker.com/engine/storage/containerd/)

Moby 官方问题 #48907 记录同 tag buildx/build 覆盖后旧 image ID 不再可 inspect；维护者在 2026-05 的后续讨论明确区分：load/import 已保留 dangling image，而 build 仍不保留。问题关闭为 not planned，不能据关闭状态声称已有修复。这个行为与父任务的重复 build 过程、本机旧 ID 404 高度吻合；本评审没有再次 build 做破坏性复现，因此根因属于有直接观测与官方记录支持的判断。[Moby #48907](https://github.com/moby/moby/issues/48907)

Moby 当前 containerd inspect 实现将解析出的 target descriptor digest 作为 image ID，再读取匹配平台 config；它说明不能假设 image ID 永远是旧 graphdriver 的 config digest。此处 master 源码仅作语义补充，不冒充本机 29.5.2 的精确源码。[Moby image_inspect.go](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go)

## 处理建议

1. 继续禁止同内容 hash tag 存在时重复 build；任何内容变化使用新 tag，绝不覆盖仍有账户依赖的旧 tag。启动脚本应把 tag 视作不可变发布名称，并在启动前验证相关 raw.Image 仍可 inspect。
2. 保留按容器不可变 raw.Image 读取镜像 Env 基线的校验。**禁止**在旧 digest 404 时回退当前 tag、从容器 Env 反推出可信镜像配置、忽略 baseline 或自动销毁重建账户。这些做法会破坏原来的信任关系或持久操作语义。
3. 更健壮的后续设计应保存“内容 tag → 解析出的 manifest digest → 平台/config digest”关系，并为仍被账户使用的镜像保持独立不可变引用/可恢复构建产物。对于多平台 image，需要显式区分 index、平台 manifest 与 config digest。当前单平台本地验收无需为此改变 driver 公共接口；仅增加固定 manifest 记录却不保留镜像对象，也不能避免 image inspect 404。
4. 已有旧容器：优先从可信的原始镜像产物恢复**完全相同的旧 digest**及其本地引用；如果旧产物确实无法恢复，需要另立明确、可审计的迁移操作及其未知结果处理。现有 lifecycle.upgrade 同样依赖旧资源完整校验，不能宣称它现在无需准备即可升级这些失去 baseline 的容器。本次未执行任何恢复或迁移，也未删除现有容器/卷。
5. 给后续复验补一项“同环境再次 local:up 不 build、不改 image digest，原账户 ensure/reuse 仍通过”，并保留“缺失旧镜像 baseline 失败关闭”的负测。当前两旧容器的健康只证明已运行进程可用，不能作为 ensure/reuse 完整通过的证据。
