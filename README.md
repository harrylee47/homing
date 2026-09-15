# sms-gateway

自托管的短信 / 来电事件网关：安卓机采集，服务端集中规则、渠道与历史，推送到 Telegram / Bark / Webhook。

基于 [SmsForwarder](https://github.com/pppscn/SmsForwarder) 裁剪改造，GPL-3.0。

> **状态：开发中（M3）。** 收发双向 + Web 控制台已可用：
> 短信到达 → Telegram 推送约 1.1 秒；发送可见 accepted → sent → delivered；
> 控制台含口令 + 强制 TOTP、消息检索、规则编辑与「用历史消息试跑」。

## Scope 声明

本项目面向**个人自用**场景：使用者自持 SIM 卡、自持设备、自托管服务端。

明确不支持：多卡批量管理、主叫号码改写、语音中继、代收验证码 / 接码服务。
使用者需自行遵守所在司法辖区的法律法规。

## 开发

需要 Node >= 24（用到内置 `node:sqlite`）。

```bash
pnpm install
pnpm dev              # 启动服务端，默认 127.0.0.1:8070
pnpm test             # 单元测试
pnpm typecheck
pnpm lint:core        # 检查 core 层没有引入运行时特有依赖
```

跑单个测试文件：`pnpm exec vitest run src/core/__tests__/session.test.ts`

### 本地验证链路（无需真机）

```bash
pnpm dev &
node scripts/add-device.mjs "JP-Gateway-01"     # 打印 device_id 与 token
node scripts/sim-agent.mjs <device_id> <token>  # 模拟 Agent 接入并上报一条短信
```

## 安卓 Agent 开发环境

命令行工具链即可，不需要 Android Studio：

```bash
brew install --cask temurin@21 android-commandlinetools
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
yes | sdkmanager --licenses
sdkmanager --install "platform-tools" "emulator" "platforms;android-34" \
  "build-tools;35.0.0" "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n gw-test -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_6
```

无界面启动模拟器并注入事件：

```bash
$ANDROID_HOME/emulator/emulator -avd gw-test -no-window -no-audio -no-boot-anim &
adb emu sms send 95533 "【建设银行】验证码 123456"   # 注入短信
adb emu gsm call 13800138000                        # 模拟来电
adb emu power capacity 15                           # 改电量
adb shell svc wifi disable                          # 断网，测离线补传
```

模拟器覆盖除**保活、真实运营商送达回执、双卡、长稳**以外的全部场景，
这几项必须在目标真机上验收（计划 §13 M0 / M5）。

## API

**首次启动必须先完成配置向导**：未初始化前，除向导外所有路由（含 API 与 WS）一律返回 403。
打开控制台按提示设置管理员口令并绑定 TOTP 即可。

人使用控制台走会话（口令 + TOTP 登录，30 分钟无操作超时，绑定 UA 与 IP 段）。
自动化脚本可用 `data/admin.token` 里的长期 token（或 `GW_ADMIN_TOKEN` 注入）。
两者都走 `Authorization: Bearer`，不用 Cookie——天然免疫 CSRF。
未认证请求一律返回 404 而非 401。

```
POST   /api/devices/pairing-code   生成一次性配对码（TTL 5 分钟）
POST   /api/pair                   Agent 用配对码换长期凭证（无需鉴权）
GET    /api/devices                设备列表与在线状态
DELETE /api/devices/:id/token      吊销凭证并踢下线

GET    /api/channels               渠道列表（不返回配置明文）
POST   /api/channels               新增渠道
POST   /api/channels/:id/test      发送测试消息
DELETE /api/channels/:id

GET    /api/rules                  规则列表
POST   /api/rules                  新增/更新规则
DELETE /api/rules/:id

POST   /api/outbound               下发短信（限速 20 条/小时）
GET    /api/outbound/:id            查询发送状态
GET    /api/outbound                发送历史

GET    /api/events?kind=&limit=&offset=
GET    /api/stats                  总览统计
POST   /api/rules/test             用历史消息试跑规则
GET    /api/health

GET    /api/setup/status           是否已初始化（无需鉴权）
POST   /api/setup/password         向导第一步：设管理员口令
POST   /api/setup/verify           向导第二步：验证 TOTP 并完成初始化
POST   /api/auth/login             口令 + TOTP 换会话
POST   /api/auth/logout
POST   /api/auth/password          改口令（会使全部会话失效）
```

## Bark（可选）

`docker-compose.yml` 里带一个自建 bark-server。它**不对外暴露端口**，由网关在
`/bark/*` 反代——所以不必为 Bark 单独建站或申请证书。

这台 Bark **也可以给你的其它服务用**：推送地址 `https://<网关域名>/bark/<设备Key>`。
控制台「渠道」页可调开放档位：

| 档位 | 行为 |
|---|---|
| `push`（默认） | 允许推送，**禁止注册**。其它服务拿已知的设备 Key 就能推；陌生人无法注册新设备，也就无法把这台服务器当免费中转——Key 是随机串，不知道就推不了 |
| `full` | 注册也开放。只在用 Bark App 绑定新设备时临时调到这一档 |
| `off` | 外部完全不可用 |

被拒的请求返回 404 而非 403，不确认这里存在 Bark 服务。

三档都不影响两条内部通路：网关自己推送走 `http://bark:8080`（渠道配置里
填这个，控制台自动预填），arm 本机的其它服务可用 `http://127.0.0.1:2334`。

绑定新设备的流程：档位调 `full` → Bark App 服务器填 `https://<网关域名>/bark`
→ 拿到设备 Key → 填进渠道 → 档位调回 `push`。

不需要 Bark 就删掉 compose 里的 `bark` 服务并去掉 `GW_BARK_UPSTREAM`。

## 多设备

可以配对多台设备（每张 SIM 一台）。按设备分流靠**规则**而不是给渠道绑设备——
一套机制做到底，两套并行的分流会在冲突时行为不可预期。

```
规则「日本卡验证码」  限定设备 = A25-JP   → Bark-JP
规则「国内卡验证码」  限定设备 = A25-CN   → Telegram-CN
规则「广告」          不限设备            → 只归档
```

渠道保持全局，谁都能用；哪台设备走哪个渠道由规则决定。规则编辑器里勾选
「限定设备」即可，只有一台设备时该选项会隐藏。

有多台设备时，通知会自动带上来源设备名（Telegram 加一行、Bark 并进标题与
分组、列表里显示在时间前）；只有一台时不显示，避免噪音。

消息详情点「回复」会预选原设备——多卡场景必须从收到短信的那张卡发回去，
否则对方看到的是陌生号码。Telegram Bot 的 `/send` 在多设备时会先让你选设备，
不会替你挑一台。

**保号任务是每张卡一个**：保号针对的是具体号码，绑定设备后只会用那台发；
指定设备离线时跳过并等它上线，而不是换一台——换台发等于该保的号没保。

## 消息查询

控制台的消息页支持组合筛选：关键词（正文或号码）、来源号码（部分匹配）、
设备、类型、时间范围；分页可选每页 30 / 50 / 100 条。筛选条件写在 URL 里，
刷新、前进后退、把链接发给自己都能还原当前视图。

正文与号码是加密存储的，SQL 搜不了，所以带关键词/号码的查询需要先解密候选集。
索引列（类型、设备、时间）走 SQL，能利用索引也能准确计数；解密扫描设了 3000 条
上限，超过会如实标注「结果已截断」而不是给一个错的总数。

## 计划任务

定时发送短信。最常见的用法是**保号**——国内号码长期零消费加异地漫游可能被
停机，而停机不会有任何提示。同一套机制也能做每日提醒之类的事。

支持的重复方式：每隔 N 天、每天、每周（可多选星期几）、每月（可多选日期）、
每年、仅一次。全部按**设置的时区**的墙上时间计算——服务端跑在 UTC，
不设对的话「每天 9 点」会差几个小时。

超出当月天数的日期会落到当月最后一天：选 31 号的人在 2 月显然是想要 28/29 号，
而不是这个月不执行。

每个任务绑定设备。指定设备离线时**跳过并等它上线**，不换设备也不推进排期——
换台发等于该保的号没保。连续失败 2 次触发跨渠道告警。

控制台每个任务都有「立即测试发送」，走与定时执行完全相同的代码路径。

## 设备定位（找回）

设备页对在线设备有「定位」按钮，**按需查询一次**，不做持续跟踪——持续 GPS
显著耗电，而「查找设备」本身是低频需求。返回坐标、精度、provider 与定位时刻，
可直接在地图中打开。实时定位拿不到时退回系统的最后已知位置，并标注为缓存。

用系统的 `LocationManager` 而非 Google Play 服务的 FusedLocationProvider：
白牌 ROM 未必装了 GMS，依赖它等于赌运气。

位置与短信正文同等敏感：

- **加密落库**（AES-256-GCM），与短信同一把密钥
- 服务端与 Agent 的日志都不记录坐标
- **每次定位与每次查看历史位置都写审计**，含来源 IP——能定位这台设备的人
  也能看到你全部的验证码，至少要留下谁在什么时候查过的痕迹
- 设备列表只返回「有没有位置、什么时候」，坐标要单独请求

需要三项前提：Agent 的定位权限、**后台定位权限**（网关平时在后台跑，
没有它只在你恰好打开 App 时才有效）、以及手机系统的定位总开关。

## 电量与充电

设备每次心跳上报电量与充电状态，控制台与总览页直接显示（🔌 充电中 /
🔋 正常 / 🪫 低电量）。

可配三类告警：

- **低电量**：低于阈值且未充电时告警。电量耗尽关机后验证码完全收不到，
  而且不会有任何告警——因为告警也要靠设备上报
- **充满提醒**：充电到阈值以上提醒拔电，长期满电会加速电池老化
- **充电状态变化**：默认关闭，插拔电源是日常操作，开了会比较吵

阈值填 0 表示关闭该项。低电量告警有 5% 回差，不会在阈值附近反复触发。

## Telegram Bot

启用 Telegram 渠道后自动拉起 Bot（long polling，零入站端口）。只响应渠道里
配置的那个 `chat_id`，其余静默丢弃。

```
/status            设备状态、电量、今日统计
/recent [n]        最近 n 条消息
/search <关键词>    全文检索
/send <号码> <内容>  发送短信（新号码需二次确认）
/devices           设备列表
/rules             规则列表（只读）
/help
```

**引用回复任意一条短信推送**，内容就会作为短信发回原发件人——比敲 `/send`
顺手得多。映射保留 7 天。

Bot 经自己的 REST API 取数，用的是独立的 service token，权限比 Web 会话低
一档：能看消息与设备、能发短信，**不能改渠道、不能配对设备、不能改规则**。
Telegram 账号被盗的概率高于控制台口令 + TOTP 被攻破。控制台可单独吊销该
token（`POST /api/bot/rotate-token`），不影响 Web 会话。

## 控制台

零构建的原生 SPA（`web/`），移动端优先——Bark 通知点击后落地的是手机浏览器。
深链路由 `/events/:id`、`/compose?to=`、`/devices` 由服务端回落到 index.html 后交前端处理。

## 部署

```bash
docker compose up -d      # 端口只绑 127.0.0.1，公网入口由反代提供
```

首次启动会在 `data/` 下生成 `dek.key`（数据加密密钥）与 `admin.token`。
**`dek.key` 与数据库不要备份到同一处**——两者同时泄露等于未加密。

数据目录需属于容器运行用户：`chown -R 10001:10001 data`。

## 文档

- [开发计划](docs/dev-plan.md) —— 架构决策、里程碑、威胁模型
- [协议契约](src/core/protocol.ts) —— 两端唯一事实来源
- [CLAUDE.md](CLAUDE.md) —— 给 AI 助手的项目约定
