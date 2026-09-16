package org.smsgateway.agent.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** describe() 是短信指令回复里的一行，纯数据类，可以直接跑 JVM 单测。 */
class SimCardTest {

    private fun card(
        slot: Int = 0,
        carrier: String? = "中国移动",
        label: String? = null,
        tail: String? = "1234",
        signal: Int? = 3,
    ) = SimCard(slot, carrier, label, tail, signal, defaultSms = false, defaultData = false)

    @Test
    fun `卡槽从 1 开始数给人看`() {
        // slot 是 0 基的数组下标，但没人管第一张卡叫 SIM0
        assertTrue(card(slot = 0).describe().startsWith("SIM1"))
        assertTrue(card(slot = 1).describe().startsWith("SIM2"))
    }

    @Test
    fun `完整信息`() {
        assertEquals("SIM2 · 中国移动 · 尾号 1234 · 信号 3/4", card(slot = 1).describe())
    }

    @Test
    fun `没有运营商名就退回系统里设的卡名`() {
        assertTrue(card(carrier = null, label = "工作卡").describe().contains("工作卡"))
    }

    @Test
    fun `取不到的字段直接不提，不要编「未知」`() {
        assertEquals("SIM1", card(carrier = null, label = null, tail = null, signal = null).describe())
    }
}
