package org.smsgateway.agent.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.util.Log
import java.util.concurrent.TimeUnit

/**
 * 用一次性配对码换取长期凭证（计划 §6.1）。
 *
 * 配对码在 TTL 内等价于设备凭证，因此：
 *  - 只走 https，不接受明文（debug 构建的本地地址除外，由 network_security_config 控制）
 *  - 成功后立即丢弃配对码，不留存
 */
class PairingClient {

    @Serializable
    private data class PairRequest(val code: String)

    @Serializable
    data class PairResponse(
        @SerialName("device_id") val deviceId: String,
        val token: String,
        @SerialName("device_name") val deviceName: String,
    )

    sealed interface Result {
        data class Ok(val data: PairResponse) : Result
        data class Fail(val message: String) : Result
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    /**
     * @param baseUrl 形如 wss://host/ws 或 https://host —— 统一推导出 https://host/api/pair
     */
    fun pair(baseUrl: String, code: String): Result {
        val url = apiUrl(baseUrl) ?: return Result.Fail("服务端地址格式不正确")

        val body = Protocol.json.encodeToString(PairRequest.serializer(), PairRequest(code.trim().uppercase()))
            .toRequestBody("application/json".toMediaType())

        return try {
            http.newCall(Request.Builder().url(url).post(body).build()).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    // 服务端对无效/已用/过期一律返回同一响应，不区分原因
                    Log.w("配对失败 HTTP ${resp.code}")
                    return Result.Fail(
                        when (resp.code) {
                            401 -> "配对码无效或已过期"
                            429 -> "尝试过于频繁，请稍后再试"
                            else -> "服务端返回 ${resp.code}"
                        },
                    )
                }
                Result.Ok(Protocol.json.decodeFromString(PairResponse.serializer(), text))
            }
        } catch (e: Exception) {
            Log.w("配对请求异常: ${e.message}")
            Result.Fail("无法连接服务端：${e.message}")
        }
    }

    /** wss://host/ws → https://host/api/pair；ws:// → http://（仅 debug 构建可用） */
    private fun apiUrl(baseUrl: String): String? {
        val u = baseUrl.trim()
        val origin = when {
            u.startsWith("wss://") -> "https://" + u.removePrefix("wss://")
            u.startsWith("ws://") -> "http://" + u.removePrefix("ws://")
            u.startsWith("https://") || u.startsWith("http://") -> u
            else -> return null
        }
        return origin.substringBeforeLast("/ws").trimEnd('/') + "/api/pair"
    }
}
