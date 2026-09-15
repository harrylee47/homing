package org.smsgateway.agent.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.smsgateway.agent.App
import org.smsgateway.agent.util.Log

/** 开机自启。LOCKED_BOOT_COMPLETED 让我们在用户解锁前就开始连接。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.i("收到开机广播 ${intent.action}")
        val app = App.get()
        if (app.prefs.isPaired) app.ws.start()
    }
}
