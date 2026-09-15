#!/bin/bash
# 部署到你自己的服务器。
#
#   SMSGW_DEPLOY_HOST=my-vps SMSGW_HEALTH_URL=https://gw.example.com/api/setup/status \
#     bash scripts/deploy.sh
#
# HOST 是 ~/.ssh/config 里的主机别名。
#
# 构建失败必须让部署失败并原样打印错误——之前用 tail -1 截输出，
# 结果 tsc 报错被吞掉，显示「部署成功」但跑的还是旧镜像，
# 这比 bug 本身更糟：你以为修好了。
set -euo pipefail

HOST="${1:-${SMSGW_DEPLOY_HOST:-}}"
[ -n "$HOST" ] || { echo "用法：bash scripts/deploy.sh <ssh 主机别名>（或设 SMSGW_DEPLOY_HOST）" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "── 本地检查 ──"
cd "$ROOT"
pnpm typecheck
node scripts/check-core-purity.mjs
pnpm exec vitest run --reporter=dot 2>&1 | tail -3

echo "── 同步 ──"
# .env 必须排除：它只存在于服务器上，--delete 会把它删掉，
# 表现为「部署完容器起不来了，说缺环境变量」
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude data --exclude bark-data \
  --exclude .env --exclude Caddyfile --exclude caddy-data \
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

# 启动崩溃与构建失败一样致命，而且更隐蔽：容器会 Restarting 循环，
# 而端口仍被旧连接占着，看上去像是「部署成功了但行为没变」。
STATUS=$(ssh -o ConnectTimeout=20 "$HOST" 'docker ps -a --filter name=sms-gateway --format "{{.Status}}"')
echo "$STATUS"
case "$STATUS" in
  Up*)
    # 没配健康检查地址就只看容器状态，不假装检查过
    if [ -n "${SMSGW_HEALTH_URL:-${GW_HEALTH_URL:-}}" ]; then
      curl -fsS -o /dev/null --max-time 10 "${SMSGW_HEALTH_URL:-${GW_HEALTH_URL}}" \
        || { echo "✗ 容器在跑但接口不通"; exit 1; }
    fi
    echo "✓ 部署完成"
    ;;
  *)
    echo "✗ 容器未正常运行，最近日志："
    ssh -o ConnectTimeout=20 "$HOST" 'docker logs sms-gateway --tail 30'
    exit 1
    ;;
esac
