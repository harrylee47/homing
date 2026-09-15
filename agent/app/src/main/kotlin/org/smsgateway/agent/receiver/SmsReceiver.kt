package org.smsgateway.agent.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.util.Log
import java.util.UUID

/**
 * 短信捕获。
 *
 * 捕获逻辑参考 SmsForwarder（BSD 2-Clause, Copyright (c) 2021 pppscn）的
 * receiver/SmsReceiver.kt，保留了两处关键处理：
 *  1. 长短信在一个 intent 里以多个 PDU 到达，必须拼接
 *  2. 卡槽以 intent 的 subscription extra 为准，其余字段都不可靠
 * 分发链路（原为 WorkManager + SendWorker）已替换为本地队列 + WS 上报。
 */
class SmsReceiver : BroadcastReceiver() {

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

            val app = App.get()
            val event = PendingEvent(
                id = "evt_${UUID.randomUUID()}",
                kind = "sms",
                from = from,
                content = content,
                occurredAt = System.currentTimeMillis(),
                simSlot = simSlot(intent),
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

    /** 只有 subscription 相对靠谱，取不到就报 null，由服务端展示为未知。 */
    private fun simSlot(intent: Intent): Int? {
        val sub = intent.extras?.getInt("subscription", -1) ?: -1
        return if (sub in 0..3) sub else null
    }
}
