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
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import org.smsgateway.agent.net.PairPayload
import org.smsgateway.agent.notification.NotificationCapture
import android.app.KeyguardManager
import androidx.core.view.isVisible
import org.smsgateway.agent.App
import org.smsgateway.agent.util.Autostart
import org.smsgateway.agent.PairPhase
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
        if (denied.isEmpty()) toast(getString(R.string.toast_perms_all))
        else toast(getString(R.string.toast_perms_denied, denied.joinToString { it.substringAfterLast('.') }))
        // 前台定位到手之后才谈得上后台定位，见 requestBackgroundLocation()
        requestBackgroundLocation()
        // 权限刚到手：两个内容观察器是在 onCreate 里启动的，那时候一个权限
        // 都没有，而授权不会重启进程——不在这里补一次，去电与已发送短信
        // 就永远不会被捕获，且一声不吭
        App.get().startObservers()
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
            toast(getString(R.string.toast_not_pair_qr))
            return@registerForActivityResult
        }
        // 先让人看清要连到哪：扫错一个码，这台手机之后收到的每一条验证码
        // 都会发给别人。这一次确认的成本远小于那个后果。
        AlertDialog.Builder(this)
            .setTitle(R.string.dlg_pair_title)
            .setMessage(getString(R.string.dlg_pair_msg, p.url))
            .setPositiveButton(R.string.btn_pair) { _, _ ->
                vb.urlInput.setText(p.url)
                vb.codeInput.setText(p.code)
                pair()
            }
            .setNegativeButton(R.string.btn_cancel, null)
            .show()
    }

    private val cameraPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) launchScanner() else toast(getString(R.string.toast_no_camera))
    }

    /**
     * 回到前台时补启动两个内容观察器。
     *
     * 权限不一定是在这个界面里给的：通知使用权要跳去系统设置、后台定位在
     * Android 11+ 也会被丢到设置页里，两者都不会回调 permLauncher。
     * onResume 是唯一能可靠察觉「他刚在外面把权限给上了」的时机，
     * 而两个 start() 都是幂等的，白调一次没有代价。
     */
    override fun onResume() {
        super.onResume()
        App.get().startObservers()
        /*
         * **回到前台必须重画一次。**
         *
         * 这一页上有四样东西是在**别处**被改变的：运行时权限、通知使用权、
         * 电池优化白名单、以及锁屏凭证——用户都是跳去系统设置里改完再回来的，
         * 一个回调都不会给我们。不在这里重画，他改完回来看到的还是旧状态，
         * 会以为自己没改成功，然后再点一遍。
         *
         * 锁屏那条尤其要紧：它是「这台机器能不能无人值守」的答案，
         * 而用户看到它之后第一件事多半就是去把锁屏关掉。
         */
        render(lastState, lastPending)
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
                    toast(getString(R.string.toast_qr_ok))
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
        vb.autostartButton.setOnClickListener { Autostart.open(this) }
        vb.notifyButton.setOnClickListener { requestNotificationAccess() }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(app.ws.state, app.ws.pendingCount) { s, p -> s to p }
                    .collect { (s, p) -> render(s, p) }
            }
        }

        /*
         * 配对状态单独订阅。界面重建之后重新收到的是**当前**阶段，
         * 所以「配对中…」在转屏之后仍然是「配对中…」，而不是复位成「配对」。
         */
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.pairPhase.collect { phase ->
                    vb.pairButton.isEnabled = phase !is PairPhase.Running
                    vb.pairButton.setText(if (phase is PairPhase.Running) R.string.btn_pairing else R.string.btn_pair)
                    if (phase is PairPhase.Done) {
                        toast(phase.message)
                        // 配对码用过即弃，不留在界面上
                        if (phase.ok) vb.codeInput.setText("")
                        render(lastState, lastPending)
                        app.consumePairResult()
                    }
                }
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
        vb.statusText.text = s.label(this, App.get().prefs.isPaired)
        val chip = when (s) {
            is ConnState.Connected -> R.color.brand_mint
            is ConnState.Fatal -> R.color.brand_pink
            // 会一直重试，但要人动手才好得了——按失败色标，不能和「正在连」混为一谈
            is ConnState.Blocked -> R.color.brand_pink
            is ConnState.Connecting, is ConnState.Waiting -> R.color.brand_yellow
            is ConnState.Idle -> R.color.brand_bg
        }
        (vb.statusText.background as? android.graphics.drawable.GradientDrawable)
            ?.setColor(ContextCompat.getColor(this, chip))
        vb.detailText.text = buildString {
            val p = App.get().prefs
            if (paired) {
                appendLine(getString(R.string.detail_device, p.deviceName))
                appendLine(getString(R.string.detail_server, p.serverUrl))
            }
            when (s) {
                is ConnState.Connected -> appendLine(getString(R.string.detail_connected_at, fmt.format(Date(s.since))))
                is ConnState.Fatal -> appendLine(s.message)
                else -> {}
            }
            appendLine(getString(R.string.detail_pending, pending))
            appendLine(getString(R.string.detail_battery, batteryText()))
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
            todo == 0 -> getString(R.string.perms_all_granted)
            bgLocMissing == 1 && missing == 0 -> getString(R.string.perms_loc_always)
            else -> getString(R.string.perms_missing, todo)
        }
        vb.permButton.isEnabled = todo > 0

        val notifyOk = NotificationCapture.isEnabled(this@MainActivity)
        vb.notifyButton.setText(if (notifyOk) R.string.notify_granted else R.string.notify_missing)
        vb.notifyButton.isEnabled = !notifyOk

        val batteryOk = isIgnoringBattery()
        vb.batteryButton.setText(if (batteryOk) R.string.battery_ok else R.string.battery_missing)
        vb.batteryButton.isEnabled = !batteryOk

        // 厂商自启动：系统不给查询接口，所以永远可点、永远不置灰。
        // 提示按机型给，认不出的机型给通用那句。
        vb.autostartTip.text = Autostart.tip(this)

        /*
         * **做不到的事要说出来。**
         *
         * 设了锁屏凭证的机器，重启后在有人解锁之前收不到任何短信——这不是我们的
         * 实现问题：Android 把解锁前到达的 SMS_RECEIVED 整个押到解锁之后才派发
         * （2026-09-18 在 Android 14 上实测过，directBootAware 也绕不开，
         * 连直接查 content://sms 都因为它走 CE 路径而抛异常）。
         *
         * 所以这里只能如实讲代价和两条出路。每次 onResume 都重算：
         * 用户可能刚在设置里把锁屏加上或去掉，而那正是这条提示该跟着变的时刻。
         */
        val km = getSystemService(KeyguardManager::class.java)
        vb.rebootWarn.isVisible = km?.isDeviceSecure == true
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
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                // 不传 setOrientationLocked：默认 true，CaptureManager 会在打开那一刻
                // 把方向钉住，扫码途中转屏不会重建。方向本身由清单里那条
                // fullUser 决定（库清单默认是 sensorLandscape，见 AndroidManifest）
        )
    }

    /** 用一次性配对码换长期凭证。凭证由服务端生成，本机不产生也不显示。 */
    private fun pair() {
        val url = vb.urlInput.text.toString().trim()
        val code = vb.codeInput.text.toString().trim()
        if (url.isEmpty() || code.isEmpty()) {
            toast(getString(R.string.toast_need_both))
            return
        }
        if (!url.startsWith("wss://") && !url.startsWith("ws://")) {
            toast(getString(R.string.toast_need_wss))
            return
        }
        if (url.startsWith("ws://")) toast(getString(R.string.toast_ws_plain))

        /*
         * 只发起，不等结果——请求跑在 App 的进程作用域上。
         *
         * 原来它挂在 lifecycleScope 上：配对途中转一次屏，Activity 销毁、协程取消、
         * token 丢掉，而服务端那一侧配对码已经用掉了（一次性）。用户看到的只是
         * 按钮从「配对中…」复位，然后拿同一个码重试得到「配对码无效」。
         * 理由与落盘顺序写在 App.startPairing。
         */
        App.get().startPairing(url, code)
    }

    private fun unpair() {
        val app = App.get()
        app.ws.stop()
        app.prefs.clear()
        toast(getString(R.string.toast_unpaired))
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
            .setTitle(R.string.bgloc_title)
            .setMessage(R.string.bgloc_msg)
            .setPositiveButton(R.string.btn_open_settings) { _, _ ->
                // 部分 ROM 没有这个 Intent，崩在这里比不跳转糟得多
                runCatching {
                    startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:$packageName"),
                        ),
                    )
                }.onFailure { toast(getString(R.string.toast_no_settings)) }
            }
            .setNegativeButton(R.string.btn_later, null)
            .show()
    }

    /** 界面上直观显示电量与充电状态，插没插上一眼可见。 */
    private fun batteryText(): String {
        val bm = getSystemService(android.os.BatteryManager::class.java) ?: return getString(R.string.battery_unknown)
        val level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = runCatching { bm.isCharging }.getOrDefault(false)
        return getString(
            R.string.battery_line, level,
            getString(if (charging) R.string.battery_charging else R.string.battery_not_charging),
        )
    }

    /**
     * 通知使用权属于「特殊访问权限」，没有运行时权限对话框，
     * 只能跳到系统设置页由用户手动打开。
     */
    private fun requestNotificationAccess() {
        if (NotificationCapture.isEnabled(this)) {
            toast(getString(R.string.toast_already_granted))
            return
        }
        runCatching { startActivity(NotificationCapture.settingsIntent()) }
            .onSuccess { toast(getString(R.string.toast_find_in_list)) }
            .onFailure { toast(getString(R.string.toast_no_jump_notify)) }
    }

    private fun isIgnoringBattery(): Boolean {
        val pm = getSystemService(PowerManager::class.java) ?: return false
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryWhitelist() {
        if (isIgnoringBattery()) {
            toast(getString(R.string.toast_already_whitelisted))
            return
        }
        runCatching {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName")),
            )
        }.onFailure { toast(getString(R.string.toast_no_jump_battery)) }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private companion object {
        /** 一次插入这么多字符只可能是粘贴；配对内容本身有 60 字符上下 */
        const val PASTE_MIN_CHARS = 20
    }
}
