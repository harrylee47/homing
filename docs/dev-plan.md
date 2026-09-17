# 跨境短信网关 —— 开发计划

> 基于 SmsForwarder 裁剪改造的自托管短信/来电事件网关
> 版本：v0.1 draft ｜ 状态：规划中

---

## 1. 背景与目标

### 1.1 要解决的问题

国内手机号绑定了银行、政务、社交等大量账号，人在日本时该号码必须保持可达。现有方案是「安卓机 + SmsForwarder + 自写网关 + Telegram Bot」，链路能跑通，但存在三个问题：

1. **配置分散**：转发规则、渠道配置散落在手机 App 的设置页里，改一条规则要拿起手机翻五层菜单。
2. **无可观测性**：设备掉线是无感的，等到要用验证码时才发现昨晚就断了。
3. **Agent 过重**：SmsForwarder 自带内网穿透（frpc）、本机 HTTP Server、十几种 Sender 实现，其中绝大部分用不到，却增加了攻击面和维护负担。

### 1.2 目标

把「能用」做成「好用且可信」：

- Agent 退化为纯粹的**采集器 + 保活器**，只负责读取和上报，不做决策。
- 所有规则、渠道、状态、历史，集中到一个 **Web 控制台**。
- 设备与服务端之间**单向长连接**，彻底移除内网穿透。
- 全链路强制 TLS，敏感数据落库加密。
- 可靠性做成一等公民：心跳、断网补传、掉线跨渠道告警。

### 1.3 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 语音通话（接听/拨出音频） | 合规风险跳变（《反电信网络诈骗法》），技术复杂度高。来电仅做**通知**，接听交给运营商呼叫转移 |
| 多卡/批量设备管理 | 灰产特征，技术上限制每账号绑定设备数 |
| 托管服务 / SaaS | 本阶段仅自用 + 开源自托管，不持有他人 SIM，不做中间人 |
| 主叫号码改写 | 明确红线 |

---

## 2. 前提与约束

### 2.1 许可证

SmsForwarder 采用 **GPL-3.0**。基于其代码删减再开发形成的衍生作品，**一旦分发即必须以 GPL-3.0 开源**。

- 自用阶段不分发，不触发义务。
- 计划开源，因此本项目从一开始就按 GPL-3.0 规划，**服务端与 Agent 建议同仓或同许可**，避免后期拆分纠纷。
- 动工第一件事：通读上游 LICENSE 与 NOTICE，保留原作者版权声明。

### 2.2 运行环境

- **Agent**：一台专用安卓机（建议刷 LineageOS 等干净 ROM，插中国移动卡，常年连家中 Wi-Fi）
- **服务端**：Oracle Cloud VPS，Docker 部署
- **控制台**：浏览器访问，建议仅经 WireGuard 内网可达

### 2.3 设计原则

1. **Agent 越薄越好** —— 它经手所有银行验证码，代码量必须小到能逐行读完。
2. **服务端有状态，Agent 无状态** —— 除离线缓存外，Agent 不保存任何配置逻辑。
3. **协议先于实现** —— 契约定死后两端并行开发。
4. **可靠性 > 功能数量** —— 宁可少一个渠道，不可少一次告警。

---

## 3. 总体架构

```
┌──────────────────────────┐
│  安卓 Agent（裁剪版）      │
│                          │
│  SMS Receiver            │
│  PhoneStateListener      │──┐
│  NotificationListener    │  │  WSS 长连接（设备主动外连）
│  保活模块                 │  │  上行：event
│  离线缓存（Room）         │  │  下行：cmd
└──────────────────────────┘  │
                              ▼
                  ┌─────────────────────────┐
                  │  服务端（VPS / Docker）   │
                  │                         │
                  │  WS Hub   ← 连接与心跳   │
                  │  Event Store ← SQLite   │
                  │  Rule Engine            │
                  │  Notifier (Provider 化) │
                  │  REST API               │
                  └─────────────────────────┘
                       │              │
                       ▼              ▼
              ┌────────────┐   ┌──────────────┐
              │ Web 控制台  │   │ Telegram     │
              │ (SPA)      │   │ Bark / Webhook│
              └────────────┘   └──────────────┘
```

### 3.1 关键架构决策

**决策一：反转连接方向，移除内网穿透**

SmsForwarder 需要 frpc，是因为其架构是「服务端主动调用手机上的 HTTP Server」。本项目改为**设备主动外连服务端并保持 WebSocket 长连接**：

- 手机处于 NAT 后无影响
- frpc 整块删除
- 连接状态天然即心跳，断开服务端立即感知
- 下行指令（发短信、查状态）沿同一条连接下发

这是本次重构收益最大的一处简化。

**决策二：加密分层与其代价（需明确取舍）**

真正的端到端加密（服务端只存密文）与「Telegram 里直接看到验证码」是**互斥**的——服务端看不到明文就无法把内容塞进推送正文。

选定方案（分阶段）：

| 阶段 | 传输 | 服务端内存 | 落库 | 通知正文 |
|---|---|---|---|---|
| **v1（自用）** | TLS 1.3 强制 | 明文（仅瞬时） | AES-256-GCM 加密 | 完整明文 |
| **v2（可选开关）** | TLS 1.3 | 密文 | 密文 | 降级为「来自 XXXX 的新消息」，明文在控制台查看 |

v1 是自用场景的正确选择。v2 作为配置项预留，供未来分发给他人时启用。**数据模型从一开始就按可加密设计**，避免后期改结构。

---

