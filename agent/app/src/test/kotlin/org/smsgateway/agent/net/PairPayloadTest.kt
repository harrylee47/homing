package org.smsgateway.agent.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 配对二维码的解析。
 *
 * 重点在「认不出来要明确说认不出来」：扫到别的二维码时拿着半个字段去配对，
 * 表现是一个看不懂的网络错误，用户会以为是服务端坏了。
 */
class PairPayloadTest {

    private val url = "wss://gw.example.com/ws"

    @Test
    fun `正常的配对码`() {
        val p = PairPayload.parse("smsgw://pair?url=wss%3A%2F%2Fgw.example.com%2Fws&code=A1B2C3D4")
        assertEquals(url, p?.url)
        assertEquals("A1B2C3D4", p?.code)
    }

    @Test
    fun `参数顺序反过来也认`() {
        assertEquals(url, PairPayload.parse("smsgw://pair?code=A1B2C3D4&url=wss%3A%2F%2Fgw.example.com%2Fws")?.url)
    }

    @Test
    fun `前后空白`() {
        assertEquals(url, PairPayload.parse("  smsgw://pair?url=wss%3A%2F%2Fgw.example.com%2Fws&code=X  ")?.url)
    }

    @Test
    fun `本地调试的明文地址也认`() {
        assertEquals(
            "ws://192.168.1.2:8070/ws",
            PairPayload.parse("smsgw://pair?url=ws%3A%2F%2F192.168.1.2%3A8070%2Fws&code=X")?.url,
        )
    }

    @Test
    fun `别的二维码一律拒绝`() {
        assertNull(PairPayload.parse("https://example.com"))
        assertNull(PairPayload.parse("WIFI:S:MyWiFi;T:WPA;P:pass;;"))
        assertNull(PairPayload.parse(""))
        assertNull(PairPayload.parse(null))
    }

    @Test
    fun `缺字段不拿半个去配对`() {
        assertNull(PairPayload.parse("smsgw://pair?url=wss%3A%2F%2Fgw.example.com%2Fws"))
        assertNull(PairPayload.parse("smsgw://pair?code=A1B2C3D4"))
    }

    @Test
    fun `协议不对的地址拒绝——https 地址连不上 WS`() {
        assertNull(PairPayload.parse("smsgw://pair?url=https%3A%2F%2Fgw.example.com&code=X"))
    }

    // ── 宽松查找（手工粘贴）────────────────────────────────

    @Test
    fun `粘贴时输入框里还留着上次的地址`() {
        // 真实情况：点进输入框直接粘，是追加不是替换
        val p = PairPayload.find("wss://old.example.com/wssmsgw://pair?url=wss%3A%2F%2Fgw.example.com%2Fws&code=A1B2C3D4")
        assertEquals(url, p?.url)
        assertEquals("A1B2C3D4", p?.code)
    }

    @Test
    fun `后面跟着别的文字也能挑出来`() {
        assertEquals(url, PairPayload.find("配对链接：smsgw://pair?url=wss%3A%2F%2Fgw.example.com%2Fws&code=X 五分钟内有效")?.url)
    }

    @Test
    fun `找不到就是找不到`() {
        assertNull(PairPayload.find("wss://gw.example.com/ws"))
        assertNull(PairPayload.find(null))
    }

    @Test
    fun `扫码那条路径仍然严格——夹在别的内容里的不认`() {
        assertNull(PairPayload.parse("https://evil.example.com#smsgw://pair?url=wss%3A%2F%2Fevil%2Fws&code=X"))
    }
}
