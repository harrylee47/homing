#!/bin/bash
# 部署到 arm。
#
# 构建失败必须让部署失败并原样打印错误——之前用 tail -1 截输出，
# 结果 tsc 报错被吞掉，显示「部署成功」但跑的还是旧镜像，
# 这比 bug 本身更糟：你以为修好了。
set -euo pipefail

HOST="${1:-arm}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "── 本地检查 ──"
cd "$ROOT"
pnpm typecheck
node scripts/check-core-purity.mjs
pnpm exec vitest run --reporter=dot 2>&1 | tail -3

echo "── 同步 ──"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude data --exclude bark-data \
  --exclude .git --exclude agent --exclude 'docs/dev-plan.md' \
  "$ROOT/" "$HOST:~/sms-gateway/"

echo "── 构建 ──"
if ! ssh -o ConnectTimeout=20 "$HOST" 'cd ~/sms-gateway && docker compose build' 2>&1 | tee /tmp/gw-build.log | grep -E 'error|ERROR|Built' ; then
  :
fi
if grep -qE 'error TS|ERROR:' /tmp/gw-build.log; then
  echo "✗ 构建失败，未部署"
  grep -E 'error TS|ERROR:' /tmp/gw-build.log | head -10
  exit 1
fi

echo "── 启动 ──"
ssh -o ConnectTimeout=20 "$HOST" 'cd ~/sms-gateway && docker compose up -d'
sleep 8
ssh -o ConnectTimeout=20 "$HOST" 'docker ps --filter name=sms-gateway --format "{{.Status}}"'
