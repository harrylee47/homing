# 手动部署教程

一键脚本装不了的情况看这里：机器上已经有网站、用宝塔 / 1Panel、或者你就是想自己一步步来。

每一步都写清楚了「为什么」和「怎么验证这步成了」。照着做不会错。

## 目录

- [情况一：干净机器，自己一步步装](#情况一干净机器自己一步步装)
- [情况二：机器上已经有宝塔 / 1Panel](#情况二机器上已经有宝塔--1panel)
- [情况三：已经有 Nginx](#情况三已经有-nginx)
- [情况四：内网自用，不要 HTTPS](#情况四内网自用不要-https)
- [环境变量对照表](#环境变量对照表)
- [升级与备份](#升级与备份)
- [出问题了怎么查](#出问题了怎么查)

---

## 情况一：干净机器，自己一步步装

### 1. 装 Docker

```bash
curl -fsSL https://get.docker.com | sh          # 国内机器加 -s -- --mirror Aliyun
systemctl enable --now docker
docker version                                   # 能打印版本就成了
```

### 2. 拉代码

```bash
mkdir -p /opt && cd /opt
git clone --depth 1 https://github.com/rikouu/smsgateway.git
cd smsgateway
```

### 3. 生成数据密钥

短信正文、渠道 Token 都用它加密。**只生成一次**，丢了历史消息就再也解不开。

```bash
echo "GW_DEK=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > .env
echo "GW_BASE_URL=https://你的域名" >> .env
chmod 600 .env
cat .env        # 把 GW_DEK 这一行抄到密码管理器里，现在就抄
```

> **备份它**，而且不要和 `data/` 备份到同一个地方。
> 两样东西一起丢给别人，等于把你所有的短信明文交出去。

### 4. 起服务

```bash
mkdir -p data bark-data
docker compose up -d --build
docker compose logs -f gateway     # 看到「网关已启动」就对了，Ctrl-C 退出看日志
```

此时服务监听在 `127.0.0.1:8070`，**还不能从公网访问**。下一步给它套 HTTPS。

### 5. 套 HTTPS（Caddy，推荐）

Caddy 会自动申请和续期证书，不用管。

```bash
cat > Caddyfile <<'EOF'
你的域名 {
	reverse_proxy 127.0.0.1:8070
}
EOF

docker run -d --name caddy --restart unless-stopped --network host \
  -v /opt/smsgateway/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /opt/smsgateway/caddy-data:/data \
  caddy:2-alpine
```

**没有域名**就把「你的域名」换成 `你的IP用横杠连起来.sslip.io`，
比如 IP 是 `1.2.3.4` 就写 `1-2-3-4.sslip.io`。sslip.io 会把它解析到你的 IP，
是真实域名，能申请到正式证书。

别忘了在云服务商的**安全组**里放行 80 和 443。

验证：`curl https://你的域名/api/setup/status`，返回 `{"initialized":false}` 就成了。

### 6. 告诉网关它的对外地址

`.env` 里的 `GW_BASE_URL` 要和实际访问地址一致，否则配对二维码、Bark 深链都会指错地方。

```bash
sed -i 's|^GW_BASE_URL=.*|GW_BASE_URL=https://你的域名|' .env
docker compose up -d
```

---

## 情况二：机器上已经有宝塔 / 1Panel

面板已经占了 80/443，所以**不要**再起 Caddy，让面板做反代。

### 1. 前三步同上（装 Docker、拉代码、生成密钥）

### 2. 让容器只监听本机

`docker-compose.yml` 里网关默认映射到 `127.0.0.1:8070`，正是我们要的。直接起：

```bash
docker compose up -d --build
```

### 3. 面板里加一个网站

宝塔：网站 → 添加站点 → 填域名 → 不要 PHP、不要数据库。
1Panel：网站 → 创建网站 → 反向代理。

然后**申请 SSL 证书**（面板里都有 Let's Encrypt 一键申请）。

### 4. 配反向代理，并且**一定要打开 WebSocket 开关**

- 宝塔：站点设置 → 反向代理 → 添加，目标 URL `http://127.0.0.1:8070`，
  **勾上「启用 WebSocket」**
- 1Panel：网站 → 反向代理 → 目标 `http://127.0.0.1:8070`，**打开 WebSocket**

> 这一步最容易踩坑：不开 WebSocket，**网页能打开但手机永远连不上**，
> 而且报错很不明显。如果配完手机一直显示「连接中」，先回来检查这个开关。

### 5. 让网关认得面板传来的真实 IP

反代会把访客 IP 放在 `X-Forwarded-For` 头里。网关默认**不采信**这个头——
配错的话任何人都能伪造来源 IP，限速和登录告警会同时失效。

在 `.env` 里加一行，写你的 Docker 网段：

```bash
# 先查网段
docker network inspect bridge -f '{{(index .IPAM.Config 0).Subnet}}'
# 假设输出 172.17.0.0/16，就写：
echo 'GW_TRUSTED_PROXY=172.17.0.0/16' >> .env
docker compose up -d
```

---

## 情况三：已经有 Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name 你的域名;

    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8070;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # WebSocket 必需的三行。少了它们网页能开、手机连不上
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 长连接要活得久一点，否则每分钟断一次重连
        proxy_read_timeout 600s;
    }
}
```

同样要在 `.env` 里设 `GW_TRUSTED_PROXY`（见上一节）。

---

## 情况四：内网自用，不要 HTTPS

只在局域网里用、不打算从外网访问时可以这么干，但要知道代价：
**短信正文和登录口令在局域网里是明文传输的**。

```bash
echo 'GW_BASE_URL=http://192.168.1.100:8070' >> .env
```

然后把 `docker-compose.yml` 里网关的端口映射从 `127.0.0.1:8070:8070` 改成 `8070:8070`。

手机 App 配对时地址填 `ws://192.168.1.100:8070/ws`。
注意：**正式版 APK 禁止明文连接**，这种用法需要用 debug 版 APK。

---

## 环境变量对照表

都写在 `.env` 里。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GW_DEK` | 是 | 数据密钥，64 位十六进制。**只生成一次，丢了历史全废** |
| `GW_BASE_URL` | 是 | 对外访问地址，如 `https://gw.example.com`。配对二维码和深链都用它 |
| `GW_PORT` | 否 | 默认 8070 |
| `GW_HOST` | 否 | 默认 `0.0.0.0`（容器内） |
| `GW_DATA_DIR` | 否 | 默认 `/data`，数据库放这儿 |
| `GW_TRUSTED_PROXY` | 反代时必填 | 可信反代网段，如 `172.17.0.0/16`。**不要写 `0.0.0.0/0`** |
| `GW_BARK_UPSTREAM` | 否 | 自建 Bark 地址，compose 默认 `http://bark:8080` |
| `GW_ADMIN_TOKEN` | 否 | 自动化用的长期 token。不设会自动生成到 `data/admin.token` |

---

## 升级与备份

### 升级

```bash
cd /opt/smsgateway
git pull
docker compose up -d --build
```

数据库迁移会在启动时自动跑。升级不会动你的数据。

### 备份

要备份的只有两样：

```bash
# 1. 数据库（历史消息、规则、渠道）
tar czf backup-$(date +%F).tar.gz data/

# 2. 数据密钥
cat .env | grep GW_DEK
```

**这两样必须分开存。** 只有数据库没有密钥，短信正文解不开；
只有密钥没有数据库，什么都没有。两样一起泄露，等于短信明文泄露。

### 恢复

把 `data/` 解压回去，`.env` 里填回同一个 `GW_DEK`，`docker compose up -d` 即可。

---

## 出问题了怎么查

```bash
cd /opt/smsgateway

# 网关日志（最有用）
docker compose logs -f --tail 100 gateway

# 容器状态，Up 才是正常
docker compose ps

# 接口通不通
curl -i http://127.0.0.1:8070/api/setup/status
```

| 症状 | 多半是 |
| --- | --- |
| 网页能开、手机连不上 | 反代没开 WebSocket |
| 网页打不开、证书报错 | 安全组没放行 80/443 |
| 容器反复重启 | 看 `docker compose logs gateway`，多半是 `GW_DEK` 格式不对 |
| 手机连上又断 | 反代的 `proxy_read_timeout` 太短 |
| 登录提示「尝试过于频繁」 | 限速触发了，等 15 分钟；或者 `GW_TRUSTED_PROXY` 配错导致所有人共用一个 IP |

日志里不会出现短信正文、验证码、Bot Token、配对码——这是故意的，
因为日志会进 Docker 的文件和面板界面，等于长期留存。
