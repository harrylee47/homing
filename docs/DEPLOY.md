# 手动部署教程

一键脚本装不了的情况看这里：机器上已经有网站、用宝塔 / 1Panel、或者你就是想自己一步步来。

每一步都写清楚了「为什么」和「怎么验证这步成了」。照着做不会错。

## 目录

- [情况一：干净机器，自己一步步装](#情况一干净机器自己一步步装)
- [情况二：机器上已经有宝塔 / 1Panel](#情况二机器上已经有宝塔--1panel)
- [情况三：已经有 Nginx](#情况三已经有-nginx)
- [情况四：内网自用，不要 HTTPS](#情况四内网自用不要-https)
- [第一次打开控制台：安装口令](#第一次打开控制台安装口令)
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
git clone --depth 1 https://github.com/rikouu/homing.git
cd homing
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

> **从旧版本升上来的先对齐，否则历史消息全部解不开。**
> 早先的 `docker-compose.yml` 漏了把 `GW_DEK` 传进容器（compose 会读同目录的 `.env`，
> 但那只用于文件里的 `${}` 插值，**不会注入容器**），于是真正在用的是网关自动生成的
> `data/dek.key`，`.env` 里那把从头到尾是个摆设——包括你按上面那句「换一把新的」换过的。
> 现在它会真的生效，所以升级前要确认两边是同一把：
>
> ```bash
> cat data/dek.key                     # 有这个文件，它才是正在用的那把
> grep GW_DEK .env                     # 和上面不一样（或者 .env 里根本没有）就要处理
> ```
>
> 处理办法二选一：把 `data/dek.key` 的内容填进 `.env` 的 `GW_DEK=`（推荐，密钥这才算搬出了
> `data/`），或者把 `.env` 里的 `GW_DEK` 那一行删掉（留空会继续回落到 `data/dek.key`）。
> 选前者的话：改完 `docker compose up -d`，**先在控制台里翻一条旧消息确认读得出正文**，
> 再删 `data/dek.key`。顺序反了就没有退路了。

### 4. 起服务

```bash
mkdir -p data bark-data
# 容器里是 uid 10001（非 root）在跑，而这个目录是你用 root 建的。
# 不改属主的话 data/ 一个字节都写不进去：容器起来就 EACCES / SQLITE_CANTOPEN 反复重启。
chown -R 10001:10001 data
docker compose up -d --build
docker compose logs -f gateway     # 看到「网关已启动」就对了，Ctrl-C 退出看日志
```

此时服务监听在**宿主机的 `127.0.0.1:2333`**，**还不能从公网访问**。下一步给它套 HTTPS。

> **端口有两个数，别弄混。** `docker-compose.yml` 里写的是 `127.0.0.1:2333:8070`——
> 宿主机侧是 **2333**，容器里才是 8070。反代一律填 2333；填 8070 的话那个端口在宿主机上
> 根本没人监听，结果是站点 502，而两边配置看上去都「对」。

### 5. 套 HTTPS（Caddy，推荐）

Caddy 会自动申请和续期证书，不用管。

```bash
cat > Caddyfile <<'EOF'
你的域名 {
	reverse_proxy 127.0.0.1:2333
}
EOF

docker run -d --name caddy --restart unless-stopped --network host \
  -v /opt/homing/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /opt/homing/caddy-data:/data \
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

### 7. 取「安装口令」，然后才去开控制台

第一次打开控制台时，配置向导会先问你一个安装口令：

```bash
docker compose exec gateway cat /data/admin.token
```

**为什么有这道门**：从容器起来、到你在浏览器里点完向导为止，这台网关是
「谁先到就归谁」的——连发两个请求就能成为第一个管理员（能建号、停用、
重置任何人的口令）。而这不是「没人知道」：新签的 HTTPS 证书会被记进
公开的[证书透明度日志](https://crt.sh)，实时可查，等于对外广播
「这个地址刚起来一台新服务」。而按上面的步骤走，从起容器到你打开控制台
中间往往隔着改安全组、配反代这些事，窗口是小时级的。

这个口令只用这一次。它就是 `data/admin.token`，也是应急用的长期管理 token——
**和 `.env` 里的 `GW_DEK` 一样，不要和 `data/` 备份在同一处。**

---

## 情况二：机器上已经有宝塔 / 1Panel

面板已经占了 80/443，所以**不要**再起 Caddy，让面板做反代。

### 1. 前三步同上（装 Docker、拉代码、生成密钥）

### 2. 让容器只监听本机

`docker-compose.yml` 里网关默认映射到 `127.0.0.1:2333`（容器里是 8070），正是我们要的。直接起：

```bash
mkdir -p data bark-data
chown -R 10001:10001 data     # 容器以 uid 10001 跑，不改属主起不来
docker compose up -d --build
```

### 3. 面板里加一个网站

宝塔：网站 → 添加站点 → 填域名 → 不要 PHP、不要数据库。
1Panel：网站 → 创建网站 → 反向代理。

然后**申请 SSL 证书**（面板里都有 Let's Encrypt 一键申请）。

### 4. 配反向代理，并且**一定要打开 WebSocket 开关**

- 宝塔：站点设置 → 反向代理 → 添加，目标 URL `http://127.0.0.1:2333`，
  **勾上「启用 WebSocket」**
- 1Panel：网站 → 反向代理 → 目标 `http://127.0.0.1:2333`，**打开 WebSocket**

> 端口是 **2333** 不是 8070：8070 只存在于容器里。指错的表现是站点 502。

> 这一步最容易踩坑：不开 WebSocket，**网页能打开但手机永远连不上**，
> 而且报错很不明显。如果配完手机一直显示「连接中」，先回来检查这个开关。

### 5. 让网关认得面板传来的真实 IP

反代会把访客 IP 放在 `X-Forwarded-For` 头里。网关默认**不采信**这个头——
配错的话任何人都能伪造来源 IP，限速和登录告警会同时失效。

`docker-compose.yml` 已经把本项目那张网**钉在 `172.27.0.0/16`**，并且默认只信任这个网段；
面板跑在宿主机上、经 `127.0.0.1:2333` 进来，在容器里正好呈现为这个网段的网桥地址，
所以**通常什么都不用改**。

（不钉网段而在环境变量里写死一个网段，等于在猜：compose 的默认网段由 Docker 按这台机器上
已有多少网络现分配。猜错不会报错，表现是所有请求的来源都成了同一个地址——限速按单一 IP 算、
陌生网段登录告警永不触发。）

两种要动手的情况：

```bash
# ① 这个网段被机器上别的网络占了：docker compose up 会直接报 Pool overlaps 停下来。
#    换一个空闲网段，两个变量必须写成同一个值。
echo 'GW_SUBNET=172.28.0.0/16'        >> .env
echo 'GW_TRUSTED_PROXY=172.28.0.0/16' >> .env

# ② 反代自己也是容器、而且在另一张 docker 网络里：把那张网的网段也加上（逗号分隔多个）
docker network ls --filter name=_default --format '{{.Name}}'
docker network inspect <那张网> -f '{{(index .IPAM.Config 0).Subnet}}'
echo 'GW_TRUSTED_PROXY=172.27.0.0/16,172.18.0.0/16' >> .env

docker compose up -d
```

验证钉住了：

```bash
docker network inspect "$(basename "$PWD")_default" -f '{{(index .IPAM.Config 0).Subnet}}'
# 应当输出 172.27.0.0/16，和 GW_TRUSTED_PROXY 是同一个值
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
        proxy_pass http://127.0.0.1:2333;
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

`GW_TRUSTED_PROXY` 通常不用设：compose 已经把自己那张网钉死，默认只信任它（见上一节）。
Nginx 跑在宿主机上时就是这种情况；Nginx 自己在别的 docker 网络里才需要补一个网段。

---

## 情况四：内网自用，不要 HTTPS

只在局域网里用、不打算从外网访问时可以这么干，但要知道代价：
**短信正文和登录口令在局域网里是明文传输的**。

```bash
echo 'GW_BASE_URL=http://192.168.1.100:2333' >> .env
```

然后把 `docker-compose.yml` 里网关的端口映射从 `127.0.0.1:2333:8070` 改成 `2333:8070`
（去掉前面那段回环地址就是对所有网卡开放；冒号右边的 8070 是容器内端口，不要动）。

手机 App 配对时地址填 `ws://192.168.1.100:2333/ws`。
注意：**正式版 APK 禁止明文连接**，这种用法需要用 debug 版 APK。

---

## 第一次打开控制台：安装口令

**不管上面走的是哪一种**，第一次打开控制台时向导都会先问一个安装口令：

```bash
docker compose exec gateway cat /data/admin.token
```

理由见[情况一的第 7 步](#7-取安装口令然后才去开控制台)：在你点完向导之前，
这台网关是「谁先到就归谁」的，而新签的证书会被公开日志实时广播出去。
只用这一次。

---

## 环境变量对照表

都写在 `.env` 里。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GW_DEK` | 是 | 数据密钥，64 位十六进制。**只生成一次，丢了历史全废**。留空会回落到 `data/dek.key`——那等于密钥和密文放在同一个目录、同一份备份里，不要这么用 |
| `GW_ADMIN_TOKEN` | 否 | 应急管理 token，也是首次配置向导的「安装口令」。不设就用首启生成的 `data/admin.token` |
| `GW_BASE_URL` | 是 | 对外访问地址，如 `https://gw.example.com`。配对二维码和深链都用它 |
| `GW_PORT` | 否 | 默认 8070 |
| `GW_HOST` | 否 | 默认 `0.0.0.0`（容器内） |
| `GW_DATA_DIR` | 否 | 默认 `/data`，数据库放这儿 |
| `GW_TRUSTED_PROXY` | 否 | 可信反代网段，默认就是下面 `GW_SUBNET` 的值。要信任多个网段用逗号分隔。**不要写 `0.0.0.0/0`**，那等于任何人都能伪造来源 IP |
| `GW_SUBNET` | 否 | compose 给自己那张网钉的网段，默认 `172.27.0.0/16`。和别的网络撞了（`Pool overlaps`）就改这里，并把 `GW_TRUSTED_PROXY` 改成同一个值 |
| `GW_BARK_UPSTREAM` | 否 | 自建 Bark 地址，compose 默认 `http://bark:8080` |
| `GW_ADMIN_TOKEN` | 否 | 自动化用的长期 token。不设会自动生成到 `data/admin.token` |

---

## 升级与备份

### 升级

```bash
cd /opt/homing
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
grep GW_DEK .env
```

这一行是空的或者根本没有，说明你还在用 `data/dek.key`——那就没有「分开存」可言了，
先按「情况一 第 3 步」的提示把它搬进 `.env`。

**这两样必须分开存。** 只有数据库没有密钥，短信正文解不开；
只有密钥没有数据库，什么都没有。两样一起泄露，等于短信明文泄露。

### 恢复

把 `data/` 解压回去，`.env` 里填回同一个 `GW_DEK`，`docker compose up -d` 即可。

---

## 出问题了怎么查

```bash
cd /opt/homing

# 网关日志（最有用）
docker compose logs -f --tail 100 gateway

# 容器状态，Up 才是正常
docker compose ps

# 接口通不通
curl -i http://127.0.0.1:2333/api/setup/status
```

| 症状 | 多半是 |
| --- | --- |
| 站点 502、宿主机上 `curl 127.0.0.1:2333` 也不通 | 容器没起来，看下一行 |
| 站点 502、但 `curl 127.0.0.1:2333` 通 | 反代指到 8070 去了，那个端口只存在于容器里 |
| 容器反复重启、日志里是 EACCES / SQLITE_CANTOPEN | `data/` 属主不是 uid 10001：`chown -R 10001:10001 data` |
| 升级后历史消息全成了乱码 / 打不开 | `.env` 的 `GW_DEK` 和原来在用的 `data/dek.key` 不是同一把，见「情况一 第 3 步」 |
| 网页能开、手机连不上 | 反代没开 WebSocket |
| 网页打不开、证书报错 | 安全组没放行 80/443 |
| 容器反复重启 | 看 `docker compose logs gateway`，多半是 `GW_DEK` 格式不对 |
| 手机连上又断 | 反代的 `proxy_read_timeout` 太短 |
| 登录提示「尝试过于频繁」 | 限速触发了，等 15 分钟；或者 `GW_TRUSTED_PROXY` 配错导致所有人共用一个 IP |

日志里不会出现短信正文、验证码、Bot Token、配对码——这是故意的，
因为日志会进 Docker 的文件和面板界面，等于长期留存。
