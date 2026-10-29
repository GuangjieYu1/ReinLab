# 开通 staging（Fly 东京 + Supabase 东京）

> **暂缓（2026-10-20）：** 先在本地把整条链跑通，再按本文开通云端，见 [DEFERRED.md](DEFERRED.md)。

适用于用户本人。下面的注册、登录、绑卡和复制密钥都要你亲手做。助手和 Codex 都不经手任何凭据，所有凭据**一律不贴进聊天**。

## 0. 先建一个放凭据的文件（仓库外）

```bash
mkdir -p ~/.config/reinlab && touch ~/.config/reinlab/staging.env && chmod 600 ~/.config/reinlab/staging.env
```

用编辑器打开它，把下面的模板粘进去，后面每一步拿到一个值就填一个：

```bash
# —— Supabase ——
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=
SUPABASE_JWT_SECRET=
# —— Fly ——
FLY_API_TOKEN=
FLY_APP_ACCOUNTS=reinlab-accounts
FLY_REGION=nrt
# —— 模型（暂只填便宜档）——
DEEPSEEK_API_KEY=
```

`SUPABASE_JWT_SECRET` 留空：新项目用非对称签名，后端会去 JWKS 校验。

## 1. Supabase（约 10 分钟，staging 用免费档即可）

1. 打开 supabase.com，用 GitHub 登录，然后点 **New project**：
   - Name 填 `reinlab-staging`；
   - Region 选 **Northeast Asia (Tokyo)**；
   - Database Password 点生成，存进密码管理器。
2. 在项目设置的 API（或 Data API）页面：
   - **Project URL** 填进 `SUPABASE_URL`；
   - **service_role / secret key** 填进 `SUPABASE_SERVICE_ROLE_KEY`。这把钥匙权限最大，只放在这个文件里。
3. 点页面顶部的 **Connect**，选 Session pooler 的连接串，把 `[YOUR-PASSWORD]` 换成刚才的数据库密码，填进 `DATABASE_URL`。
4. 打开 Database → Extensions，确认 `supabase_vault` 已启用（通常默认就是开的）。
5. 应用账号 `reinlab_app`、存储桶、RLS 都由 Codex 的迁移来建。你不用手动建表。

**免费档的限制：** 一周没有访问，项目会被暂停，在控制台点一下就能恢复。正式给朋友用之前，再升到付费档。

## 2. Fly.io（约 10 分钟）

1. 打开 fly.io 注册。绑卡是必须的，staging 每月大约几美元。
2. 在本机装命令行并登录：
   ```bash
   brew install flyctl
   ```
   ```bash
   fly auth login
   ```
3. 创建放账户容器的私有应用：
   ```bash
   fly apps create reinlab-accounts
   ```
   不要给它分配公网 IP。账户机器由 provisioner 按人创建，不要用 `fly deploy`。
4. 生成一个**只对这个应用有效**的令牌，复制输出，填进 `FLY_API_TOKEN`：
   ```bash
   fly tokens create deploy -a reinlab-accounts
   ```

## 3. DeepSeek（便宜档）

在 platform.deepseek.com 创建一个 API key，填进 `DEEPSEEK_API_KEY`，再充一点余额。

## 4. 告诉 Codex

在聊天里只说**文件路径**，不说里面的内容：

> staging 已开通：Supabase 东京项目 reinlab-staging、Fly 应用 reinlab-accounts（nrt）。凭据在 `~/.config/reinlab/staging.env`（权限 600），用 `set -a; source ~/.config/reinlab/staging.env; set +a` 加载，不要打印、不要写进仓库或证据。请按 infra/fly/README.md 补做 P1-08 的云端验收和 Q-006 / 012 / 029。

## 以后再开

- **Hatchet：** 夜间快照、长流程调度要用，等 Codex 做到长流程时再开。
- **CI 用的密钥：** 到时在 GitHub 仓库 Settings → Secrets 里填，同样不经聊天。
