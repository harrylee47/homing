package org.smsgateway.agent.command

import org.smsgateway.agent.protocol.SmsCommandConfig

/**
 * 短信指令的纯逻辑部分：解析、鉴权、限速。
 *
 * 刻意不碰任何 Android API —— 这部分的错误代价最高（放行了伪造指令，
 * 或把正常短信当指令吞掉），必须能单独推敲。副作用都在 SmsCommandHandler。
 *
 * 格式：`<口令><分隔><指令>`，例如 `Kp7mQx2n 状态`。
 * 口令在前是故意的：一眼看不出这是什么系统的什么命令，
 * 而且开头对不上时立刻就能当普通短信放行，不用去猜后面写了什么。
 *
 * 分隔符**怎么写都认**：半角空格、全角空格、冒号、逗号，甚至一个都不打。
 * 人在外面用手机打字，中文输入法给出的是全角空格、全角冒号，
 * 要求他分清全角半角，等于要求他在最需要这个功能的时候不要打错字。
 */
object SmsCommand {

    /** 能力清单。**没有发短信**——伪造成功也只能知道手机还活着。 */
    enum class Action { STATUS, NETWORK, BATTERY, LOCATE, RECONNECT, HELP }

    private val ALIASES: Map<String, Action> = mapOf(
        "状态" to Action.STATUS, "status" to Action.STATUS, "st" to Action.STATUS,
        "网络" to Action.NETWORK, "wifi" to Action.NETWORK, "net" to Action.NETWORK,
        "电量" to Action.BATTERY, "battery" to Action.BATTERY, "bat" to Action.BATTERY,
        "定位" to Action.LOCATE, "位置" to Action.LOCATE, "locate" to Action.LOCATE, "loc" to Action.LOCATE,
        "重连" to Action.RECONNECT, "重启" to Action.RECONNECT, "reconnect" to Action.RECONNECT,
        "帮助" to Action.HELP, "help" to Action.HELP, "?" to Action.HELP, "？" to Action.HELP,
    )

    /** 分隔符：各种空白（含全角空格）与中英文标点。写不写、写哪个都行。 */
    private val SEPARATORS = charArrayOf(
        ' ', '\t', '\n', '\r', '\u3000',
        ':', '：', ',', '，', '.', '。', '、', '-', '_', '=',
    )

    /** 解析结果。Ignored 表示「这不是指令」，要当普通短信正常转发。 */
    sealed interface Parsed {
        data class Ok(val action: Action) : Parsed
        /** 口令对上了但指令不认识——要回一条帮助，不能沉默 */
        data object UnknownAction : Parsed
        data object Ignored : Parsed
    }

    /**
     * 解析一条短信。
     *
     * 口令比较用定长时间比较：短信指令的失败次数有限，时间侧信道其实吃不满，
     * 但这里的成本只有几行代码。
     */
    fun parse(body: String, cfg: SmsCommandConfig): Parsed {
        if (!cfg.enabled || cfg.secret.isBlank()) return Parsed.Ignored
        // 指令短信不会很长；超长的一定是普通短信，先挡掉避免白算
        if (body.length > 200) return Parsed.Ignored

        val t = body.trim(*SEPARATORS)
        if (t.length < cfg.secret.length) return Parsed.Ignored
        // 按前缀比而不是按「第一个词」比：这样分隔符写不写、写哪个都不影响
        if (!constantTimeEquals(t.take(cfg.secret.length), cfg.secret)) return Parsed.Ignored

        val rest = t.drop(cfg.secret.length).trimStart(*SEPARATORS)
        // 只发了口令、没写指令：既然口令是对的，就回一条帮助，而不是装作没看见
        if (rest.isEmpty()) return Parsed.UnknownAction

        val word = rest.split(*SEPARATORS).firstOrNull { it.isNotEmpty() } ?: return Parsed.UnknownAction
        val action = ALIASES[word.lowercase()]
        return if (action == null) Parsed.UnknownAction else Parsed.Ok(action)
    }

    /**
     * 号码白名单。
     *
     * 主叫号码可以伪造，所以白名单只能是第二道防线，不能是唯一一道；
     * 但它能挡住「口令被人看到过」之后的随手一试。
     *
     * 用后缀匹配：同一个号码在不同网络里带的前缀不一样
     * （+8613800138000 / 008613800138000 / 13800138000）。
     */
    fun senderAllowed(from: String, allow: List<String>): Boolean {
        if (allow.isEmpty()) return true
        val a = normalize(from)
        return allow.any { w ->
            val b = normalize(w)
            b.isNotEmpty() && (a.endsWith(b) || b.endsWith(a))
        }
    }

    private fun normalize(n: String): String = n.filter { it.isDigit() }

    /**
     * 限速器。
     *
     * 口令是明文传输的唯一凭证，必须挡住穷举：短时间内多次口令错误就整体
     * 停止响应一段时间。注意「停止响应」而不是「回复被拒」——回复本身
     * 就是一个信号，会告诉对方口令格式猜对没有。
     */
    class RateLimiter(
        private val maxPerWindow: Int = 10,
        private val windowMs: Long = 60 * 60 * 1000L,
        private val maxFailures: Int = 5,
        private val lockoutMs: Long = 60 * 60 * 1000L,
    ) {
        private val executions = ArrayDeque<Long>()
        private val failures = ArrayDeque<Long>()
        @Volatile private var lockedUntil = 0L

        @Synchronized
        fun locked(now: Long): Boolean {
            prune(failures, now, windowMs)
            return now < lockedUntil
        }

        /** 执行前调用。false = 超出配额，应当静默丢弃。 */
        @Synchronized
        fun allow(now: Long): Boolean {
            prune(executions, now, windowMs)
            if (now < lockedUntil) return false
            if (executions.size >= maxPerWindow) return false
            executions.addLast(now)
            return true
        }

        /** 口令错误时调用。达到阈值即锁定。 */
        @Synchronized
        fun recordFailure(now: Long): Boolean {
            prune(failures, now, windowMs)
            failures.addLast(now)
            if (failures.size >= maxFailures) {
                lockedUntil = now + lockoutMs
                failures.clear()
                return true
            }
            return false
        }

        private fun prune(q: ArrayDeque<Long>, now: Long, window: Long) {
            while (q.isNotEmpty() && now - q.first() > window) q.removeFirst()
        }
    }

    /**
     * 帮助文本。一条短信只有 70 个汉字，所以每条指令只给一个词的用途。
     *
     * 不回显口令：这条回复会留在对方手机的短信记录里。
     */
    const val HELP = "网关指令：状态(总览) 网络(WiFi) 电量 定位 重连。" +
        "发法：口令后面跟指令，如「口令 状态」，中间空格可有可无"

    /**
     * 定长时间字符串比较。
     *
     * 长度不同直接返回 false —— 长度本身泄漏一位信息，但口令长度是固定的，
     * 攻击者本来就知道。
     */
    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
        return diff == 0
    }
}
