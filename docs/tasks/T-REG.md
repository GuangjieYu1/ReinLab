# T-REG：原样导入前端回归基线

ToSpec：从用户主目录原样复制e2e/legacy的19个文件（runner、README、17场景），仅在开发依赖添加Playwright及e2e:legacy命令，不修改前端/场景。

ToTDD：以逐文件SHA-256相等及17个场景mock运行的report.json验证；场景失败先查有意前端变更，不调整基线来变绿。默认临时输出，本次明确E2E_OUT写证据目录。
