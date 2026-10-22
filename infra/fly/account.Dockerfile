FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates poppler-utils tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng python3 python3-numpy python3-scipy python3-pandas python3-matplotlib python3-sklearn && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/control/package.json services/control/package.json
COPY services/worker/package.json services/worker/package.json
COPY services/account-runtime/package.json services/account-runtime/package.json
COPY plugins/reinlab-os-plugin/package.json plugins/reinlab-os-plugin/package.json
RUN npm install -g pnpm@11.5.2 --no-audit --no-fund && pnpm install --frozen-lockfile --prod --filter @reinlab/account-runtime && mkdir -p /opt/os /opt/reinlab /services/control && ln -s /workspace/services/account-runtime/node_modules /opt/os/node_modules && ln -s /workspace/services/account-runtime/node_modules /opt/reinlab/node_modules && ln -s /workspace/services/account-runtime/node_modules /services/control/node_modules
COPY plugins/reinlab-os-plugin/index.js plugins/reinlab-os-plugin/mcp-tools.js /opt/reinlab/plugin/
COPY services/account-runtime/mcp/files.py services/account-runtime/mcp/client.mjs services/account-runtime/mcp/store.mjs /services/account-runtime/mcp/
RUN ln -s /services/account-runtime/mcp /opt/reinlab/mcp
RUN echo '{"type":"module"}' > /opt/reinlab/plugin/package.json
COPY infra/fly/account-entrypoint.mjs infra/fly/account-health.mjs /opt/reinlab/
COPY services/control/src/bridge/openscience/role-project.ts /services/control/src/bridge/openscience/role-project.ts
RUN mkdir -p /data && chown node:node /data
USER root
WORKDIR /data
ENV HOME=/data OPENSCIENCE_DATA_DIR=/data/os-data OPENSCIENCE_CONFIG_DIR=/data/os-config
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 CMD ["node","/opt/reinlab/account-health.mjs"]
ENTRYPOINT ["node","/opt/reinlab/account-entrypoint.mjs"]