## 4. Agent 改造方案

### 4.1 保留（核心资产，尽量不动）

| 模块 | 说明 |
|---|---|
| `SmsReceiver` | 短信捕获 BroadcastReceiver |
| `PhoneStateReceiver` | 来电状态监听 |
| `NotificationListenerService` | App 通知捕获（可选启用） |
| **保活模块** | 前台服务、电池优化白名单引导、各厂商自启适配、锁屏保活 —— **一行不改**，这是上游最值钱的部分 |
| `SmsManager` 发送封装 | 含 sentIntent / deliveryIntent |
| 权限申请流程 | 各版本安卓的权限适配 |

### 4.2 删除

- 全部 Sender 实现（钉钉、企业微信、飞书、邮件、Bark、Webhook、Server酱……）
- 本地规则匹配引擎
- frpc / 内网穿透相关全部代码与依赖
- 本机 HTTP Server
- 主动控制指令解析（改由服务端下发结构化 cmd）
- 绝大部分设置页面与多语言资源

### 4.3 新增

- `WsClient`：WebSocket 客户端，含指数退避重连
- `EventQueue`：Room 数据库离线队列，含补传与幂等 id
- `CmdHandler`：处理下行指令
- `PairingActivity`：扫码配对，写入服务端地址与设备凭证

### 4.4 改造后 UI

只保留一页：

```
┌────────────────────────────┐
│  服务端：wss://xxx.xxx      │
│  设备名：JP-Gateway-01      │
│  状态：● 已连接 (12s ago)    │
│  待补传：0 条               │
│  ───────────────────────   │
│  最近事件                   │
│  10:23  SMS  95533          │
│  09:11  CALL 138****1234    │
│  ───────────────────────   │
│  [重新配对]  [导出日志]      │
└────────────────────────────┘
```

**预估代码量**：从数万行缩减到 2000–3000 行。目标是自己能逐行读完。

---

## 5. 通信协议

### 5.1 传输

- `wss://` only，TLS 1.3，禁用明文回退
- 心跳：应用层 ping/pong，间隔 30s，超时 90s 判定离线
- 重连：指数退避 1s → 2s → 4s … 上限 60s，带 jitter

### 5.2 帧格式

统一信封：

```json
{
  "v": 1,
  "type": "hello | hello_ack | event | event_ack | cmd | cmd_result | ping | pong",
  "msg_id": "uuid",
  "ts": 1757894400000,
  "payload": { }
}
```

### 5.3 握手

```json
// → hello
{
  "type": "hello",
  "payload": {
    "device_id": "dev_01H...",
    "token": "<长期凭证>",
    "app_version": "0.1.0",
    "android_sdk": 34,
    "battery": 87,
    "pending_count": 3
  }
}

// ← hello_ack
{
  "type": "hello_ack",
  "payload": {
    "server_time": 1757894400000,
    "config": {
      "heartbeat_sec": 30,
      "capture_notification": false,
      "encrypt_payload": false
    }
  }
}
```

服务端可通过 `hello_ack.config` 下发配置，Agent 不持久化业务配置。

### 5.4 事件模型（统一，不按类型分叉）

```json
{
  "type": "event",
  "payload": {
    "id": "evt_<uuid-v4>",          // 设备端生成，用于幂等
    "device_id": "dev_01H...",
    "kind": "sms | call | notification",
    "from": "95533",
    "content": "您的验证码是 123456...",
    "occurred_at": 1757894390000,   // 事件真实发生时间
    "sim_slot": 0,
    "extra": {
      "call_type": "missed",         // kind=call 时
      "package": "com.tencent.mm"    // kind=notification 时
    }
  }
}
```

**关键约定：**

- `id` 由设备端生成，服务端按 `id` **幂等去重**。断网重连补传不会产生重复记录——这个细节现在不做，后面数据乱了很难收拾。
- `occurred_at` 是事件发生时间，不是上报时间。补传时排序依据。
- 服务端收到后回 `event_ack`，Agent 收到 ack 才从本地队列删除。

### 5.5 下行指令

```json
{
  "type": "cmd",
  "payload": {
    "cmd_id": "cmd_<uuid>",
    "action": "send_sms | get_location | list_apps | import_history | list_fingerprints",
    "args": {
      "to": "13800138000",
      "text": "收到",
      "sim_slot": 0
    }
  }
}
```

回执：

```json
{
  "type": "cmd_result",
  "payload": {
    "cmd_id": "cmd_<uuid>",
    "status": "accepted | sent | delivered | done | failed",
    "error": null
  }
}
```

**发送状态机**：`accepted`（Agent 收到）→ `sent`（sentIntent 回调）→ `delivered`（deliveryIntent 回调）。每一步都回传，控制台上可见完整状态。上游 SmsForwarder 在这块体验较糙，是明确的改进点。

---

## 6. 认证与安全

### 6.1 设备认证

**不使用静态永久 token。**

1. 控制台生成一次性配对码（TTL 5 分钟，二维码）
2. Agent 扫码，携带配对码 + 设备指纹换取长期凭证
3. 长期凭证可在控制台**随时吊销**（手机丢失场景比想象中更常见）
4. 凭证服务端仅存哈希

### 6.2 落库加密

- 敏感字段（`from`、`content`）使用 AES-256-GCM 加密后入库
- 密钥来源：控制台主口令经 Argon2id 派生，或环境变量注入的独立 DEK
- 数据模型预留 `enc_ver` 字段，支持未来密钥轮换与 v2 端到端模式

