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
                    _pairPhase.value = PairPhase.Done(true, getString(R.string.toast_pair_ok, r.data.deviceName))
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
        sentObserver = SentSmsObserver(this)
        // 去电同理：NEW_OUTGOING_CALL 从 Android 10 起只发给默认拨号应用
        callObserver = CallLogObserver(this)
        startObservers()

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
                    Cactus.instance.setContent(s.label(this@App, prefs.isPaired)).updateNotification(this@App)
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
            description = getString(R.string.notification_channel_desc)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    /**
     * 保活。
     *
     * 配置参考 SmsForwarder（BSD 2-Clause, Copyright (c) 2021 pppscn）
     * app/src/main/kotlin/cn/ppps/forwarder/App.kt 中的 Cactus 初始化，
     * 现在**四项全开**，和上游实际跑起来的样子一致：
     * 双进程前台服务 + JobScheduler + WorkManager 互拉 + 无声音乐 + 一像素。
     *
     * 这里曾经写着「去掉了无声音乐与一像素」并给了两条理由，**两条都是错的**，
     * 2026-09-18 逐条查过（反编译 AAR + 模拟器 A/B 实测）：
     *
     *  - 「无声音乐持续占用音频焦点，会干扰正常使用」——**假**。Cactus 的 68 个
     *    class 里 `requestAudioFocus` 出现 0 次，它只是 `MediaPlayer.setVolume(0,0)`
     *    放一段静音 mp3，抢不走任何东西，也打断不了用户正在听的歌。
     *  - 「一像素仅在 Android 9 以下生效，目标机是 Android 12」——前半句对，但
     *    结论反了：Cactus 内部就写着 `SDK_INT >= 28 直接 return`，所以在 Android 12 上
     *    `setOnePixEnabled(false)` 是**彻底的 no-op**，关掉它一分钱都省不到；
     *    真正被关掉的是 API 24–27 那些机器上还会跑的那一招，而 minSdk=24、
     *    产品的前提正是「翻一台闲置旧机」。
     *
     * 后来替换上去的那条「华为/小米/OPPO 的耗电统计会标成后台播放音频」同样
     * **查不到任何依据**，是个听起来合理但没人验证过的说法。
     *
     * 已知的真实账（实测）：开着音乐时系统会给这个 uid 记一条 `AudioMix` partial
     * wakelock，覆盖约 94% 的播放时长；而这台手机常年熄屏，等于全天候持有。
     * 在 **AOSP** 上它换不来任何进程优先级——前台服务已经把 `oom_score_adj` 摁到
     * 200，开与不开的 adj、procstate、adjType 三项完全相同。
     *
     * **但那不是这一招被认为有用的地方。** 华为/小米/OPPO 自家的清理守护进程会不会
     * 对「正在放音频」的进程网开一面，两个方向都没有证据——而那恰恰是唯一可能
     * 有收益的一层。既然代价是「常年插电的机器上多一条 wakelock」，而上游几百万
     * 装机量跑的就是开着的配置（且运营者自己用它时体感确实更稳），这个赌注划算。
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
            setContent(getString(if (prefs.isPaired) R.string.state_disconnected else R.string.state_unpaired))
            setSmallIcon(R.drawable.ic_notification)
            setPendingIntent(pi)
            setCrashRestartUIEnabled(true)
            /*
             * **这四行全部显式写出来，哪怕值和 Cactus 的默认值一样。**
             *
             * 这里栽过一次：M0 的注释写着「去掉了无声音乐与一像素」，而代码里一个
             * setter 都没有——Cactus 这两项默认就是 true，于是注释和现实整整半年
             * 是反的，没人看得出来。依赖隐式默认值 = 把一个会变的东西当成不会变的。
             *
             * `setMusicInterval` 的单位是**毫秒**，不是秒：它原样写进
             * `DefaultConfig.repeatInterval`，消费处是 `Handler.postDelayed(r, 那个值)`。
             * 上游传的 `10` 因此是 10 毫秒而不是 10 秒——也就是说上游实际跑的是
             * 连续循环。这里写 0（Cactus 的默认值，语义同样是「放完立刻再放」），
             * 与上游的实际行为一致。那段 mp3 长 26.46 秒。
             *
             * 那个 439,659 字节的 mp3 无论开关都打在包里（占出货 APK 的 15%），
             * 所以「关掉它能瘦身」也是不成立的。
             */
            setMusicEnabled(true)
            setMusicInterval(0L)
            setOnePixEnabled(true)
            addCallback({ Log.d("保活 onStop") }) { Log.d("保活 doWork") }
        }
    }

    /**
     * 启动（或补启动）两个内容观察器。**权限到手之后必须再喊一次。**
     *
     * 它们第一次被启动是在 onCreate 里，而那时候一个权限都还没给——
     * 全新安装的人是先点开 App、再在界面上点「申请权限」的，
     * 而授予运行时权限**不会重启进程**。没有这一下补启动，
     * 去电就永远不上报、已发送短信也永远不捕获，两者都零报错。
     *
     * 两个 start() 自己是幂等的，所以这里可以随便调（MainActivity 的
     * 权限回调与每次 onResume 各调一次——通知使用权、后台定位这类要跳出
     * App 去授予的权限，onResume 是唯一能可靠察觉到的时机）。
     */
    fun startObservers() {
        if (!ProcessUtil.isMainProcess(this)) return
        sentObserver?.start()
        callObserver?.start()
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
