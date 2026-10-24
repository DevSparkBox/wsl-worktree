#!/usr/bin/env bash
# 兼容旧习惯：模型 A 下 deploy 就是安装/重启 systemd 服务，不再复制文件。
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" "$@"
