package org.smsgateway.agent.sms

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.annotation.RequiresPermission
import androidx.core.content.ContextCompat
import org.smsgateway.agent.util.Log
import java.util.concurrent.atomic.AtomicInteger

/**
 * 发送短信并上报状态机：accepted → sent → delivered，任一步可转 failed。
 *
 * 长短信会被拆成多段，每段各有自己的 sentIntent / deliveryIntent，
 * 回执顺序不保证。因此这里按「全部成功才算成功、任一失败即失败」聚合，
 * 而不是收到第一个回执就上报 —— 上游 SmsForwarder 在这块体验较糙，
 * 是计划 §5.5 明确点名的改进点。
 */
class SmsSender(private val ctx: Context) {

    /** 状态回调。同一个 cmdId 可能依次回调 accepted → sent → delivered。 */
    fun interface Callback {
        fun onStatus(cmdId: String, status: String, error: String?)
    }

    @RequiresPermission(android.Manifest.permission.SEND_SMS)
    fun send(cmdId: String, to: String, text: String, simSlot: Int?, cb: Callback) {
        val (sms, why) = managerFor(simSlot)
        if (sms == null) {
            cb.onStatus(cmdId, "failed", why ?: "无法获取 SmsManager")
            return
        }

        val parts = sms.divideMessage(text)
        val n = parts.size
        Log.i("发送短信 cmd=$cmdId 到 ${Log.phone(to)} 共 $n 段")

        // 每个 cmd 用独立的 action，避免不同任务的回执串台
        val sentAction = "$ACTION_SENT.$cmdId"
        val deliveredAction = "$ACTION_DELIVERED.$cmdId"

        val tracker = Tracker(n, cmdId, cb)

        val sentReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) = tracker.onSent(resultCode)
        }
        val deliveredReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) = tracker.onDelivered(resultCode)
        }
        tracker.receivers = listOf(sentReceiver, deliveredReceiver)

        register(sentReceiver, sentAction)
        register(deliveredReceiver, deliveredAction)

        val sentIntents = ArrayList<PendingIntent>(n)
        val deliveredIntents = ArrayList<PendingIntent>(n)
        for (i in 0 until n) {
            sentIntents.add(pending(sentAction))
            deliveredIntents.add(pending(deliveredAction))
        }

        try {
            // 单段也走 multipart：回执处理只有一条路径，少一处分支就少一处 bug
            sms.sendMultipartTextMessage(to, null, parts, sentIntents, deliveredIntents)
            cb.onStatus(cmdId, "accepted", null)
        } catch (e: Exception) {
            Log.e("发送失败", e)
            tracker.finish()
            cb.onStatus(cmdId, "failed", e.message ?: "sendMultipartTextMessage 抛异常")
        }
    }

    // ── 回执聚合 ────────────────────────────────────────────

    private inner class Tracker(
        private val total: Int,
        private val cmdId: String,
        private val cb: Callback,
    ) {
        var receivers: List<BroadcastReceiver> = emptyList()
        private val sentOk = AtomicInteger(0)
        private val deliveredOk = AtomicInteger(0)
        @Volatile private var failed = false
        @Volatile private var done = false

        fun onSent(code: Int) {
            if (code != Activity.RESULT_OK) return fail("发送失败：${sentErrorText(code)}")
            if (sentOk.incrementAndGet() == total) cb.onStatus(cmdId, "sent", null)
        }

        fun onDelivered(code: Int) {
            if (code != Activity.RESULT_OK) return fail("送达失败")
            if (deliveredOk.incrementAndGet() == total) {
                cb.onStatus(cmdId, "delivered", null)
                finish()
            }
        }

        private fun fail(msg: String) {
            if (failed) return
            failed = true
            cb.onStatus(cmdId, "failed", msg)
            finish()
        }

        fun finish() {
            if (done) return
            done = true
            for (r in receivers) runCatching { ctx.unregisterReceiver(r) }
        }
    }

    private fun register(r: BroadcastReceiver, action: String) {
        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // 这些广播只发给自己，显式声明不导出，避免其他应用伪造回执
            ctx.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(r, filter)
        }
    }

    /** requestCode 必须逐段不同，否则多段的 PendingIntent 会被系统合并成同一个。 */
    private fun pending(action: String): PendingIntent {
        val intent = Intent(action).setPackage(ctx.packageName)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(ctx, requestCode.incrementAndGet(), intent, flags)
    }

    /**
     * 双卡：按 simSlot 找到对应的 subscriptionId。
     *
     * **认不出要哪张卡时，单卡机回落、双卡机拒发。**
     *
     * 原来是一律回落到默认卡，而那正是 CLAUDE.md 点名的那一类错：
     * 「收件人看到的号码取决于用哪张卡，挑错等于用错身份」。双卡机上指定了 SIM2
     * 却从 SIM1 发出去，对方看到的是一个陌生号码，而**两头都不会有任何报错**。
     * 最常见的触发条件是没授予 READ_PHONE_STATE——`activeSubscriptionInfoList`
     * 需要它，原来被 runCatching 一吞就退回默认卡了。
     *
     * 单卡机不在此列：只有一张卡，回落到它就是对的，为此拒发反而是添乱。
     * 卡槽数用 `TelephonyManager` 问（不需要任何权限），避免「为了判断要不要
     * 检查权限，先得有那个权限」的死结。
     *
     * @return first 为 null 表示不能发，原因在 second 里。
     */
    @Suppress("DEPRECATION")
    private fun managerFor(simSlot: Int?): Pair<SmsManager?, String?> {
        val base = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                ctx.getSystemService(SmsManager::class.java)
            } else {
                SmsManager.getDefault()
            }
        }.getOrNull()
        if (simSlot == null) return base to null
        if (base == null) return null to "无法获取 SmsManager"

        // 卡槽数不需要权限，先用它把「单卡机」这一档摘出去
        val slots = runCatching {
            val tm = ctx.getSystemService(TelephonyManager::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) tm?.activeModemCount else tm?.phoneCount
        }.getOrNull() ?: 1
        val single = slots <= 1

        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_PHONE_STATE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w("没有 READ_PHONE_STATE，认不出 SIM$simSlot 对应哪张卡")
            return if (single) base to null
            else null to "未授予 READ_PHONE_STATE，认不出 SIM$simSlot 是哪张卡；" +
                "不敢用另一张卡发出去（对方会看到陌生号码），请先在 App 里补上权限"
        }

        val sm = ctx.getSystemService(SubscriptionManager::class.java)
        val sub = runCatching { sm?.activeSubscriptionInfoList }.getOrNull()
            ?.firstOrNull { it.simSlotIndex == simSlot }
        if (sub == null) {
            Log.w("找不到 SIM$simSlot 对应的卡（没插卡？被停用？）")
            return if (single) base to null
            else null to "找不到 SIM$simSlot 对应的卡（没插卡或已停用）；" +
                "不敢用另一张卡发出去"
        }
        /*
         * **按卡取 SmsManager 有两条路，API 31 是分水岭。**
         *
         * `createForSubscriptionId` 是实例方法、**API 31 才有**；minSdk 是 24，
         * 所以在 Android 7–11 上直接调它会抛 NoSuchMethodError——原来那句被
         * runCatching 一吞就退回默认卡，于是**旧机上指定哪张卡都没用，
         * 永远从默认卡发**，而两头都没有任何报错。而「翻一台闲置旧机」
         * 恰恰是这个产品的前提，也就是说这条路才是多数人会走的那条。
         *
         * 31 以下用静态的 `getSmsManagerForSubscriptionId`（已废弃但可用）。
         */
        val bySub = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                base.createForSubscriptionId(sub.subscriptionId)
            } else {
                SmsManager.getSmsManagerForSubscriptionId(sub.subscriptionId)
            }
        }.getOrElse {
            Log.e("按卡取 SmsManager 失败 SIM$simSlot", it)
            null
        }
        if (bySub == null) {
            return if (single) base to null
            else null to "取不到 SIM$simSlot 的发送通道；不敢用另一张卡发出去"
        }
        return bySub to null
    }

    private companion object {
        const val ACTION_SENT = "org.smsgateway.agent.SMS_SENT"
        const val ACTION_DELIVERED = "org.smsgateway.agent.SMS_DELIVERED"
        val requestCode = AtomicInteger(1000)

        /** 把系统返回码翻译成人话，控制台上直接能看懂失败原因。 */
        fun sentErrorText(code: Int): String = when (code) {
            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "通用失败"
            SmsManager.RESULT_ERROR_NO_SERVICE -> "无服务"
            SmsManager.RESULT_ERROR_NULL_PDU -> "PDU 为空"
            SmsManager.RESULT_ERROR_RADIO_OFF -> "射频关闭（飞行模式？）"
            else -> "错误码 $code"
        }
    }
}
