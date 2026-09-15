package org.smsgateway.agent.util

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Process

/**
 * Cactus 的保活机制会拉起 `:cactusRemoteService` 独立进程，
 * 而每个进程都会各自执行一次 Application.onCreate。
 *
 * 如果不加区分，远程进程会建立第二条 WebSocket —— 服务端按 device_id 只保留
 * 一条连接，两个进程会互相把对方踢下线，形成无限重连。
 * 因此连接、队列这些只能在主进程里初始化。
 */
object ProcessUtil {

    fun currentProcessName(ctx: Context): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return android.app.Application.getProcessName()
        }
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val pid = Process.myPid()
        return am?.runningAppProcesses?.firstOrNull { it.pid == pid }?.processName ?: ctx.packageName
    }

    fun isMainProcess(ctx: Context): Boolean = currentProcessName(ctx) == ctx.packageName
}
