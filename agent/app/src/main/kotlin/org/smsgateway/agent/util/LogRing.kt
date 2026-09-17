package org.smsgateway.agent.util

/**
 * 内存里的日志环形缓冲，供「在控制台看这台手机的日志」用。
 *
 * **不 import 任何 Android API**——不是洁癖，是为了能写 JVM 单测：
 * 这个模块没有 Robolectric，碰一下 android.util.Log 测试就会抛
 * 「Method d in android.util.Log not mocked」。同一个拆法在 SmsCommand
 * 与 SmsCommandHandler 之间已经用过一次，理由相同。
 *
 * 两个上限，先到先算：
 *  - **行数 500**：足够看清一次重连风暴的来龙去脉
 *  - **总字节 64 KB**：只限行数是不够的——一个异常栈是一「行」但可能 4 KB，
 *    500 条栈就是几 MB 常驻内存，而这台机器本来就在跟资源较劲
 *
 * 单行再截到 512 字符。日志要给人看，一行滚出去两屏的没人会读。
 */
class LogRing(
    private val maxLines: Int = 500,
    private val maxBytes: Int = 64 * 1024,
    private val maxLineChars: Int = 512,
) {
    data class Entry(val at: Long, val level: String, val msg: String)

    private val buf = ArrayDeque<Entry>()
    private var bytes = 0
    /** 因为满了而被挤掉的行数。界面上要显示它，否则人会以为日志就这么多 */
    var dropped = 0
        private set

    @Synchronized
    fun add(at: Long, level: String, raw: String) {
        val msg = scrub(raw).let { if (it.length > maxLineChars) it.take(maxLineChars) + "…" else it }
        val e = Entry(at, level, msg)
        buf.addLast(e)
        bytes += msg.length
        while (buf.size > maxLines || bytes > maxBytes) {
            val old = buf.removeFirstOrNull() ?: break
            bytes -= old.msg.length
            dropped++
        }
    }

    @Synchronized
    fun snapshot(limit: Int, minLevel: String): List<Entry> {
        val want = RANK[minLevel] ?: RANK["info"]!!
        return buf.filter { (RANK[it.level] ?: 0) >= want }.takeLast(limit)
    }

    @Synchronized
    fun clear() {
        buf.clear()
        bytes = 0
        dropped = 0
    }

    /**
     * 已知秘密的字面擦除。
     *
     * 这是**第二道**防线，不是第一道。第一道是「所有日志都经 Log.content()
     * 与 Log.phone() 脱敏」那条约定——它挡的是将来有人加了一行新日志时的疏忽。
     * 这一道挡的是「确切知道是秘密的那几个串不小心出现在某条消息里」。
     *
     * 从前这些日志只进 logcat（要 adb 或 READ_LOGS，本地）；
     * 现在它们会经服务端送到公网浏览器——同一个疏忽，代价差一个量级。
     */
    @Synchronized
    fun addSecret(s: String?) {
        if (s != null && s.length >= 6) secrets.add(s)
    }

    private val secrets = mutableSetOf<String>()

    private fun scrub(s: String): String {
        var out = s
        for (sec in secrets) if (sec.isNotEmpty()) out = out.replace(sec, "***")
        // 4–8 位数字：验证码的形状。
        //
        // 左右都要求不是字母、数字、下划线或连字符——否则 UUID 里凑巧全是数字的
        // 那一段也会被打码（evt_ea5f****-427d-…），而 id 恰恰是排查时最需要
        // 对得上的东西。这一道本来就是第二层防线，第一层是 Log.content()/phone()。
        out = CODE_RE.replace(out) { m -> "*".repeat(m.value.length) }
        return out
    }

    companion object {
        private val RANK = mapOf("debug" to 0, "info" to 1, "warn" to 2, "error" to 3)
        private val CODE_RE = Regex("(?<![0-9A-Za-z_-])[0-9]{4,8}(?![0-9A-Za-z_-])")
    }
}
