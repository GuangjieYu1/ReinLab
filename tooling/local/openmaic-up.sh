#!/usr/bin/env bash
# 本地 OpenMAIC：课程库与原生课程播放器（D5 用）。跑在 http://127.0.0.1:3000。
set -euo pipefail
APP="${OPENMAIC_APP:-$HOME/Documents/Codex/2026-09-26/new-chat/outputs/OpenMAIC}"
SUP="$HOME/Library/Application Support/ReinLab/OpenMAIC"
PGBIN=/opt/homebrew/opt/postgresql@16/bin
mkdir -p "$SUP"
# 1) 课程库的 postgres（pg16-data）
if ! lsof -nP -iTCP:55433 -sTCP:LISTEN >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$SUP/pg16-data" -l "$SUP/postgres.log" -o "-p 55433" start >/dev/null
fi
# 2) OpenMAIC 本体：dev 模式才会带上 /api/reinlab/* 导出端点
if ! curl -sf -m 2 http://127.0.0.1:3000/api/reinlab/health >/dev/null 2>&1; then
  ( cd "$APP" && PORT=3000 HOSTNAME=127.0.0.1 nohup npx next dev -p 3000 -H 127.0.0.1 \
      > "$SUP/openmaic-dev.log" 2>&1 & )
  for _ in $(seq 1 60); do
    curl -sf -m 2 http://127.0.0.1:3000/api/reinlab/health >/dev/null 2>&1 && break
    sleep 2
  done
fi
curl -sf -m 4 http://127.0.0.1:3000/api/reinlab/health >/dev/null \
  && echo '{"code":"OPENMAIC_READY","origin":"http://127.0.0.1:3000"}' \
  || { echo '{"code":"OPENMAIC_UNAVAILABLE"}' >&2; exit 1; }
