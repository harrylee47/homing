package org.smsgateway.agent.receiver

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import androidx.core.content.ContextCompat
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
    @Volatile private var registered = false

    /**
     * **可以反复调用。**
     *
     * 第一次调用发生在 Application.onCreate，那一刻权限一个都还没给
     * （全新安装的必经路径：点图标 → onCreate → 用户才去点「申请权限」）。
     * 授予运行时权限**不会重启进程**，所以必须有人在权限到手之后再喊一次——
     * 见 MainActivity 的 permLauncher 回调与 onResume。
     * 没有这一下的话，表现是「功能开着但一条都不报」，而且一点报错都没有。
     */
    fun start() {
        if (!hasPermission()) {
            Log.w("没有短信读取权限，已发送短信不会被捕获（授予后会自动重试）")
            return
        }
        /*
         * 起点分三档，**「读不到」和「发件箱是空的」必须分开**。
         *
         * 原来两种都回落成 0，于是权限没给、或者 ROM 不让读的时候起点是 0；
         * 等权限一到手、短信库随便一次变动触发 onChange，`_ID > 0` 就把
         * **整个发件箱的历史**当成刚发出的短信全量补报上去。这些事件带的是
         * 随机 UUID（不是导入路径那种可去重的 id），服务端按 id 幂等挡不住，
         * 重装一次就再来一遍——而事件永不删除。
         * 通话记录那份早就打过这个补丁，短信这份一直漏着。
         */
        val start = maxSentId()
        if (start == null) {
            Log.e("读不到短信库，已发送短信捕获未启动")
            return
        }
        lastId = start
        runCatching {
            // 幂等：重复注册同一个 observer 会收到重复回调，先摘再挂
            if (registered) ctx.contentResolver.unregisterContentObserver(this)
            ctx.contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, this)
            registered = true
            Log.i("已开始监听发件箱，起始 id=$lastId")
        }.onFailure { Log.w("注册发件箱监听失败: ${it.message}") }
    }

    fun stop() {
        runCatching { ctx.contentResolver.unregisterContentObserver(this) }
        registered = false
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED

    override fun onChange(selfChange: Boolean, uri: Uri?) {
        if (lastId < 0) return   // start() 没成功
        // 短信库任何变化都会触发（含收件箱、草稿），所以只查发件箱增量。
        // **不在主线程扫库**：这个回调挂在主 Looper 上，而一次扫描要查库、
        // 逐行反查卡槽、逐行写日志——收一条短信就卡一下界面，量大时直接 ANR。
        App.get().scope.launch { scanNewSent() }
    }

    /** @return 发件箱里的最大 id；发件箱为空时 0；读不了时 null */
    private fun maxSentId(): Long? = runCatching {
        ctx.contentResolver.query(
            Telephony.Sms.Sent.CONTENT_URI, arrayOf(Telephony.Sms._ID),
            null, null, "${Telephony.Sms._ID} DESC LIMIT 1",
        )?.use { if (it.moveToFirst()) it.getLong(0) else 0L }
    }.onFailure { Log.e("查询发件箱最大 id 失败", it) }.getOrNull()

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
