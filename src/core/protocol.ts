/**
 * 设备 ↔ 服务端 WebSocket 协议契约。
 *
 * 这是两端唯一的事实来源：Agent（Kotlin）与服务端（TS）都以本文件为准，
 * 任何改动必须同步两端并递增 PROTOCOL_VERSION。
 *
 * 运行时无关：本文件只依赖 zod，不得引入任何 Node / Workers 特有 API。
 */
import { z } from 'zod'

/** 协议版本。不兼容变更时递增；服务端拒绝未知版本。 */
export const PROTOCOL_VERSION = 1

// ─────────────────────────────────────────────────────────────
// 时间与超时常量（两端共用，不要各写各的）
// ─────────────────────────────────────────────────────────────

/** 心跳间隔（秒）。由 hello_ack.config 下发，此处为默认值。 */
export const DEFAULT_HEARTBEAT_SEC = 30
/** 无 pong 超过此秒数判定离线。 */
export const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 90
/** 离线超过此秒数触发跨渠道告警（计划 §10.1）。 */
export const OFFLINE_ALERT_SEC = 300

/**
 * 帧时间戳 `ts` 允许的时钟偏移（毫秒）。超出即拒绝，用于抵御重放。
 *
 * 注意这只约束 `ts`（帧生成时刻），不约束 `event.occurred_at`——
 * 补传场景下 occurred_at 可以是数天前，这是正常的。
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000

/** 单个 event 帧允许的最大内容长度（字符）。超长截断并标记。 */
export const MAX_CONTENT_LEN = 4096

/** Agent 本地离线队列上限（条）。超限丢弃最旧并告警（计划 §10.2）。 */
export const MAX_PENDING_EVENTS = 5000

// ─────────────────────────────────────────────────────────────
// 错误码
// ─────────────────────────────────────────────────────────────

/**
 * 服务端拒绝时返回的错误码。
 *
 * `retryable` 语义由 Agent 决定重连策略：
 *  - AUTH_* 与 PROTOCOL_VERSION_UNSUPPORTED 不可重试，需人工介入（重新配对/升级）
 *  - 其余可按指数退避重试
 */
