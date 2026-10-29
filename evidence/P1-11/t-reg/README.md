18/18，0失败，原始 report.json 未改。前端 src/ 与 e2e/legacy/ 相对 P1-10 全部253文件哈希一致。
归档每个场景最后一张截图，selected-screenshots.json 是实际归档清单（18张）；report.shots 为原始全量截图名，未全部纳入Git。全套359MiB原图本机 /tmp/reinlab-p111-treg18，属于可丢弃输出。
使用 mock Vite http://127.0.0.1:5173 和全新无头 Playwright profile，不读取用户浏览器、不访问真实模型。
具体命令沿用 e2e/legacy/run.mjs 的环境变量接口，见脚本头部；禁止为了适配改场景。
