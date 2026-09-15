package org.smsgateway.agent.command

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.telephony.TelephonyManager
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.location.Locator
import org.smsgateway.agent.net.ConnState
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.sms.SmsSender
import org.smsgateway.agent.util.Log
import java.util.UUID

/**
 * 短信指令的执行端。
 *
 * 为什么这件事必须在手机上做完、不能转给服务端：这个功能存在的全部意义
 * 就是「手机连不上服务端了，我还想知道它怎么了」。链路一旦经过服务端，
 * 最需要它的那一刻恰好是它不工作的那一刻。
 *
 * 因此：配置落盘（唯一的例外，见 Prefs.smsCommand），执行不依赖网络，
 * 结果优先用短信回（短信在数据网络挂掉时仍然能走）。
 */
class SmsCommandHandler(private val ctx: Context) {

    private val limiter = SmsCommand.RateLimiter()

    /**
     * @return true 表示这条短信是指令，已经处理掉，**不要**再当普通短信转发。
     *         口令会明文躺在短信里，转发出去等于把口令推到 Telegram。
     */
    fun handle(from: String, body: String): Boolean {
        val app = App.get()
        val cfg = app.prefs.smsCommand
        val parsed = SmsCommand.parse(body, cfg)
        if (parsed is SmsCommand.Parsed.Ignored) return false

        val now = System.currentTimeMillis()

        // 口令对了但号码不在白名单：吞掉且不回复。
        // 回复会告诉对方「口令是对的，只是号码不行」，等于送出半个答案。
        if (!SmsCommand.senderAllowed(from, cfg.allowNumbers)) {
            Log.w("短信指令：号码不在白名单，已忽略 ${Log.phone(from)}")
            if (limiter.recordFailure(now)) alertLocked(from)
            report(from, "被拒绝（号码不在白名单）", null)
            return true
        }

        if (limiter.locked(now) || !limiter.allow(now)) {
            // 静默丢弃：任何回复都是给穷举者的反馈信号
            Log.w("短信指令：已限速/锁定，静默丢弃")
            return true
        }

        if (parsed is SmsCommand.Parsed.UnknownAction) {
            reply(from, SmsCommand.HELP, cfg.reply)
            report(from, "未知指令", null)
            return true
        }

        val action = (parsed as SmsCommand.Parsed.Ok).action
        Log.i("短信指令：执行 $action ← ${Log.phone(from)}")

        when (action) {
            SmsCommand.Action.HELP -> finish(from, action, SmsCommand.HELP, cfg.reply)
            SmsCommand.Action.STATUS -> finish(from, action, statusText(), cfg.reply)
            SmsCommand.Action.NETWORK -> finish(from, action, networkText(), cfg.reply)
            SmsCommand.Action.BATTERY -> finish(from, action, batteryText(), cfg.reply)
            SmsCommand.Action.RECONNECT -> {
                app.ws.restart()
                finish(from, action, "已重连网关服务。${connText()}", cfg.reply)
            }
            SmsCommand.Action.LOCATE -> Locator(ctx).locate { r, err ->
                val text = if (r == null) "定位失败：${err ?: "未知原因"}"
                    else "位置 ${"%.5f".format(r.lat)},${"%.5f".format(r.lng)}" +
                        (r.accuracy?.let { " ±${it.toInt()}m" } ?: "") +
                        (if (r.cached) "（缓存）" else "") +
                        " https://maps.google.com/?q=${r.lat},${r.lng}"
                finish(from, action, text, cfg.reply)
            }
        }
        return true
    }

    private fun finish(from: String, action: SmsCommand.Action, text: String, replyEnabled: Boolean) {
        reply(from, text, replyEnabled)
        report(from, action.name, text)
    }

    // ── 状态采集 ────────────────────────────────────────────

    /** 一条短信 70 个汉字，状态要挑最要紧的：连没连上、网络、电量、积压。 */
    private fun statusText(): String = buildString {
        append(connText())
        append("；").append(networkText())
        append("；").append(batteryText())
        val pending = App.get().ws.pendingCount.value
        if (pending > 0) append("；待补传 ").append(pending).append(" 条")
    }

