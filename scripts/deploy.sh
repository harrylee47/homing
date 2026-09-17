#!/bin/bash
# 部署到你自己的服务器。
#
#   HOMING_DEPLOY_HOST=my-vps HOMING_HEALTH_URL=https://gw.example.com/api/setup/status \
#     bash scripts/deploy.sh
#
# HOST 是 ~/.ssh/config 里的主机别名。
#
# 构建失败必须让部署失败并原样打印错误——之前用 tail -1 截输出，
# 结果 tsc 报错被吞掉，显示「部署成功」但跑的还是旧镜像，
# 这比 bug 本身更糟：你以为修好了。
set -euo pipefail

HOST="${1:-${HOMING_DEPLOY_HOST:-}}"
[ -n "$HOST" ] || { echo "用法：bash scripts/deploy.sh <ssh 主机别名>（或设 HOMING_DEPLOY_HOST）" >&2; exit 1; }
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

# 密钥对齐检查。docker-compose.yml 以前漏了把 GW_DEK 传进容器，所以线上真正在用的
# 可能是网关自动生成的 data/dek.key，而 .env 里那把从没生效过。现在它生效了：
# 两把不一样的话，这次部署之后全部历史消息都解不开——**而且容器照常启动、不报任何错**，
# 你要等到打开控制台才发现。所以宁可在这里停住。
echo "── 密钥对齐 ──"
DEK_CHECK=$(ssh -o ConnectTimeout=20 "$HOST" 'bash -s' <<'REMOTE' || true
cd ~/sms-gateway 2>/dev/null || exit 0
# 只留十六进制字符：引号、空格、CR、换行都不算差异，大小写也不算
env_dek=$(sed -n 's/^GW_DEK=//p' .env 2>/dev/null | head -1 | tr -cd '0-9a-fA-F' | tr 'A-F' 'a-f')
file_dek=$(cat data/dek.key 2>/dev/null | tr -cd '0-9a-fA-F' | tr 'A-F' 'a-f')
# 先看格式：.env 里填了占位文字时，上面那行 tr 会把它过滤成空串，
# 于是被判成「没配」而放行，容器却拿到一个垃圾串、启动即 crash-loop，
# 而守卫打印的那句话是误导的
if [ -n "$(sed -n 's/^GW_DEK=//p' .env 2>/dev/null | head -1 | tr -d '[:space:]\"'"'"'')" ] && [ ${#env_dek} -ne 64 ]; then
  echo BAD_ENV_DEK
elif [ -n "$env_dek" ] && [ -n "$file_dek" ] && [ "$env_dek" != "$file_dek" ]; then
  echo MISMATCH
elif [ -z "$env_dek" ] && [ -n "$file_dek" ]; then
  echo FILE_ONLY
fi
REMOTE
)
case "$DEK_CHECK" in
  BAD_ENV_DEK)
    echo "✗ 服务器上 .env 里的 GW_DEK 不是 64 位十六进制，容器起不来。先改对再部署。"
    exit 1
    ;;
  MISMATCH)
    echo "✗ 服务器上 .env 的 GW_DEK 与 data/dek.key 不是同一把，未部署。"
    echo "  正在用的是 data/dek.key（旧 compose 没把 GW_DEK 传进容器）。"
    echo "  把 data/dek.key 的内容填进 .env 的 GW_DEK=，或删掉 .env 里那一行（留空会继续用文件），"
    echo "  再重跑本脚本。详见 docs/DEPLOY.md「情况一 第 3 步」。"
    exit 1
    ;;
  FILE_ONLY)
    echo "! 服务器在用 data/dek.key，密钥和密文在同一个目录、同一份备份里。"
    echo "  按 docs/DEPLOY.md 把它搬进 .env 的 GW_DEK 更稳妥。这次照常部署。"
    ;;
esac

echo "── 构建 ──"
# 判据是**构建自己的退出码**，不是「日志里有没有 error TS」。
# 原来写成 `ssh … | tee | grep …`，管道的退出码是 grep 的、还被 `:` 吞掉，
# 于是只剩字符串匹配这一个判据：断网拉不到基础镜像、磁盘满、OOM、docker daemon
# 报错时日志里没有那几个字，脚本照样往下 up -d，起的是上一次的旧镜像，
# 最后打印「✓ 部署完成」—— 这正是文件开头那段说的、比 bug 本身更糟的情形。
# 输出经 tee 原样打印，不截断。
BUILD_LOG="/tmp/gw-build.log"
if ! ssh -o ConnectTimeout=20 "$HOST" 'cd ~/sms-gateway && docker compose build' 2>&1 | tee "$BUILD_LOG"; then
  echo "✗ 构建失败，未部署（上面是构建的原样输出）"
  exit 1
fi
# 退出码为 0 但日志里有 tsc 报错的情况（构建缓存、多阶段吞掉失败）再兜一道。
# 这里宁可误停：不部署没有代价，部署了旧镜像却以为修好了才有代价。
if grep -qE 'error TS|ERROR:' "$BUILD_LOG"; then
  echo "✗ 构建退出码是 0，但日志里有报错，未部署"
  grep -E 'error TS|ERROR:' "$BUILD_LOG" | head -10
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
    if [ -n "${HOMING_HEALTH_URL:-${GW_HEALTH_URL:-}}" ]; then
      curl -fsS -o /dev/null --max-time 10 "${HOMING_HEALTH_URL:-${GW_HEALTH_URL}}" \
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