### 6.3 控制台访问（公网暴露 —— 已定方案）

控制台会展示**所有短信明文，包括银行验证码**。这道门的强度比代码质量重要得多。

**基线要求（全部为必须，非可选）：**

- 强制 HTTPS + HSTS，TLS 1.3
- 口令 + **TOTP**（公网暴露后 TOTP 从推荐升级为强制）
- 会话超时 30 分钟，签发即绑定 UA + IP 段
- 登录失败限速（5 次/15 分钟锁定）+ 失败立即告警到 Telegram
- 审计日志记录所有登录与写操作

**接入方式（推荐 Cloudflare Tunnel）：**

用 `cloudflared` 建立出站隧道，**VPS 不开放任何入站端口**。Cloudflare Tunnel 支持 WebSocket，Agent 的 `/ws` 与 Web UI 可走同一隧道。

进一步可在前面挂 **Cloudflare Access（Zero Trust）**：Web UI 路径要求身份验证（邮箱 OTP 或 Google 账号）后才放行，等于在应用自身认证之前多一道独立的网关。Agent 的 `/ws` 路径配 Service Token 绕过 Access。免费额度足够个人使用。

这套组合的效果是：应用层认证被绕过也还有 Access 兜底，且服务器不存在可被扫描的暴露端口。

**降低可发现性：**

- 不使用可识别的默认端口
- 未认证请求统一返回 `404`，不返回 `401`（不确认服务存在）
- 自定义或移除 `Server` / `X-Powered-By` 响应头
- 登录页不放置项目名称、版本号、favicon 等指纹特征

> 网络空间测绘（Shodan / FOFA）扫的是特征，不是运气。默认端口 + 默认页面 = 必然被收录。


### 6.4 威胁模型速查

| 威胁 | 缓解 |
|---|---|
| VPS 被入侵 | 落库加密；密钥不与数据同盘；v2 可选 E2E |
| 手机丢失 | 凭证可吊销；Agent 本地队列加密 |
| Bot token 泄露 | token 不入代码库；Bot 仅响应固定 chat_id |
| 控制台口令泄露 | TOTP + 内网限制 |
| 中间人 | TLS 1.3；可选证书 pinning |
| 重放 | msg_id 幂等 + 时间戳窗口校验 |

---

## 7. 服务端设计

### 7.1 技术选型

| 组件 | 选择 | 理由 |
|---|---|---|
| 语言 | **TypeScript（Node）** | 为将来适配 Workers 预留；业务逻辑两个运行时共用 |
| 存储 | SQLite（WAL），经 `store` 接口 | 单机自托管足够；接口层保证可换 D1 |
| WS | `ws`，经 `hub` 接口 | 接口层保证可换 Durable Object |
| 前端 | Vue 3 + 组件库，或 HTMX | 体量不大，别上重框架 |
| 部署 | Docker（见第 12 章） | 一条 `docker run` 起步 |

> **关于语言**：如果 Go 写得明显更顺手，那就 Go 到底并放弃 Workers 路径——半吊子的兼容比明确的取舍更浪费时间。既然目标包含「后续一键适配 Workers」，就现在定 TypeScript。

### 7.2 目录结构

```
sms-gateway/
├── src/
│   ├── core/              # 运行时无关：规则引擎、加解密、Provider、API 逻辑
│   ├── adapters/
│   │   ├── node/          # SQLite + ws + node-cron
│   │   └── workers/       # D1 + Durable Object + Cron Triggers（后续）
│   └── index.ts
├── web/                   # SPA
├── agent/                 # 安卓 Agent（裁剪自上游）
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

`core` 里不允许出现任何运行时特有的 import。这条是第 12.7 四条约束的落点，CI 里加一条 lint 规则强制检查。

### 7.3 数据模型

```sql
-- 设备
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  status        TEXT DEFAULT 'offline',   -- online | offline | revoked
  last_seen_at  INTEGER,
  battery       INTEGER,
  app_version   TEXT,
  created_at    INTEGER NOT NULL
);

