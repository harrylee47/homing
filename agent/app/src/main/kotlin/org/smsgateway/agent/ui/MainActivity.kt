package org.smsgateway.agent.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.smsgateway.agent.net.PairingClient
import org.smsgateway.agent.App
import org.smsgateway.agent.databinding.ActivityMainBinding
import org.smsgateway.agent.net.ConnState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 唯一的界面（计划 §4.4）：状态 + 配对信息 + 两个权限入口。
 *
 * 配对暂时是手工填写。M1 上线扫码配对后，这三个输入框会被二维码扫描替代。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var vb: ActivityMainBinding

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val denied = result.filterValues { !it }.keys
        if (denied.isEmpty()) toast("权限已全部授予")
        else toast("以下权限被拒绝：${denied.joinToString { it.substringAfterLast('.') }}")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vb = ActivityMainBinding.inflate(layoutInflater)
        setContentView(vb.root)

        val app = App.get()
        vb.urlInput.setText(app.prefs.serverUrl ?: "")

        vb.pairButton.setOnClickListener { pair() }
        vb.unpairButton.setOnClickListener { unpair() }
        vb.permButton.setOnClickListener { requestPerms() }
        vb.batteryButton.setOnClickListener { requestBatteryWhitelist() }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(app.ws.state, app.ws.pendingCount) { s, p -> s to p }
                    .collect { (s, p) -> render(s, p) }
            }
        }
    }

    private fun render(s: ConnState, pending: Int) {
        val paired = App.get().prefs.isPaired
        vb.pairingBox.visibility = if (paired) android.view.View.GONE else android.view.View.VISIBLE
        vb.unpairButton.visibility = if (paired) android.view.View.VISIBLE else android.view.View.GONE

        val fmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
        vb.statusText.text = when (s) {
            is ConnState.Idle -> if (App.get().prefs.isPaired) "● 未连接" else "○ 未配对"
            is ConnState.Connecting -> "◌ 连接中…"
            is ConnState.Connected -> "● 已连接"
            is ConnState.Waiting -> "◌ 等待重连（${s.retryInSec}s）"
            is ConnState.Fatal -> "✕ ${s.code}"
        }
        vb.detailText.text = buildString {
            val p = App.get().prefs
            if (paired) {
                appendLine("设备：\${p.deviceName}")
                appendLine("服务端：\${p.serverUrl}")
            }
            when (s) {
                is ConnState.Connected -> appendLine("连接于 ${fmt.format(Date(s.since))}")
                is ConnState.Fatal -> appendLine(s.message)
                else -> {}
            }
            appendLine("待补传：$pending 条")
            appendLine("电池优化白名单：${if (isIgnoringBattery()) "已加入" else "未加入"}")
        }
    }

    /** 用一次性配对码换长期凭证。凭证由服务端生成，本机不产生也不显示。 */
    private fun pair() {
        val url = vb.urlInput.text.toString().trim()
        val code = vb.codeInput.text.toString().trim()
        if (url.isEmpty() || code.isEmpty()) {
            toast("地址与配对码都要填")
            return
        }
        if (!url.startsWith("wss://") && !url.startsWith("ws://")) {
            toast("地址必须以 wss:// 开头")
            return
        }
        if (url.startsWith("ws://")) toast("警告：ws:// 为明文传输")

        vb.pairButton.isEnabled = false
        vb.pairButton.text = "配对中…"

        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { PairingClient().pair(url, code) }
            vb.pairButton.isEnabled = true
            vb.pairButton.text = "配对"

            when (r) {
                is PairingClient.Result.Fail -> toast(r.message)
                is PairingClient.Result.Ok -> {
                    val app = App.get()
                    app.prefs.serverUrl = url
                    app.prefs.deviceId = r.data.deviceId
                    app.prefs.token = r.data.token
                    app.prefs.deviceName = r.data.deviceName
                    vb.codeInput.setText("")   // 配对码用过即弃，不留在界面上
                    app.ws.stop()
                    app.ws.start()
                    toast("配对成功：\${r.data.deviceName}")
                }
            }
        }
    }

    private fun unpair() {
        val app = App.get()
        app.ws.stop()
        app.prefs.clear()
        toast("已解除配对")
        render(ConnState.Idle, 0)
    }

    private fun requestPerms() {
        val perms = mutableListOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms += Manifest.permission.POST_NOTIFICATIONS
        }
        permLauncher.launch(perms.toTypedArray())
    }

    private fun isIgnoringBattery(): Boolean {
        val pm = getSystemService(PowerManager::class.java) ?: return false
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryWhitelist() {
        if (isIgnoringBattery()) {
            toast("已经在白名单里了")
            return
        }
        runCatching {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName")),
            )
        }.onFailure { toast("此设备不支持直接跳转，请到系统设置手动添加") }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
