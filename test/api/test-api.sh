#!/usr/bin/env bash
# 接口级测试总入口：起一个隔离配置的临时服务，依次跑完所有 API 测试。
#
# 不碰 7801 上的生产服务，也不依赖 /tmp 在两个进程之间可见：
# 临时仓库和服务配置都放在仓库根目录的 .test-run/ 下（.gitignore 已排除）。
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PORT=${PORT:-7813}
TMP="$ROOT/.test-run"
NODE=${NODE:-node}

rm -rf "$TMP"
mkdir -p "$TMP/repos"
cat > "$TMP/config.json" <<EOF
{
  "port": $PORT,
  "host": "127.0.0.1",
  "roots": ["$TMP/repos"],
  "scanMaxDepth": 4,
  "stateCacheMs": 500,
  "scanCacheMs": 1000,
  "maxPatchBytes": 2097152,
  "apps": {
    "fileManager": { "command": "/bin/true", "args": [], "pathStyle": "auto" },
    "terminal": { "command": "/bin/true", "args": [], "pathStyle": "auto" },
    "editor": { "command": "/bin/true", "args": [], "pathStyle": "auto" }
  }
}
EOF

WORKTREE_CONFIG="$TMP/config.json" "$NODE" "$ROOT/server.mjs" > "$TMP/server.log" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
if ! curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then
  echo "测试服务启动失败：" >&2
  cat "$TMP/server.log" >&2
  exit 1
fi

export BASE="http://127.0.0.1:$PORT"
export WT_TEST_TMP="$TMP"

# 请求守卫回归：DNS rebinding / 跨站 / 非 JSON 写请求
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$BASE/api/config")
[[ "$code" == 403 ]] || { echo "FAIL Host 校验：期望 403，实际 $code" >&2; exit 1; }
echo "PASS  Host 校验（DNS rebinding）           403"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'Origin: http://evil.example' \
  -d '{}' "$BASE/api/settings")
[[ "$code" == 403 ]] || { echo "FAIL 跨站 Origin：期望 403，实际 $code" >&2; exit 1; }
echo "PASS  跨站 Origin 被拒绝                   403"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: text/plain' -d '{}' "$BASE/api/settings")
[[ "$code" == 415 ]] || { echo "FAIL 非 JSON 写请求：期望 415，实际 $code" >&2; exit 1; }
echo "PASS  非 JSON 写请求被拒绝                 415"
for t in test-ops.mjs test-file-history.mjs test-fetch-tag.mjs test-tag-create.mjs test-checkout-tag.mjs test-pending.mjs test-clone.mjs test-settings.mjs; do
  echo
  echo "===== $t ====="
  "$NODE" "$HERE/$t"
done
