# 公开模型目录只读核对

结论：真实 models.dev/api.json 已包含 deepseek/deepseek-v4-flash；无需stub或伪造元数据。2026-10-21T00:56:50Z 实际无认证HTTP200，响应5889411字节，SHA256=0e2b65744063ae82c3cf8e33ed71672e49b1f58a4eb910acddabd292f955afe1。仅保存所需公开字段摘录 public-model-catalog.json，不读取本地环境凭据、模型key或账户数据。

目标字段cost USD每百万tokens input0.15/output0.6/cache_read0.003；limit context1048576/output393216。满足现PricingService报价要求的正价格/context≥13000/output≥3000。models.dev将其标为deprecated兼容别名，canonical_model_id为deepseek/deepseek-v4.1-flash-1017；DeepSeek官方当前价格页明确旧deepseek-v4-flash仍接受、由V4.1 Flash-1017服务并按Flash计费。此为公开元数据可用性，不是实际付费模型调用成功证据；没有扩大本任务视觉/模型功能范围。

来源：[公开API](https://models.dev/api.json)、[models.dev维护者源文件](https://github.com/anomalyco/models.dev/blob/dev/providers/deepseek/models/deepseek-v4-flash.toml)、[DeepSeek官方价格与兼容说明](https://api-docs.deepseek.com/quick_start/pricing/)。
