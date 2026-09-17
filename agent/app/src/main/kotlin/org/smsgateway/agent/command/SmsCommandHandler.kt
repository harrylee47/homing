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
import org.smsgateway.agent.R
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.location.Locator
import org.smsgateway.agent.net.ConnState
import org.smsgateway.agent.net.label
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.sms.SmsSender
import org.smsgateway.agent.util.Log
import org.smsgateway.agent.util.NetStatus
import org.smsgateway.agent.util.SimInfo
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
            reply(from, ctx.getString(R.string.sms_help), cfg.reply)
            report(from, "未知指令", null)
            return true
        }

        val action = (parsed as SmsCommand.Parsed.Ok).action
        Log.i("短信指令：执行 $action ← ${Log.phone(from)}")

        when (action) {
            SmsCommand.Action.HELP -> finish(from, action, ctx.getString(R.string.sms_help), cfg.reply)
            SmsCommand.Action.STATUS -> finish(from, action, statusText(), cfg.reply)
            SmsCommand.Action.NETWORK -> finish(from, action, networkText(), cfg.reply)
            SmsCommand.Action.BATTERY -> finish(from, action, batteryText(), cfg.reply)
            SmsCommand.Action.RECONNECT -> {
                app.ws.restart()
                finish(from, action, ctx.getString(R.string.sms_reconnected, connText()), cfg.reply)
            }
            SmsCommand.Action.LOCATE -> Locator(ctx).locate { r, err ->
                val text = if (r == null) {
                    ctx.getString(R.string.sms_locate_fail, err ?: ctx.getString(R.string.sms_locate_unknown))
                } else {
                    ctx.getString(
                        R.string.sms_location,
                        "${"%.5f".format(r.lat)},${"%.5f".format(r.lng)}",
                    ) +
                        (r.accuracy?.let { " ±${it.toInt()}m" } ?: "") +
                        (if (r.cached) ctx.getString(R.string.sms_cached) else "") +
                        " https://maps.google.com/?q=${r.lat},${r.lng}"
                }
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
        if (pending > 0) append(ctx.getString(R.string.sms_pending, pending))
    }

    private fun connText(): String = when (val s = App.get().ws.state.value) {
        is ConnState.Connected -> {
            val min = (System.currentTimeMillis() - s.since) / 60000
            if (min < 1) ctx.getString(R.string.conn_connected)
            else ctx.getString(R.string.conn_connected_min, min)
        }
        is ConnState.Connecting -> ctx.getString(R.string.conn_connecting)
        is ConnState.Waiting -> ctx.getString(R.string.conn_waiting, s.retryInSec)
        is ConnState.Fatal -> ctx.getString(R.string.conn_stopped, s.code)
        /*
         * 这条回复恰恰是这个功能存在的理由：「手机联不上服务端了，我还想知道
         * 它怎么了」。所以被拒的原因必须出现在这条短信里——尤其是时钟偏差，
         * 那是人回到手机跟前一分钟就能修好的事，而在此之前他完全看不出来。
         * 直接用 label()：界面、常驻通知、这条短信共用同一句话。
         */
        is ConnState.Blocked -> s.label(ctx, App.get().prefs.isPaired)
        ConnState.Idle -> ctx.getString(R.string.conn_idle)
    }

    /**
     * WiFi 与移动数据状态。
     *
     * 只读不改：Android 10 起 setWifiEnabled 对普通应用是空操作，
     * 远程开关 WiFi 在非系统应用上做不到——能查到「WiFi 关了」已经解决了
     * 大半问题（知道要回家开，而不是以为手机丢了）。
     *
     * 与心跳上报共用同一份采集逻辑（util/NetStatus），两个出口一套实现。
     */
    private fun networkText(): String = buildString {
        append(NetStatus.read(ctx).describe())
        // 双卡时逐卡各报一行：一张卡没信号照样收不到验证码，
        // 而上面那个总的信号格数只代表其中一张
        val sims = SimInfo.read(ctx)
        if (sims.size > 1) sims.forEach { append('\n').append(it.describe()) }
    }

    private fun batteryText(): String {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val pct = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.coerceIn(0, 100)
        /*
         * 无条件用 isCharging：它是 **API 23** 就有的，低于 minSdk 24。
         *
         * 原来那个版本分支不但多余，在 API 24/25 上还是错的——
         * BATTERY_PROPERTY_STATUS 是 API 26 才加的常量，更低版本上
         * getIntProperty 返回 Integer.MIN_VALUE，永远不等于 BATTERY_STATUS_CHARGING，
         * 于是「（充电中）」在 Android 7.x 上一辈子不出现。
         * 而同一台手机的控制台显示「充电中」、短信指令说没充电——
         * 「它是不是被拔了电」恰恰是你发这条指令时最想确认的事。
         * 仓库里另外两处（WsClient、MainActivity）本来就是无条件调的。
         */
        val charging = runCatching { bm?.isCharging == true }.getOrDefault(false)
        return ctx.getString(
            R.string.sms_battery, pct?.toString() ?: "?",
            if (charging) ctx.getString(R.string.sms_battery_charging) else "",
        )
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
