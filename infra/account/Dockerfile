# 每账户执行容器的镜像（PRD 3.2）。
#
# 容器里跑 DSH 内核：基础工具（bash/grep/文件读写等）由此全开，边界靠容器本身
# 与挂载范围，而不是靠隐藏工具。
#
# Provider key 不进镜像：模型调用走控制面代理，容器只用只读挂入的运行令牌。

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/reinlab

# 内核：与仓库锁文件同一版本。
RUN npm install --no-audit --no-fund --loglevel=error @deepseek-ai/dsh@0.2.1-rc.4 \
 && npm cache clean --force

# 运行期需要的脚本：容器内的 shim 与精读插件。
COPY services/control/src/kernel/dsh/shim.mjs /opt/reinlab/shim.mjs
COPY plugins/reinlab-read-plugin/index.js /opt/reinlab/plugins/reinlab-read-plugin/index.js
COPY plugins/reinlab-read-plugin/restrict.patch.yml /opt/reinlab/plugins/reinlab-read-plugin/restrict.patch.yml
COPY plugins/reinlab-read-plugin/container.patch.yml /opt/reinlab/plugins/reinlab-read-plugin/container.patch.yml

# 这些文件由仓库 COPY 进来，权限跟着宿主走（可能是 0600）；容器以宿主 uid 运行，
# 必须保证可读，否则 dsh 读 overlay 会 Permission denied。
RUN chmod -R a+rX /opt/reinlab/plugins /opt/reinlab/shim.mjs

ENV NODE_ENV=production \
    REINLAB_ACCOUNT_ROOT=/opt/reinlab-account

# 非 root 运行；账户根在运行时以可写卷挂入。
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin reinlab \
 && mkdir -p /opt/reinlab-account \
 && chown -R reinlab:reinlab /opt/reinlab /opt/reinlab-account
USER reinlab

CMD ["sleep", "infinity"]
