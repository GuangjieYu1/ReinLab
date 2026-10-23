# P1-12 前置：凭据文件化

本轮只完成控制面配置与账户部署鉴权文件化。未执行真实模型请求或T-MCP-10；Fly交付记「云端补验」。旧账户的实际本地迁移单列后续报告，不能以合成协议通过代替。

## 验证

- green/control-config.json：50/50。
- green/node22-full.json：1395/1395，零跳过；是新writer独立用例加入前的一次全量。
- green/final-targeted.json：81/81，含writer/迁移安全测试及最终uid元数据调整。
- green/native-account.json：6/6，真实正式产物与账户启动代理、备份/重启，模型0次。
- green/linux-container.json：8/8，真实Linux镜像、root新卷/降权、备份/重启、所有进程ENV无合成凭据。
- review/：独立GPT6.1 Sol medium安全复核；正式产物13项检查、routes/reload白名单、原Host/Origin与插件internal transport均通过。
- 控制面tsc、pnpm lint通过。最终批次还会跑Node22/24全量、CI和T-REG。

首次全量1392/1395：两项fixture重复mkdir，一项原镜像COPY解析只支持单阶段；修复夹具后全量通过，校验强度保持。首次容器失败来自未共享凭据目录与9p uid映射，修正部署契约后通过。红灯证据的实际failed计数以JSON为准。

## 复跑

在此工作树根目录，Node22，PATH包含Bun1.3.14、Docker、Poppler；不要source任何凭据配置：

```sh
unset DEEPSEEK_API_KEY
REINLAB_BUN_BINARY=/absolute/path/to/bun node services/account-runtime/build.mjs
pnpm test
pnpm exec tsc -p services/control/tsconfig.json
pnpm lint
docker build -f infra/fly/account.Dockerfile -t reinlab-account:p1-12-file-auth .
node services/account-runtime/verify-container.mjs reinlab-account:p1-12-file-auth
node services/account-runtime/verify-native.mjs
```

Bun build只下载固定公开源码并在dist副本中安装frozen依赖、生成bundled skills，不写用户的OpenScience checkout。自有wrapper/source provenance见native-build-manifest.json、docs/questions.md Q-075。镜像中带原LICENSE/NOTICE。容器测试只写项目外临时合成secret，结束清理；Docker需要可见相同绝对host路径的只读bind目录。

受信运维入口（参数均非秘密，FILE只为路径）为：

```sh
REINLAB_RUNTIME_CONFIG_FILE=/protected/0700/runtime.env pnpm exec tsx services/control/scripts/account-maintenance.ts migrate-credentials ACCOUNT_UUID IMAGE wait OPERATION_UUID
```

旧ENV迁移需原Vault令牌精确匹配；有active runs时wait拒绝，中断只允许显式interrupt。同operation未知结果只对账，不重做；不同内容冲突。正常ensure/resolver不接受旧ENV形态。不要把机器config、files.raw_value、完整Docker inspect或Vault内容导出进证据。
