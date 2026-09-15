package org.smsgateway.agent.command

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.smsgateway.agent.protocol.SmsCommandConfig

/**
 * 短信指令的解析与限速。
 *
 * 这块错一次的代价不对称：放行一条伪造指令只是泄漏「手机还活着」，
 * 但把一条正常短信误判成指令就会**把验证码吞掉**——那条短信不会被转发，
 * 而且用户不会知道。所以「不是指令」这条路径的用例写得最细。
 */
class SmsCommandTest {

    private val cfg = SmsCommandConfig(enabled = true, secret = "Kp7mQx2n9", reply = true)

    @Test
    fun `口令正确的指令被识别`() {
        assertEquals(
            SmsCommand.Parsed.Ok(SmsCommand.Action.STATUS),
            SmsCommand.parse("Kp7mQx2n9 状态", cfg),
        )
    }

    @Test
    fun `别名与大小写`() {
        for (word in listOf("status", "STATUS", "St")) {
            assertEquals(
                "『$word』应当识别为状态查询",
                SmsCommand.Parsed.Ok(SmsCommand.Action.STATUS),
                SmsCommand.parse("Kp7mQx2n9 $word", cfg),
            )
        }
    }

    @Test
    fun `口令本身区分大小写`() {
        assertEquals(SmsCommand.Parsed.Ignored, SmsCommand.parse("kp7mqx2n9 状态", cfg))
    }

    @Test
    fun `口令错误一律当普通短信放行`() {
        assertEquals(SmsCommand.Parsed.Ignored, SmsCommand.parse("wrongpass 状态", cfg))
    }

    @Test
    fun `口令对但指令不认识时回帮助，而不是静默`() {
        assertEquals(SmsCommand.Parsed.UnknownAction, SmsCommand.parse("Kp7mQx2n9 跳舞", cfg))
    }

    @Test
    fun `关闭时任何短信都不是指令`() {
        val off = cfg.copy(enabled = false)
        assertEquals(SmsCommand.Parsed.Ignored, SmsCommand.parse("Kp7mQx2n9 状态", off))
    }

    @Test
    fun `没有口令时不响应——否则等于谁都能下指令`() {
        val empty = cfg.copy(secret = "")
        assertEquals(SmsCommand.Parsed.Ignored, SmsCommand.parse(" 状态", empty))
        assertEquals(SmsCommand.Parsed.Ignored, SmsCommand.parse("状态", empty))
    }

    @Test
    fun `普通短信不会被误判`() {
        for (body in listOf(
            "【建设银行】您的验证码是 902431，请勿泄露",
            "状态",                             // 只有指令，没有口令
            "您的快递已到，取件码 8823 状态良好",
            "",
        )) {
            assertEquals("『$body』不该被当成指令", SmsCommand.Parsed.Ignored, SmsCommand.parse(body, cfg))
        }
    }

    @Test
    fun `只发口令不写指令，回一条帮助`() {
        // 口令是对的就说明是自己人，装作没看见只会让人以为功能坏了
        assertEquals(SmsCommand.Parsed.UnknownAction, SmsCommand.parse("Kp7mQx2n9", cfg))
    }

    // ── 分隔符：中文输入法怎么打都要认 ──────────────────────

    @Test
    fun `全角空格、全角冒号、顿号都认`() {
        for (sep in listOf(" ", "\u3000", ":", "：", ",", "，", "、", "  ", " ：")) {
            assertEquals(
                "分隔符『$sep』应当识别",
                SmsCommand.Parsed.Ok(SmsCommand.Action.STATUS),
                SmsCommand.parse("Kp7mQx2n9${sep}状态", cfg),
            )
        }
    }

    @Test
    fun `一个分隔符都不打也认`() {
        assertEquals(SmsCommand.Parsed.Ok(SmsCommand.Action.STATUS), SmsCommand.parse("Kp7mQx2n9状态", cfg))
        assertEquals(SmsCommand.Parsed.Ok(SmsCommand.Action.NETWORK), SmsCommand.parse("Kp7mQx2n9wifi", cfg))
    }

    @Test
    fun `指令后面跟了多余的字不影响`() {
        assertEquals(SmsCommand.Parsed.Ok(SmsCommand.Action.STATUS), SmsCommand.parse("Kp7mQx2n9 状态 现在", cfg))
    }

    @Test
    fun `超长短信直接放行，不去比对口令`() {
        val long = "Kp7mQx2n9 状态 " + "啊".repeat(300)
        assertEquals(SmsCommand.Parsed.Ignored, SmsCommand.parse(long, cfg))
    }

    @Test
    fun `前后空白与全角问号`() {
        assertEquals(SmsCommand.Parsed.Ok(SmsCommand.Action.HELP), SmsCommand.parse("  Kp7mQx2n9   ？ ", cfg))
    }

    @Test
    fun `口令只对了一半仍然当普通短信`() {
        assertEquals(SmsCommand.Parsed.Ignored, SmsCommand.parse("Kp7mQx2n8 状态", cfg))
        assertEquals(SmsCommand.Parsed.Ignored, SmsCommand.parse("Kp7mQx2n 状态", cfg))
    }

    // ── 号码白名单 ──────────────────────────────────────────

    @Test
    fun `白名单为空表示不限制`() {
        assertTrue(SmsCommand.senderAllowed("13800138000", emptyList()))
    }

    @Test
    fun `带不带国际区号都认`() {
        val allow = listOf("13800138000")
        for (from in listOf("+8613800138000", "008613800138000", "13800138000", "138-0013-8000")) {
            assertTrue("『$from』应当通过白名单", SmsCommand.senderAllowed(from, allow))
        }
    }

    @Test
    fun `不在白名单的号码被拒`() {
        assertFalse(SmsCommand.senderAllowed("13900139000", listOf("13800138000")))
    }

    // ── 限速与锁定 ──────────────────────────────────────────

    @Test
    fun `每小时执行次数有上限`() {
        val l = SmsCommand.RateLimiter(maxPerWindow = 3)
        val t = 1_700_000_000_000L
        assertTrue(l.allow(t))
        assertTrue(l.allow(t + 1))
        assertTrue(l.allow(t + 2))
        assertFalse("超出配额应当拒绝", l.allow(t + 3))
    }

    @Test
    fun `窗口滑过之后配额恢复`() {
        val l = SmsCommand.RateLimiter(maxPerWindow = 1, windowMs = 1000)
        val t = 1_700_000_000_000L
        assertTrue(l.allow(t))
        assertFalse(l.allow(t + 500))
        assertTrue(l.allow(t + 2000))
    }

    @Test
    fun `连续口令错误触发锁定`() {
        val l = SmsCommand.RateLimiter(maxFailures = 3, lockoutMs = 60_000)
        val t = 1_700_000_000_000L
        assertFalse(l.recordFailure(t))
        assertFalse(l.recordFailure(t + 1))
        assertTrue("第三次失败应当锁定", l.recordFailure(t + 2))

        assertTrue(l.locked(t + 3))
        assertFalse("锁定期间不执行任何指令", l.allow(t + 3))
        assertFalse(l.locked(t + 61_000))
        assertTrue(l.allow(t + 61_000))
    }
}
