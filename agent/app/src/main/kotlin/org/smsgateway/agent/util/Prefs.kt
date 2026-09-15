package org.smsgateway.agent.util

import android.content.Context
import androidx.core.content.edit
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.protocol.SmsCommandConfig

/**
 * 设备身份与服务端地址。
 *
 * Agent 无状态（计划 §2.3）——这里只存「我是谁、连哪」，
 * 所有业务配置由服务端 hello_ack.config 下发，不落盘。
 */
class Prefs(ctx: Context) {
    private val sp = ctx.applicationContext.getSharedPreferences("agent", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString(KEY_URL, null)
        set(v) = sp.edit { putString(KEY_URL, v) }

    var deviceId: String?
        get() = sp.getString(KEY_DEVICE, null)
        set(v) = sp.edit { putString(KEY_DEVICE, v) }

    var token: String?
        get() = sp.getString(KEY_TOKEN, null)
        set(v) = sp.edit { putString(KEY_TOKEN, v) }

    var deviceName: String
        get() = sp.getString(KEY_NAME, "") ?: ""
        set(v) = sp.edit { putString(KEY_NAME, v) }

    /**
     * 短信指令配置。**唯一落盘的业务配置**。
     *
     * 破例的理由：这个功能是给「手机连不上服务端」那一刻用的，
     * 配置若只在内存里，进程一重启就没了——而重启恰恰最需要它。
     * 其余业务配置一律仍由 hello_ack.config 下发、不落盘（计划 §2.3）。
     */
    var smsCommand: SmsCommandConfig
        get() = sp.getString(KEY_SMS_CMD, null)
            ?.let { runCatching { Protocol.json.decodeFromString(SmsCommandConfig.serializer(), it) }.getOrNull() }
            ?: SmsCommandConfig()
        set(v) = sp.edit { putString(KEY_SMS_CMD, Protocol.json.encodeToString(SmsCommandConfig.serializer(), v)) }

    /**
     * 这台设备第一次开始采集的时刻。
     *
     * 历史导入以它为界：早于这个时刻的才导。不设这条线，导入与实时捕获会在边界上
     * 重叠，同一条短信进两次——两条路径生成的 id 不同，服务端的幂等去重救不了。
     * 只写一次，之后重装 App 也不该改（除非解除配对清空）。
     */
    val captureStartedAt: Long
        get() {
            val v = sp.getLong(KEY_CAPTURE_START, 0L)
            if (v > 0L) return v
            val now = System.currentTimeMillis()
            sp.edit { putLong(KEY_CAPTURE_START, now) }
            return now
        }

    val isPaired: Boolean
        get() = !serverUrl.isNullOrBlank() && !deviceId.isNullOrBlank() && !token.isNullOrBlank()

    fun clear() = sp.edit { clear() }

    private companion object {
        const val KEY_URL = "server_url"
        const val KEY_DEVICE = "device_id"
        const val KEY_TOKEN = "token"
        const val KEY_NAME = "device_name"
        const val KEY_SMS_CMD = "sms_command"
        const val KEY_CAPTURE_START = "capture_started_at"
    }
}
