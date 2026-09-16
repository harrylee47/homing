package org.smsgateway.agent.receiver

import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.util.Log
import org.smsgateway.agent.util.SimInfo
import java.util.UUID

/**
 * 捕获这台手机**自己发出**的短信。
 *
 * 为什么需要：你在手机上手动回了一条短信，或者别人拿这台机器发了短信，
 * 历史记录里应该查得到——否则「这条验证码我转给谁了」无从追溯。
 *
 * 系统没有「短信已发送」的广播，只能监听短信数据库的变化再查发件箱。
 * 用 ContentObserver 而不是轮询：轮询要么太频繁耗电，要么太稀疏漏消息。
 */
class SentSmsObserver(private val ctx: Context) : ContentObserver(Handler(Looper.getMainLooper())) {

    /** 上次处理到的记录 id。只往后看，避免重复上报历史短信。 */
    @Volatile private var lastId: Long = -1

    fun start() {
        // 先把游标推到当前最大 id：启动时不该把历史发件箱整个补报一遍
        lastId = maxSentId() ?: 0
        runCatching {
            ctx.contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, this)
            Log.i("已开始监听发件箱，起始 id=$lastId")
        }.onFailure { Log.w("注册发件箱监听失败: ${it.message}") }
    }

    fun stop() {
        runCatching { ctx.contentResolver.unregisterContentObserver(this) }
    }

    override fun onChange(selfChange: Boolean, uri: Uri?) {
        // 短信库任何变化都会触发（含收件箱、草稿），所以只查发件箱增量
        scanNewSent()
    }

    private fun maxSentId(): Long? = runCatching {
        ctx.contentResolver.query(
            Telephony.Sms.Sent.CONTENT_URI, arrayOf(Telephony.Sms._ID),
            null, null, "${Telephony.Sms._ID} DESC LIMIT 1",
        )?.use { if (it.moveToFirst()) it.getLong(0) else null }
    }.getOrNull()

    private fun scanNewSent() {
        runCatching {
            ctx.contentResolver.query(
                Telephony.Sms.Sent.CONTENT_URI,
                arrayOf(
                    Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE,
                    // 短信库里存的是 subscriptionId，要反查才知道是哪个卡槽
                    Telephony.Sms.SUBSCRIPTION_ID,
                ),
                "${Telephony.Sms._ID} > ?", arrayOf(lastId.toString()),
                "${Telephony.Sms._ID} ASC",
            )?.use { c ->
                val app = App.get()
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    lastId = maxOf(lastId, id)

                    val address = c.getString(1).orEmpty()
                    val body = c.getString(2).orEmpty()
                    val date = c.getLong(3).takeIf { it > 0 } ?: System.currentTimeMillis()
                    if (address.isBlank() && body.isBlank()) continue

                    var content = body
                    var truncated = false
                    if (content.length > Protocol.MAX_CONTENT_LEN) {
                        content = content.take(Protocol.MAX_CONTENT_LEN)
                        truncated = true
                    }

                    val event = PendingEvent(
                        id = "evt_" + UUID.randomUUID(),
                        kind = "sms",
                        // 发出的短信里，「对方」是收件人
                        from = address,
                        content = content,
                        occurredAt = date,
                        simSlot = SimInfo.slotOfSub(ctx, runCatching { c.getInt(4) }.getOrDefault(-1)),
                        callType = null,
                        pkg = null,
                        truncated = truncated,
                        direction = "out",
                        queuedAt = System.currentTimeMillis(),
                    )
                    Log.i("捕获已发送短信 to=" + Log.phone(address) + " content=" + Log.content(content))
                    app.scope.launch { app.ws.enqueue(event) }
                }
            }
        }.onFailure { Log.w("扫描发件箱失败: ${it.message}") }
    }
}
