package org.smsgateway.agent.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telephony.TelephonyManager
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.util.Log
import org.smsgateway.agent.util.SimInfo
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
                /*
                 * **号码取不到也要记一笔，不能整通丢掉。**
                 *
                 * Android 9 起，PHONE_STATE 广播里的号码要有 READ_CALL_LOG 才给，
                 * 否则恒为 null。原来这里 `if (!isNullOrBlank())` 不成立就什么都不记，
                 * 于是 IDLE 那一支的 `ringingNumber ?: return` 把整通来电吞掉——
                 * 不上报、不写日志，控制台上看到的是「来电从来不响」，
                 * 而「取 Agent 日志」里一个字都没有。
                 *
                 * 一通没有号码的未接来电仍然是信息，而且它顺带告诉你为什么没有号码。
                 * 空串作哨兵：report() 那边据此在正文里说明原因。
                 */
                if (number.isNullOrBlank() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    Log.w("来电号码为空：Android 9 起需要 READ_CALL_LOG 才给号码")
                }
                ringingNumber = number?.takeIf { it.isNotBlank() } ?: ""
                answered = false
                // 记响铃时刻而不是挂断时刻：系统通话记录里的 date 也是通话开始时间，
                // 两边对齐才能在「历史导入」时认出这是同一通电话。
                // 用挂断时刻的话，一通聊了三分钟的电话会差出三分钟，导入就会重复一条。
                ringingAt = System.currentTimeMillis()
                // 来电广播没有标准的卡槽字段，各家 ROM 自己加。取不到就算了，
                // 报个错的卡槽比不报更糟——双卡下会让人以为另一张卡在响
                ringingSlot = simSlot(context, intent)
            }

            TelephonyManager.EXTRA_STATE_OFFHOOK -> answered = true

            TelephonyManager.EXTRA_STATE_IDLE -> {
                // 空串是「响过但没拿到号码」的哨兵，不能和「压根没响过」（null）混为一谈
                val num = ringingNumber ?: return
                val at = ringingAt.takeIf { it > 0 } ?: System.currentTimeMillis()
                val slot = ringingSlot
                ringingNumber = null
                ringingAt = 0
                ringingSlot = null
                report(num, if (answered) "incoming" else "missed", at, slot)
            }
        }
    }

    /** 来电是哪张卡接的。没有标准字段，只能试各家 ROM 常用的 extra。 */
    private fun simSlot(ctx: Context, intent: Intent): Int? {
        val extras = intent.extras ?: return null
        for (key in SUB_KEYS) {
            val sub = runCatching { extras.getInt(key, -1) }.getOrDefault(-1)
            if (sub >= 0) SimInfo.slotOfSub(ctx, sub)?.let { return it }
        }
        for (key in SLOT_KEYS) {
            val slot = runCatching { extras.getInt(key, -1) }.getOrDefault(-1)
            if (slot in 0..3) return slot
        }
        return null
    }

    private fun report(number: String, callType: String, at: Long, simSlot: Int?) {
        val app = App.get()
        val event = PendingEvent(
            id = "evt_${UUID.randomUUID()}",
            kind = "call",
            from = number,
            /*
             * 号码为空时把原因缀在正文里。只报一通「未接来电」而不说为什么，
             * 人会以为是号码隐藏；写清楚了他才知道去给 READ_CALL_LOG。
             */
            content = (if (callType == "missed") "未接来电" else "已接来电") +
                if (number.isBlank()) "（未授予通话记录权限，取不到号码）" else "",
            occurredAt = at,
            simSlot = simSlot,
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
        @Volatile var ringingSlot: Int? = null
        @Volatile var answered: Boolean = false

        val SUB_KEYS = listOf("subscription", "android.telephony.extra.SUBSCRIPTION_INDEX", "subscription_id")
        val SLOT_KEYS = listOf("slot", "simId", "phone", "slot_id")
        /** 响铃开始时刻，作为这通电话的发生时间 */
        @Volatile var ringingAt: Long = 0
    }
}
