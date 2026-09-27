# ReinLab → iOS 应用：可行性结论与实施计划

> 目标形态：自签真机安装（免费 Apple ID）+ 云端 macOS CI 出包
> 结论日期：基于当前工作目录实测

---

## 一、结论

**可以做，而且这个项目的底子比一般 Web 项目好得多。** 不需要重写成 React Native，
用 Capacitor 包一层 WKWebView 即可。真正的工作量不在「打包」，而在**移动端适配**
和**云端签名链路的分工**这两件事上。

---

## 二、实测现状（依据，非推测）

| 项目 | 实测结果 | 对 iOS 的意义 |
|---|---|---|
| 技术栈 | Vite 6 + React 19 + TS，纯前端 | 可直接打包 |
| 构建 | Node 20 下 `npm run build` 通过，2.4s | 可进 CI |
| 测试 | 10 个文件 / 75 个用例全过，1.2s | 可作门禁 |
| 产物体积 | JS ~800KB（gzip ~250KB）、CSS ~228KB（gzip ~49KB） | 首屏无压力 |
| WebGL | 零依赖（无 canvas / Three.js / 着色器） | WKWebView 上最省心 |
| 拖拽交互 | 已用 Pointer Events + `onPointerCancel` | 触屏安全，无需重写 |
| 视频 | `<video playsInline>` 已就位 | iOS 内联播放 OK |
| 音频 | 登录点击手势内 `new AudioContext()` + `resume()` | 满足 iOS 手势解锁要求 |
| 断点 | 最窄覆盖到 520px / 540px | iPhone 竖屏 390pt 在范围内 |
| 移动菜单 | `App.tsx` 已有 `mobileNav` + scrim | 已有基础 |
| 媒体资源 | `public/classroom/` 3 个文件共 358KB，全本地 | 离线可用，无需额外处理 |

**运行时层面几乎没有阻塞项。**

---

## 三、真实卡点（按严重程度排序）

### 1. 硬编码 `http://127.0.0.1:3000` —— 第一阻塞项

`src/components/cinematic/openMaicPortal.ts:1` 写死了 OpenMAIC 开发服务器地址，
调用点为 `App.tsx:75`、`CinematicExperience.tsx:178`、`CinematicExperience.tsx:533`。
在 iPhone 上 `127.0.0.1` 指向**手机自己**，该路径必然失败；ATS 默认还禁止明文 HTTP。

**必须改为** `import.meta.env.VITE_OPENMAIC_ORIGIN`，缺失时降级为本地提示而非跳转。

### 2. 本机工具链缺失（已选择绕过）

- `xcode-select -p` → `/Library/Developer/CommandLineTools`，`/Applications` 无 `Xcode.app`
- 无 CocoaPods、无 Rust
- 数据卷仅剩 **17GB**（已用 417GB），装不下 Xcode 26

→ 云端 CI 路线绕开此点，**不再是阻塞项**，代价是反馈变慢（见 Phase 1.5 缓解方案）。

### 3. 安全区 / 刘海未处理

`index.html` 的 viewport **缺少 `viewport-fit=cover`**；全项目仅 5 处
`env(safe-area-inset-*)`（全部位于 `research.css`）。开场动画使用硬编码像素偏移：

- `.boot-corner { top: 33px }` → 撞状态栏 / 灵动岛
- `.skip-boot { bottom: 35px; right: 40px }` → 撞 Home 指示条
- 开场右上角跳过 / 调试按钮同理

### 4. 调试面板在 iPhone 上打不开

性能面板靠 `Ctrl/Cmd+Shift+D`（`CinematicExperience.tsx:498`）。iPhone 无键盘，
**无法在真机测量那 25 秒开场的真实 FPS**——而 128 份 CSS 3D 档案阵列恰是最大性能风险点。

→ 必须补触屏入口（长按标题 / 五连点）。

### 5. 缺图标与启动图 + 不是 git 仓库

- `public/favicon.svg`（286 字节，64×64）可作图标种子，`Visuals.tsx` 的 `BrandMark`
  是同一图形；但真机需要 1024×1024 无透明通道 PNG。
- `git status` → **不是 git 仓库**，云 CI 路线的前置条件。

---

## 四、技术选型：Capacitor 8

