package org.smsgateway.agent.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 指令参数必须按类型解码。
 *
 * 踩过的坑：对 `cmd.args["since"]` 写 `as? String`。args 是 JsonObject，
 * 取出来的是 JsonPrimitive，那个转换**永远**返回 null —— 于是界面上选的
 * 时间范围和条数上限被静默忽略，选什么都等于「全部、按默认上限」。
 * 不报错、不告警，只有对着结果数数才能发现。
 */
class ImportArgsTest {

    private fun decode(o: JsonObject) = Protocol.json.decodeFromJsonElement(ImportArgs.serializer(), o)

    @Test
    fun `按类型解码能拿到值`() {
        val a = decode(buildJsonObject { put("since", 1_700_000_000_000L); put("limit", 50) })
        assertEquals(1_700_000_000_000L, a.since)
        assertEquals(50, a.limit)
    }

    @Test
    fun `错误示范：对 JsonElement 做 as String 永远是 null`() {
        val o = buildJsonObject { put("since", 1_700_000_000_000L) }
        @Suppress("USELESS_IS_CHECK")
        assertEquals(null, o["since"] as? String)
    }

    @Test
    fun `不给时间范围表示不限，条数有默认值`() {
        val a = decode(buildJsonObject { put("limit", 200) })
        assertEquals(null, a.since)
        assertEquals(200, a.limit)
    }

    @Test
    fun `什么都不给也不能崩`() {
        val a = decode(JsonObject(emptyMap()))
        assertEquals(null, a.since)
        assertEquals(1000, a.limit)
    }
}
