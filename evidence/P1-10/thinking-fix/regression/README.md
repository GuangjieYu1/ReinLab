# 修复后全量回归

最终源码包括B-6/B-7/B-8、独立安全测试和第二次固定入口。Node22.23.3与Node24.14.1均**1347通过、0失败、0跳过**。Node24仅兼容回归，项目目标Node22。

分别选择工具链PATH后，在工作树根目录执行：

```sh
pnpm test --reporter=json --outputFile=evidence/P1-10/thinking-fix/regression/node22.json
# 切到Node24后输出另一个文件
pnpm test --reporter=json --outputFile=evidence/P1-10/thinking-fix/regression/node24.json
```

未设置REINLAB_EVIDENCE_OUT，全仓测试内部证据使用唯一temp目录，历史证据不覆盖。两次全量顺序执行，无重试/skip/放大timeout。它们均不读真实key，不调用真实模型；具体静态检查结果在../static-checks.json。
