#!/usr/bin/env bash
# 安装/更新 systemd user 服务。
#
# 部署模型 A：直接从源码目录运行，不再把文件复制到 ~/.local/share。
# 因此“改完源码 → 重启服务”一步到位，不会出现源码和运行副本不一致。
#
# WSL 和纯 Linux 都能用：脚本自己找 node，生成的 unit 只带当前机器路径。
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node。请先装 Node.js，或把 nvm 的 node 加进 PATH。" >&2
  exit 1
fi
NODE_DIR=$(dirname "$NODE_BIN")
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/wsl-worktree.service"

if [[ "$SRC" == *" "* ]]; then
  echo "WARN: 源码路径含空格（$SRC）。systemd 的 WorkingDirectory 对空格支持不好，" >&2
  echo "      建议把仓库移到不含空格的目录，或手动改 unit 里的 WorkingDirectory。" >&2
fi

if [[ "$SRC" == /mnt/* ]]; then
  echo "WARN: 源码在 $SRC（/mnt 下）。模型 A 会直接从 /mnt 运行，" >&2
  echo "      git 扫描会明显变慢；建议把仓库移到 WSL 原生路径（如 ~/codes）。" >&2
fi

mkdir -p "$UNIT_DIR"
sed \
  -e "s|@SRC@|$SRC|g" \
  -e "s|@NODE@|$NODE_BIN|g" \
  -e "s|@NODE_DIR@|$NODE_DIR|g" \
  "$SRC/wsl-worktree.service.in" > "$UNIT_FILE"

if [ -d "$HOME/.local/share/wsl-worktree" ]; then
  echo "提示：旧的部署副本 ~/.local/share/wsl-worktree 已不再使用，确认无误后可手动删除。"
fi

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemctl --user 不可用（WSL 可能没有启用 systemd）。"
  echo "直接前台运行：node \"$SRC/server.mjs\""
  exit 0
fi

systemctl --user daemon-reload
systemctl --user enable wsl-worktree.service >/dev/null 2>&1 || true
if ! systemctl --user restart wsl-worktree.service; then
  echo "重启失败，最近日志：" >&2
  journalctl --user -u wsl-worktree -n 30 --no-pager >&2 || true
  exit 1
fi
sleep 1

if systemctl --user is-active --quiet wsl-worktree.service; then
  echo "status: active"
else
  echo "status: 启动失败，查看日志：journalctl --user -u wsl-worktree -n 50" >&2
  exit 1
fi
echo "url:    http://localhost:${PORT:-7801}"
echo "src:    $SRC"
echo "node:   $NODE_BIN"
