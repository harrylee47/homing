#!/usr/bin/env bash
#
# 短信网关一键安装脚本。
#
# 面向「刚买的一台干净 VPS」：没有面板、没有 Docker、没有域名。
# 跑完你会得到一个带正式 HTTPS 证书的控制台地址，直接能打开。
#
#   bash install.sh              正式安装
#   bash install.sh --dry-run    只打印会做什么，不改动系统
#
# 不需要域名的原理：用 sslip.io —— 一个公共 DNS 服务，把
# 1-2-3-4.sslip.io 解析到 1.2.3.4。它是真实域名，所以 Let's Encrypt
# 肯给签证书，你既不用买域名也不会看到「证书不受信任」的红色警告。
#
set -euo pipefail

# ── 可调项（都可以用环境变量覆盖）────────────────────────────

REPO="${HOMING_REPO:-https://github.com/rikouu/homing.git}"
DIR="${HOMING_DIR:-/opt/homing}"
BRANCH="${HOMING_BRANCH:-main}"
# 留空表示自动探测公网 IP
PUBLIC_IP="${HOMING_IP:-}"
# 不想用 sslip.io、自己有域名时填这里
DOMAIN="${HOMING_DOMAIN:-}"
# Let's Encrypt 的过期提醒邮箱。留空则不注册邮箱（仍能签发）
EMAIL="${HOMING_EMAIL:-}"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# ── 输出 ────────────────────────────────────────────────────

