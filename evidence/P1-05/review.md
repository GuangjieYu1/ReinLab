# P1-05 独立评审

最新结论（修复后复审）：**通过。凭据格式遗漏已修复，六位费用精度与幂等重放已独立真实数据库验证；无未关闭的评审阻断。**

下文保留首轮失败记录，最终复审见文末。

范围：任务 ToSpec / ToTDD、实现规格账本 / SSE / audit、验收 X7 / SEC-6 / CH-3、Q-018/019、ledger/index.ts、api/ledger.ts、共享事件契约与真实数据库测试。冻结快照只读审查；额外真实数据库验证全部事务回滚，仅写本报告，没有改实现、前端或已应用迁移。

## P1：文本脱敏存在明确凭据格式遗漏

位置：`services/control/src/ledger/index.ts` 的 `cleanText()` / `scrub()`。

字段名敏感检查能保护 payload.apiKey 等结构化字段，但自由文本只识别 Bearer / JWT / 部分 key 前缀，URI 只匹配 http / https。以下合成样本经 scrub 后原样保留：

```json
{"text":"postgres://review_user:synthetic_password_123@db.invalid/review"}
{"text":"refresh_token=1//0gSyntheticRefreshToken1234567890"}
{"text":"Authorization: Basic c3ludGhldGljOnBhc3N3b3Jk"}
```

它们分别是带 userinfo 的数据库连接 URI、OAuth refresh token 的明确赋值、可还原用户名密码的 Basic 认证文本。不是要求识别任意未知随机字符串；均有可静态识别的认证格式。仅 HTTP URL 保护会漏掉数据库 / 其他工具输出的常见认证 URI。X7 禁止明文凭据进入账本，SEC-6 明确扫描 OAuth refresh token。

### 真实数据库复现

在本地真实 Postgres 中 BEGIN，管理员仅创建随机 A 账户 / D 档案，SET LOCAL ROLE reinlab_app 并 set_config 绑定 A；调用 appendEvent：

```ts
appendEvent(client, A, {
  dossierId: D, kind: 'message', dedupeKey: randomUUID(),
  inputRef: 'postgres://review_user:synthetic_password_123@db.invalid/review',
  payload: {
    text: 'refresh_token=1//0gSyntheticRefreshToken1234567890 ' +
          'Authorization: Basic c3ludGhldGljOnBhc3N3b3Jk'
  }
});
```

随后查询原始 event 行并调用 auditSnapshot，三个阶段逐一检测合成 secret：

| 阶段 | URI password | refresh token | Basic value |
|---|---|---|---|
| appendEvent 返回值 | 明文保留 | 明文保留 | 明文保留 |
| event 原始存储 | 明文保留 | 明文保留 | 明文保留 |
| auditSnapshot 输出 | 明文保留 | 明文保留 | 明文保留 |

所有对象和记录已随 ROLLBACK 清理；没有使用或读取真实凭据。SSE 与审计使用相同 serialize / scrub 路径，因此读取阶段的二次过滤也不能修复这些遗漏。

建议：对通用可解析带 userinfo 的 URI 移除认证信息（至少覆盖数据库 / 常见服务协议）；在自由文本中处理明确的 password / client_secret / refresh_token 等赋值、Authorization Basic 与已知 refresh token 格式。补存储前、旧记录读取、SSE 和 audit 的合成凭据负例，并保留普通 URL / 引用结构正例。避免只在导出端过滤而继续持久保存原文。

## 其他审查结论

- requireDossier 与真实 RLS 在读取 / 导出前完成账户隔离；appendEvent 验证事务账户一致性，复合外键拒绝跨账户与同账户跨档案 run 引用。没有任意写事件 HTTP 路由。
- 账户事务锁在 seq 分配前取得，后续事务必须等前一持锁事务提交 / 回滚，避免已观察高序号后漏掉低序号后提交事件。单账户统一锁也避免同事务多档案追加锁顺序循环，与 Q-018 一致。
- 去重按账户 + dedupe_key 查询；同键同内容返回原事件，异内容409；内容按脱敏后形式比较，业务事件与后续数据库事务一起提交或回滚。
- 金额输入限制六位小数 / 有限非负；审计使用 SQL numeric 汇总为固定六位字符串，没有浮点累计。null 保持 null，并以 unknownCostEvents 单列；quota / GPU 单列。
- audit 的事件集合与汇总来自同一 SQL statement snapshot，排序和汇总一致；随后流式输出的是已经固定的快照。
- SSE 读取每批短事务后释放连接，100条分批，after / Last-Event-ID 取大，非法游标拒绝；取消唤醒轮询等待，流错误只输出稳定中文错误，没有 PG 详情。API 挂在既有 JWT / 账户验证之后。
- 共享新增事件字段为可选，兼容旧客户端；未改前端 mock 逻辑。最终测试 / 30秒断网105事件 / 覆盖报告由独立测试提供，本评审未重复跑长套件。

本地 Postgres 与临时真实 JWT 验证仍不等于 Supabase 云集成验收。


## 修复后独立复审

结论：**通过，原凭据阻断已关闭，未发现未关闭的新阻断。**

### 凭据过滤修复

cleanText 新增 Basic、通用认证 URI、OAuth fragment、明确的自由文本凭据赋值、PEM 与常见密钥格式过滤。追加前及序列化时仍使用同一过滤器；没有把保护仅放在导出端。

独立按首轮相同真实数据库事务样本复验，appendEvent 返回、原始 event 行、auditSnapshot 输出三阶段，URI 密码、refresh token、Basic 值的原文均不再出现。含脱敏内容的同键重放仍返回相同 seq；普通 source / locator / quote 与不含认证信息的普通 URL 均保留。事务整体回滚。

### 费用精度补充修复

父 agent / 独立测试发现 Zod3 multipleOf 对科学计数 1e-7 的校验缺口。最终实现改为按数值字符串的 significand / exponent 计算十进制小数位，严格拒绝超过六位的数据，在入库前避免 PG 舍入。首轮上文的六位精度描述是设计检查，不能代替此后针对该缺口的实际验证。

独立真实数据库验证：

| 输入 | 最终结果 |
|---|---|
| 1e-7、1.2e-6、0.1234567 | 拒绝 |
| 0.1 + 0.2 的浮点残差 0.30000000000000004 | 拒绝 |
| 1000000（超过单项金额范围） | 拒绝 |
| 1e-6、0.1、0.2、999999.999999、null | 接受，逐项同键重放原 seq |

五项有效事件的 audit 汇总为 `knownCostCny: "1000000.300000"`、`unknownCostEvents: 1`、`eventCount: 5`，null 未被转换为零费用事件。所有验证记录均事务回滚。

### SSE 补充与验证范围

已审查初始 connected 注释、15秒 keepalive 注释与请求 raw signal 同步 abort stream 的修复；取消仍唤醒等待并在 finally 清理请求监听。Hono 现用版本 stream.abort 有幂等保护，不会因 onAbort 回调重复调用产生递归问题。未改变鉴权前置、批量读取释放连接或游标规则。

独立 lint 通过。完整长套件 / 30秒断线105事件 / HTTP取消与覆盖结果由父 agent 及独立测试报告提供，本评审没有重复长套件。仅更新本报告，未改实现、前端或迁移。
