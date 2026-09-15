package org.smsgateway.agent.net

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.BatteryManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.smsgateway.agent.BuildConfig
import org.smsgateway.agent.db.AgentDatabase
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.protocol.*
import org.smsgateway.agent.location.Locator
import org.smsgateway.agent.sms.SmsSender
import org.smsgateway.agent.util.Log
import org.smsgateway.agent.util.Prefs
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.random.Random

sealed interface ConnState {
    data object Idle : ConnState
    data object Connecting : ConnState
    data class Connected(val since: Long) : ConnState
    data class Waiting(val retryInSec: Int) : ConnState
    /** 不可恢复：凭证无效 / 被吊销 / 协议版本不支持。停止重连，等人工处理。 */
    data class Fatal(val code: String, val message: String) : ConnState
}

/**
 * 与服务端的长连接。
 *
 * 连接方向是设备主动外连（计划 §3.1 决策一），因此手机在 NAT 后无影响，
 * 也不需要任何内网穿透。连接状态天然即心跳。
 */
class WsClient(
    private val ctx: Context,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
) {
    private val dao = AgentDatabase.get(ctx).events()

    private val http = OkHttpClient.Builder()
        // 应用层自己做心跳，这里关掉 OkHttp 的，避免两套超时互相干扰
        .pingInterval(0, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state.asStateFlow()

    private val _pending = MutableStateFlow(0)
    val pendingCount: StateFlow<Int> = _pending.asStateFlow()

    private var ws: WebSocket? = null
    private var config = AgentConfig()
    private var attempt = 0
    private var loopJob: Job? = null
    private var heartbeatJob: Job? = null
    private var lastInboundAt = 0L
    private var running = false

    fun start() {
        if (running) return
        running = true
        loopJob = scope.launch { connectLoop() }
        scope.launch { refreshPending() }
    }

    fun stop() {
        running = false
        loopJob?.cancel()
        heartbeatJob?.cancel()
        ws?.close(1000, "stopped")
        ws = null
        _state.value = ConnState.Idle
    }

    /** 收到新事件：先落本地队列，再尝试立刻发送。落库在前，保证不丢。 */
    suspend fun enqueue(e: PendingEvent) {
        val n = dao.count()
        if (n >= Protocol.MAX_PENDING_EVENTS) {
            // 超限丢最旧的，并且这件事必须让人知道
            dao.dropOldest(n - Protocol.MAX_PENDING_EVENTS + 1)
            Log.e("离线队列超过 ${Protocol.MAX_PENDING_EVENTS} 条，已丢弃最旧记录")
        }
        dao.insert(e)
        refreshPending()
        Log.i("事件入队 id=${e.id} kind=${e.kind} from=${Log.phone(e.from)} content=${Log.content(e.content)}")
        if (_state.value is ConnState.Connected) drain()
    }

    private suspend fun refreshPending() {
        _pending.value = runCatching { dao.count() }.getOrDefault(0)
    }

    // ── 连接与重连 ──────────────────────────────────────────

    private suspend fun connectLoop() {
        while (running) {
            if (!prefs.isPaired) {
                _state.value = ConnState.Idle
                delay(3000)
                continue
            }
            if (_state.value is ConnState.Fatal) {
                delay(5000)
                continue
            }

            _state.value = ConnState.Connecting
            val connected = CompletableDeferred<Boolean>()
            val closed = CompletableDeferred<Unit>()
            openSocket(connected, closed)

            val ok = runCatching { connected.await() }.getOrDefault(false)
            if (ok) {
                // 连上了就在这里停住，直到对端断开再走重连——
                // 否则循环会立刻开出第二条连接，与自己互踢。
                runCatching { closed.await() }
                attempt = 0
                continue
            }
            if (running) {
                // 指数退避 1s→60s，带 jitter 避免断网恢复时全部设备同时冲击服务端
                val backoff = minOf(60_000L, 1000L shl minOf(attempt, 6))
                val jitter = Random.nextLong(0, backoff / 4 + 1)
                val waitMs = backoff + jitter
                attempt++
                _state.value = ConnState.Waiting((waitMs / 1000).toInt())
                Log.i("第 $attempt 次重连等待 ${waitMs}ms")
                delay(waitMs)
            }
        }
    }

    private fun openSocket(connected: CompletableDeferred<Boolean>, closed: CompletableDeferred<Unit>) {
        val url = prefs.serverUrl ?: return
        val req = Request.Builder().url(url).build()
        ws = http.newWebSocket(req, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                lastInboundAt = System.currentTimeMillis()
                sendHello(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                lastInboundAt = System.currentTimeMillis()
                scope.launch { handle(webSocket, text, connected) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w("连接失败: ${t.message}")
                cleanup()
                if (!connected.isCompleted) connected.complete(false)
                if (!closed.isCompleted) closed.complete(Unit)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i("连接关闭 code=$code reason=$reason")
                cleanup()
                if (!connected.isCompleted) connected.complete(false)
                if (!closed.isCompleted) closed.complete(Unit)
            }
        })
    }

    private fun cleanup() {
        heartbeatJob?.cancel()
        ws = null
        if (_state.value !is ConnState.Fatal) _state.value = ConnState.Idle
    }

    // ── 收发 ────────────────────────────────────────────────

    private fun frame(type: String, payload: Any): String {
        val p = when (payload) {
            is HelloPayload -> Protocol.json.encodeToJsonElement(HelloPayload.serializer(), payload)
            is EventPayload -> Protocol.json.encodeToJsonElement(EventPayload.serializer(), payload)
            is PongPayload -> Protocol.json.encodeToJsonElement(PongPayload.serializer(), payload)
            is PingPayload -> Protocol.json.encodeToJsonElement(PingPayload.serializer(), payload)
            is CmdResultPayload -> Protocol.json.encodeToJsonElement(CmdResultPayload.serializer(), payload)
            else -> JsonObject(emptyMap())
        }
        val env = Envelope(
            v = Protocol.VERSION, type = type,
            msgId = UUID.randomUUID().toString(),
            ts = System.currentTimeMillis(), payload = p,
        )
        return Protocol.json.encodeToString(Envelope.serializer(), env)
    }

    private fun sendHello(webSocket: WebSocket) {
        val hello = HelloPayload(
            deviceId = prefs.deviceId ?: return,
            token = prefs.token ?: return,
            appVersion = BuildConfig.VERSION_NAME,
            androidSdk = android.os.Build.VERSION.SDK_INT,
            battery = battery(),
            charging = isCharging(),
            pendingCount = _pending.value,
        )
        webSocket.send(frame("hello", hello))
    }

    private suspend fun handle(webSocket: WebSocket, text: String, connected: CompletableDeferred<Boolean>) {
        val env = runCatching { Protocol.json.decodeFromString(Envelope.serializer(), text) }.getOrNull()
        if (env == null) {
            Log.w("收到无法解析的帧，已忽略")
            return
        }
        if (env.v != Protocol.VERSION) {
            Log.e("服务端协议版本 ${env.v} 与本机 ${Protocol.VERSION} 不一致")
            return
        }

        when (env.type) {
            "hello_ack" -> {
                val p = Protocol.json.decodeFromJsonElement(HelloAckPayload.serializer(), env.payload)
                config = p.config
                attempt = 0
                _state.value = ConnState.Connected(System.currentTimeMillis())
                Log.i("已连接，心跳 ${config.heartbeatSec}s，启用类型 ${config.enabledKinds}")
                if (!connected.isCompleted) connected.complete(true)
                startHeartbeatWatchdog(webSocket)
                drain()
            }

            "hello_reject" -> {
                val p = Protocol.json.decodeFromJsonElement(HelloRejectPayload.serializer(), env.payload)
                Log.e("握手被拒 ${p.code}: ${p.message}")
                if (p.code in ErrorCodes.FATAL) {
                    // 不可重试：继续重连只会刷日志，停下来等人处理
                    _state.value = ConnState.Fatal(p.code, p.message)
                }
                if (!connected.isCompleted) connected.complete(false)
            }

            "event_ack" -> {
                val p = Protocol.json.decodeFromJsonElement(EventAckPayload.serializer(), env.payload)
                // stored / duplicate / rejected 三者都出队：
                // 前两者已被服务端接受，rejected 重传也不会变好
                val ids = p.acks.map { it.id }
                p.acks.filter { it.status == "rejected" }
                    .forEach { Log.e("事件被拒 id=${it.id} error=${it.error}") }
                dao.delete(ids)
                refreshPending()
                drain()
            }

            "ping" -> {
                val p = Protocol.json.decodeFromJsonElement(PingPayload.serializer(), env.payload)
                webSocket.send(frame("pong", PongPayload(p.seq, battery(), isCharging(), _pending.value)))
            }

            "cmd" -> {
                val p = Protocol.json.decodeFromJsonElement(CmdPayload.serializer(), env.payload)
                onCommand(webSocket, p)
            }

            else -> Log.d("忽略未知帧类型 ${env.type}")
        }
    }

    private val smsSender by lazy { SmsSender(ctx) }
    private val locator by lazy { Locator(ctx) }

    private fun onCommand(webSocket: WebSocket, cmd: CmdPayload) {
        Log.i("收到指令 ${cmd.action} cmd_id=${cmd.cmdId}")
        when (cmd.action) {
            "send_sms" -> onSendSms(cmd)
            "get_location" -> onGetLocation(cmd)
            else -> report(cmd.cmdId, "failed", "尚未实现：${cmd.action}")
        }
    }

    /**
     * 按需定位，用于设备找回。只在收到指令时执行一次，不做持续定位。
     */
    private fun onGetLocation(cmd: CmdPayload) {
        report(cmd.cmdId, "accepted", null)
        locator.locate { result, error ->
            if (result == null) {
                report(cmd.cmdId, "failed", error ?: "定位失败")
                return@locate
            }
            // 日志里不记坐标：位置和短信正文同等敏感
            Log.i("定位完成 cmd=${cmd.cmdId} provider=${result.provider} cached=${result.cached}")
            val detail = Protocol.json.encodeToJsonElement(
                LocationResult.serializer(),
                LocationResult(
                    lat = result.lat, lng = result.lng, accuracy = result.accuracy,
                    provider = result.provider, time = result.time, cached = result.cached,
                ),
            )
            val socket = ws
            if (socket == null) {
                Log.w("定位结果无法上报（连接已断）cmd=${cmd.cmdId}")
                return@locate
            }
            socket.send(frame("cmd_result", CmdResultPayload(cmd.cmdId, "done", null, detail)))
        }
    }

    private fun onSendSms(cmd: CmdPayload) {
        val args = runCatching {
            Protocol.json.decodeFromJsonElement(SendSmsArgs.serializer(), cmd.args)
        }.getOrNull()
        if (args == null) {
            report(cmd.cmdId, "failed", "send_sms 参数非法")
            return
        }
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            report(cmd.cmdId, "failed", "未授予 SEND_SMS 权限")
            return
        }
        // 每一步状态都独立上报，控制台上能看到完整流转
        smsSender.send(cmd.cmdId, args.to, args.text, args.simSlot) { id, status, error ->
            report(id, status, error)
        }
    }

    /**
     * 回执必须走当前连接。断线期间产生的回执会丢失 ——
     * 这是可接受的：outbound 的真实状态以设备重连后的查询为准，
     * 而短信本身已经发出，重发比丢状态危险得多。
     */
    private fun report(cmdId: String, status: String, error: String?) {
        val socket = ws
        if (socket == null) {
            Log.w("回执无法上报（连接已断）cmd=$cmdId status=$status")
            return
        }
        socket.send(frame("cmd_result", CmdResultPayload(cmdId, status, error)))
    }

    // ── 补传 ────────────────────────────────────────────────

    private val drainMutex = kotlinx.coroutines.sync.Mutex()

    /** 按 occurredAt 升序补传。收到 ack 才出队，所以这里只管发。 */
    private fun drain() {
        scope.launch {
            if (!drainMutex.tryLock()) { Log.d("drain: 已有补传在跑"); return@launch }
            try {
                val socket = ws
                if (socket == null) { Log.w("drain: socket 为空"); return@launch }
                if (_state.value !is ConnState.Connected) { Log.w("drain: 状态非已连接 ${_state.value}"); return@launch }
                val batch = dao.oldest(config.maxBatchSize)
                Log.d("drain: 待发 ${batch.size} 条")
                val deviceId = prefs.deviceId ?: return@launch
                for (e in batch) {
                    if (e.kind !in config.enabledKinds) {
                        // 服务端动态收窄了类型，本地直接丢弃，不占队列
                        dao.delete(listOf(e.id))
                        continue
                    }
                    socket.send(frame("event", e.toPayload(deviceId)))
                }
                refreshPending()
            } finally {
                drainMutex.unlock()
            }
        }
    }

    // ── 心跳看门狗 ──────────────────────────────────────────

    /**
     * 服务端会主动 ping，我们只需检测「多久没收到任何东西」。
     * 超时即主动断开，交给重连循环——比等 TCP 超时快得多。
     */
    private fun startHeartbeatWatchdog(webSocket: WebSocket) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(config.heartbeatSec * 1000L)
                val silent = System.currentTimeMillis() - lastInboundAt
                if (silent > config.heartbeatTimeoutSec * 1000L) {
                    Log.w("心跳超时 ${silent}ms，主动断开")
                    webSocket.cancel()
                    return@launch
                }
            }
        }
    }

    private fun battery(): Int {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        return bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.coerceIn(0, 100) ?: 0
    }

    /**
     * 是否在充电。
     *
     * 用 BatteryManager.isCharging 而不是解析 ACTION_BATTERY_CHANGED 的粘性广播：
     * 后者要注册一个 receiver、解析 EXTRA_PLUGGED，还得处理「充满后停止充电但
     * 仍插着电源」的边界，而这个 API 直接给出结论。
     */
    private fun isCharging(): Boolean {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        return runCatching { bm?.isCharging == true }.getOrDefault(false)
    }
}

private fun PendingEvent.toPayload(deviceId: String) = EventPayload(
    id = id, deviceId = deviceId, kind = kind, from = from, content = content,
    occurredAt = occurredAt, simSlot = simSlot,
    extra = EventExtra(callType = callType, `package` = pkg, truncated = truncated.takeIf { it }),
)
