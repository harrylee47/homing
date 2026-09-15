# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态

**尚未动工。** 仓库当前只有 `sms-gateway-dev-plan_1.md`（v0.1 draft 规划文档），没有代码、没有 git 仓库、没有构建配置。任何"运行/构建/测试"命令都还不存在，需要随 M0 一并创建。

动工前先做计划 §17 的三件事，其中第 2 条（敲定 §5 协议帧与事件模型）是两端并行开发的前提。

## 项目是什么

自托管的跨境短信/来电事件网关：国内手机号插在一台常驻安卓机上，验证码等短信通过长连接上报到 VPS，再按规则分发到 Telegram / Bark / Webhook。Agent 基于 SmsForwarder 裁剪改造。

面向**个人自用 + 开源自托管**。明确不做：语音中继、多卡批量管理、主叫号码改写、接码服务、SaaS 托管（详见计划 §1.3、§16）。涉及这些方向的需求应当拒绝而非实现。

## 技术选型（已定，勿重新讨论）

- **服务端：TypeScript / Node**，不是 Go。计划 §9 里的 `Provider` 接口是 Go 代码片段、§17 写"起一个空的 Go 服务"——这两处是 §7.1 做出决策**之前**的残留，以 §7.1 与 §12.7 约束①为准。写代码时按 TypeScript 来。
- 存储 SQLite（WAL），WS 用 `ws`，前端 Vue 3 或 HTMX，Docker 部署。
- Agent：安卓原生（Kotlin/Java），裁剪自上游 SmsForwarder。

## 架构要点

```
安卓 Agent ──WSS 长连接（设备主动外连）──> 服务端（WS Hub + Rule Engine + Notifier + REST API）
                                              ├─> Web UI（SPA）
                                              └─> Telegram Bot / Bark / Webhook
```

**连接方向是反的**：设备主动外连并保持 WebSocket，服务端从不主动连手机。因此没有 frpc、没有内网穿透、手机在 NAT 后无影响，连接状态天然即心跳。上游 SmsForwarder 那套本机 HTTP Server + frpc 全部删除。

**职责切分**：Agent 是纯采集器 + 保活器，不做任何决策、不持久化业务配置（配置由 `hello_ack.config` 下发）；所有规则、渠道、状态、历史都在服务端。目标 Agent 代码量 2000–3000 行，小到能逐行读完。

**一套 API 三个入口**：Web UI 和 Telegram Bot 都是 REST API 的客户端，**Bot 绝不直连数据库**。否则两端逻辑必然漂移。

## 四条硬约束（为 Workers 适配预留，从 M0 起遵守）

违反任何一条，将来就不是适配而是重写：

1. 服务端用 **TypeScript**。
2. SQL 限制在 **D1 兼容子集**：不用触发器、自定义函数、`ATTACH`；全文检索用 `LIKE`，**不引入 FTS5**（FTS5 会直接堵死 D1 路径）。
3. **不依赖本地文件系统**，除数据库文件外零磁盘读写，日志走 stdout。
4. **进程内不保存状态**。例外只有 WS 连接表与 Bot 的 message_id 映射缓存，且这两处必须能从存储重建。

落点：`store` 与 `hub` 从第一天就是**接口**，不是直接调具体实现。`src/core/` 里不允许出现任何运行时特有的 import，CI 加 lint 规则强制检查。

目录结构：`src/core/`（运行时无关）、`src/adapters/node/`、`src/adapters/workers/`（后续）、`web/`、`agent/`。

## 协议契约（改动需同步两端）

统一信封：`{ v, type, msg_id, ts, payload }`，`type ∈ hello | hello_ack | event | event_ack | cmd | cmd_result | ping | pong`。

两条关键约定，现在不做后面数据乱了很难收拾：

- **事件 `id` 由设备端生成，服务端按 `id` 幂等去重**。断网补传不得产生重复记录。
- **`occurred_at` 是事件发生时间，不是上报时间**，补传时按它升序排序。
- Agent 收到 `event_ack` 才从本地队列删除。

发送状态机：`accepted`（Agent 收到）→ `sent`（sentIntent）→ `delivered`（deliveryIntent），每一步都回传。上游在这块体验较糙，是明确改进点。

心跳 30s / 超时 90s 判离线；重连指数退避 1s→60s 带 jitter。

## 安全红线

控制台展示所有短信明文含银行验证码，且**公网可达**（经 Cloudflare Tunnel）。以下为必须项：

