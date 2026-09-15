package org.smsgateway.agent.service

import android.app.Service
import android.content.Intent
import android.os.IBinder
import org.smsgateway.agent.App
import org.smsgateway.agent.util.Log

/**
 * 连接的启停入口。
 *
 * 真正让进程存活的是 Cactus 的前台服务，这里不重复挂通知——
 * 两个前台通知会让通知栏出现两条常驻消息，对用户是噪音。
 */
class GatewayService : Service() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i("GatewayService 启动")
        App.get().ws.start()
        return START_STICKY
    }

    override fun onDestroy() {
        Log.i("GatewayService 停止")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
