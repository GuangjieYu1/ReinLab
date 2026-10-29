# 每账户执行容器的镜像（PRD 3.2）。
#
# 容器里跑 DSH 内核：基础工具（bash/grep/文件读写等）由此全开，边界靠容器本身
# 与挂载范围，而不是靠隐藏工具。
#
# 注意：本文件尚未在本机构建验证（见 design/SPEC-tools-3.md 片二）。
# Provider key 不进镜像：模型调用走控制面代理，容器只用只读挂入的运行令牌。

FROM node:22-bookworm-slim

# 解析与阅读常用的工具；Agent 自己决定要不要用。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 poppler-utils \
 && rm -rf /var/lib/apt/lists/*

# 账户根由运行时以可写卷挂入；镜像里只放解释器与内核运行时。
WORKDIR /opt/reinlab

# 内核与插件的依赖由构建上下文提供（与仓库锁文件一致的那一份）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY plugins/reinlab-read-plugin ./plugins/reinlab-read-plugin
COPY services/control/src/kernel/dsh/shim.mjs ./shim.mjs
COPY packages/contracts ./packages/contracts

RUN corepack enable \
 && corepack prepare pnpm@11.5.2 --activate \
 && pnpm install --frozen-lockfile --prod --filter @reinlab/read-plugin... \
 && rm -rf ~/.cache /root/.local/share/pnpm/store

ENV NODE_ENV=production \
    REINLAB_ACCOUNT_ROOT=/opt/reinlab-account \
    REINLAB_SHIM_MODULE=/opt/reinlab/shim.mjs

# 以非 root 运行；账户根在运行时挂入并需要写权限。
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin reinlab \
 && mkdir -p /opt/reinlab-account \
 && chown -R reinlab:reinlab /opt/reinlab /opt/reinlab-account
USER reinlab

CMD ["sleep", "infinity"]