export const ErrorCode = {
  /** token 不匹配 */
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  /** 设备存在但凭证已被吊销（计划 §6.1） */
  AUTH_DEVICE_REVOKED: 'AUTH_DEVICE_REVOKED',
  /** device_id 不存在 */
  AUTH_UNKNOWN_DEVICE: 'AUTH_UNKNOWN_DEVICE',
  /** 协议版本不受支持 */
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  /** 帧结构非法 / 校验失败 */
  PROTOCOL_MALFORMED: 'PROTOCOL_MALFORMED',
  /** 时钟偏移超出容忍范围 */
  CLOCK_SKEW: 'CLOCK_SKEW',
  /** 超出速率限制 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 服务端尚未完成初始化向导（计划 §12.1①），一律拒绝 */
  SERVER_NOT_INITIALIZED: 'SERVER_NOT_INITIALIZED',
  /** 服务端内部错误 */
  INTERNAL: 'INTERNAL',
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** 不可重试的错误码：Agent 收到后应停止重连并提示用户。 */
export const FATAL_ERROR_CODES: readonly ErrorCode[] = [
  ErrorCode.AUTH_INVALID_TOKEN,
  ErrorCode.AUTH_DEVICE_REVOKED,
  ErrorCode.AUTH_UNKNOWN_DEVICE,
  ErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
]

// ─────────────────────────────────────────────────────────────
// 基础类型
// ─────────────────────────────────────────────────────────────

/** epoch 毫秒 */
const Timestamp = z.number().int().nonnegative()

/** 设备端生成的事件 id，格式 `evt_<uuid-v4>`，服务端据此幂等去重。 */
export const EventId = z.string().regex(/^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
/** 指令 id，格式 `cmd_<uuid-v4>`。 */
export const CmdId = z.string().regex(/^cmd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
/** 设备 id，服务端配对时生成。 */
export const DeviceId = z.string().min(3).max(64).regex(/^dev_[A-Za-z0-9_-]+$/)

export const EventKind = z.enum(['sms', 'call', 'notification'])
export type EventKind = z.infer<typeof EventKind>

export const CmdAction = z.enum(['send_sms', 'query_status', 'reboot_service', 'sync_config'])
export type CmdAction = z.infer<typeof CmdAction>

/**
 * 发送状态机（计划 §5.5）：accepted → sent → delivered，任一步可转 failed。
 * 每一步都回传，控制台上可见完整过程。
 */
export const CmdStatus = z.enum(['accepted', 'sent', 'delivered', 'failed'])
export type CmdStatus = z.infer<typeof CmdStatus>

// ─────────────────────────────────────────────────────────────
// payload 定义
// ─────────────────────────────────────────────────────────────

/** Agent → 服务端：握手。 */
export const HelloPayload = z.object({
  device_id: DeviceId,
  /** 长期凭证明文；服务端只存哈希（计划 §6.1）。 */
  token: z.string().min(16).max(512),
  app_version: z.string().max(32),
  android_sdk: z.number().int().min(1).max(200),
  /** 电量百分比 0-100 */
  battery: z.number().int().min(0).max(100),
  /** 本地待补传条数，服务端用于显示与告警 */
  pending_count: z.number().int().min(0),
})

/**
 * 服务端下发的运行配置。Agent 不持久化业务配置，每次握手以此为准
 * （计划 §5.3：Agent 无状态）。
 */
export const AgentConfig = z.object({
  heartbeat_sec: z.number().int().min(5).max(300),
  heartbeat_timeout_sec: z.number().int().min(10).max(900),
  /** 是否启用通知捕获（NotificationListenerService） */
  capture_notification: z.boolean(),
  /** v2 端到端模式开关，v1 恒为 false（计划 §3.1 决策二） */
  encrypt_payload: z.boolean(),
  /** 单次补传最大批量，避免重连瞬间打爆服务端 */
  max_batch_size: z.number().int().min(1).max(200),
  /** 允许上报的事件类型，服务端可动态收窄 */
  enabled_kinds: z.array(EventKind).min(1),
})
export type AgentConfig = z.infer<typeof AgentConfig>

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  heartbeat_sec: DEFAULT_HEARTBEAT_SEC,
  heartbeat_timeout_sec: DEFAULT_HEARTBEAT_TIMEOUT_SEC,
  capture_notification: false,
  encrypt_payload: false,
  max_batch_size: 50,
  enabled_kinds: ['sms', 'call'],
}

/** 服务端 → Agent：握手成功。 */
export const HelloAckPayload = z.object({
  server_time: Timestamp,
  config: AgentConfig,
  /**
   * 服务端已确认存在的事件 id（取 Agent pending 的交集回执）。
   * 预留字段：用于重连后快速对账，避免整队重传。v1 可为空数组。
   */
  known_event_ids: z.array(EventId).default([]),
})

/** 服务端 → Agent：握手被拒。发送后立即关闭连接。 */
export const HelloRejectPayload = z.object({
  code: z.enum([
    ErrorCode.AUTH_INVALID_TOKEN,
    ErrorCode.AUTH_DEVICE_REVOKED,
    ErrorCode.AUTH_UNKNOWN_DEVICE,
    ErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
    ErrorCode.CLOCK_SKEW,
    ErrorCode.RATE_LIMITED,
    ErrorCode.SERVER_NOT_INITIALIZED,
    ErrorCode.INTERNAL,
  ]),
  /** 面向人的说明，不含敏感信息 */
  message: z.string().max(200),
  /** 建议等待秒数；不可重试错误为 null */
  retry_after_sec: z.number().int().min(0).nullable(),
})

/**
 * Agent → 服务端：一条事件。
 *
 * 敏感字段：`from` 与 `content` 落库前必须 AES-256-GCM 加密（计划 §6.2），
 * 且任何日志输出中都必须脱敏——stdout 会进 Docker 日志并长期留存。
 */
export const EventPayload = z.object({
  /** 设备端生成，服务端按此幂等去重。 */
  id: EventId,
  device_id: DeviceId,
  kind: EventKind,
  /** 发件人号码 / 来电号码 / 通知包名对应的来源 */
  from: z.string().max(64),
  content: z.string().max(MAX_CONTENT_LEN),
  /** 事件真实发生时间，不是上报时间。补传时的排序依据。 */
  occurred_at: Timestamp,
  /** 双卡槽位，0 或 1；未知为 null */
  sim_slot: z.number().int().min(0).max(3).nullable(),
  extra: z
    .object({
      /** kind=call 时：来电类型 */
      call_type: z.enum(['incoming', 'missed', 'outgoing']).optional(),
      /** kind=notification 时：来源包名 */
      package: z.string().max(128).optional(),
      /** content 被 MAX_CONTENT_LEN 截断时为 true */
      truncated: z.boolean().optional(),
    })
    .default({}),
})
export type EventPayload = z.infer<typeof EventPayload>

/** 单条事件的入库结果。 */
export const EventAckItem = z.object({
  id: EventId,
  /** stored=新写入 duplicate=幂等命中（Agent 同样应出队） rejected=校验失败，不再重试 */
  status: z.enum(['stored', 'duplicate', 'rejected']),
  /** status=rejected 时的原因 */
  error: z.string().max(200).nullable().default(null),
})

/**
 * 服务端 → Agent：事件回执，支持批量。
 * Agent 必须收到 ack 才从本地队列删除（计划 §5.4）。
 */
export const EventAckPayload = z.object({
  acks: z.array(EventAckItem).min(1),
})

/** 服务端 → Agent：下行指令。 */
export const CmdPayload = z.object({
  cmd_id: CmdId,
  action: CmdAction,
  args: z.record(z.string(), z.unknown()).default({}),
})

/** action=send_sms 时 args 的结构。 */
export const SendSmsArgs = z.object({
  to: z.string().min(3).max(32),
  text: z.string().min(1).max(MAX_CONTENT_LEN),
  sim_slot: z.number().int().min(0).max(3).nullable().default(null),
})

/** Agent → 服务端：指令回执。状态机每一步都发一帧。 */
export const CmdResultPayload = z.object({
  cmd_id: CmdId,
  status: CmdStatus,
  /** status=failed 时的原因 */
  error: z.string().max(200).nullable().default(null),
  /** 可选补充信息，如运营商返回码 */
  detail: z.record(z.string(), z.unknown()).nullable().default(null),
})

/** 心跳。seq 用于匹配 ping/pong，便于测量 RTT。 */
export const PingPayload = z.object({ seq: z.number().int().nonnegative() })
export const PongPayload = z.object({
  seq: z.number().int().nonnegative(),
  /** Agent 顺带上报的实时状态，服务端用于控制台展示 */
  battery: z.number().int().min(0).max(100).optional(),
  pending_count: z.number().int().min(0).optional(),
})

// ─────────────────────────────────────────────────────────────
// 统一信封
// ─────────────────────────────────────────────────────────────

const envelope = <const T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    /** 每帧唯一，uuid-v4，用于日志追踪与重放检测 */
    msg_id: z.string().uuid(),
    /** 帧生成时刻，受 CLOCK_SKEW_TOLERANCE_MS 约束 */
    ts: Timestamp,
    payload,
  })