    private fun connText(): String = when (val s = App.get().ws.state.value) {
        is ConnState.Connected -> {
            val min = (System.currentTimeMillis() - s.since) / 60000
            if (min < 1) "网关已连接" else "网关已连接 ${min}分钟"
        }
        is ConnState.Connecting -> "网关连接中"
        is ConnState.Waiting -> "网关重连中（${s.retryInSec}s 后）"
        is ConnState.Fatal -> "网关已停止：${s.code}"
        ConnState.Idle -> "网关未运行"
    }

    /**
     * WiFi 与移动数据状态。
     *
     * 只读不改：Android 10 起 setWifiEnabled 对普通应用是空操作，
     * 远程开关 WiFi 在非系统应用上做不到——能查到「WiFi 关了」已经解决了
     * 大半问题（知道要回家开，而不是以为手机丢了）。
     */
    @Suppress("DEPRECATION")
    private fun networkText(): String = buildString {
        val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val on = wifi?.isWifiEnabled == true
        append("WiFi ").append(if (on) "开" else "关")

        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = runCatching { cm?.getNetworkCapabilities(cm.activeNetwork) }.getOrNull()
        val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
        val via = when {
            caps == null -> "无网络"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> {
                // SSID 需要定位权限且手机要处于已连接状态，取不到就只说「已连 WiFi」
                val ssid = if (on) wifi?.connectionInfo?.ssid?.trim('"')?.takeIf {
                    it.isNotBlank() && it != "<unknown ssid>"
                } else null
                if (ssid != null) "已连 $ssid" else "已连 WiFi"
            }
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "走移动数据"
            else -> "其他网络"
        }
        append("，").append(via)
        if (caps != null && !online) append("（未验证）")

        val tm = ctx.getSystemService(TelephonyManager::class.java)
        val signal = runCatching { tm?.networkOperatorName }.getOrNull()
        if (!signal.isNullOrBlank()) append("，运营商 ").append(signal)
    }

    private fun batteryText(): String {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val pct = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.coerceIn(0, 100)
        val charging = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) bm?.isCharging == true
            else bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS) == BatteryManager.BATTERY_STATUS_CHARGING
        return "电量 ${pct ?: "?"}%${if (charging) "（充电中）" else ""}"
    }

    // ── 回复与上报 ──────────────────────────────────────────

    /** 回复走短信：数据网络可能正是坏掉的那一环，而短信还能走。 */
    private fun reply(to: String, text: String, enabled: Boolean) {
        if (!enabled) return
        runCatching {
            SmsSender(ctx).send("smscmd_${UUID.randomUUID()}", to, text, null) { _, status, err ->
                if (status == "failed") Log.e("短信指令回复失败：$err")
            }
        }.onFailure { Log.e("短信指令回复异常", it) }
    }

    /**
     * 每一次指令都上报，包括被拒绝的。
     *
     * 借普通事件通道走规则与渠道，不另开一条路：发件人写成固定的「网关指令」，
     * 用户想静音或改推送目标，用规则就能做到。
     *
     * 上报内容里**不含口令**——它会被存进消息历史，也会推到 Telegram。
     */
    private fun report(from: String, action: String, result: String?) {
        val app = App.get()
        val content = buildString {
            append("来自 ").append(from).append(" 的指令：").append(action)
            if (result != null) append('\n').append(result)
        }.take(Protocol.MAX_CONTENT_LEN)

        app.scope.launch {
            runCatching {
                app.ws.enqueue(
                    PendingEvent(
                        id = "evt_${UUID.randomUUID()}",
                        kind = "notification",
                        from = "网关指令",
                        content = content,
                        occurredAt = System.currentTimeMillis(),
                        simSlot = null,
                        callType = null,
                        pkg = PKG,
                        truncated = false,
                        queuedAt = System.currentTimeMillis(),
                    ),
                )
            }.onFailure { Log.e("短信指令上报失败", it) }
        }
    }

    private fun alertLocked(from: String) {
        Log.e("短信指令：连续失败过多，已锁定一小时")
        report(from, "连续失败过多，已锁定 1 小时", null)
    }

    private companion object {
        /** 上报事件的 package 字段，便于在规则里单独挑出来 */
        const val PKG = "org.smsgateway.command"
    }
}
