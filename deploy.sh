#!/usr/bin/env bash
# 把 E:\ai-spaces\tools\wsl-worktree 同步到 WSL 原生路径并重启服务
set -euo pipefail

SRC=/mnt/e/ai-spaces/tools/wsl-worktree
DEST=/home/wangy/.local/share/wsl-worktree
UNIT=/home/wangy/.config/systemd/user/wsl-worktree.service

mkdir -p "$DEST" "$(dirname "$UNIT")"

# 逐个复制并校验（/mnt/e 上 cp -f 偶发静默失败，必须比对 md5）
cp_verify() {
  local src="$1" dst="$2"
  local a b
  for _ in 1 2 3; do
    cp -f "$src" "$dst" 2>/dev/null || true
    a=$(md5sum "$src" 2>/dev/null | cut -d' ' -f1)
    b=$(md5sum "$dst" 2>/dev/null | cut -d' ' -f1)
    if [ -n "$a" ] && [ "$a" = "$b" ]; then return 0; fi
    sleep 0.2
  done
  echo "WARN: $dst 与源文件不一致 (src=$a dst=$b)" >&2
  return 1
}

cp_verify "$SRC/server.mjs" "$DEST/server.mjs"
cp_verify "$SRC/config.json" "$DEST/config.json"
rm -rf "$DEST/lib" "$DEST/public"
mkdir -p "$DEST/lib" "$DEST/public"
for f in "$SRC"/lib/*; do cp_verify "$f" "$DEST/lib/$(basename "$f")"; done
for f in "$SRC"/public/*; do cp_verify "$f" "$DEST/public/$(basename "$f")"; done
cp_verify "$SRC/wsl-worktree.service" "$UNIT"

systemctl --user daemon-reload
systemctl --user restart wsl-worktree.service
sleep 1
echo "status: $(systemctl --user is-active wsl-worktree.service)"
echo "url:    http://localhost:7801"
