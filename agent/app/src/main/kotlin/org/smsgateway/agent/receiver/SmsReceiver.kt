package org.smsgateway.agent.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.command.SmsCommandHandler
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.util.Log
import org.smsgateway.agent.util.SimInfo
import java.util.UUID

/**
 * 短信捕获。
 *
 * 捕获逻辑参考 SmsForwarder（BSD 2-Clause, Copyright (c) 2021 pppscn）的
 * receiver/SmsReceiver.kt，保留了两处关键处理：
 *  1. 长短信在一个 intent 里以多个 PDU 到达，必须拼接
 *  2. 卡槽要由 intent 里的 subscriptionId 反查，不能直接当卡槽用
 * 分发链路（原为 WorkManager + SendWorker）已替换为本地队列 + WS 上报。
 */
class SmsReceiver : BroadcastReceiver() {

    private companion object {
        @Volatile private var handler: SmsCommandHandler? = null

        /** 各家 ROM 用来放 subscriptionId 的 extra 名字 */
        val SUB_KEYS = listOf("subscription", "android.telephony.extra.SUBSCRIPTION_INDEX", "subscription_id")
        /** 少数 ROM 直接给卡槽序号 */
        val SLOT_KEYS = listOf("slot", "simId", "phone", "slot_id")
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION &&
            intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION
        ) return

        try {
            var from = ""
            val body = StringBuilder()
            // 长短信拆成多条 PDU 放在同一个 intent 里，必须全部拼起来
            for (m in Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: emptyArray()) {
                from = m.displayOriginatingAddress ?: from
                body.append(m.messageBody ?: "")
            }
            if (from.isBlank() && body.isEmpty()) return

            var content = body.toString()
            var truncated = false
            if (content.length > Protocol.MAX_CONTENT_LEN) {
                content = content.take(Protocol.MAX_CONTENT_LEN)
                truncated = true
            }

            // 指令短信里带着口令，绝不能进转发链路——一转就把口令推到 Telegram 了
            if (commandHandler(context).handle(from, content)) return

            val app = App.get()
            val event = PendingEvent(
                id = "evt_${UUID.randomUUID()}",
                kind = "sms",
                from = from,
                content = content,
                occurredAt = System.currentTimeMillis(),
                simSlot = simSlot(context, intent),
                callType = null,
                pkg = null,
                truncated = truncated,
                queuedAt = System.currentTimeMillis(),
            )
            app.scope.launch { app.ws.enqueue(event) }

        } catch (e: Exception) {
            Log.e("短信解析失败", e)
        }
    }

    /** 限速器要跨多条短信记账，处理器必须是单例。 */
    private fun commandHandler(ctx: Context): SmsCommandHandler = synchronized(SmsReceiver::class.java) {
        handler ?: SmsCommandHandler(ctx.applicationContext).also { handler = it }
    }

    /**
     * 这条短信是哪张卡收到的。
     *
     * 广播里的 `subscription` 是 **subscriptionId**，不是卡槽序号——这两个曾经
     * 被当成一回事，于是 subId=1 的 SIM1 被记成「SIM2」，而 subId 大于 3 的
     * （重新插拔几次卡就会出现）被整个丢成 null。必须查一次才知道是哪个槽。
     *
     * 各家 ROM 用的 extra 名字不统一，几个常见的都试一遍；都取不到就报 null，
     * 由服务端展示为未知，不要猜一个卡槽填上去。
     */
    private fun simSlot(ctx: Context, intent: Intent): Int? {
        val extras = intent.extras ?: return null
        for (key in SUB_KEYS) {
            val sub = runCatching { extras.getInt(key, -1) }.getOrDefault(-1)
            if (sub >= 0) SimInfo.slotOfSub(ctx, sub)?.let { return it }
        }
        // 少数 ROM 直接给卡槽（slot / simId），这类值本来就是 0/1
        for (key in SLOT_KEYS) {
            val slot = runCatching { extras.getInt(key, -1) }.getOrDefault(-1)
            if (slot in 0..3) return slot
        }
        return null
    }
}
