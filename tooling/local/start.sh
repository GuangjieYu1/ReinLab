#!/bin/sh
# 固定用项目工具链的 Node 22 起本机栈。pnpm 在 DSH 桌面应用里跑时 node 是
# Electron（dsh 内核不认），所以这个入口不经过 PATH 上的 node。
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
NODE=${REINLAB_NODE_BIN:-}
if [ -z "${NODE}" ]; then
  NODE=$(ls -d "$HOME"/.local/share/reinlab/toolchains/node-v22.*/bin/node 2>/dev/null | sort -r | head -n 1 || true)
fi
if [ -z "${NODE}" ] || [ ! -x "${NODE}" ]; then
  echo '{"code":"LOCAL_NODE22_REQUIRED","message":"没有找到项目工具链的 Node 22（~/.local/share/reinlab/toolchains/node-v22*/bin/node）。"}' >&2
  exit 1
fi
case "$("${NODE}" -p 'process.versions.electron ?? ""')" in
  "") ;;
  *) echo '{"code":"LOCAL_ELECTRON_RUNTIME_FORBIDDEN","message":"工具链里的 Node 居然带 Electron 指纹，拒绝启动。"}' >&2; exit 1 ;;
esac
cd "${ROOT}"
REINLAB_LOCAL_STACK=1
export REINLAB_LOCAL_STACK
exec "${NODE}" --import tsx tooling/local/up.ts "$@"
