package org.smsgateway.agent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import com.gyf.cactus.ext.cactus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import org.smsgateway.agent.net.WsClient
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
    @Volatile var captureNotification: Boolean = false
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

        ws = WsClient(this, prefs, scope)
        initKeepAlive()
        if (prefs.isPaired) ws.start()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ch = NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
            // 通知栏会长期挂着，别让它出声或亮屏
            enableLights(false)
            enableVibration(false)
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
            setContent(getString(R.string.app_name))
            setSmallIcon(R.drawable.ic_notification)
            setPendingIntent(pi)
            setCrashRestartUIEnabled(true)
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