- **首次启动强制配置向导**：未完成初始化前所有路由（含 API 和 WS）一律返回 403。不存在"启动即裸奔"的窗口期。这是 OpenClaw 40 万实例暴露事件的根因。
- **WS 强制校验 `Origin` 头**。浏览器同源策略不适用于 WebSocket，不校验等于任意恶意网页的 JS 都能连你的 WS 端点。
- WS 鉴权走握手帧内 token，不依赖 Cookie 自动携带；Agent 与浏览器用**不同凭证类型**，互不可替代。
- API 鉴权用 `Authorization: Bearer`，**不用 Cookie**（天然免疫 CSRF）。
- **TOTP 强制**，不提供关闭选项。
- `trusted_proxy` 必须精确配置，不能写 `0.0.0.0`——配错会使 `X-Forwarded-For` 可伪造，限速与 IP 白名单同时失效。
- 未认证请求返回 **404 而非 401**（不确认服务存在）。
- 设备凭证：一次性配对码（TTL 5min）换长期凭证，**服务端仅存哈希**，可随时吊销。不使用静态永久 token。
- 敏感字段（`from`、`content`、渠道 config）AES-256-GCM 加密入库，预留 `enc_ver` 支持密钥轮换。
- Telegram Bot 只响应固定 chat_id，其余静默丢弃；Bot 用独立 service token，权限比 Web 会话低一档。
- 服务端不引入任何 exec 类依赖。
- `GW_DEK` 与 `./data` 不要备份到同一处。

完整清单见计划 §11.6，M5 验收时逐条核对。

## 与旧系统共存（重要）

目标机器上有一套**正在使用的旧方案**必须保持运行：`frps` 容器（手机端 frpc 在线，为 SmsForwarder 打洞）+ `smsf-bot` 容器（Python + Telegram long polling）。这是当前收验证码的唯一链路，停掉当天就失效。

因此：

- 计划 §4.2「删除 frpc」指的是 **Agent 新代码不含 frp**，不是现在关掉服务端的 frps。
- **切换顺序**：M0/M1 新 WSS 链路跑通 → 双轨并行观察数日 → 确认无漏报 → 才停旧栈。不要在此之前提议清理。
- 新服务的端口不要与旧栈冲突（旧栈占用 5009、5000、8080、7000）。

## 日志脱敏

旧系统每 10 秒在日志里明文打印完整 Telegram Bot Token，是明确的反面教材。新项目所有日志输出中，Bot token、设备凭证、配对码、DEK、短信正文与提取出的验证码一律脱敏或截断。约束③要求日志走 stdout，而 stdout 会进 Docker 日志文件与面板界面——等于这些内容会落盘且长期留存。

## 容易踩的坑

- **Bot 用 long polling，不用 webhook**。Bot 主动外连 Telegram = 零入站端口；webhook 需要暴露端口配证书。（Workers 版才改 webhook。）
- **1Panel / 宝塔反代必须手动打开 WebSocket 开关**，底层 Nginx 默认不带。症状是"网页能开、Agent 连不上"，报错不明显。
- **Cloudflare Tunnel 的 service 地址必须用 compose 服务名**，写 `localhost` 会指向 cloudflared 容器自身。
- 告警**必须走独立于设备的通道**（服务端直发 Telegram）。用掉线的设备通知自己掉线没有意义。
- 规则引擎**不要写成 if-else 硬编码**，定义为可配置 JSON（`match_json` / `action_json`）。同规则内多条件 AND，数组内多值 OR，空值不限制。
- 移动端适配是**硬要求**不是加分项：Bark 点击跳转落地在手机浏览器，发送页小屏不可用则整条 Bark 链路是断的。

## 两个体验关键点（别当成小功能砍掉）

- **`extract_code`**：正则提取 4–8 位验证码放进推送标题，通知栏无需展开即可见。
- **Bark 的 `copy` + `autoCopy`**：长按通知即复制验证码，常见场景下完全不需要打开任何 App。这是日常体感提升最大的一处。

对应地，两个"看起来可选实则必须"的功能：渠道**测试按钮**（配错渠道是最常见故障，且故障时你收不到任何通知——静默失败）、规则**用历史消息试跑**（否则调试反馈周期是"等下一条真实短信"）。

## 里程碑

M0 技术验证 → M1 最小闭环 → M2 下行发送 → M3 Web 控制台 → M4 规则引擎与 Bark → M4.5 Telegram Bot → M5 加固 → M6 开源准备。每个里程碑有可验收产出，**不满足验收标准不进入下一阶段**（验收条件见计划 §13）。

测试重点：规则匹配引擎单元测试、WS 幂等去重与补传顺序集成测试、随机断网/强杀混沌测试。**漏报率是唯一真正重要的指标——延迟可接受，丢失不能。**

## 许可证

上游 SmsForwarder 是 GPL-3.0，衍生作品一旦分发即必须以 GPL-3.0 开源。本项目从一开始就按 GPL-3.0（或 AGPL-3.0）规划，服务端与 Agent 同仓同许可。动工第一件事是通读上游 LICENSE 与 NOTICE 并保留原作者版权声明。
