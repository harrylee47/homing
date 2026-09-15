package org.smsgateway.agent.receiver

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.util.Log
import java.util.UUID

/**
 * 去电捕获。
 *
 * 系统没有「打出电话」的广播可用：`NEW_OUTGOING_CALL` 从 Android 10 起只发给默认拨号应用，
 * 普通应用收不到。只能像已发送短信那样盯通话记录库的变化（见 SentSmsObserver）。
 *
 * **只报去电**。来电与未接仍然走 PhoneStateReceiver —— 那条路在响铃结束的瞬间就能报，
 * 而通话记录写库时间由 ROM 决定；两边都报同一通电话会出现重复记录。
 *
 * 启动时用当前最大 _id 打桩，避免把手机上几年的通话历史一次性补报上去。
 */
class CallLogObserver(private val ctx: Context) {

    private var lastId: Long = -1

    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = scan()
    }

    fun start() {
        if (!hasPermission()) {
            Log.w("没有通话记录权限，去电不会被捕获")
            return
        }
        // 查不到最大 id 说明这个库根本读不了（个别 ROM 会这样）。
        // 此时宁可不启动，也不能按 0 起步——那会把手机上多年的通话历史一次性补报上去。
        val start = maxId()
        if (start == null) {
            Log.e("读不到通话记录，去电捕获未启动")
            return
        }
        // 记录为空时是 0 而不是 -1：-1 会让「> lastId」这一步永远筛不出东西，
        // 表现为「功能开着但一条都不报」，而且一点报错都没有
        lastId = start
        runCatching {
            ctx.contentResolver.registerContentObserver(CallLog.Calls.CONTENT_URI, true, observer)
        }.onFailure { Log.e("注册通话记录监听失败", it) }
        Log.i("已开始监听通话记录，起始 id=$lastId")
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED

    /**
     * @return 通话记录里的最大 id；记录为空时 0；读不了时 null
     *
     * **排序里不能写 LIMIT**。CallLog 的 provider 开了 SQLiteQueryBuilder 的严格模式，
     * 「_ID DESC LIMIT 1」会被当成非法排序直接拒掉，表现为 query 返回 null——
     * 于是「功能开着但一条都不报」，而且不抛异常，只能靠把原因打出来才查得到。
     * 短信库那边不严格，所以 SentSmsObserver 用同样的写法没事。
     */
    @SuppressLint("MissingPermission")
    private fun maxId(): Long? = runCatching {
        ctx.contentResolver.query(
            CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls._ID),
            null, null, "${CallLog.Calls._ID} DESC",
        )?.use { if (it.moveToFirst()) it.getLong(0) else 0L }
    }.onFailure { Log.e("查询通话记录最大 id 失败", it) }.getOrNull()

    @SuppressLint("MissingPermission")
    private fun scan() {
        if (lastId < 0) return   // start() 没成功
        runCatching {
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DURATION, CallLog.Calls.DATE),
                "${CallLog.Calls._ID} > ?", arrayOf(lastId.toString()),
                "${CallLog.Calls._ID} ASC",
            )?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    if (id > lastId) lastId = id
                    // 来电与未接由 PhoneStateReceiver 负责，这里只认拨出去的
                    if (c.getInt(2) != CallLog.Calls.OUTGOING_TYPE) continue
                    report(
                        number = c.getString(1) ?: continue,
                        seconds = c.getLong(3),
                        at = c.getLong(4).takeIf { it > 0 } ?: System.currentTimeMillis(),
                    )
                }
            }
        }.onFailure { Log.e("读取通话记录失败", it) }
    }

    private fun report(number: String, seconds: Long, at: Long) {
        val app = App.get()
        val event = PendingEvent(
            id = "evt_${UUID.randomUUID()}",
            kind = "call",
            from = number,
            // 0 秒说明对方没接起来，这跟「通了 3 分钟」是两回事，必须分得出来
            content = if (seconds <= 0) "已拨出 · 未接通" else "已拨出 · 通话 ${duration(seconds)}",
            occurredAt = at,
            simSlot = null,
            callType = "outgoing",
            pkg = null,
            truncated = false,
            direction = "out",
            queuedAt = System.currentTimeMillis(),
        )
        Log.i("去电事件 ${Log.phone(number)} ${seconds}s")
        app.scope.launch { app.ws.enqueue(event) }
    }

    private fun duration(seconds: Long): String {
        val m = seconds / 60
        val s = seconds % 60
        return if (m > 0) "${m}分${s}秒" else "${s}秒"
    }
}
