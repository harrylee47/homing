package org.smsgateway.agent.history

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import android.provider.Telephony
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.util.Log

/**
 * 把网关启用**之前**手机里就存着的短信与通话导进来。
 *
 * 实时捕获天然只能看见「之后」发生的事：短信广播、通话记录监听都是从启用那一刻起步的。
 * 装上网关之前的几年记录就躺在手机本地，不导一次就永远进不了历史库。
 *
 * 三条必须守住的约束：
 *
 * 1. **只导入截止时刻之前的**。截止时刻就是这台设备第一次启动采集的时间
 *    （`Prefs.captureStartedAt`）。不设这条线的话，导入与实时捕获会在边界上重叠，
 *    同一条短信进两次——而两条路径生成的 id 不一样，服务端的幂等去重也救不了。
 * 2. **id 必须是确定的**（`evt_imp_sms_<_id>`）。重复点导入不该产生重复记录，
 *    服务端按 id 去重，所以 id 只能来自手机本地那行记录本身，不能用随机 UUID。
 * 3. **标记 imported=true**。服务端见到这个标记只归档不推送——
 *    导入三千条旧短信如果照常推送，就是三千条通知一次性砸到你手机上。
 */
object HistoryImporter {

    data class Result(val sms: Int, val calls: Int, val skipped: Int)

    /**
     * @param since  只导入这个时刻之后的记录；null 表示不限
     * @param limit  每一类最多导入多少条，防止把十年记录一次性灌进去
     */
    @SuppressLint("MissingPermission")
    fun run(ctx: Context, since: Long?, limit: Int): Result {
        val app = App.get()
        val cutoff = app.prefs.captureStartedAt
        var sms = 0
        var calls = 0
        var skipped = 0

        if (has(ctx, Manifest.permission.READ_SMS)) {
            sms = importSms(ctx, since, cutoff, limit)
        } else {
            Log.w("没有读短信权限，跳过短信导入")
            skipped++
        }

        if (has(ctx, Manifest.permission.READ_CALL_LOG)) {
            calls = importCalls(ctx, since, cutoff, limit)
        } else {
            Log.w("没有读通话记录权限，跳过通话导入")
            skipped++
        }

        Log.i("历史导入完成：短信 $sms 条，通话 $calls 条")
        return Result(sms, calls, skipped)
    }

    private fun has(ctx: Context, p: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    // ── 短信 ────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private fun importSms(ctx: Context, since: Long?, cutoff: Long, limit: Int): Int {
        val where = StringBuilder("${Telephony.Sms.DATE} < ?")
        val args = mutableListOf(cutoff.toString())
        if (since != null) {
            where.append(" AND ${Telephony.Sms.DATE} >= ?")
            args.add(since.toString())
        }

        var n = 0
        runCatching {
            ctx.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
                where.toString(), args.toTypedArray(),
                // 从新到旧：条数受限时，留下的应该是最近的那些
                "${Telephony.Sms.DATE} DESC",
            )?.use { c ->
                while (c.moveToNext() && n < limit) {
                    val id = c.getLong(0)
                    val from = c.getString(1) ?: continue
                    val body = c.getString(2) ?: continue
                    val date = c.getLong(3)
                    val type = c.getInt(4)
                    // 只要收件箱与发件箱；草稿、发送失败的不算历史记录
                    val direction = when (type) {
                        Telephony.Sms.MESSAGE_TYPE_INBOX -> "in"
                        Telephony.Sms.MESSAGE_TYPE_SENT -> "out"
                        else -> continue
                    }
                    enqueue(
                        id = "evt_imp_sms_$id",
                        kind = "sms",
                        from = from,
                        content = body.take(Protocol.MAX_CONTENT_LEN),
                        at = date,
                        direction = direction,
                        callType = null,
                    )
                    n++
                }
            }
        }.onFailure { Log.e("导入短信失败", it) }
        return n
    }

    // ── 通话 ────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private fun importCalls(ctx: Context, since: Long?, cutoff: Long, limit: Int): Int {
        val where = StringBuilder("${CallLog.Calls.DATE} < ?")
        val args = mutableListOf(cutoff.toString())
        if (since != null) {
            where.append(" AND ${CallLog.Calls.DATE} >= ?")
            args.add(since.toString())
        }

        var n = 0
        runCatching {
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DURATION, CallLog.Calls.DATE),
                where.toString(), args.toTypedArray(),
                "${CallLog.Calls.DATE} DESC",
            )?.use { c ->
                while (c.moveToNext() && n < limit) {
                    val id = c.getLong(0)
                    val number = c.getString(1) ?: continue
                    val type = c.getInt(2)
                    val seconds = c.getLong(3)
                    val date = c.getLong(4)

                    val (direction, callType, text) = when (type) {
                        CallLog.Calls.INCOMING_TYPE -> Triple("in", "incoming", "已接来电 · 通话 ${duration(seconds)}")
                        CallLog.Calls.MISSED_TYPE -> Triple("in", "missed", "未接来电")
                        CallLog.Calls.REJECTED_TYPE -> Triple("in", "missed", "已拒接")
                        CallLog.Calls.OUTGOING_TYPE ->
                            Triple("out", "outgoing", if (seconds <= 0) "已拨出 · 未接通" else "已拨出 · 通话 ${duration(seconds)}")
                        else -> continue
                    }
                    enqueue(
                        id = "evt_imp_call_$id",
                        kind = "call",
                        from = number,
                        content = text,
                        at = date,
                        direction = direction,
                        callType = callType,
                    )
                    n++
                }
            }
        }.onFailure { Log.e("导入通话记录失败", it) }
        return n
    }

    // ── 入队 ────────────────────────────────────────────────

    /**
     * 直接落本地队列，由既有的补传机制慢慢发出去。
     *
     * 不一次性全塞进 WebSocket：几千条一起发会把连接打爆，而队列本来就是
     * 为「断网攒着、连上慢慢发」设计的，导入正好复用它。
     */
    private fun enqueue(
        id: String, kind: String, from: String, content: String,
        at: Long, direction: String, callType: String?,
    ) {
        val app = App.get()
        app.scope.launch {
            runCatching {
                app.ws.enqueue(
                    PendingEvent(
                        id = id,
                        kind = kind,
                        from = from,
                        content = content,
                        occurredAt = at,
                        simSlot = null,
                        callType = callType,
                        pkg = null,
                        truncated = false,
                        direction = direction,
                        imported = true,
                        queuedAt = System.currentTimeMillis(),
                    ),
                )
            }.onFailure { Log.e("历史记录入队失败 $id", it) }
        }
    }

    private fun duration(seconds: Long): String {
        val m = seconds / 60
        val s = seconds % 60
        return if (m > 0) "${m}分${s}秒" else "${s}秒"
    }
}
