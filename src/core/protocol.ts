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

/**
 * 设备端生成的事件 id，服务端据此幂等去重。两种形态：
 *
 * - `evt_<uuid-v4>`：实时捕获。随机即可，重复上报靠 id 相同来去重。
 * - `evt_imp_<sms|call>_<手机本地行号>`：历史导入。**必须是确定的**——
 *   重复点一次导入不该产生重复记录，而随机 id 做不到这件事。
 */
export const EventId = z.string().regex(
  /^evt_(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|imp_(?:sms|call)_\d{1,19})$/,
)
/** 指令 id，格式 `cmd_<uuid-v4>`。 */
export const CmdId = z.string().regex(/^cmd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
/** 设备 id，服务端配对时生成。 */
export const DeviceId = z.string().min(3).max(64).regex(/^dev_[A-Za-z0-9_-]+$/)

export const EventKind = z.enum(['sms', 'call', 'notification'])
export type EventKind = z.infer<typeof EventKind>

export const CmdAction = z.enum([
  'send_sms', 'query_status', 'reboot_service', 'sync_config', 'get_location', 'list_apps',
  'import_history', 'list_fingerprints',
])
export type CmdAction = z.infer<typeof CmdAction>

/**
 * 指令状态机。
 *
 * 发短信走 accepted → sent → delivered（计划 §5.5），每一步都回传，
 * 控制台上可见完整过程。
 *
 * 查询类指令（如 get_location）没有「发出/送达」之分，走
 * accepted → done，结果放在 cmd_result 的 detail 里。
 * 任一步都可转 failed。
 */
export const CmdStatus = z.enum(['accepted', 'sent', 'delivered', 'done', 'failed'])
export type CmdStatus = z.infer<typeof CmdStatus>

// ─────────────────────────────────────────────────────────────
// payload 定义
// ─────────────────────────────────────────────────────────────

/** Agent → 服务端：握手。 */
/**
 * 设备的网络状态快照。
 *
 * 随心跳上报，控制台据此显示「连的是 WiFi 还是流量、信号几格」。
 * 掉线排查时这是最有用的一组信息——「手机在不在线」只有一个比特，
 * 「WiFi 关了」「信号 0 格」才说明是为什么。
 */
export const NetStatus = z.object({
  /** WiFi 开关是否打开 */
  wifi: z.boolean().nullish(),
  /** 当前走的是哪条路 */
  type: z.enum(['wifi', 'cellular', 'none', 'other']).nullish(),
  /** 连着 WiFi 时的名字。取不到（缺权限或未连接）为 null */
  ssid: z.string().max(64).nullish(),
  /** 运营商 */
  carrier: z.string().max(64).nullish(),
  /** 移动信号格数 0–4 */
  signal: z.number().int().min(0).max(4).nullish(),
  /** 网络是否真的通（连上 WiFi 但没网的情况很常见） */
  online: z.boolean().nullish(),
})
export type NetStatus = z.infer<typeof NetStatus>

export const HelloPayload = z.object({
  device_id: DeviceId,
  /** 长期凭证明文；服务端只存哈希（计划 §6.1）。 */
  token: z.string().min(16).max(512),
  app_version: z.string().max(32),
  android_sdk: z.number().int().min(1).max(200),
  /** 电量百分比 0-100 */
  battery: z.number().int().min(0).max(100),
  /**
   * 是否正在充电。
   *
   * 老版本 Agent 不带这个字段，因此可选——服务端不能因为字段缺失就拒绝
   * 老设备连接，那等于一次升级把所有设备踢下线。
   */
  charging: z.boolean().nullish(),
  /** 本地待补传条数，服务端用于显示与告警 */
  pending_count: z.number().int().min(0),
  /** 连上就报一次网络状态，不用等第一个心跳 */
  net: NetStatus.nullish(),
})

/**
 * 服务端下发的运行配置。Agent 不持久化业务配置，每次握手以此为准
 * （计划 §5.3：Agent 无状态）。
 */
/**
 * 短信指令配置。
 *
 * 口令放在短信正文里明文传输——这是这条链路的物理限制，没有别的办法：
 * 人在外面只能手打一条短信，算不了签名。因此防线放在别处：
 *  - 口令是服务端生成的随机串，不是用户自己起的
 *  - 可选的号码白名单作为第二道（主叫号码可伪造，所以只能是「之一」）
 *  - 限速 + 失败锁定，挡住穷举
 *  - 能力最小化：只查状态、重连、定位，**不含发短信**，
 *    伪造成功也偷不走验证码，只能知道手机还活着
 *  - 每次执行都推送告警，被人试了你立刻知道
 */
export const SmsCommandConfig = z.object({
  enabled: z.boolean(),
  /** 口令。服务端生成，8–32 位，区分大小写 */
  secret: z.string().max(32),
  /** 允许下指令的号码（部分匹配，空 = 不限制） */
  allow_numbers: z.array(z.string().max(32)).max(20).default([]),
  /** 是否用短信回复结果。关掉就只推到渠道——但那需要网络，而网络可能正是坏的那一环 */
  reply: z.boolean().default(true),
})
export type SmsCommandConfig = z.infer<typeof SmsCommandConfig>

export const AgentConfig = z.object({
  heartbeat_sec: z.number().int().min(5).max(300),
  heartbeat_timeout_sec: z.number().int().min(10).max(900),
  /** 是否启用通知捕获（NotificationListenerService） */
  capture_notification: z.boolean(),
  /**
   * 捕获范围。
   *
   * - all：全部应用，**包括以后新装的**，不用回来更新列表
   * - selected：只捕获 notification_packages 里的应用
   *
   * 两种模式各有代价：all 省心但噪音大（手机上几十个应用每天产生成百上千条
   * 通知），selected 精准但装了新应用要回来加。让用户自己选。
   */
  notification_scope: z.enum(['all', 'selected']).default('selected'),
  /** notification_scope=selected 时的包名白名单 */
  notification_packages: z.array(z.string().max(128)).max(200).default([]),
  /** v2 端到端模式开关，v1 恒为 false（计划 §3.1 决策二） */
  encrypt_payload: z.boolean(),
  /** 单次补传最大批量，避免重连瞬间打爆服务端 */
  max_batch_size: z.number().int().min(1).max(200),
  /** 允许上报的事件类型，服务端可动态收窄 */
  enabled_kinds: z.array(EventKind).min(1),
  /**
   * 短信指令。
   *
   * 唯一一处 Agent 必须落盘的业务配置（其余都是内存，见计划 §2.3）：
   * 这个功能存在的意义就是「手机联不上服务端时还能问出状态」，
   * 如果配置只在内存里，重启后就废了——而重启恰恰是最需要它的时刻。
   */
  sms_command: SmsCommandConfig.default({
    enabled: false, secret: '', allow_numbers: [], reply: true,
  }),
})
export type AgentConfig = z.infer<typeof AgentConfig>

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  heartbeat_sec: DEFAULT_HEARTBEAT_SEC,
  heartbeat_timeout_sec: DEFAULT_HEARTBEAT_TIMEOUT_SEC,
  capture_notification: false,
  notification_scope: 'selected',
  notification_packages: [],
  encrypt_payload: false,
  max_batch_size: 50,
  enabled_kinds: ['sms', 'call'],
  sms_command: { enabled: false, secret: '', allow_numbers: [], reply: true },
}

