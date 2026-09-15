package org.smsgateway.agent.util

import android.content.Context
import androidx.core.content.edit

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

    val isPaired: Boolean
        get() = !serverUrl.isNullOrBlank() && !deviceId.isNullOrBlank() && !token.isNullOrBlank()

    fun clear() = sp.edit { clear() }

    private companion object {
        const val KEY_URL = "server_url"
        const val KEY_DEVICE = "device_id"
        const val KEY_TOKEN = "token"
        const val KEY_NAME = "device_name"
    }
}
