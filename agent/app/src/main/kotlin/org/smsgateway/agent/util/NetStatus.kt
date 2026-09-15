package org.smsgateway.agent.util

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.telephony.TelephonyManager

/**
 * 设备网络状态快照。
 *
 * 随心跳上报给服务端，也供短信指令直接回答「网络怎么样」——同一份逻辑，
 * 两个出口。拆出来之前这段只长在短信指令里，控制台看不到，
 * 而掉线排查最需要的恰恰是它：「手机不在线」只有一个比特的信息量，
 * 「WiFi 关了」「信号 0 格」才说明是为什么。
 */
data class NetSnapshot(
    val wifi: Boolean,
    /** wifi | cellular | none | other */
    val type: String,
    val ssid: String?,
    val carrier: String?,
    /** 移动信号格数 0–4，取不到为 null */
    val signal: Int?,
    /** 网络是否真的通。连上 WiFi 但没网的情况很常见 */
    val online: Boolean,
) {
    /**
     * 一行人话，给短信指令用。一条短信只有 70 个字，能省则省。
     *
     * 信号单独说、不挂在「走移动数据」后面：连着 WiFi 时 SIM 卡照样可能没信号，
     * 而那种情况下短信收不到——恰恰是发指令来问的人最想知道的一条。
     */
    fun describe(): String = buildString {
        append("WiFi ").append(if (wifi) "开" else "关")
        append("，").append(
            when {
                type == "wifi" && ssid != null -> "已连 $ssid"
                type == "wifi" -> "已连 WiFi"
                type == "cellular" -> "走移动数据"
                type == "none" -> "无网络"
                else -> "其他网络"
            },
        )
        if (type != "none" && !online) append("（未验证）")
        if (signal != null) append("，信号 ").append(signal).append("/4")
        if (!carrier.isNullOrBlank()) append("，运营商 ").append(carrier)
    }
}

object NetStatus {

    @SuppressLint("MissingPermission")
    fun read(ctx: Context): NetSnapshot {
        val app = ctx.applicationContext
        val wifiOn = runCatching {
            (app.getSystemService(Context.WIFI_SERVICE) as? WifiManager)?.isWifiEnabled == true
        }.getOrDefault(false)

        val cm = app.getSystemService(ConnectivityManager::class.java)
        val caps = runCatching { cm?.getNetworkCapabilities(cm.activeNetwork) }.getOrNull()

        val type = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            else -> "other"
        }

        return NetSnapshot(
            wifi = wifiOn,
            type = type,
            ssid = if (type == "wifi") ssid(app) else null,
            carrier = runCatching {
                app.getSystemService(TelephonyManager::class.java)?.networkOperatorName
            }.getOrNull()?.takeIf { it.isNotBlank() },
            signal = signalBars(app),
            online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
        )
    }

    /** SSID 需要定位权限且已连接，取不到就报 null，不要编一个「未知」上去。 */
    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun ssid(ctx: Context): String? = runCatching {
        (ctx.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
            ?.connectionInfo?.ssid?.trim('"')
            ?.takeIf { it.isNotBlank() && it != "<unknown ssid>" }
    }.getOrNull()

    /**
     * 移动信号格数。
     *
     * `signalStrength.level` 从 API 28 起可用，之前的版本没有统一口径的换算
     * （各家 ROM 自己定义），与其给一个不可比的数字不如不给。
     *
     * 没插 SIM 卡时 level 会返回 0，和「插了卡但一格都没有」无法区分。
     * 那会在控制台上报一个红色的「无服务」假警报，所以先确认卡就绪再取值。
     */
    @SuppressLint("MissingPermission")
    private fun signalBars(ctx: Context): Int? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
        return runCatching {
            val tm = ctx.getSystemService(TelephonyManager::class.java) ?: return null
            if (tm.simState != TelephonyManager.SIM_STATE_READY) return null
            tm.signalStrength?.level?.coerceIn(0, 4)
        }.getOrNull()
    }
}
