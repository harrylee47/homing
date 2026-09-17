package org.smsgateway.agent.util

import android.util.Log as AndroidLog

/**
 * 日志脱敏。
 *
 * Agent 经手所有银行验证码，logcat 可被任何有 READ_LOGS 的应用或 adb 读取。
 * 短信正文与号码一律不得原样输出——与服务端 core/logging.ts 的约定一致。
 */
object Log {
    private const val TAG = "SmsGateway"

    /**
     * 同一份日志在内存里留一份，供控制台的「取设备日志」读。
     *
     * 挂在这里而不是各个调用点：全仓 72 处日志调用全部走 Log.*，
     * 这是唯一入口，所以加缓冲只动这一个文件，调用点一行都不用改。
     */
    val ring = LogRing()

    /** 正文只保留长度，绝不输出片段——验证码通常就在前几个字符 */
    fun content(v: String?): String = if (v == null) "null" else "<${v.length} chars>"

    /** 号码保留前 3 后 2，足以人工辨认来源 */
    fun phone(v: String?): String {
        if (v == null) return "null"
        if (v.length <= 5) return "*".repeat(v.length)
        return v.take(3) + "*".repeat(v.length - 5) + v.takeLast(2)
    }

    fun d(msg: String) {
        ring.add(System.currentTimeMillis(), "debug", msg)
        AndroidLog.d(TAG, msg)
    }

    fun i(msg: String) {
        ring.add(System.currentTimeMillis(), "info", msg)
        AndroidLog.i(TAG, msg)
    }

    fun w(msg: String, t: Throwable? = null) {
        ring.add(System.currentTimeMillis(), "warn", msg + (t?.let { " | ${it.javaClass.simpleName}: ${it.message}" } ?: ""))
        AndroidLog.w(TAG, msg, t)
    }

    fun e(msg: String, t: Throwable? = null) {
        ring.add(System.currentTimeMillis(), "error", msg + (t?.let { " | ${it.javaClass.simpleName}: ${it.message}" } ?: ""))
        AndroidLog.e(TAG, msg, t)
    }
}
