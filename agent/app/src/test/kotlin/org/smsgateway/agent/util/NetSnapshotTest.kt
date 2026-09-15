package org.smsgateway.agent.util

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * describe() 是短信指令「网络」的回复正文，人在外面只能看到这一行。
 * 纯数据类，无 Android 依赖，可以直接跑 JVM 单测。
 */
class NetSnapshotTest {

    private fun snap(
        wifi: Boolean = true,
        type: String = "wifi",
        ssid: String? = "MyWiFi",
        carrier: String? = "SoftBank",
        signal: Int? = 4,
        online: Boolean = true,
    ) = NetSnapshot(wifi, type, ssid, carrier, signal, online)

    @Test
    fun `连着 WiFi 也要报 SIM 信号`() {
        // 卡没信号时短信照样收不到，而「已连 WiFi」会让人以为一切正常
        val text = snap(signal = 0).describe()
        assertTrue(text, text.contains("已连 MyWiFi"))
        assertTrue(text, text.contains("信号 0/4"))
    }

    @Test
    fun `走移动数据时信号只说一次`() {
        val text = snap(type = "cellular", ssid = null, signal = 2).describe()
        assertTrue(text, text.contains("走移动数据"))
        assertTrue(text, Regex("信号").findAll(text).count() == 1)
    }

    @Test
    fun `取不到信号就不提，不要编一个数字`() {
        assertTrue(!snap(signal = null).describe().contains("信号"))
    }

    @Test
    fun `连上但没验证要标出来`() {
        assertTrue(snap(online = false).describe().contains("未验证"))
    }

    @Test
    fun `无网络时不说已连`() {
        val text = snap(wifi = false, type = "none", ssid = null, online = false).describe()
        assertTrue(text, text.contains("WiFi 关"))
        assertTrue(text, text.contains("无网络"))
        assertTrue(text, !text.contains("未验证"))
    }
}
