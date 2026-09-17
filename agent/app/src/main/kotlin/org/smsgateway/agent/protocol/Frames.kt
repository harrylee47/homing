package org.smsgateway.agent.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * 协议契约的 Kotlin 侧实现。
 *
 * **必须与服务端 src/core/protocol.ts 严格对齐**，任何改动要同步两端并递增 VERSION。
 */
object Protocol {
    const val VERSION = 1

    const val DEFAULT_HEARTBEAT_SEC = 30
    const val DEFAULT_HEARTBEAT_TIMEOUT_SEC = 90

    /** 帧时间戳允许的时钟偏移，超出服务端会拒绝。 */
    const val CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000L

    const val MAX_CONTENT_LEN = 4096

    /** 本地离线队列上限，超限丢弃最旧并告警。 */
    const val MAX_PENDING_EVENTS = 5000

    val json = Json {
        ignoreUnknownKeys = true      // 服务端新增字段不应导致老 Agent 解析失败
        encodeDefaults = true
        // 空字段直接省略，不输出 null —— 与服务端 zod schema 的 optional 语义一致
        explicitNulls = false
    }
}

/** 不可重试的错误码：收到后停止重连并提示用户，见 protocol.ts 的 FATAL_ERROR_CODES。 */
object ErrorCodes {
    const val AUTH_INVALID_TOKEN = "AUTH_INVALID_TOKEN"
    const val AUTH_DEVICE_REVOKED = "AUTH_DEVICE_REVOKED"
    const val AUTH_UNKNOWN_DEVICE = "AUTH_UNKNOWN_DEVICE"
    const val PROTOCOL_VERSION_UNSUPPORTED = "PROTOCOL_VERSION_UNSUPPORTED"

    /**
     * 账号停用或到期。**故意不在 FATAL 里**：它会自己好转（用户续期、
     * 管理员改到期时间），进 FATAL 就等于续完期手机再也不会自己连回来。
     * 退避循环最长 60 秒一次，续期后一分钟内自动恢复。
     */
    const val ACCOUNT_INACTIVE = "ACCOUNT_INACTIVE"

    val FATAL = setOf(
        AUTH_INVALID_TOKEN, AUTH_DEVICE_REVOKED,
        AUTH_UNKNOWN_DEVICE, PROTOCOL_VERSION_UNSUPPORTED,
    )
}

// ── 统一信封 ────────────────────────────────────────────────

/**
 * 收帧用的宽松信封：payload 保持为 JsonElement，按 type 再各自解析。
 * 这样服务端新增帧类型时老 Agent 只会忽略，而不是崩溃。
 */
@Serializable
data class Envelope(
    val v: Int,
    val type: String,
    @SerialName("msg_id") val msgId: String,
    val ts: Long,
    val payload: JsonElement = JsonObject(emptyMap()),
)

// ── 上行 payload ────────────────────────────────────────────

/** 网络状态快照。与服务端 protocol.ts 的 NetStatus 对应。 */
@Serializable
data class NetPayload(
    val wifi: Boolean? = null,
    val type: String? = null,
    val ssid: String? = null,
    val carrier: String? = null,
    val signal: Int? = null,
    val online: Boolean? = null,
    /** 插着的 SIM 卡，逐卡各报一份。空列表表示「不知道」 */
    val sims: List<SimPayload>? = null,
)

/** slot 是卡槽序号（0 = SIM1），不是 subscriptionId。 */
@Serializable
data class SimPayload(
    val slot: Int,
    val carrier: String? = null,
    val label: String? = null,
    /** 本机号码后 4 位，取不到为 null */
    val tail: String? = null,
    val signal: Int? = null,
    @SerialName("default_sms") val defaultSms: Boolean? = null,
    @SerialName("default_data") val defaultData: Boolean? = null,
)

@Serializable
data class HelloPayload(
    @SerialName("device_id") val deviceId: String,
    val token: String,
    @SerialName("app_version") val appVersion: String,
    @SerialName("android_sdk") val androidSdk: Int,
    val battery: Int,
    /** 是否正在充电 */
    val charging: Boolean,
    @SerialName("pending_count") val pendingCount: Int,
    /** 连上就报一次，不用等第一个心跳 */
    val net: NetPayload? = null,
)

@Serializable
data class EventExtra(
    @SerialName("call_type") val callType: String? = null,
    val `package`: String? = null,
    val truncated: Boolean? = null,
    /** in=收到，out=本机发出。缺省按 in 处理 */
    val direction: String? = null,
    /** 历史导入：服务端只归档不推送 */
    val imported: Boolean? = null,
)

