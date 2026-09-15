# sms-gateway

自托管的短信 / 来电事件网关：安卓机采集，服务端集中规则、渠道与历史，推送到 Telegram / Bark / Webhook。

基于 [SmsForwarder](https://github.com/pppscn/SmsForwarder) 裁剪改造，GPL-3.0。

> **状态：开发中（M0）。** 服务端最小闭环已跑通，安卓 Agent 尚未开始。

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

## 文档

- [开发计划](docs/dev-plan.md) —— 架构决策、里程碑、威胁模型
- [协议契约](src/core/protocol.ts) —— 两端唯一事实来源
- [CLAUDE.md](CLAUDE.md) —— 给 AI 助手的项目约定
