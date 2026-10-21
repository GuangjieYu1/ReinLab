# B-1 新账户可用模型配置

真实 npm OpenScience2.0.150空账户测试1红：临时连接成功，但旧模型别名被deprecated目录过滤。原始失败与catalog保留。

通过SDK将产品路由deepseek/deepseek-v4-flash映射至同模型当前API id deepseek-flash；官方依据：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ （2026-10-22查阅）。不改模型状态、不换产品路由、不修改上游。配置后先核真实可用model与输出上限，再核受信rawconfig端点；不满足即清理，不发送prompt。

原生最小fixture回合+SDK配置/清理+单次guard组合35/35，通过；fixture一次请求的API model为deepseek-flash，清理后connected回空。native-catalog.json保留实际列表与请求数，不含Auth headers/key。真实模型请求0、真实key读取0。安全边界独立审查40/40通过，见 ../../observation-independent/B-1-review.md 与 b1-independent-green.json；无剩余P1/P2。

原已有真实链前置失败仍在real-smoke/，提供方转发0；它不是本次真实模型成功证据。按用户中期新要求，本轮不执行真实模型，先交计划确认。
