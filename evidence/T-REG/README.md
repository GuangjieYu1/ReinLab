# T-REG：17个前端mock场景

完整17/17通过、0失败、0控制台/页面错误、0warning，report.json原样保存。19个基线文件与用户主仓库逐字节一致，source-hashes.json与integrity.json记录摘要。Playwright1.64.1固定为开发依赖，只新增e2e:legacy命令，前端/场景没有修改；独立测试和评审通过，见independent-test.md与review.md。

复验：
```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
VITE_BACKEND=mock pnpm dev --port 5181
# 另一终端：
REINLAB_URL=http://127.0.0.1:5181 E2E_OUT=/tmp/reinlab-t-reg pnpm e2e:legacy
```
本次使用CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome，Chrome155.0.8059.82，Node22.23.3。

运行原始输出共134张截图（350,943,303字节），全部保存在本机归档 `/Users/guangjieyu/.codex/backups/reinlab-research-20261020/T-REG/full-run`，未修改图像。为避免将重复过程截图350MB全部写入Git，本目录保留每场景最后一张，共17张；screenshots-manifest.json列出全部134张的SHA256、大小及实际归档位置。原始report仍完整列出全部截图，不宣称它们全已入库；复跑会重建完整截图集。

Q-005已关闭。以后每次送审仍须重新附T-REG报告，不用本次结果替代未来回归。