**决定性理由**：Capacitor 从 `capacitor://localhost/` 提供服务，项目中的**根绝对路径**
（`/classroom/guitar-a.wav`、`/assets/...`）**原样可用**。若手写裸 WKWebView 加载
`file://`，这些路径全部失效。

**排除项**：

- **Tauri v2 iOS** — 需 Rust 工具链，生态成熟度不如 Capacitor，收益为零
- **React Native 重写** — 项目重度依赖 CSS 3D transform（`matrix3d` 相机）、SVG、`dvh`，等于全部重写
- **纯 PWA** — 作为验证手段而非交付形态（见 Phase 1.5）

**版本约束**（已核对官方文档）：Capacitor 8 要求 **iOS 15+ / Xcode 26.0+**；
GitHub Actions 已有 `macos-26` runner 镜像。使用 **SPM 而非 CocoaPods**
（`npx cap add ios --packagemanager SPM`），CI 省掉 `pod install`，本地也无需装 CocoaPods。

---

## 五、分发链路（关键分工）

> 免费 Apple ID **无法创建 App Store Connect API Key**，CI 拿不到签名身份，
> **云端不可能替你签名**。CI 只能产出**未签名 .ipa**，签名必须回到本机用你的 Apple ID 完成。

```
GitHub Actions (macos-26, Xcode 26)
  ├─ npm ci → npm test → vite build → cap sync ios
  ├─ xcodebuild CODE_SIGNING_ALLOWED=NO      ← 故意不签名
  ├─ 组装 Payload/App.app → ReinLab-unsigned.ipa
  └─ upload-artifact
        ↓ 下载
本机 Sideloadly / SideStore（免费 Apple ID，无需 Xcode）
  └─ 签名 + USB 安装到 iPhone
```

**免费账号硬限制**（SideStore 官方 FAQ 确认）：同时最多 3 个 App、每周最多 10 个
App ID、证书 **7 天过期需重签**。

**成本**：私有仓库免费额度 2000 分钟/月，但 macOS runner **按 10 倍计费** →
约 200 分钟 ≈ 每月 20–40 次构建。公开仓库完全免费。

**升级路径**：$99/年 开发者账号可解锁 365 天证书 + TestFlight 无线安装，
且**届时 CI 可直接签名**，链路才真正闭环。

---

## 六、分阶段执行计划

### Phase 0 — 准备（约 10 分钟，零风险）

1. `git init` + 首次提交（`.gitignore` 已就绪，会排除 `node_modules/`、`dist/`、
   `reference-clips/`、`previews/`）
2. 加 `.nvmrc` 锁 Node 20。**注意 `/usr/local/bin/node` 是 v16.14.2，跑不动 Vite 6**，
   必须用 nvm 的 v20.20.0
3. 推送仓库到 GitHub

### Phase 1 — 接入 Capacitor（约半天，本地可验）

1. `npm i @capacitor/core @capacitor/cli @capacitor/ios`
2. `capacitor.config.ts`：`appId: 'chat.reinlab.terminal'`、`appName: 'REINLAB'`、`webDir: 'dist'`
3. `npx cap add ios --packagemanager SPM` 生成 `ios/` 并**提交进仓库**（CI 需要）
4. 本地验证：`npm run build` + `npx cap sync ios`（**不需要 Xcode**）

### Phase 1.5 — 无 Xcode 的真机验证（约半天）★ 本项目最重要的一步

```sh
npm run dev -- --host 0.0.0.0    # 默认只绑 127.0.0.1，必须放开
```

用 **iPhone Safari 通过局域网 IP 打开**，逐条验证：触屏拖拽、安全区遮挡、
开场 25 秒真实流畅度、音频解锁、字体回退。**零成本暴露绝大多数问题**，
避免带着一堆问题去折腾云端签名。可再「添加到主屏」验证全屏与安全区。

### Phase 2 — 打通云 CI 出包（约半天）

`.github/workflows/ios.yml`（`workflow_dispatch` + push 触发）：

1. `actions/setup-node@v4`（node 20）→ `npm ci` → `npm test` → `npm run build`
2. `npx cap sync ios`
3. `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release
   -sdk iphoneos -destination 'generic/platform=iOS'
   CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""`
4. 组装 `Payload/App.app` → `zip` 成未签名 ipa
5. `actions/upload-artifact@v4`