/** 历史导入的结果，随 cmd_result 的 detail 回传。 */
export const ImportResult = z.object({
  sms: z.number().int().min(0),
  calls: z.number().int().min(0),
  /** 因缺权限被跳过的类别数 */
  skipped: z.number().int().min(0).default(0),
})
export type ImportResult = z.infer<typeof ImportResult>

/** 手机当前还有哪些记录（只有指纹，没有原文）。用于镜像同步的比对。 */
export const FingerprintList = z.object({
  items: z.array(z.object({ fp: z.string().max(32), at: Timestamp })).max(20000),
  truncated: z.boolean().default(false),
})
export type FingerprintList = z.infer<typeof FingerprintList>

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
  /**
   * 双卡槽位，0 或 1；未知为 null。
   *
   * 用 nullish 而非 nullable：Kotlin 侧配置了 explicitNulls=false，
   * 空值会被**整个省略**而不是写成 null。只写 nullable 的话，
   * 通知这类恒无卡槽的事件会被判为非法帧整条丢掉——协议边界上的每一个
   * 可空字段都要同时容忍「显式 null」与「字段缺失」两种写法。
   */
  sim_slot: z.number().int().min(0).max(3).nullish().transform((v) => v ?? null),
  extra: z
    .object({
      // 用 nullish 而非 optional：Kotlin 等语言序列化空值时给的是显式 null，
      // 而 zod 的 optional 只接受 undefined。协议边界要对两种写法都宽容。
      /** kind=call 时：来电类型 */
      call_type: z.enum(['incoming', 'missed', 'outgoing']).nullish(),
      /** kind=notification 时：来源包名 */
      package: z.string().max(128).nullish(),
      /** content 被 MAX_CONTENT_LEN 截断时为 true */
      truncated: z.boolean().nullish(),
      /**
       * 方向。in=收到，out=这台设备发出的。
       *
       * 手机上手动发的短信也会被捕获，否则「这条验证码我转给谁了」
       * 在历史里查不到。缺省按 in 处理，兼容不上报该字段的老 Agent。
       */
      direction: z.enum(['in', 'out']).nullish(),
      /**
       * 历史导入：这条是网关启用**之前**手机里就有的记录。
       *
       * 必须区分出来——导入几千条旧短信时如果照常走推送，
       * 等于把几千条通知一次性砸到你手机上。导入的只归档、不推送。
       */
      imported: z.boolean().nullish(),
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

/**
 * action=get_location 的回执结构。
 *
 * 位置是敏感信息，与短信正文同等对待：落库加密、日志脱敏、每次查询写审计。
 */
export const LocationResult = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** 水平精度，米 */
  accuracy: z.number().nonnegative().nullable(),
  /** gps / network / passive / fused */
  provider: z.string().max(32),
  /** 定位时刻。可能明显早于回执时刻——那说明返回的是缓存位置 */
  time: z.number().int().nonnegative(),
  /** 是否为系统缓存的最后已知位置，而非本次实时定位 */
  cached: z.boolean().default(false),
})
export type LocationResult = z.infer<typeof LocationResult>

/**
 * action=list_apps 的回执结构。
 *
 * 供控制台挑选要捕获通知的应用——让用户手敲包名是不现实的。
 */
export const AppListResult = z.object({
  apps: z.array(z.object({
    package: z.string().max(200),
    label: z.string().max(200),
    /** 系统应用。默认不展示，但短信、电话这些系统应用有时也需要 */
    system: z.boolean(),
  })).max(1000),
})
export type AppListResult = z.infer<typeof AppListResult>

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
  /** Agent 顺带上报的实时状态，服务端用于控制台展示与电量告警 */
  battery: z.number().int().min(0).max(100).optional(),
  charging: z.boolean().nullish(),
  pending_count: z.number().int().min(0).optional(),
  net: NetStatus.nullish(),
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
