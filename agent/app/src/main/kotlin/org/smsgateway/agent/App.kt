package org.smsgateway.agent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import com.gyf.cactus.Cactus
import com.gyf.cactus.ext.cactus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.smsgateway.agent.net.PairingClient
import org.smsgateway.agent.net.WsClient
import org.smsgateway.agent.net.label
import org.smsgateway.agent.receiver.CallLogObserver
import org.smsgateway.agent.receiver.SentSmsObserver
import org.smsgateway.agent.ui.MainActivity
import org.smsgateway.agent.util.Log
import org.smsgateway.agent.util.Prefs
import org.smsgateway.agent.util.ProcessUtil

class App : Application() {

    /** 进程级作用域：连接与队列的生命周期跟随进程，由 Cactus 负责让进程活着。 */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    lateinit var prefs: Prefs
        private set
    lateinit var ws: WsClient
        private set

    /**
     * 通知捕获配置，由服务端经 hello_ack.config 下发。
     *
     * 放在内存而不是落盘：Agent 无状态（计划 §2.3），配置以服务端为准，
     * 每次握手都会重新下发。
     */
    private var sentObserver: SentSmsObserver? = null
    private var callObserver: CallLogObserver? = null

    /**
     * 配对的进行状态。**挂在 App 上，不挂在 Activity 上。**
     *
     * 原来配对请求飞在 `lifecycleScope` 上：转一次屏、展一次折叠屏、ROM 在这一秒
     * 改了字体大小，Activity 一销毁协程就被取消，返回的 token 直接丢掉。
     * 而服务端那一侧**码已经用掉了**（pairing_codes 是一次性的，
     * `used_at IS NULL` 写在 UPDATE 的 WHERE 里），于是：配对码作废、服务端多出
     * 一台幽灵设备，而手机上按钮只是从「配对中…」复位成「配对」，什么提示都没有。
     * 人拿同一个码重试只会得到「配对码无效」，得回控制台重新生成、再去清掉那条
     * 多出来的设备记录——而这是每个人的第一步。
     *
     * 所以请求走进程作用域，**拿到结果第一件事就是落盘**；界面只是订阅这个状态，
     * 它在不在都不影响配对完成。
     */
    private val _pairPhase = MutableStateFlow<PairPhase>(PairPhase.Idle)
    val pairPhase: StateFlow<PairPhase> = _pairPhase.asStateFlow()

    fun startPairing(url: String, code: String) {
        if (_pairPhase.value is PairPhase.Running) return
        _pairPhase.value = PairPhase.Running
        scope.launch {
            when (val r = PairingClient().pair(url, code)) {
                is PairingClient.Result.Ok -> {
                    // 先落盘。配对码已经在服务端消费掉了，这一刻起唯一的凭证就在手上
                    prefs.serverUrl = url
                    prefs.deviceId = r.data.deviceId
                    prefs.token = r.data.token
                    prefs.deviceName = r.data.deviceName
                    ws.stop()
                    ws.start()
                    Log.i("配对成功 ${r.data.deviceName}")
                    _pairPhase.value = PairPhase.Done(true, "配对成功：${r.data.deviceName}")
                }
                is PairingClient.Result.Fail -> {
                    _pairPhase.value = PairPhase.Done(false, r.message)
                }
            }
        }
    }

    /** 界面把结果显示过了就调一次，免得重建之后又弹一遍同一个 toast。 */
    fun consumePairResult() {
        if (_pairPhase.value is PairPhase.Done) _pairPhase.value = PairPhase.Idle
    }

    @Volatile var captureNotification: Boolean = false
    /** "all" = 全部应用（含以后新装的）；"selected" = 仅白名单 */
    @Volatile var notificationScope: String = "selected"
    @Volatile var notificationPackages: Set<String> = emptySet()