75 个测试可设为构建门禁（仅 1.2s）。

### Phase 3 — 装机 + 真机验收（约半天）

安装 Sideloadly（约 50MB，**不需要 Xcode**），拖入 ipa、登录 Apple ID、USB 安装，
然后跑第七节验收清单。

### Phase 4 — 移动端适配修复（按实测结果排期）

1. **修 `openMaicPortal.ts` 硬编码 origin**（`VITE_OPENMAIC_ORIGIN` + 优雅降级）
2. `index.html` 加 `viewport-fit=cover`；给 `.boot-corner` / `.skip-boot` /
   开场右上角控件补 `env(safe-area-inset-*)`
3. 调试面板补触屏入口，让真机 FPS 可测
4. `@capacitor/assets` 从 `favicon.svg` 生成 1024×1024 图标 + 启动图
5. 字体：`src/styles.css:1` 的 Google Fonts `@import` 在原生壳需联网
   （Noto Sans SC 是 CJK 大字体，自托管要按 unicode-range 切子集）。
   建议先依赖已有的系统字体回退（README 第 152 行已说明），确认观感后再决定
6. 性能：若 128 档案阵列在真机掉帧，按 README 第 29 行已有的「材质分级」机制
   加一档移动端降级

### Phase 5 — 可选：TestFlight / App Store

**必须明确**：本项目是《明日方舟》莱茵生命**非官方同人概念设计**（README 第 3 行）。
自用无碍，但上架 App Store 有较大概率因 IP / 冒充问题被拒。建议止步于自签或 TestFlight。

---

## 七、真机验收清单

- [ ] 冷启动 → 3.8s 登录过渡 → 登录表单，全程无白屏
- [ ] 全屏模式下刘海与 Home 条不遮挡任何可点元素
- [ ] 开场 25 秒：调试面板实测 FPS / P95 帧间隔（桌面 60 为标准）
- [ ] 切后台再回来：演出正确暂停、音频正确淡出（README 第 25 行声称已实现，需实测）
- [ ] 系统「减弱动态效果」开启后行为正确
- [ ] 档案阵列：拖动、选中、抽取、归位全部可触屏完成
- [ ] 六科课堂逐一进入；地球拖拽旋转、数学画布节点拖动在触屏上跟手
- [ ] 吉他课的 `.wav` / `.mp4` 可播放；播放时背景音乐正确降低
- [ ] 课后导出 Markdown 可用；`navigator.clipboard` 走通或正确回退
- [ ] 杀进程重开：localStorage（`reinlab-learning-classrooms-v1` 等）数据仍在
- [ ] 断网启动：字体回退正常，无功能阻塞

---

## 八、风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 证书被 Apple 吊销 | sideload 应用集体打不开（2026 年有此类报告） | 重签安装；或升级 $99 账号 |
| 7 天重签 | 每周需联机刷新 | SideStore 后台刷新；或付费账号 |
| 云端反馈慢 | 每次 iOS 改动要等 CI | Phase 1.5 局域网验证覆盖大部分问题 |
| 128 档案阵列掉帧 | 开场不流畅，核心体验受损 | 已有材质分级机制，可加移动端降档 |
| 同人 IP | 无法上架 | 明确定位为自用原型 |
| 免费账号 Anisette 风控 | Apple ID 被临时锁定 | 用官方服务器，勿用第三方 |

---

## 九、待决定项

1. **仓库公开还是私有？** 公开 = CI 完全免费；私有 = 每月约 200 macOS 分钟额度
2. **全屏策略**：`contentInset: 'never'` + `viewport-fit=cover` 让开场动画真正全出血，
   但需手动补全所有安全区；保守方案是让系统自动内缩。**建议先做全出血**
3. **是否在 Phase 0 就加 `.nvmrc` 与类型检查门禁**，还是保持最小配置

---

## 一句话总结

**打包不是难点，Capacitor 半天能通；难点是移动端安全区与性能适配，以及
「CI 只能出未签名包、签名必须回本机」这条被迫的两段式链路。**
建议严格按 Phase 1.5 的顺序走——先用局域网 iPhone Safari 把体验问题全部暴露，
再动云端 CI，否则会在一个每次要等 CI、每 7 天要重签的慢循环里调试布局。
