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
import androidx.core.content.ContextCompat
import android.text.Editable
import android.text.TextWatcher
import android.content.pm.PackageManager
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.smsgateway.agent.net.PairPayload
import org.smsgateway.agent.net.PairingClient
import org.smsgateway.agent.notification.NotificationCapture
import org.smsgateway.agent.App
import org.smsgateway.agent.BuildConfig
import org.smsgateway.agent.R
import org.smsgateway.agent.databinding.ActivityMainBinding
import org.smsgateway.agent.net.ConnState
import org.smsgateway.agent.net.label
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 唯一的界面（计划 §4.4）：状态 + 配对 + 几个权限入口。
 *
 * 配对首选扫码：手打一个 wss 地址加一串区分大小写的配对码，
 * 是整个接入流程里最容易打错的一步。手工填写保留为退路
 * （没有摄像头、扫不出来、或者用模拟器时）。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var vb: ActivityMainBinding

    /**
     * 最近一次渲染用的状态。
     *
     * 权限授予完之后要立刻重画（「还差 N 项」得当场变），但那几个回调拿不到
     * ws.state 的当前值——StateFlow 的收集在 lifecycleScope 里，只在状态变化时
     * 才推一次。存一份最近值，回调里原样重画即可。
     */
    private var lastState: ConnState = ConnState.Idle
    private var lastPending: Int = 0

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val denied = result.filterValues { !it }.keys
        if (denied.isEmpty()) toast("权限已全部授予")
        else toast("以下权限被拒绝：${denied.joinToString { it.substringAfterLast('.') }}")
        // 前台定位到手之后才谈得上后台定位，见 requestBackgroundLocation()
        requestBackgroundLocation()
        render(lastState, lastPending)
    }

    /** 单独申请后台定位的那一次。结果只用来刷新界面上那一行状态。 */
    private val bgLocLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { render(lastState, lastPending) }

    /** 扫码结果。内容格式见服务端 api.ts 的 pairPayload。 */
    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult   // 用户取消
        val p = PairPayload.parse(text)
        if (p == null) {
            toast("这不是配对二维码")
            return@registerForActivityResult
        }
        // 先让人看清要连到哪：扫错一个码，这台手机之后收到的每一条验证码
        // 都会发给别人。这一次确认的成本远小于那个后果。
        AlertDialog.Builder(this)
            .setTitle("确认配对")
            .setMessage("将把这台手机接入：\n\n${p.url}\n\n之后收到的短信、来电、通知都会上报到这个地址。")
            .setPositiveButton("配对") { _, _ ->
                vb.urlInput.setText(p.url)
                vb.codeInput.setText(p.code)
                pair()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private val cameraPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) launchScanner() else toast("没有摄像头权限，只能手动填写")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vb = ActivityMainBinding.inflate(layoutInflater)
        setContentView(vb.root)

        val app = App.get()
        vb.urlInput.setText(app.prefs.serverUrl ?: "")

        // 版本号缀在作者那一行后面。这台手机常年放在角落，真出问题时
        // 找到它的人（可能是几年后的自己）第一件事就是「这是哪个版本」
        vb.aboutText.text = "${getString(R.string.about_line)} · v${BuildConfig.VERSION_NAME}"

        vb.scanButton.setOnClickListener { scan() }
        // 二维码内容粘进地址框也认：同一台手机上打开控制台时，复制比扫码更顺手。
        //
        // 只认「一次插入一大段」，不是每敲一个字都去试着解析——
        // 逐字输入时会在配对码只到一半的时候就匹配成功，把输入框改掉，
        // 剩下的字符继续落在后面，结果两个框里都是半截内容。
        vb.urlInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun afterTextChanged(s: Editable?) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                if (count < PASTE_MIN_CHARS) return
                val p = PairPayload.find(s?.toString()) ?: return
                vb.urlInput.post {
                    vb.urlInput.setText(p.url)
                    vb.urlInput.setSelection(p.url.length)
                    vb.codeInput.setText(p.code)
                    toast("已识别配对信息，确认后点「配对」")
                }
            }
        })
        vb.pairButton.setOnClickListener { pair() }
        vb.unpairButton.setOnClickListener { unpair() }
        vb.permButton.setOnClickListener {
            // 前台那批齐了就直接去要后台定位，否则先要前台（回调里会接着要后台）
            if (missingPermCount() == 0) requestBackgroundLocation() else requestPerms()
        }
        vb.batteryButton.setOnClickListener { requestBatteryWhitelist() }
        vb.notifyButton.setOnClickListener { requestNotificationAccess() }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(app.ws.state, app.ws.pendingCount) { s, p -> s to p }
                    .collect { (s, p) -> render(s, p) }
            }
        }
    }

    private fun render(s: ConnState, pending: Int) {
        lastState = s
        lastPending = pending
        val paired = App.get().prefs.isPaired
        vb.pairingBox.visibility = if (paired) android.view.View.GONE else android.view.View.VISIBLE
        vb.unpairButton.visibility = if (paired) android.view.View.VISIBLE else android.view.View.GONE

        val fmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
        /*
         * 文案走 ConnState.label()，和常驻通知是同一份——两处各写一份必然漂移，
         * 而漂移的那一半是锁屏上那条，不会有人主动去核对。
         *
         * 颜色按控制台那张语义表来（style.css）：
         * 成功/在线 = 薄荷，失败/吊销 = 粉，中间态 = 黄，未开始 = 卡片底。
         */
        vb.statusText.text = s.label(App.get().prefs.isPaired)
        val chip = when (s) {
            is ConnState.Connected -> R.color.brand_mint
            is ConnState.Fatal -> R.color.brand_pink
            is ConnState.Connecting, is ConnState.Waiting -> R.color.brand_yellow
            is ConnState.Idle -> R.color.brand_bg
        }
        (vb.statusText.background as? android.graphics.drawable.GradientDrawable)
            ?.setColor(ContextCompat.getColor(this, chip))
        vb.detailText.text = buildString {
            val p = App.get().prefs
            if (paired) {
                appendLine("设备：${p.deviceName}")
                appendLine("服务端：${p.serverUrl}")
            }
            when (s) {
                is ConnState.Connected -> appendLine("连接于 ${fmt.format(Date(s.since))}")
                is ConnState.Fatal -> appendLine(s.message)
                else -> {}
            }
            appendLine("待补传：$pending 条")
            appendLine("电池：${batteryText()}")
        }

        /*
         * 三项「还没办的事」的状态**写在按钮自己身上**，不写在上面那段详情里。
         *
         * 原来「通知使用权：未授予」在页面第二块，而对应的按钮在最底下，
         * 中间隔着分隔线、扫码按钮、两个输入框和配对按钮——读到「未授予」的人
         * 要滚下去，在三颗长得一模一样的满宽按钮里找对应的那一颗。
         *
         * 更要紧的是「申请权限」管的那一整组（短信、通话、电话状态、定位…）
         * 原来**一行状态都没有**，而「短信权限没给全」恰恰是「收不到验证码」的
         * 头号原因——用户在界面上完全看不出来，只能盲点一次按钮看系统弹不弹框。
         *
         * 办完的置灰：它已经不是一件待办了，但留着能回答「这项到底给没给」。
         */
        val missing = missingPermCount()
        // 后台定位不在 requiredPerms 里（它必须单独申请），但它属于同一类
        // 「不授予就静默失效」的东西，得一起算进「还差几项」
        val bgLocMissing = if (hasForegroundLocation() && !hasBackgroundLocation()) 1 else 0
        val todo = missing + bgLocMissing
        vb.permButton.text = when {
            todo == 0 -> "采集权限 · 已全部授予"
            bgLocMissing == 1 && missing == 0 -> "定位还差「始终允许」"
            else -> "申请权限 · 还差 $todo 项"
        }
        vb.permButton.isEnabled = todo > 0

        val notifyOk = NotificationCapture.isEnabled(this@MainActivity)
        vb.notifyButton.text = if (notifyOk) "通知使用权 · 已授予" else "授予通知使用权 · 未授予"
        vb.notifyButton.isEnabled = !notifyOk

        val batteryOk = isIgnoringBattery()
        vb.batteryButton.text = if (batteryOk) "电池优化白名单 · 已加入" else "加入电池优化白名单 · 未加入"
        vb.batteryButton.isEnabled = !batteryOk
    }

    private fun scan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchScanner()
        } else {
            cameraPermLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchScanner() {
        scanLauncher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("对准控制台「设备」页生成的二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
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
                    toast("配对成功：${r.data.deviceName}")
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

    /**
     * 要申请的那一组运行时权限。**申请和查状态共用这一份。**
     *
     * 分两处写的话，哪天加了一项只会加到其中一处，而漏掉的那一处是静默的：
     * 界面报「已全部授予」而实际少一项，表现就是某一类消息从来不来。
     */
    private fun requiredPerms(): List<String> {
        val perms = mutableListOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            // 设备找回用。不授予也不影响短信转发，只是定位功能不可用
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION,
        )
        // 后台定位必须单独申请，且系统要求先拿到前台定位权限。
        // 放在同一批里申请会被系统直接拒绝。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms += Manifest.permission.POST_NOTIFICATIONS
        }
        // 双卡的本机号码尾号。API 30 起才是独立权限，之前包含在 READ_PHONE_STATE 里
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            perms += Manifest.permission.READ_PHONE_NUMBERS
        }
        return perms
    }

    /** 还差几项没给。0 就是齐了。 */
    private fun missingPermCount(): Int = requiredPerms().count {
        ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }

    private fun requestPerms() {
        permLauncher.launch(requiredPerms().toTypedArray())
    }

    /** 后台定位拿到了吗。API 29 以下没有这个权限，前台定位就够。 */
    private fun hasBackgroundLocation(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasForegroundLocation(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * 后台定位。**必须单独申请，而且必须在前台定位到手之后。**
     *
     * 清单里一直声明着 ACCESS_BACKGROUND_LOCATION，但运行时一次都没申请过——
     * 于是 Android 10 起「查找设备」必然失败：网关平时就在后台，系统什么都不返回，
     * requestLocationUpdates 一个回调都不来、getLastKnownLocation 全是 null，
     * 25 秒后报「定位超时且无缓存位置」——CLAUDE.md「定位」那一节点名的、
     * 极易被误判成硬件问题的那个表现，就是这么来的。
     *
     * 两段路径不一样：
     *  - API 29：系统还会弹对话框，直接单独 launch 一次（混在一批里会被直接拒）。
     *  - API 30+：系统不再弹，requestPermissions 会自动拒绝，只能把人送去设置页
     *    自己选「始终允许」。
     */
    private fun requestBackgroundLocation() {
        if (hasBackgroundLocation() || !hasForegroundLocation()) return
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
            bgLocLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            return
        }
        AlertDialog.Builder(this)
            .setTitle("还差「始终允许」定位")
            .setMessage(
                "「查找设备」要在网关后台运行时也能定位，而这一项系统不让 App 弹窗申请，" +
                    "只能你手动改：设置页 → 权限 → 位置 → 选「始终允许」。\n\n" +
                    "不改也不影响短信转发，只是手机丢了的时候定不到位。",
            )
            .setPositiveButton("去设置") { _, _ ->
                // 部分 ROM 没有这个 Intent，崩在这里比不跳转糟得多
                runCatching {
                    startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:$packageName"),
                        ),
                    )
                }.onFailure { toast("这台机器打不开应用设置页，请手动去系统设置里改") }
            }
            .setNegativeButton("以后再说", null)
            .show()
    }

    /** 界面上直观显示电量与充电状态，插没插上一眼可见。 */
    private fun batteryText(): String {
        val bm = getSystemService(android.os.BatteryManager::class.java) ?: return "未知"
        val level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = runCatching { bm.isCharging }.getOrDefault(false)
        return "$level%${if (charging) " · 充电中" else " · 未充电"}"
    }

    /**
     * 通知使用权属于「特殊访问权限」，没有运行时权限对话框，
     * 只能跳到系统设置页由用户手动打开。
     */
    private fun requestNotificationAccess() {
        if (NotificationCapture.isEnabled(this)) {
            toast("已经授予了")
            return
        }
        runCatching { startActivity(NotificationCapture.settingsIntent()) }
            .onSuccess { toast("在列表里找到「短信网关」并打开") }
            .onFailure { toast("此设备不支持直接跳转，请到系统设置 → 通知使用权 手动开启") }
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

    private companion object {
        /** 一次插入这么多字符只可能是粘贴；配对内容本身有 60 字符上下 */
        const val PASTE_MIN_CHARS = 20
    }
}