-- 事件（短信 / 来电 / 通知）
CREATE TABLE events (
  id            TEXT PRIMARY KEY,          -- 设备端 UUID，幂等键
  device_id     TEXT NOT NULL REFERENCES devices(id),
  kind          TEXT NOT NULL,             -- sms | call | notification
  sender_enc    BLOB,
  content_enc   BLOB,
  enc_ver       INTEGER DEFAULT 1,
  occurred_at   INTEGER NOT NULL,
  received_at   INTEGER NOT NULL,
  matched_rules TEXT,                      -- JSON array of rule ids
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_events_time ON events(occurred_at DESC);
CREATE INDEX idx_events_kind ON events(kind, occurred_at DESC);

-- 通知渠道
CREATE TABLE channels (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,                -- telegram | bark | webhook | email
  name       TEXT NOT NULL,
  config_enc BLOB NOT NULL,                -- 加密存储 token 等
  enabled    INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 规则
CREATE TABLE rules (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  priority   INTEGER DEFAULT 100,          -- 数字小者先匹配
  enabled    INTEGER DEFAULT 1,
  match_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 发送任务
CREATE TABLE outbound (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  to_number   TEXT NOT NULL,
  content_enc BLOB NOT NULL,
  status      TEXT DEFAULT 'pending',      -- pending|accepted|sent|delivered|failed
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 审计
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
```

### 7.4 REST API

```
POST   /api/auth/login              口令 + TOTP
POST   /api/auth/logout

GET    /api/devices                 列表 + 在线状态
POST   /api/devices/pairing-code    生成配对码
DELETE /api/devices/:id/token       吊销凭证

GET    /api/events                  ?kind=&from=&q=&page=  全文检索
GET    /api/events/:id
DELETE /api/events/:id

GET    /api/rules
POST   /api/rules
PUT    /api/rules/:id
DELETE /api/rules/:id
POST   /api/rules/:id/test          用历史事件试跑规则

GET    /api/channels
POST   /api/channels
PUT    /api/channels/:id
POST   /api/channels/:id/test       发送测试消息 ★

POST   /api/outbound                下发短信
GET    /api/outbound/:id            查询发送状态

GET    /api/health                  设备在线率、队列深度、最近告警
```

★ **渠道测试按钮不是可选项**。配错渠道是这类系统最常见的故障，且故障时你收不到任何通知——这是个静默失败。

---

## 8. 规则引擎

**不要写成 if-else 硬编码。** 定义为可配置 JSON，前期多花两小时，后面每加一条需求省半天。

### 8.1 匹配条件

```json
{
  "kind": ["sms"],
  "sender_regex": "^(95533|95588|10086)$",
  "content_contains": ["验证码", "動的パスワード"],
  "content_regex": null,
  "time_window": { "from": "00:00", "to": "23:59" },
  "device_ids": []
}
```

同一规则内多条件为 **AND**；数组内多值为 **OR**；空值视为不限制。

### 8.2 动作

```json
{
  "channels": ["ch_telegram_main", "ch_bark_urgent"],
  "priority": "high",
  "extract_code": true,
  "template": "【{sender}】{content}",
  "archive": true,
  "stop_processing": true
}
```

- `extract_code`：正则提取 4–8 位验证码，单独放在推送标题，**手机通知栏直接可见无需展开**——这是日常体验提升最大的一个小功能。
- `stop_processing`：命中后不再匹配后续规则。
- 无规则命中时走 `default` 兜底规则（建议：推送到主 Telegram + 归档）。

### 8.3 建议的初始规则集

| 优先级 | 名称 | 匹配 | 动作 |
|---|---|---|---|
| 10 | 银行验证码 | sender ∈ 银行短信号段 | Telegram + Bark，提取验证码，high |
| 20 | 政务/运营商 | sender ∈ 10086/12306… | Telegram |
| 50 | 骚扰过滤 | content 含推广关键词 | 仅归档，不推送 |
| 100 | 默认 | — | Telegram + 归档 |

---

## 9. 通知 Provider

定义统一接口，新增渠道即实现一个接口：

```go
type Provider interface {
    Type() string
    Validate(cfg json.RawMessage) error
    Send(ctx context.Context, cfg json.RawMessage, msg Message) error
}

type Message struct {
    Title    string
    Body     string
    Priority string   // normal | high
    Code     string   // 提取出的验证码，可空
}
```

**首批实现**：Telegram Bot、Bark、通用 Webhook。
**后续**：SMTP、飞书、Discord、ntfy。

**可靠性要求**：

- 发送失败重试 3 次，指数退避
- 三次全败 → 写入 `audit_log` 并触发**跨渠道告警**
- 单个 Provider 故障不得阻塞其他渠道（并发发送，独立超时）

---

## 10. 可靠性与可观测性

这是本项目区别于「一个转发脚本」的核心，优先级高于任何功能。

### 10.1 心跳与离线告警

- WS 连接状态即心跳，90s 无 pong 判离线
- 离线超过 **5 分钟** → 触发告警
- **告警必须走独立于设备的通道**：Telegram 机器人由服务端直接发送，不经过手机。用掉线的设备去通知自己掉线是没有意义的。
- 建议额外接一个 Uptime Kuma 监控服务端 `/api/health`

### 10.2 断网补传

- Agent 离线期间事件写入本地 Room 队列（加密）
- 重连后按 `occurred_at` 升序补传，服务端按 `id` 幂等
- 队列上限 5000 条，超限丢弃最旧并告警
- **必须做**。不然断网期间的验证码永久丢失，这正是整套系统存在的理由。

### 10.3 保号任务

中国移动对长期零消费、长期异地漫游的号码有停机策略。

- 服务端定时任务：每月 1 日下发一条 `send_sms` 指令至指定号码
- 失败连续 2 次 → 告警
- 比哪天突然收不到验证码再去补救省事得多

### 10.4 控制台首页

最显眼的位置是设备状态，不是短信列表：

```
● JP-Gateway-01   在线   最后心跳 12 秒前   电量 87%   待补传 0
  今日事件 24 ｜ 推送成功 24 ｜ 失败 0
```

---

## 11. 三端交互形态

三个入口，**一套 API**。Web UI 和 Telegram Bot 都是 REST API 的客户端，Bot 绝不直连数据库。这条定死，否则两端逻辑必然漂移。

```
                  ┌──────────────┐
                  │  REST API     │  ← 唯一事实来源
                  └──────────────┘
                    ▲     ▲
         ┌──────────┘     └──────────┐
         │                            │
   ┌───────────┐              ┌──────────────┐
   │  Web UI   │              │ Telegram Bot │
   │  全权操作  │              │  全功能对等   │
   └───────────┘              └──────────────┘
         ▲
         │ 深链跳转
   ┌───────────┐
   │   Bark    │  仅通知，不可交互
   └───────────┘
```

### 11.1 能力矩阵

| 能力 | Web UI | Telegram Bot | Bark |
|---|:---:|:---:|:---:|
| 接收通知 | — | ✅ | ✅ |
| 查看消息历史 / 检索 | ✅ | ✅ | ❌ |
| 发送短信 | ✅ | ✅（受限） | ❌ 跳转 Web |
| 查看设备状态 / 电量 | ✅ | ✅ | ❌ |
| 规则增删改 | ✅ | 只读 | ❌ |
| 渠道配置 | ✅ | ❌ | ❌ |
| 设备配对 / 凭证吊销 | ✅ | ❌ | ❌ |

**权限分级原则**：Bark 只读 < Bot 受限写 < Web 全权。Telegram 账号被盗的概率高于控制台口令 + TOTP 被攻破，因此 Bot 不应拥有配置类权限。

---

### 11.2 Web UI

| 页面 | 内容 |
|---|---|
| **总览** | 设备状态卡片、今日统计、最近告警、快捷发送 |
| **消息** | 列表 + 全文检索 + 按发件人/类型/时间筛选；点击查看原文与命中规则 |
| **发送** | 选设备 / 收件人 / 内容，发送后显示状态机进度 |
| **规则** | 列表拖拽排序、启停开关、编辑器、**「用历史消息试跑」** |
| **渠道** | 增删改、启停、**测试按钮**、最近发送成功率 |
| **设备** | 配对二维码、凭证吊销、下发配置、查看设备日志 |
| **设置** | 主口令 / TOTP、加密模式（v1/v2）、数据保留期、导出备份 |

「用历史消息试跑」很重要：规则写错的反馈周期否则是「等下一条真实短信」，调试极其痛苦。

**移动端适配是硬要求**，不是加分项。Bark 点击跳转后落地的是手机浏览器，如果发送页在小屏上不可用，整条 Bark 链路就是断的。

**深链路由**（供 Bark 跳转）：

```
/compose?to=13800138000&ref=evt_xxx    预填收件人的发送页
/events/:id                             单条消息详情
/devices                                设备状态
```

---

### 11.3 Bark（自建）

**部署**：`bark-server` Docker 自托管。注意自建的只是**服务端**，推送通道仍走 Apple APNs——开源版内置了推送凭证，可直接用，无需自备证书。

**必用参数**：

| 参数 | 用途 |
|---|---|
| `title` / `body` | 标题放发件人，正文放内容 |
| `url` | **点击跳转深链**，指向 Web UI 对应页面 |
| `copy` | 指定点击通知时复制的内容 |
| `autoCopy` | 自动复制到剪贴板 |
| `level` | `timeSensitive` 可穿透专注模式；`passive` 用于低优先级 |
| `group` | 按发件人分组，通知中心不会糊成一片 |
| `isArchive` | 是否存入 Bark 历史 |

**验证码场景的正确形态**：

```
标题：中国建设银行
正文：验证码 123456
copy：123456          ← 长按即可复制，无需打开任何 App
level：timeSensitive
url：https://console.example.com/events/evt_xxx
group：bank
```

`copy` + `autoCopy` 是整套系统日常体感提升最大的一处细节——常见场景下用户根本不需要打开任何界面。

**规则动作需要扩展**，在 `action_json` 中增加 Bark 专属字段：

```json
{
  "bark": {
    "level": "timeSensitive",
    "group": "bank",
    "auto_copy_code": true,
    "deep_link": "event"   // event | compose | none
  }
}
```

---

### 11.4 Telegram Bot

定位：**与 Web UI 功能基本对等的第二操作面**，适用于手机上快速处理。

**命令集**：

```
/status            设备在线状态、电量、待补传数、今日统计
/recent [n]        最近 n 条消息（默认 10）
/search <关键词>    全文检索
/send <号码> <内容>  发送短信
/rules             列出规则（只读）
/devices           设备列表
/help
```

**核心交互：Reply 即回复**

推送的每条短信消息，用户在 Telegram 里**直接引用回复**，Bot 即把内容作为短信回给该发件人号码。这比 `/send` 敲号码顺手一个量级，是 Bot 端最值得打磨的交互。

实现：推送时把 `event_id` 与 message_id 的映射存入缓存（Redis 或内存 LRU，TTL 7 天），收到 reply 时反查发件人。

**Inline Keyboard**：每条推送下方挂按钮

```
【中国建设银行】验证码 123456

[📋 复制 123456]  [↩️ 回复]  [🔗 网页打开]
```

**安全约束（必做）**：

1. Bot 只响应**固定 chat_id**，其余一律静默丢弃，不回任何提示
2. 发短信到**不在历史记录中的新号码**，需 inline 按钮二次确认
3. 发送速率限制：每小时上限 N 条，超限告警
4. Bot 调用 API 使用独立的 service token，权限集比 Web 会话低一档，可单独吊销
5. Bot token 走环境变量，不入代码库

**实现方式：long polling，不用 webhook。**

理由：webhook 需要 VPS 暴露入站端口并配置证书；long polling 是 Bot 主动外连 Telegram，**零入站端口**。本项目规模下资源开销可忽略，而拓扑上干净得多。

---

### 11.5 网络拓扑（已定：公网可达）

**决策**：Web UI 公网可达，经 Cloudflare Tunnel 接入，安全靠认证与网关而非网络隔离。理由是 Bark 的核心价值就是「通知栏点一下就处理完」，走 VPN 会在这条主路径上引入不确定性。

拓扑：

```
Agent ──WSS──┐
             ├── Cloudflare ──tunnel── cloudflared ── 服务端
浏览器 ───────┤   (Access 网关)          (VPS 零入站端口)
Telegram ←── long polling（Bot 主动外连，不占入站）
```

单一域名按路径分流：

```
/ws      → Agent，设备凭证鉴权，Access Service Token
/api/*   → REST，Bearer token 鉴权
/*       → Web UI，Access + 口令 + TOTP
```

### 11.6 公网暴露的具体加固清单

以下每一条都对应过真实的在野攻击路径，**建议逐条实现并在 M5 验收**：

**认证与会话**

- [ ] TOTP 强制，不提供关闭选项
- [ ] API 鉴权用 `Authorization: Bearer`，**不用 Cookie** —— 天然免疫 CSRF；若因故必须用 Cookie，则 `SameSite=Strict` + `HttpOnly` + `Secure`
- [ ] 登录失败限速 + 锁定 + 告警
- [ ] 会话可在控制台主动吊销（全端下线）

**WebSocket（最容易被忽略的一环）**

- [ ] **强制校验 `Origin` 头**。浏览器的同源策略不适用于 WebSocket，不校验 Origin 意味着任意恶意网页的 JS 都能向你的 WS 端点发起连接。这是 OpenClaw 那次 `ClawJacked` 的成因，同类项目反复踩。
- [ ] WS 鉴权走握手帧内的 token，不依赖 Cookie 自动携带
- [ ] Agent 与浏览器使用**不同的凭证类型**，互不可替代
- [ ] 连接建立后仍校验每帧的 `device_id` 与凭证绑定关系

**反向代理**

- [ ] `trusted_proxy` 必须精确配置。配错会导致 `X-Forwarded-For` 可伪造，限速与 IP 白名单同时失效——这是反代后认证绕过的经典成因
- [ ] 只信任 Cloudflare 回源 IP 段，直连源站一律拒绝

**最小权限**

- [ ] 容器非 root 运行，根文件系统只读
- [ ] 数据库文件权限 600，密钥不与数据同盘
- [ ] 服务端不具备执行 shell 的能力（不引入任何 exec 类依赖）

**可维护性（这条常被当成非安全项，实则最关键）**

- [ ] 依赖自动扫描（Dependabot / `govulncheck`）
- [ ] 版本号与更新通道，确保能快速升级
- [ ] 异常访问模式告警（非常用 IP 登录、短时间大量 API 调用）

> 参考教训：OpenClaw 在 2026 年 3 月被披露 80+ 漏洞，公网暴露实例逾 40 万，其中约 27% 存在高危漏洞。问题的根源不是「它选择了公网可达」，而是**默认绑定 `0.0.0.0` 且默认无认证**，加上迭代速度远快于安全流程。
>
> 结论不是「不能公网」，而是：默认配置必须是拒绝性的，且要留好升级通道——自己写的代码同样会有洞。


---

## 12. 部署与运行时

分三档，对应三类使用者。**你自己从第三档起步，别人从第一档进门。**

| 档位 | 目标用户 | 门槛 |
|---|---|---|
| 快速开始 | 想先看看是什么东西 | 一条命令，两分钟 |
| 加上 HTTPS | 决定长期用 | 三选一，十分钟 |
| 生产加固 | 长期公网运行 | 半小时 |

### 12.1 两条不可妥协的默认行为

简化门槛不等于放松默认安全。以下两条无论哪一档都必须存在：

**① 首次启动强制配置向导**

未完成初始化前，除向导页外**所有路由一律返回 403**，包括 API 和 WS。不存在「启动即裸奔」的窗口期。

向导流程：设管理员口令 → 扫码绑定 TOTP → 生成设备配对二维码 → 完成。

> OpenClaw 那 40 多万个公网暴露实例，根子不是「选择了公网可达」，是**默认绑定 `0.0.0.0` 且默认无认证**。默认配置必须是拒绝性的。

**② 明文 HTTP 警告**

检测到请求为明文 HTTP 且来源非本机时，页面顶部挂**持续警告横幅**：「当前连接未加密，短信内容与验证码正在明文传输」。不阻断操作，提供开关给明确知情的用户关闭。

这两条合计几十行代码，但决定了这个项目将来会不会变成别人的安全事故。

---

### 12.2 第一档 —— 快速开始

```bash
docker run -d --name sms-gateway \
  -p 8080:8080 \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  ghcr.io/<you>/sms-gateway
```

打开 `http://<服务器IP>:8080`，进入配置向导。

**没有 .env，没有反代，没有隧道。** 所有配置——Telegram token、Bark 地址、规则、渠道——全部在网页里填。加密主密钥 `DEK` 首次启动自动生成并写入 `/data`，用户无感。

Compose 版同理，只是多一个文件：

```yaml
services:
  gateway:
    image: ghcr.io/<you>/sms-gateway:latest
    restart: unless-stopped
    ports: ["8080:8080"]
    volumes: ["./data:/data"]
```

---

### 12.3 第二档 —— 加上 HTTPS

域名与证书交给外层，三选一，文档各给一段配置即可，**不塞进 compose**。

**A. 1Panel / 宝塔反代（你的情况）**

网站 → 反向代理 → 目标填容器地址，证书一键申请 Let's Encrypt 自动续期。

三个必做项：

1. **打开 WebSocket 开关**。底层是 Nginx，反代默认不带 WS 支持。不开的表现是「网页能开、Agent 连不上」，报错不明显，极易卡住。手写配置的话补上 `Upgrade` / `Connection` 两个 header。
2. **容器网络互通**。1Panel 的 OpenResty 自己也在容器里，填 `gateway:8080` 需要两者同网络；否则只能填宿主机 IP + 映射端口。推荐把 gateway 加入 1Panel 的网络，这样可以去掉 `ports`，宿主机不暴露端口。
3. **`trusted_proxy` 填反代容器地址**，不要写 `0.0.0.0`。写错等于限速与 IP 告警全部可被伪造绕过。

> 顺带：1Panel 面板自身的默认端口与入口路径如果没改过，会被全网扫到。既然这台机器上要跑装着全部银行验证码的服务，把面板入口改掉并加 IP 白名单，比在网关代码里加任何一道锁都划算——面板被拿下，下面跑什么都白搭。

**B. Caddy**

```
console.example.com {
    reverse_proxy gateway:8080
}
```

证书自动申请续期，WebSocket 默认透传。最省心的自持方案。

**C. Cloudflare Tunnel**

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment: [TUNNEL_TOKEN=${CF_TUNNEL_TOKEN}]
```

前提：域名 NS 托管在 Cloudflare（域名本身无需转移）。面板建隧道 → 复制 token → 配 Public Hostname 指向 `http://gateway:8080`。

优点：**宿主机零入站端口**，源站 IP 不暴露，证书全托管。
易错点：service 地址必须用 compose 服务名，写 `localhost` 会指向 cloudflared 容器自身——这是最常见的错。

---

### 12.4 第三档 —— 生产加固

```yaml
services:
  gateway:
    image: ghcr.io/<you>/sms-gateway:latest
    restart: unless-stopped
    env_file: .env
    volumes: ["./data:/data"]
    read_only: true
    tmpfs: [/tmp]
    user: "10001:10001"
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    expose: ["8080"]        # 不用 ports，仅反代/隧道可达
```

配套：

- 防火墙仅放行 443 与 SSH；SSH 改端口 + 仅密钥 + fail2ban
- 若走 Cloudflare 橙云代理，防火墙**只放行 CF 回源 IP 段**，直连源站一律拒绝
- 第 11.6 的加固清单逐条落实
- 证书续期失败告警（Caddy 自动续不等于永不失败）

---

### 12.5 环境变量（全部可选，用于自动化部署）

```bash
GW_BASE_URL=https://console.example.com
GW_TRUSTED_PROXY=172.18.0.0/16
GW_DEK=                    # 留空则首次启动自动生成到 /data
GW_ADMIN_PASSWORD_HASH=    # argon2id，留空则走向导
GW_TOTP_SECRET=
GW_TELEGRAM_BOT_TOKEN=     # 留空则在网页配置
GW_TELEGRAM_CHAT_ID=
GW_BARK_SERVER=
GW_BARK_KEY=
```

**`GW_DEK` 与 `./data` 不要备份到同一处**。两者同时泄露等于未加密。

---

### 12.6 备份与升级

- 备份：`VACUUM INTO` 导出 `data/gateway.db`，加密后异地同步，每日 cron
- **恢复演练至少做一次**。没演练过的备份等于没有备份
- 升级：`docker compose pull && up -d`。迁移脚本内嵌，启动时自动执行并先行自动备份

---

### 12.7 为 Workers 适配预留（四条硬约束）

从 M0 起遵守，否则将来不是适配是重写：

1. **语言用 TypeScript**。Workers 不跑 Go。Docker 版在 Node 上跑，Workers 版共用规则引擎、加解密、Provider、API 逻辑，差异只在存储层与 WS Hub 两块。
2. **SQL 限制在 D1 兼容子集**。不用触发器、自定义函数、`ATTACH`；全文检索先用 LIKE，**暂不引入 FTS5**（数据量几年都到不了 LIKE 的瓶颈，但 FTS5 会直接堵死 D1 路径）。
3. **不依赖本地文件系统**。除数据库文件外零磁盘读写，日志走 stdout。
4. **进程内不保存状态**。除 WS 连接表与 Bot 的 message_id 映射缓存外一切入库，且这两处要能从存储重建。

`store` 与 `hub` 从第一天就是接口，不是直接调具体实现。这是上述约束的落点。

---

### 12.8 未来迁移变更点（备案，不实现）

| Docker 版 | Workers 版 |
|---|---|
| 内存 WS Hub | Durable Object + WebSocket Hibernation（必须用 `serializeAttachment` / `deserializeAttachment` 恢复连接元数据，休眠后内存状态会被清空） |
| SQLite | D1 |
| cron | Cron Triggers（最小间隔 1 分钟，够用） |
| **Telegram long polling** | **改为 webhook**（无常驻进程；边缘入口下 webhook 反而更自然） |
| SPA 由服务端托管 | Workers Static Assets |
| 反代 / 隧道 | 不需要 |

> 注意：**Cloudflare Pages 无法承载本项目**——它面向静态站点，Functions 不支持 Durable Object，跑不了长连接。目标是 **Workers**（现已原生托管静态资源，新项目基本取代 Pages）。仓库挂 Deploy to Cloudflare 按钮实现一键部署。

预计工作量：四条约束守住，数天；未守住，等同重写。

---

## 13. 里程碑

每个里程碑都有可验收的产出，不满足验收标准不进入下一阶段。

### M0 — 技术验证（1–2 晚）

- Fork 上游仓库，确认可编译可运行
- 砍掉全部 Sender 与 frpc，确认不影响短信捕获与保活
- 打通最小 WebSocket 上报：手机收到短信 → 服务端 console 打印

**验收**：给那台安卓机发一条短信，VPS 日志里能看到内容。

### M1 — 最小闭环（1 周）

- 服务端：WS Hub + SQLite 落库 + 幂等去重
- 设备配对流程（配对码 → 长期凭证）
- Telegram Provider
- 默认规则兜底

**验收**：收到短信 3 秒内 Telegram 有推送；重启服务端不丢数据；重复上报不产生重复记录。

### M2 — 下行发送（3 天）

- `send_sms` 指令下发
- sentIntent / deliveryIntent 回执上报
- 状态机完整落库

**验收**：通过 API 发出一条短信，能看到 accepted → sent → delivered 全过程。

### M3 — Web 控制台（1–2 周）

- 登录 + TOTP
- 总览、消息列表与检索、发送页、设备页
- **移动端适配 + 深链路由**（`/compose?to=`、`/events/:id`）

**验收**：不碰手机、不看日志，完全通过网页完成日常所有操作；手机浏览器打开发送页可正常使用。

### M4 — 规则引擎与 Bark（1 周）

- 规则 CRUD + 优先级 + 试跑
- Bark Provider（自建 bark-server），含 `copy` / `level` / `group` / `url`
- 验证码提取
- Webhook Provider

**验收**：银行短信走 Bark `timeSensitive`，通知栏直接显示验证码且长按可复制；点击跳转到对应详情页；推广短信静默归档。

### M4.5 — Telegram Bot 操作面（1 周）

- long polling 接入，chat_id 白名单
- `/status` `/recent` `/search` `/send` `/devices` `/rules`
- **Reply 即回复**（event_id ↔ message_id 映射缓存）
- Inline Keyboard：复制验证码 / 回复 / 网页打开
- 新号码二次确认 + 速率限制

**验收**：全程不打开网页，仅在 Telegram 内完成「看到验证码 → 回复对方 → 查设备电量」全流程。

### M5 — 加固（1 周）

- 断网补传 + 本地队列
- 离线跨渠道告警
- 落库加密 + 凭证吊销
- 保号定时任务
- **公网暴露加固清单（11.6）逐条实现**
- Cloudflare Tunnel + Access 接入

**验收**：拔掉手机 Wi-Fi 30 分钟，期间发 5 条短信，恢复后 5 条全部到达且不重复；断网 5 分钟后收到独立渠道告警；伪造 Origin 的 WS 连接被拒绝；直连源站 IP 被拒绝；未认证请求返回 404。

### M6 — 开源准备（3 天）

- LICENSE / NOTICE / 上游致谢
- README：架构图、部署步骤、**scope 声明**
- 敏感信息清理（git history 全量扫描）
- Docker Compose 一键部署 + 示例配置

**验收**：在一台全新 VPS 上照着 README 从零部署成功。

---

## 14. 测试策略

| 层次 | 内容 |
|---|---|
| 单元 | 规则匹配引擎（重点）、加解密、验证码提取正则 |
| 集成 | WS 握手、幂等去重、补传顺序、状态机流转 |
| 混沌 | 随机断网、服务端重启、Agent 强杀、时钟漂移 |
| 长稳 | 连续运行 7 天，统计漏报率（目标 0） |

**漏报率是唯一真正重要的指标。** 延迟可以接受，丢失不能。

---

## 15. 风险清单

| 风险 | 等级 | 应对 |
|---|---|---|
| 安卓保活失效（尤其魔改 ROM） | **高** | 刷干净 ROM；保活代码不动上游；心跳告警兜底 |
| 上游代码耦合度高，裁剪引入回归 | 中 | 小步删除，每步验证短信捕获；保留 git 分支可回滚 |
| 控制台泄露导致验证码全盘暴露 | **高** | TOTP + 仅内网可达；落库加密 |
| GPL 义务理解偏差 | 中 | 开源前通读许可证；必要时咨询 |
| 中国移动号码因异地/零消费停机 | 中 | 保号定时任务 + 话费余额监控 |
| 国内 eSIM 放开导致需求消失 | 中 | 接受；本项目定位为自用工具，沉没成本可控 |

### 关于最后一条

国内 eSIM 已进入商用试验，目前卡在「仅少数国行机型 + 必须线下办理」两道限制上。一旦海外版机型白名单放开或开放线上办理，这个痛点会快速缩小。

**这不构成不做的理由**（自用需求当下真实存在，且开源工具边际成本为零），但**构成不要过度投入的理由**：保持架构轻量，不引入需要长期运维的重资产，M5 之后的功能按实际使用频率增补，而非一次性堆满。

---

## 16. 开源时的 Scope 声明

README 中需明确写入，既是技术边界也是立场：

> 本项目面向**个人自用**场景：使用者自持 SIM 卡、自持设备、自托管服务端。
>
> 明确不支持：多卡批量管理、主叫号码改写、语音中继、代收验证码/接码服务。
> 技术上限制单账号绑定设备数量。
>
> 使用者需自行遵守所在司法辖区的法律法规。

许可证选 **AGPL-3.0**（若上游 GPL-3.0 允许升级）或保持 **GPL-3.0**。挡不住灰产，但表明立场。

---

## 17. 立即可做的三件事

1. Fork 上游仓库，跑通编译，确认那台 mini 安卓机刷机后蓝牙/短信/保活均正常
2. 敲定本文档第 5 章的协议帧与事件模型 —— 这是两端的契约，定死后才能并行
3. 在 VPS 上起一个空的 Go 服务 + SQLite，把 M0 的「收到短信 → 日志打印」打通

其余一切都可以后置。
