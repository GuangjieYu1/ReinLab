# B-7 独立安全评审（2026-10-22）

结论：当前守卫改动通过独立边界评审。新增独立测试 **35/35 通过，0 失败；P1/P2 发现 0**。本结论限于本地守卫及 B-6 配置核验，不构成真实模型调用授权。

## 范围与隔离

- 读主仓库 `design/reviews/BATCH3_INTERIM_REVIEW.md` 的 2026-10-22 追加要求。
- 评审工作树 `research-foundation/ReinLab`，分支 `codex/p1-10-translation-complete`，B-6 基线 `118d1d0`，及未提交 B-7 diff。
- 测试以独立新文件实现，不复用作者断言或 fixture。网络只使用本机 loopback；守卫 transport 是内存假响应。真实模型请求 **0**，真实 key 读取 **0**。
- 未改上游、未修改产品安全策略、未提交。真实 marker、凭据文件和真实 provider 均未访问。

## 证据

| 独立验证 | 测试数 | 结果 |
| --- | ---: | --- |
| 两个模型别名 × 14 种非法 thinking 形态 | 28 | 全部 HTTP 400；每例确认 marker 不存在、transport 0 次、状态 ready；随后合法请求成功 1 次，再请求 409 |
| 超 65536 字节 / max_tokens 超 1024（两个别名） | 2 | 413 / 400，不消费 marker，随后合法请求 1 次 |
| 2 个实例、两个别名、12 个并发请求 | 1 | 1 个成功 + 11 个 409；transport 总计 1 次 |
| transport 抛错 / 上游 HTTP 400 后重启 | 2 | 首次已消费；重启为 spent，另一别名 409；总转发仍 1 次 |
| B-6 raw config thinking 缺失 / enabled | 2 | configureSmokeGateway 拒绝；恢复原始 raw config、删除临时 auth 各 1 次，无 prompt；后续 cleanup 无重复写 |

非法矩阵涵盖 missing、null、enabled、大小写错误、伪嵌套、额外字段、空对象、数组、字符串、布尔、数值、type null、constructor 伪形态。每个合法转发均断言固定 DeepSeek endpoint、`redirect: error`，以及完整 JSON body 深度等于原输入（模型别名与 disabled 字段未被改写；守卫按原实现规范化 JSON 字节）。

## 代码边界检查

1. `keys(value.thinking, ["type"])` 先拒绝非对象和额外键，再严格比较 `type === "disabled"`；缺失/null 不会被宽松判断放行。
2. 验证在 `open(marker, "wx", 0o600)` 之前完成。marker 写入并 sync 后才调用 transport；多实例原子争用继续由 `wx` 仲裁。
3. 上游返回失败和异常均无 marker 删除或重试路径，因此修复未放宽原先单次授权边界。
4. B-6 从 raw config 核验显式 disabled；核验失败进入现有 cleanup，独立负面测试证明临时状态收回。

## 复现

Node v22.23.3；命令：

```sh
pnpm exec vitest run tooling/b7-independent-thinking-boundary.test.ts services/control/test/b7-independent-config-boundary.test.ts --reporter=json --outputFile=evidence/P1-10/thinking-fix/B-7/independent/tests.json
```

机器默认 PATH 为 Node20，首次 pnpm 启动因缺少 node:sqlite 失败（未启动测试）；使用现有本地 Node22 工具链后上述命令通过。机器可读结果见 `tests.json`。未执行全量测试（由主任务负责集成验证）。第二次授权路径选择模块尚待主任务实现后另行补充评审。

## 第二次授权路径接线补充（同日）

只读评审 `tooling/local/smoke-plan.ts` 与 `services/control/scripts/smoke-local.ts` 的新 diff；未 import 或执行真实 CLI。

- `smokeAuthorization` 仅接受 `undefined` 和精确字符串 `second-authorization`；返回固定目录，不接受路径、第三次名字或大小写变体。`Object.freeze` 阻止调用方改写返回值。
- CLI 在读取 admission/runtime/identity/真实凭据之前选择目录；第五个参数用于固定选择，额外参数拒绝。缺省仍为原 `p110-one-shot`，新增目录为 `p110-second-authorization`。
- marker、admission、identity 均从同一个所选 `privateDirectory` 派生；没有旧目录文件删除、覆盖或迁移逻辑。第二次目录仍通过原 `wx` marker 守卫，不能用不同 requestID 重置已消费的转发资格。
- `report.authorization` 记录第二次授权标签；selector 自身不构成人类授权。当前独立评审未执行真实 CLI，也未生成真实第二次 requestID。

补充结论：此接线未发现 P1/P2 问题。此部分为静态独立评审；作者 selector 用例及主任务集成测试作为补充证据，不计入本评审独立 35 项测试数量。
