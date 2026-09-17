package org.smsgateway.agent.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 日志环形缓冲。
 *
 * 这些日志从前只进 logcat（要 adb 或 READ_LOGS，本地），
 * 加了导出之后会经服务端送到公网浏览器——同一个疏忽，代价差一个量级。
 * 所以脱敏那几条比容量那几条更要紧。
 */
class LogRingTest {

    private fun ring() = LogRing(maxLines = 5, maxBytes = 1000, maxLineChars = 50)

    @Test
    fun `超出行数时挤掉最老的并记下丢了多少`() {
        val r = ring()
        repeat(8) { r.add(it.toLong(), "info", "line $it") }
        val out = r.snapshot(100, "debug")
        assertEquals(5, out.size)
        assertEquals("line 3", out.first().msg)
        assertEquals("line 7", out.last().msg)
        // 界面上要显示它，否则人会以为日志就这么多
        assertEquals(3, r.dropped)
    }

    /**
     * 只限行数是不够的：一个异常栈是一「行」但可能几 KB，
     * 500 条就是几 MB 常驻内存，而这台机器本来就在跟资源较劲。
     */
    @Test
    fun `总字节超限时同样会挤掉，哪怕行数还没满`() {
        val r = LogRing(maxLines = 1000, maxBytes = 200, maxLineChars = 100)
        repeat(10) { r.add(it.toLong(), "info", "x".repeat(100)) }
        assertTrue("字节上限没生效", r.snapshot(1000, "debug").size <= 2)
        assertTrue(r.dropped > 0)
    }

    @Test
    fun `单行过长会被截断`() {
        val r = ring()
        r.add(1, "info", "y".repeat(500))
        assertTrue(r.snapshot(10, "debug").first().msg.length <= 51)
    }

    @Test
    fun `按级别过滤，取 warn 就不该看到 info`() {
        val r = ring()
        r.add(1, "debug", "d")
        r.add(2, "info", "i")
        r.add(3, "warn", "w")
        r.add(4, "error", "e")
        assertEquals(listOf("w", "e"), r.snapshot(10, "warn").map { it.msg })
        assertEquals(4, r.snapshot(10, "debug").size)
    }

    @Test
    fun `limit 取的是最近的那几条，不是最早的`() {
        val r = ring()
        repeat(5) { r.add(it.toLong(), "info", "line $it") }
        assertEquals(listOf("line 3", "line 4"), r.snapshot(2, "debug").map { it.msg })
    }

    /** 验证码是 4-8 位数字。宁可误伤一个订单号，也不要漏一个验证码 */
    @Test
    fun `正文里的验证码会被擦掉`() {
        val r = ring()
        r.add(1, "info", "收到验证码 902431 来自 95533")
        val msg = r.snapshot(10, "debug").first().msg
        assertFalse("验证码原样留在日志里", msg.contains("902431"))
        assertTrue(msg.contains("******"))
    }

    /**
     * 但**不能**把 id 里的数字段一起打码。
     *
     * 第一版的正则只要求左右不是数字，于是 evt_ea5f****-427d-… 这样的 UUID
     * 被打得七零八落——而 id 恰恰是排查时最需要对得上的东西。
     * 这一道本来就是第二层防线，第一层是 Log.content() / Log.phone()。
     */
    @Test
    fun `id 里的数字段不会被误伤`() {
        val r = LogRing(maxLines = 10, maxBytes = 10000, maxLineChars = 300)
        val line = "事件入队 id=evt_ea5f1234-427d-4e28-9fef-6c2812345678 cmd_id=cmd_4c09ea90"
        r.add(1, "info", line)
        assertEquals(line, r.snapshot(10, "debug").first().msg)
    }

    @Test
    fun `夹在字母数字里的数字串不打码，独立成词的才打`() {
        val r = LogRing(maxLines = 10, maxBytes = 10000, maxLineChars = 300)
        r.add(1, "info", "port=8095 abc1234def 验证码 5678 结束")
        val msg = r.snapshot(10, "debug").first().msg
        assertTrue("独立的验证码没打码", msg.contains("****"))
        assertFalse("验证码漏了", msg.contains("5678"))
        assertTrue("夹在字母中的被误伤了", msg.contains("abc1234def"))
    }

    @Test
    fun `已登记的秘密串会被擦掉`() {
        val r = ring()
        r.addSecret("Xk7m2pQ9")
        r.add(1, "info", "短信指令口令是 Xk7m2pQ9 别外传")
        val msg = r.snapshot(10, "debug").first().msg
        assertFalse(msg.contains("Xk7m2pQ9"))
        assertTrue(msg.contains("***"))
    }

    @Test
    fun `太短的秘密不登记 —— 否则会把日志擦成一片星号`() {
        val r = ring()
        r.addSecret("ab")
        r.add(1, "info", "about")
        assertEquals("about", r.snapshot(10, "debug").first().msg)
    }

    @Test
    fun `清空之后计数也归零`() {
        val r = ring()
        repeat(9) { r.add(it.toLong(), "info", "x") }
        r.clear()
        assertEquals(0, r.snapshot(10, "debug").size)
        assertEquals(0, r.dropped)
    }
}
