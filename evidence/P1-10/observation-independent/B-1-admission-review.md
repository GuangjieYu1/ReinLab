# B-1 admission 意图隔离增量独立复核

结论：本次 diff 未发现新增 P1/P2。仅静态只读检查，未执行 CLI、未读取 identity/admission/runtime 等私有文件、未请求真实模型。

- 新 admission.env 的 RUN_KEY 检查位于读取 runtime 配置、用户 DeepSeek key、认证/配置及 HTTP 确认之前；存在键（包括空字符串）即拒绝。
- 新确认只从 admission.RUN_KEY 提交，使用新 UUID；estimate/run ID 写 admission.env。旧 identity.env 内 RUN_KEY/ESTIMATE_ID/RUN_ID 没有迁移、清除或作为重发凭据使用；identity 的账户注册字段沿用原机制。
- RUN_KEY 和 ESTIMATE_ID 在唯一确认 HTTP 调用前保存；已保存 admission 的后续进程被拒绝。RUN_ID 在确认返回后保存；未知确认结果不会自动重试旧 request ID。
- 文件继续使用 readPrivateEnv/writePrivateEnv 的 owner/mode、祖先 symlink 与 O_NOFOLLOW 检查。admission 是意图记录，不承担付费并发围栏；其普通写入非排他/非原子特性不被当作付费授权。
- 固定共享 model-forwarded.marker 路径及脚本启动前检查未变，guard 在转发前仍以 open(wx,0600) 原子占用并 fsync。更换意图文件不会扩大跨进程付费请求名额；marker 未删除、重命名或重新生成。
- 本次未扩展真实 smoke 授权，仍需用户确认新的计划后由主任务执行。

审查 smoke-local.ts SHA-256：`f9f39ec57df60d1033b035bdbce8e9408fa88684df9892aebe8e44f6bd6f8082`
