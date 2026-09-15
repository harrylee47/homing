package org.smsgateway.agent.net

import java.net.URLDecoder

/**
 * 配对二维码的内容：`smsgw://pair?url=<ws 地址>&code=<配对码>`。
 *
 * 格式定义在服务端 `src/adapters/node/api.ts` 的 `pairPayload()`，改动要同步两端。
 *
 * 不用 `android.net.Uri` 而是自己切：一来这段逻辑值得单测，而 Uri 在 JVM 单测里
 * 是空壳；二来 Uri 对畸形输入的容忍度很高，会把半个字段也解析出来——
 * 扫到别人的 Wi-Fi 码时我们要的是「明确报错」，不是「拿着半个地址去试」。
 */
object PairPayload {

    data class Parsed(val url: String, val code: String)

    private const val PREFIX = "smsgw://pair?"

    /**
     * 严格解析：整段文本必须就是配对内容。扫码走这条。
     *
     * 扫到的二维码指向哪台服务器，决定了这台手机之后把所有短信发给谁，
     * 所以不接受「夹在别的内容里」——那种二维码的来源本身就可疑。
     */
    fun parse(text: String?): Parsed? {
        val t = text?.trim().orEmpty()
        if (!t.startsWith(PREFIX)) return null

        var url = ""
        var code = ""
        for (kv in t.removePrefix(PREFIX).split('&')) {
            val i = kv.indexOf('=')
            if (i <= 0) continue
            val v = decode(kv.substring(i + 1))
            when (kv.substring(0, i)) {
                "url" -> url = v.trim()
                "code" -> code = v.trim()
            }
        }

        if (url.isEmpty() || code.isEmpty()) return null
        // 明文地址只在 debug 构建里可用（network_security_config 控制），
        // 但格式本身要认——否则本地调试连二维码都用不了
        if (!url.startsWith("wss://") && !url.startsWith("ws://")) return null
        return Parsed(url, code)
    }

    /**
     * 宽松查找：从一段文本里把配对内容挑出来。手工粘贴走这条。
     *
     * 输入框里往往已经有上次的地址，粘贴是追加而不是替换，
     * 严格匹配开头会让粘贴永远失败——而用户看不出为什么。
     * 这条路径最终仍要用户自己点「配对」，不会凭一段文本就把短信发出去。
     */
    fun find(text: String?): Parsed? {
        val t = text.orEmpty()
        val i = t.indexOf(PREFIX)
        if (i < 0) return null
        // 到第一个空白为止：地址与配对码里都不会有空格
        val tail = t.substring(i).substringBefore(' ').substringBefore('\n')
        return parse(tail)
    }

    private fun decode(s: String): String =
        runCatching { URLDecoder.decode(s, "UTF-8") }.getOrElse { s }
}
