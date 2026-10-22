# 安全边界与实际值扫描

独立 agent 仅用于安全边界与迁移，GPT 6.1 Sol / medium。令牌、服务器检查、files 路径/原子性、审批和两份迁移经独立复核。主 agent 自行复核其余实现。

- 阶段独立报告：reinlab-p111-security-stage.md、reinlab-p111-files-security.md。
- 后续独立测试：independent-mcp-security（7）+ independent-mcp-integration（3，含 max=1 连接池）+ independent-mcp-papers（5），agent 亲跑15/15。green/pre-freeze-security.json 另含 root 执行的真实 npm 内核 fixture（1），合计16，不能将其全部表述为 agent 亲跑。
- 扫描器独立复评：reinlab-p111-scan-review.md，7/7；已修必需目录缺失误报、FIFO阻塞、Git错误诊断泄露、不可读子目录静默遗漏。无未解决的确认 P1/P2；实际扫描缺口仍须下述单独披露。
- 主 agent 根据原生 fixture 发现并修复 Zod4 record 接口、账户 ledger/run 锁反序；HTTP 用户决定与吊销复用同一 client/事务；末态 ended_at（含 paused_budget）主动删除临时配置均有集成验证。未加重试、未改RLS或断言去隐藏失败。

## T-MCP-9：部分通过

credential-scan.json 是本机实际值扫描：读取受保护文件中的当前 DeepSeek key、当前 MCP Ed25519 私钥、一个真实签发并成功在线核验过的 fixture 能力令牌。该令牌随后已吊销、fixture租户已清理，值仅存于项目外0700/0600目录；不进入 argv/ENV/证据。所有三个选定值只在扫描进程内存比较，报告没有值、片段或可关联秘密的 fingerprint。

工作树、全部 Git refs/reflog 可达对象（含 commit/tree/blob）、证据目录及本任务临时日志为0命中、0读取错误。Codex sessions 有1个文件命中，shell_snapshots 有3个文件命中，均为未轮换的 DeepSeek key；新增 MCP 私钥和选定能力令牌在这些范围均0。不得将本报告写成 T-MCP-9 全绿，不清除历史记录掩盖事件。

扫描所有 ~/.codex/sessions 和 shell_snapshots；本机 ~/.codex/logs 存在但为空，~/.codex/log不存在，属于显式标记的可选布局。必需目录缺失或读失败会报 incomplete。第三方 node_modules、Git原始对象目录（改由git对象流扫描）、项目外受保护源配置排除；截图只按原始字节扫描，没有OCR。此结论覆盖选定值与列明范围，不覆盖所有历史临时令牌、整机磁盘或未保存的容器进程。

旧 OPENSCIENCE_AUTH_TOKEN / REINLAB_CONTAINER_SECRET 部署接口与 local runtime.env 的既有控制面凭据 ENV 传递仍待迁移；用户接受旧部署鉴权单列，但没有把新增能力令牌放进ENV的例外。也未确认用户删除了旧shell自动加载；保持真实模型禁用，等待轮换确认及新授权。

复跑命令（参数全为路径，无秘密值）：

```sh
unset DEEPSEEK_API_KEY
python3 tooling/security/test-scan.py
python3 tooling/security/scan-mcp-credentials.py \
  --root /absolute/path/to/worktree \
  --deepseek-file /Users/guangjieyu/.config/reinlab/local.env \
  --signing-key-file /Users/guangjieyu/.config/reinlab/mcp/signing.pem \
  --capability-fixture-file /absolute/private/audit/selected.json \
  --output /tmp/p111-credential-scan.json
```

selected.json应由测试 fixture 实际签发、核验、吊销后的令牌准备，私有父目录0700、文件0600。送审扫描后删除本轮自建副本；审查方需自行产生新的fixture，不可把令牌拷贝进证据重跑。仅扫描 key 不会发起任何模型请求。