export const HelloFrame = envelope('hello', HelloPayload)
export const HelloAckFrame = envelope('hello_ack', HelloAckPayload)
export const HelloRejectFrame = envelope('hello_reject', HelloRejectPayload)
export const EventFrame = envelope('event', EventPayload)
export const EventAckFrame = envelope('event_ack', EventAckPayload)
export const CmdFrame = envelope('cmd', CmdPayload)
export const CmdResultFrame = envelope('cmd_result', CmdResultPayload)
export const PingFrame = envelope('ping', PingPayload)
export const PongFrame = envelope('pong', PongPayload)

/** 允许由 Agent 发往服务端的帧。 */
export const UpstreamFrame = z.discriminatedUnion('type', [
  HelloFrame,
  EventFrame,
  CmdResultFrame,
  PingFrame,
  PongFrame,
])
export type UpstreamFrame = z.infer<typeof UpstreamFrame>

/** 允许由服务端发往 Agent 的帧。 */
export const DownstreamFrame = z.discriminatedUnion('type', [
  HelloAckFrame,
  HelloRejectFrame,
  EventAckFrame,
  CmdFrame,
  PingFrame,
  PongFrame,
])
export type DownstreamFrame = z.infer<typeof DownstreamFrame>

export type AnyFrame = UpstreamFrame | DownstreamFrame
