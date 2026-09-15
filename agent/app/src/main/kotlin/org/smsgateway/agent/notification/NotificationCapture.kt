package org.smsgateway.agent.notification

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import kotlinx.coroutines.launch
import org.smsgateway.agent.App
import org.smsgateway.agent.db.PendingEvent
import org.smsgateway.agent.protocol.Protocol
import org.smsgateway.agent.util.Log
import java.util.UUID

/**
 * 应用通知捕获。
 *
 * 很多验证码走 App 推送而不是短信——微信、支付宝、银行 App 的登录确认都是，
 * 这是短信之外最需要转发的一类。
 *
 * 两个必须做对的地方：
 *  1. **只捕获白名单里的应用**。手机上几十个应用每天产生成百上千条通知，
 *     全捕获等于把网关变成噪音源，验证码反而被淹没。白名单由服务端下发。
 *  2. **去重**。Android 通知会被反复更新（进度条刷新、多条合并、应用主动重发），
 *     同一条内容几秒内触发十几次回调很常见。
 */
class NotificationCapture : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val app = App.get()
            if (!app.captureNotification) return

            val pkg = sbn.packageName ?: return
            // all 模式连以后新装的应用也一起捕获，不用回控制台更新列表
            if (app.notificationScope != "all" && !app.notificationPackages.contains(pkg)) return
            // 自己的前台服务通知不能被自己捕获，否则会无限自我触发
            if (pkg == packageName) return

            val extras = sbn.notification?.extras ?: return
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
            if (title.isBlank() && text.isBlank()) return

            var content = if (title.isBlank()) text else if (text.isBlank()) title else title + "\n" + text
            var truncated = false
            if (content.length > Protocol.MAX_CONTENT_LEN) {
                content = content.take(Protocol.MAX_CONTENT_LEN)
                truncated = true
            }

            if (!shouldEmit(pkg, content)) return

            val event = PendingEvent(
                id = "evt_" + UUID.randomUUID(),
                kind = "notification",
                from = title.ifBlank { pkg },
                content = content,
                occurredAt = if (sbn.postTime > 0) sbn.postTime else System.currentTimeMillis(),
                simSlot = null,
                callType = null,
                pkg = pkg,
                truncated = truncated,
                queuedAt = System.currentTimeMillis(),
            )
            Log.i("通知捕获 pkg=" + pkg + " content=" + Log.content(content))
            app.scope.launch { app.ws.enqueue(event) }
        } catch (e: Exception) {
            Log.e("通知处理失败", e)
        }
    }

    /**
     * 按「包名 + 内容」在时间窗内去重。
     *
     * 窗口取 5 分钟：验证码类通知不会在 5 分钟内发两条不同的，
     * 而进度条这类更新在几秒内就能刷几十次。
     */
    private fun shouldEmit(pkg: String, content: String): Boolean {
        val key = pkg + SEPARATOR + content
        val now = System.currentTimeMillis()
        synchronized(recent) {
            recent.entries.removeAll { now - it.value > DEDUP_WINDOW_MS }
            if (recent.containsKey(key)) return false
            recent[key] = now
            // 异常情况下防止无限增长
            if (recent.size > 500) recent.clear()
        }
        return true
    }

    companion object {
        private const val DEDUP_WINDOW_MS = 5 * 60 * 1000L
        /** 用空字符分隔，避免包名或内容里恰好含有分隔符导致误判 */
        private const val SEPARATOR = "\u0000"
        private val recent = LinkedHashMap<String, Long>()

        /** 用户是否已在系统设置里授予通知读取权限。 */
        fun isEnabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
            val full = ComponentName(ctx, NotificationCapture::class.java).flattenToString()
            val short = ComponentName(ctx, NotificationCapture::class.java).flattenToShortString()
            return flat.split(":").any { it == full || it == short }
        }

        /**
         * 通知读取属于「特殊访问权限」，无法用运行时权限对话框申请，
         * 只能跳到系统设置页由用户手动打开。
         */
        fun settingsIntent(): Intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
    }
}
