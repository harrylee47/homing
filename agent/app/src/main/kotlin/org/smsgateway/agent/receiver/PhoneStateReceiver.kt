package org.smsgateway.agent.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.util.Log
import java.util.UUID

/**
 * 来电监听。只做通知，不接听——接听交给运营商呼叫转移（计划 §1.3）。
 *
 * 状态机：RINGING 记下号码 → 若直接回到 IDLE 则是未接，
 * 经过 OFFHOOK 则是已接听。只在结束时上报一条，避免响一次报两条。
 */
class PhoneStateReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)

        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                if (!number.isNullOrBlank()) ringingNumber = number
                answered = false
            }

            TelephonyManager.EXTRA_STATE_OFFHOOK -> answered = true

            TelephonyManager.EXTRA_STATE_IDLE -> {
                val num = ringingNumber ?: return
                ringingNumber = null
                report(num, if (answered) "incoming" else "missed")
            }
        }
    }

    private fun report(number: String, callType: String) {
        val app = App.get()
        val event = PendingEvent(
            id = "evt_${UUID.randomUUID()}",
            kind = "call",
            from = number,
            content = if (callType == "missed") "未接来电" else "已接来电",
            occurredAt = System.currentTimeMillis(),
            simSlot = null,
            callType = callType,
            pkg = null,
            truncated = false,
            queuedAt = System.currentTimeMillis(),
        )
        Log.i("来电事件 ${Log.phone(number)} $callType")
        app.scope.launch { app.ws.enqueue(event) }
    }

    private companion object {
        // 广播接收器每次是新实例，状态必须放在伴生对象里
        @Volatile var ringingNumber: String? = null
        @Volatile var answered: Boolean = false
    }
}
