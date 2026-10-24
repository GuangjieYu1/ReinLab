# E-1 / E-4

原生产物迁到.artifacts/account-runtime；Vite仍输出dist，不改前端构建接口。Docker COPY与真实fixture/verifier统一路径；忽略第三方归档测试目录。原生suite收集时检查文件和可执行权限，缺失明确提示`node services/account-runtime/build.mjs`并失败：missing-native-fails.json为1个失败suite、0跳过，不是通过报告。CI设REINLAB_REQUIRE_NATIVE=1并全局预检。

ToTDD：新测试最初因artifact模块缺失红灯；补实现后1/1。真实固定内核构建成功后，`REINLAB_NATIVE_REPORT=/tmp/reinlab-p113-e1-after-build-green.json pnpm test:native-after-build`先完整mock前端构建，再跑7文件原生测试31/31、0失败0跳过，并核对二进制hash未变化。均使用loopback fixture，真实模型0调用。

E-4只排版LoginGate原新增分支、空格与引号，不改逻辑；真实前端build和TS检查通过。后续统一19场景回归另附。不以构建前测试代替该回归。