    override fun onCreate() {
        super.onCreate()
        instance = this
        prefs = Prefs(this)
        createChannel()

        // Cactus 会拉起 :cactusRemoteService 独立进程，它同样会走到这里。
        // 连接与队列只能存在一份，否则两个进程会互相踢下线（见 ProcessUtil）。
        if (!ProcessUtil.isMainProcess(this)) {
            Log.d("远程保活进程启动，跳过连接初始化")
            return
        }

        // 读一次就会写入并固定下来。必须在这里读，而不是等到导入时才读——
        // 那时读到的是「点导入的时刻」，中间实时捕获过的记录会被再导一遍
        Log.d("采集起点 ${prefs.captureStartedAt}")

        ws = WsClient(this, prefs, scope)
        initKeepAlive()

        // 捕获本机发出的短信。没有「已发送」广播，只能监听短信库变化。
        sentObserver = SentSmsObserver(this).also { it.start() }
        // 去电同理：NEW_OUTGOING_CALL 从 Android 10 起只发给默认拨号应用
        callObserver = CallLogObserver(this).also { it.start() }

        if (prefs.isPaired) ws.start()

        /*
         * 常驻通知的正文跟着连接状态走。
         *
         * 这台手机常年锁屏、无人看管，**常驻通知是不解锁就能看到的唯一信号**。
         * 原来它从启动到进程死都写着同一句应用名：凭证被吊销、已经彻底停止重连
         * （ConnState.Fatal）时，它照样显示「运行中」——在最需要说实话的时候说了假话。
         *
         * 文案走 ConnState.label()，和 App 界面里那一行是同一份。
         */
        scope.launch {
            ws.state.collect { s ->
                runCatching {
                    Cactus.instance.setContent(s.label(prefs.isPaired)).updateNotification(this@App)
                }.onFailure { Log.w("更新常驻通知失败 ${it.javaClass.simpleName}") }
            }
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ch = NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
            // 通知栏会长期挂着，别让它出声或亮屏
            enableLights(false)
            enableVibration(false)
            /*
             * 把关掉它的后果写出来。这是全 App 唯一一条渠道，而它恰恰是**绝对不该
             * 关**的那一条：多数 ROM 上关掉前台通知等于允许系统随时收走这个前台服务，
             * 而收走之后验证码不再转发，且不会有任何报错。
             * 系统设置里那一页只给渠道名，不写清楚就是让人凭感觉决定。
             */
            description = "常驻通知。关掉它，系统会把网关停掉，验证码就不会再转发过来。"
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    /**
     * 保活。
     *
     * 配置参考 SmsForwarder（BSD 2-Clause, Copyright (c) 2021 pppscn）
     * app/src/main/kotlin/cn/ppps/forwarder/App.kt 中的 Cactus 初始化，
     * 去掉了无声音乐与一像素 Activity：
     *  - 无声音乐持续占用音频焦点，会干扰正常使用，且本机 Android 12 上收益有限
     *  - 一像素 Activity 仅在 Android 9 以下生效，目标机是 Android 12
     *
     * 保留的是 Cactus 的核心机制：双进程前台服务 + JobScheduler + WorkManager 互拉。
     */
    private fun initKeepAlive() {
        val flags = if (Build.VERSION.SDK_INT >= 30) PendingIntent.FLAG_IMMUTABLE
                    else PendingIntent.FLAG_UPDATE_CURRENT
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)

        cactus {
            setServiceId(NOTIFY_ID)
            setChannelId(CHANNEL_ID)
            setChannelName(getString(R.string.notification_channel))
            setTitle(getString(R.string.notification_title))
            // 初始值也要说事，不能是应用名（头部本来就渲染应用名了）
            setContent(if (prefs.isPaired) "未连接" else "未配对")
            setSmallIcon(R.drawable.ic_notification)
            setPendingIntent(pi)
            setCrashRestartUIEnabled(true)
            /*
             * 上面那段注释说「去掉了无声音乐与一像素 Activity」，但**光写注释不算数**：
             * Cactus 这两项默认都是开的，不显式关掉就一直在跑。
             *
             * 无声音乐的实际代价落在 ROM 上：华为、小米、OPPO 的耗电统计会把这个 App
             * 标成「后台播放音频」，用户据此去限制它——而那恰好等于关掉保活，
             * 正是我们最不想要的结果。
             * （那个 440KB 的 mp3 打在 Cactus 的 AAR 里，关掉播放不会让它从包里消失。）
             */
            setMusicEnabled(false)
            setOnePixEnabled(false)
            addCallback({ Log.d("保活 onStop") }) { Log.d("保活 doWork") }
        }
    }

    companion object {
        const val CHANNEL_ID = "gateway"
        const val NOTIFY_ID = 4113

        @Volatile private var instance: App? = null
        fun get(): App = instance!!
    }
}

/** 配对的三个阶段。Done 带上要显示给人的那句话。 */
sealed interface PairPhase {
    data object Idle : PairPhase
    data object Running : PairPhase
    data class Done(val ok: Boolean, val message: String) : PairPhase
}
