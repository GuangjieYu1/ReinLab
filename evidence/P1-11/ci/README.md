# CI 记录

初始实现提交 `af1aac281aeec98e1f072e780695a629e50d5165`：PR CI 39830380884，4/4 jobs success（Node22、Node24、account-image、local-stack）。完整步骤在 initial-terminal.json。

https://github.com/GuangjieYu1/ReinLab/actions/runs/39830380884

本批最终 HEAD 的 CI 终态在 PR #17 描述中固定提交 SHA、run 链接与全部 job 结论；正式送审前必须逐项核对完成，不能以前次成功覆盖新变更。最终提交包含扫描器7项合成fixture的独立 CI 步骤；CI不读取真实模型key，不执行真实模型冒烟。

https://github.com/GuangjieYu1/ReinLab/pull/17

GitHub Actions 同时响应 push 与 pull_request，可能产生两组同内容运行；送审时分别核对，不将尚未结束的组写成成功。最新报告可从对应run的Artifacts下载（Node22/24全量、两份容器报告、本地Supabase集成报告）。