@Serializable
data class EventPayload(
    val id: String,
    @SerialName("device_id") val deviceId: String,
    val kind: String,
    val from: String,
    val content: String,
    /** 事件真实发生时间，不是上报时间。补传时的排序依据。 */
    @SerialName("occurred_at") val occurredAt: Long,
    @SerialName("sim_slot") val simSlot: Int?,
    val extra: EventExtra = EventExtra(),
)

@Serializable
data class CmdResultPayload(
    @SerialName("cmd_id") val cmdId: String,
    /** accepted / sent / delivered（发短信）｜ done（查询类）｜ failed */
    val status: String,
    val error: String? = null,
    val detail: JsonElement? = null,
)

/** list_apps 的回执内容。 */
@Serializable
data class AppInfo(
    val `package`: String,
    val label: String,
    val system: Boolean,
)

@Serializable
data class AppListResult(val apps: List<AppInfo>)

/** get_location 的回执内容。位置与短信正文同等敏感，服务端加密落库。 */
@Serializable
data class LocationResult(
    val lat: Double,
    val lng: Double,
    val accuracy: Float? = null,
    val provider: String,
    val time: Long,
    val cached: Boolean = false,
)

@Serializable
data class PingPayload(val seq: Long)

@Serializable
data class PongPayload(
    val seq: Long,
    val battery: Int? = null,
    val charging: Boolean? = null,
    @SerialName("pending_count") val pendingCount: Int? = null,
    val net: NetPayload? = null,
)

// ── 下行 payload ────────────────────────────────────────────

@Serializable
data class AgentConfig(
    @SerialName("heartbeat_sec") val heartbeatSec: Int = Protocol.DEFAULT_HEARTBEAT_SEC,
    @SerialName("heartbeat_timeout_sec") val heartbeatTimeoutSec: Int = Protocol.DEFAULT_HEARTBEAT_TIMEOUT_SEC,
    @SerialName("capture_notification") val captureNotification: Boolean = false,
    /** all = 全部应用（含以后新装的）；selected = 仅白名单 */
    @SerialName("notification_scope") val notificationScope: String = "selected",
    /** notificationScope=selected 时的白名单 */
    @SerialName("notification_packages") val notificationPackages: List<String> = emptyList(),
    @SerialName("encrypt_payload") val encryptPayload: Boolean = false,
    @SerialName("max_batch_size") val maxBatchSize: Int = 50,
    @SerialName("enabled_kinds") val enabledKinds: List<String> = listOf("sms", "call"),
    @SerialName("sms_command") val smsCommand: SmsCommandConfig = SmsCommandConfig(),
)

/** 历史导入结果。与服务端 protocol.ts 的 ImportResult 对应。 */
@Serializable
data class ImportResult(val sms: Int, val calls: Int, val skipped: Int)

/** 手机当前还有哪些记录，用于镜像同步的比对。 */
@Serializable
data class FingerprintItem(val fp: String, val at: Long)

@Serializable
data class FingerprintList(val items: List<FingerprintItem>, val truncated: Boolean = false)

/** 短信指令配置。语义见服务端 protocol.ts 的 SmsCommandConfig。 */
@Serializable
data class SmsCommandConfig(
    val enabled: Boolean = false,
    val secret: String = "",
    @SerialName("allow_numbers") val allowNumbers: List<String> = emptyList(),
    val reply: Boolean = true,
)

@Serializable
data class HelloAckPayload(
    @SerialName("server_time") val serverTime: Long,
    val config: AgentConfig,
    @SerialName("known_event_ids") val knownEventIds: List<String> = emptyList(),
)

@Serializable
data class HelloRejectPayload(
    val code: String,
    val message: String,
    @SerialName("retry_after_sec") val retryAfterSec: Int? = null,
)

@Serializable
data class EventAckItem(
    val id: String,
    /** stored / duplicate / rejected —— 三者都应让本地队列出队 */
    val status: String,
    val error: String? = null,
)

@Serializable
data class EventAckPayload(val acks: List<EventAckItem>)

@Serializable
data class CmdPayload(
    @SerialName("cmd_id") val cmdId: String,
    val action: String,
    val args: JsonObject = JsonObject(emptyMap()),
)

/**
 * 历史导入参数。
 *
 * **必须按类型解码**，不能对 `cmd.args["since"]` 做 `as? String` ——
 * args 是 JsonObject，取出来的是 JsonPrimitive，那个转换永远返回 null，
 * 于是时间范围和条数上限被静默忽略，界面上选什么都等于「全部、按默认上限」。
 */
@Serializable
data class ImportArgs(
    val since: Long? = null,
    val limit: Int = 1000,
)

@Serializable
data class SendSmsArgs(
    val to: String,
    val text: String,
    @SerialName("sim_slot") val simSlot: Int? = null,
)
