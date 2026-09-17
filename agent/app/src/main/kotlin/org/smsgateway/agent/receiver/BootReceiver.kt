package org.smsgateway.agent.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.smsgateway.agent.App
import org.smsgateway.agent.util.Log

/**
 * 开机自启。
 *
 * **只接 BOOT_COMPLETED（解锁之后）**，不接 LOCKED_BOOT_COMPLETED——
 * 解锁前 prefs 与 Room 队列都在凭据加密区读不到，那时候拉起进程只会在
 * Application.onCreate 里崩掉。理由写在 AndroidManifest 里那段注释。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.i("收到开机广播 ${intent.action}")
        val app = App.get()
        if (app.prefs.isPaired) app.ws.start()
    }
}
