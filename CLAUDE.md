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

## Bark 是验证码的主通道

Telegram 因封禁风险只能发模糊正文，所以「通知栏直接看到验证码、长按即复制」
这个核心体验落在 Bark 上（自托管，无封禁风险）。

自建 bark-server 跑在网关自己的 compose 里，**不对外暴露端口**，由网关在
`/bark/*` 反代（`src/adapters/node/barkproxy.ts`）——省掉单独建站与证书。
上游地址必须用 compose 服务名，容器里的 `127.0.0.1` 指向网关自己。
该路径不走网关鉴权（Bark App 不会带 token），但受初始化门禁约束。

Bark 的 level/group/copy 等参数配在**规则的 action 里**而非渠道配置里，
因为它随消息类型变化：验证码要穿透专注模式，广告短信不该。

## 多设备分流

按设备分流**只走规则的 `match.device_ids`**，不要给渠道加设备绑定——两套并行的分流机制在冲突时行为不可预期。渠道保持全局。

通知里的设备名只在**有多台未吊销设备时**才带（`pipeline.ts` 里判断）。单设备下每条都缀设备名是噪音，多设备下不缀就分不清验证码来自哪张卡。同一判断也用在消息列表、Bot 的 /recent 与 /search。

回复时必须用原事件所属的设备（`message_refs.device_id`）：多卡场景下从别的卡发回去，对方看到的是陌生号码。

**任何「挑一台在线设备」的写法都要警惕**——收件人看到的号码取决于用哪张卡，挑错等于用错身份。已知需要显式指定设备的位置：保号任务（每张卡一个任务，绑定设备）、Bot 的 `/send`（多设备时先让用户选）、控制台发送页（下拉选择，回复时预选原设备）。保号任务指定的设备离线时**跳过并等它上线**，不换设备、不推进排期。

## 部署

用 `pnpm run deploy:arm`（`scripts/deploy.sh`），不要手敲 rsync + docker compose。

脚本会先本地跑类型检查、core 纯度检查与测试，再同步构建，**构建失败即中止并原样打印错误**。手敲时容易用 `tail -1` 截输出，结果 tsc 报错被吞掉、显示「部署成功」但跑的还是旧镜像——这比 bug 本身更糟，你以为修好了。

`pnpm` 有若干内置命令会吃掉同名 script：`audit`、`deploy` 都踩过。自定义脚本起名避开，或用 `pnpm run <name>`。

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

## Telegram 必须模糊正文（踩过的坑）

发往 Telegram 的消息，**正文必须包在 `<tg-spoiler>` 里，验证码不得单独明文显示**（`parse_mode` 用 HTML，MarkdownV2 没有 spoiler）。发件人号码可明文。

原因：Telegram 反欺诈系统会封禁转发验证码的 Bot，上一版网关实际被封过。Bot 一封所有通知全断，是单点故障。

连带影响：计划 §8.2 说 `extract_code` 要让「通知栏直接可见无需展开」——**这个体验在 Telegram 上做不到**，只能留给自建的 Bark。新增任何 Telegram 功能（推送、Bot 命令回复、历史查询）都要遵守这条。

## 两个体验关键点（别当成小功能砍掉）

- **`extract_code`**：正则提取 4–8 位验证码。**仅 Bark 可放进推送标题**——Telegram 见上一节。提取只认关键词邻近的数字并要求数字边界，避免把订单号截成验证码。
- **Bark 的 `copy` + `autoCopy`**：长按通知即复制验证码，常见场景下完全不需要打开任何 App。这是日常体感提升最大的一处。

对应地，两个"看起来可选实则必须"的功能：渠道**测试按钮**（配错渠道是最常见故障，且故障时你收不到任何通知——静默失败）、规则**用历史消息试跑**（否则调试反馈周期是"等下一条真实短信"）。

## 里程碑

M0 技术验证 → M1 最小闭环 → M2 下行发送 → M3 Web 控制台 → M4 规则引擎与 Bark → M4.5 Telegram Bot → M5 加固 → M6 开源准备。每个里程碑有可验收产出，**不满足验收标准不进入下一阶段**（验收条件见计划 §13）。

测试重点：规则匹配引擎单元测试、WS 幂等去重与补传顺序集成测试、随机断网/强杀混沌测试。**漏报率是唯一真正重要的指标——延迟可接受，丢失不能。**

## 许可证

**上游 SmsForwarder 是 BSD 2-Clause，不是计划 §2.1 假设的 GPL-3.0。** 这是宽松许可，无 copyleft 义务，本项目可自由选择许可证。

本项目采用 **AGPL-3.0**（计划 §16 的本意即"表明立场"，此前只是误以为受上游限制）。`NOTICE` 保留 pppscn 的 BSD 版权声明，沿用上游逻辑的文件在头部注明来源。

## 安卓 Agent

采用**新建工程 + 选择性拷贝**，而非在上游 46177 行代码里做减法。原因是上游 App.kt / Core.kt / Room 数据库把 Frpc、Sender、Rule 全串在一起，删比写更容易引入回归。

关键认识：**保活不是上游的代码资产，是一个公开依赖** —— `com.gyf.cactus:cactus:1.1.3-beta13`。上游自己的保活代码仅 App.kt 里约 50 行配置。jcenter 已停服，AAR 随仓库分发（`agent/app/libs/`）以保证构建可复现，其传递依赖（work-runtime、gson）必须显式声明，`files()` 引入拿不到。

两个必须守住的实现约束：

- **只在主进程建立连接**。Cactus 会拉起 `:cactusRemoteService` 独立进程，它同样执行 `Application.onCreate`；不加判断会开出第二条 WS，两个进程按 device_id 互相踢下线，形成无限重连。见 `util/ProcessUtil.kt`。
- **连接成功后必须等待断开信号再重连**，不能让重连循环直接进入下一轮——同样会自己踢自己。

明文策略：`main` 源集的 network_security_config 完全禁止明文；`debug` 源集单独放行本地开发地址。release 构建不受影响。