c_ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m·\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
step()   { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

run() {
  if [[ $DRY_RUN == 1 ]]; then
    printf '   [dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

die() { c_err "$*"; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────

step "环境检查"

[[ $DRY_RUN == 1 || $EUID -eq 0 ]] || die "请用 root 运行：sudo bash install.sh"

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  c_ok "系统 ${PRETTY_NAME:-$ID}"
else
  c_warn "认不出这个系统，继续尝试"
  ID=unknown
fi

case "${ID:-}" in
  ubuntu|debian|centos|rhel|rocky|almalinux|alinux|anolis|opencloudos|tencentos) ;;
  *) c_warn "没在这个发行版上验证过，装不上的话按 README 里的手动步骤来" ;;
esac

ARCH=$(uname -m)
[[ "$ARCH" == "x86_64" || "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] \
  || die "不支持的 CPU 架构 $ARCH"
c_ok "架构 $ARCH"

# ── 公网 IP ─────────────────────────────────────────────────

step "确定访问地址"

detect_ip() {
  # 依次尝试几个来源：云厂商元数据最准，公共服务兜底
  local ip
  for url in \
    "http://100.100.100.200/latest/meta-data/eipv4" \
    "http://169.254.169.254/latest/meta-data/public-ipv4" \
    "https://api.ipify.org" \
    "https://ifconfig.me/ip" \
    "https://ipinfo.io/ip"
  do
    ip=$(curl -fsS --max-time 4 "$url" 2>/dev/null | tr -d '[:space:]') || continue
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && { echo "$ip"; return 0; }
  done
  return 1
}

if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP=$(detect_ip) || die "探测不到公网 IP，请用 HOMING_IP=1.2.3.4 bash install.sh 指定"
fi
c_ok "公网 IP $PUBLIC_IP"

if [[ -z "$DOMAIN" ]]; then
  # sslip.io 支持把点换成横杠，避免某些证书场景下的通配符问题
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  c_info "没指定域名，使用 $DOMAIN（sslip.io 会把它解析到你的 IP）"
else
  c_ok "使用自带域名 $DOMAIN"
fi

BASE_URL="https://${DOMAIN}"

# ── 端口占用与放行 ──────────────────────────────────────────

step "检查端口"

port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | grep -qE "[:.]$1[[:space:]]"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | grep -qE "[:.]$1[[:space:]]"
  else
    return 1
  fi
}

for p in 80 443; do
  if port_busy "$p"; then
    die "$p 端口已被占用。这台机器上已经有 Web 服务（宝塔/1Panel/Nginx）时，
     请按 README 的「已有 Web 服务时怎么装」一节来，不要用这个脚本。"
  fi
done
c_ok "80 / 443 空闲"

c_warn "云服务器还要在控制台的【安全组】里放行 80 和 443，否则签不到证书。"
c_warn "阿里云：ECS → 安全组 → 配置规则 → 入方向 → 手动添加 80/443。"

# ── Docker ──────────────────────────────────────────────────

step "安装 Docker"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  c_ok "Docker 已就绪，跳过"
else
  c_info "正在安装 Docker（国内机器走阿里云镜像，会快很多）"
  if curl -fsS --max-time 4 https://www.google.com >/dev/null 2>&1; then
    run "curl -fsSL https://get.docker.com | sh"
  else
    run "curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun"
  fi
  run "systemctl enable --now docker"
  command -v docker >/dev/null 2>&1 || [[ $DRY_RUN == 1 ]] || die "Docker 装失败，请看上面的报错"
  c_ok "Docker 安装完成"
fi

# ── 取代码 ──────────────────────────────────────────────────

step "下载源码"

if command -v git >/dev/null 2>&1; then
  :
else
  c_info "安装 git"
  if command -v apt-get >/dev/null 2>&1; then
    run "apt-get update -qq && apt-get install -y -qq git"
  else
    run "yum install -y -q git"
  fi
fi

if [[ -d "$DIR/.git" ]]; then
  c_info "已存在，拉取最新代码"
  run "git -C '$DIR' fetch --depth 1 origin '$BRANCH' && git -C '$DIR' reset --hard 'origin/$BRANCH'"
else
  run "git clone --depth 1 -b '$BRANCH' '$REPO' '$DIR'"
fi
c_ok "源码在 $DIR"

# ── 生成配置 ────────────────────────────────────────────────

step "生成配置"

run "mkdir -p '$DIR/data' '$DIR/bark-data' '$DIR/caddy-data'"

# 数据密钥。短信正文与渠道凭证都用它加密，丢了等于历史全部作废，
# 所以只生成一次；已存在就原样保留。
ENV_FILE="$DIR/.env"
if [[ -f "$ENV_FILE" ]] && grep -q '^GW_DEK=' "$ENV_FILE" 2>/dev/null; then
  c_ok "已有数据密钥，保留不动"
else
  DEK=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  if [[ $DRY_RUN == 1 ]]; then
    printf '   [dry-run] 写入 %s（含新生成的 GW_DEK）\n' "$ENV_FILE"
  else
    cat > "$ENV_FILE" <<EOF
# 数据密钥：短信正文、渠道凭证都用它加密。
# 丢了 = 历史消息全部无法解密。**请立刻抄走备份，且不要和 data/ 放在同一处。**
GW_DEK=$DEK
GW_BASE_URL=$BASE_URL
EOF
    chmod 600 "$ENV_FILE"
  fi
  c_ok "已生成数据密钥"
fi

COMPOSE="$DIR/docker-compose.deploy.yml"
if [[ $DRY_RUN == 1 ]]; then
  printf '   [dry-run] 写入 %s\n' "$COMPOSE"
else
  cat > "$COMPOSE" <<'YAML'
services:
  gateway:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      GW_HOST: 0.0.0.0
      GW_PORT: "8070"
      GW_DATA_DIR: /data
      GW_BARK_UPSTREAM: http://bark:8080
      # 只信任同一个 docker 网络里的反代传来的 X-Forwarded-For。
      # 写成 0.0.0.0/0 的话，任何人都能伪造来源 IP，限速与登录告警同时失效。
      GW_TRUSTED_PROXY: 172.16.0.0/12
    volumes:
      - ./data:/data
    depends_on:
      - bark

  # 自建 Bark：验证码推送的主通道，不对外暴露端口
  bark:
    image: finab/bark-server:latest
    restart: unless-stopped
    volumes:
      - ./bark-data:/data

  # Caddy 负责 HTTPS。证书自动申请、自动续期，不用管
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
    depends_on:
      - gateway
YAML
fi

CADDYFILE="$DIR/Caddyfile"
if [[ $DRY_RUN == 1 ]]; then
  printf '   [dry-run] 写入 %s（域名 %s）\n' "$CADDYFILE" "$DOMAIN"
else
  {
    [[ -n "$EMAIL" ]] && printf '{\n\temail %s\n}\n\n' "$EMAIL"
    cat <<EOF
${DOMAIN} {
	# WebSocket 会自动透传，不用额外配置——这一点比 Nginx 省心得多
	reverse_proxy gateway:8070
}
EOF
  } > "$CADDYFILE"
fi
c_ok "配置已生成"

# ── 启动 ────────────────────────────────────────────────────

step "构建并启动（第一次要几分钟）"

run "cd '$DIR' && docker compose -f docker-compose.deploy.yml build"
run "cd '$DIR' && docker compose -f docker-compose.deploy.yml up -d"

if [[ $DRY_RUN == 0 ]]; then
  c_info "等待证书签发…"
  for i in $(seq 1 30); do
    if curl -fsS --max-time 5 "$BASE_URL/api/setup/status" >/dev/null 2>&1; then
      c_ok "HTTPS 已就绪"
      break
    fi
    sleep 4
    [[ $i == 30 ]] && c_warn "还没通。多半是安全组没放行 80/443，放行后等一两分钟会自己好。"
  done
fi

# ── 完成 ────────────────────────────────────────────────────

step "装好了"

cat <<EOF

  控制台地址   ${BASE_URL}
  Agent 地址   wss://${DOMAIN}/ws   （手机配对时用，控制台会给二维码，不用手打）

  接下来：
    1. 用手机或电脑浏览器打开控制台，按向导设置口令与两步验证
    2. 在「设备」页生成配对码，用手机 App 扫码配对
    3. 在「渠道」页加一个 Telegram 或 Bark

  常用命令（都在 $DIR 下执行）：
    docker compose -f docker-compose.deploy.yml logs -f gateway    看日志
    docker compose -f docker-compose.deploy.yml restart gateway    重启
    docker compose -f docker-compose.deploy.yml down               停止

EOF

c_warn "务必备份 $DIR/.env 里的 GW_DEK，并且不要和 data/ 放在同一个地方。"
c_warn "它丢了，所有历史消息都解不开——没有找回办法。"
