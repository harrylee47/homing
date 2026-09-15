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
                // 记响铃时刻而不是挂断时刻：系统通话记录里的 date 也是通话开始时间，
                // 两边对齐才能在「历史导入」时认出这是同一通电话。
                // 用挂断时刻的话，一通聊了三分钟的电话会差出三分钟，导入就会重复一条。
                ringingAt = System.currentTimeMillis()
            }

            TelephonyManager.EXTRA_STATE_OFFHOOK -> answered = true

            TelephonyManager.EXTRA_STATE_IDLE -> {
                val num = ringingNumber ?: return
                val at = ringingAt.takeIf { it > 0 } ?: System.currentTimeMillis()
                ringingNumber = null
                ringingAt = 0
                report(num, if (answered) "incoming" else "missed", at)
            }
        }
    }

    private fun report(number: String, callType: String, at: Long) {
        val app = App.get()
        val event = PendingEvent(
            id = "evt_${UUID.randomUUID()}",
            kind = "call",
            from = number,
            content = if (callType == "missed") "未接来电" else "已接来电",
            occurredAt = at,
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
        /** 响铃开始时刻，作为这通电话的发生时间 */
        @Volatile var ringingAt: Long = 0
    }
}
