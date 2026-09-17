package org.smsgateway.agent.util

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.smsgateway.agent.R

/**
 * 把人送到厂商的「自启动管理」页。
 *
 * **这是一道独立于 Android 权限体系的闸。** 清单里声明了 `RECEIVE_BOOT_COMPLETED`
 * 也没用：华为、小米、OPPO、vivo 默认禁止应用开机自启，必须用户自己在系统设置
 * 或「手机管家」里放行。而在这些 ROM 上，它恰恰是决定「重启之后还活不活着」的
 * 那一道——比电池优化白名单更要紧。
 *
 * 和电池优化、通知使用权不同的是：**系统不提供任何查询接口**，我们无从知道用户
 * 到底开没开。所以这颗按钮永远可点、永远不置灰，文案也只能写成「去设置」。
 * 装成能检测的样子比不检测更糟。
 *
 * 组件表 2026-09-18 逐条核过（并行取证 + 对抗复核，16 条里留下 9 条）。
 * 参考了 SmsForwarder（BSD 2-Clause, Copyright (c) 2021 pppscn）的同类实现，
 * 但**没有照抄**——那份表有两处会出事，见下面各自的注释。
 */
object Autostart {

    /**
     * 厂商 → 候选组件（按「越可能存在」排前面）。
     *
     * 写成 `包名/类名`，类名以 `.` 开头表示相对包名——`ComponentName.unflattenFromString`
     * 认这种写法。
     */
    private val TARGETS: Map<String, List<String>> = mapOf(
        // 红米与 POCO 的 Build.MANUFACTURER 报的都是 "Xiaomi"，所以这一条就覆盖了它们，
        // 不需要单列（上游那份表里单列了 redmi/poco，而它的分发是 equals 匹配，
        // 那两行永远不会被命中）。
        //
        // **只留 AutoStartManagementActivity 一条。** 上游表里还有一个
        // PermissionsEditorActivity，那是「单应用权限编辑页」而不是自启动列表，
        // 且必须带 action `miui.intent.action.APP_PERM_EDITOR` 与 extra_pkgname
        // 才能正常打开——直接 setComponent 启动多半白屏，而它一旦「成功」启动，
        // 就把后面真正该走的退路吃掉了。
        "xiaomi" to listOf(
            "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
        ),

        "huawei" to listOf(
            "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager/.appcontrol.activity.StartupAppControlActivity",
            "com.huawei.systemmanager/.optimize.process.ProtectActivity",
        ),

        // **荣耀必须单列。** 独立之后它的 Build.MANUFACTURER 是 "HONOR"、管家包名
        // 换成了 com.hihonor.systemmanager，而上游那份表里根本没有这一项——
        // 于是所有荣耀机走上游的逻辑时一条候选都不会试，直接掉到应用详情页。
        // 2021 年前出厂的老荣耀报的仍是 HUAWEI，由上面那条覆盖；这里把华为那几个
        // 也接在后面，兜住过渡期的机器。
        "honor" to listOf(
            "com.hihonor.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
            "com.hihonor.systemmanager/.appcontrol.activity.StartupAppControlActivity",
            "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
        ),

        // ColorOS 一家。一加从 OxygenOS 12、realme 从 realme UI 3 起都并到 ColorOS 上了，
        // 所以共用同一组候选；跳不到会静默落到退路，代价为零。
        "oppo" to COLOROS,
        "oneplus" to COLOROS,
        "realme" to COLOROS,

        "vivo" to VIVO,
        "iqoo" to VIVO,

        // 三星没有「自启动管理」这个概念，对应的是「后台使用限制 / 不休眠的应用」。
        "samsung" to listOf(
            "com.samsung.android.lool/com.samsung.android.sm.battery.ui.usage.CheckableAppListActivity",
        ),

        "meizu" to listOf(
            "com.meizu.safe/com.meizu.safe.permission.SmartBGActivity",
            "com.meizu.safe/com.meizu.safe.security.AppSecActivity",
        ),
    )

    /** 跳不到具体页面时，退到厂商自己的「手机管家」首页。 */
    private val FALLBACK_PKG: Map<String, String> = mapOf(
        "xiaomi" to "com.miui.securitycenter",
        "huawei" to "com.huawei.systemmanager",
        "honor" to "com.hihonor.systemmanager",
        "oppo" to "com.coloros.phonemanager",
        "oneplus" to "com.coloros.phonemanager",
        "realme" to "com.coloros.phonemanager",
        "vivo" to "com.iqoo.secure",
        "iqoo" to "com.iqoo.secure",
        "meizu" to "com.meizu.safe",
    )

    private val TIPS: Map<String, Int> = mapOf(
        "xiaomi" to R.string.autostart_tip_xiaomi,
        "huawei" to R.string.autostart_tip_huawei,
        "honor" to R.string.autostart_tip_honor,
        "oppo" to R.string.autostart_tip_oppo,
        "oneplus" to R.string.autostart_tip_oppo,
        "realme" to R.string.autostart_tip_oppo,
        "vivo" to R.string.autostart_tip_vivo,
        "iqoo" to R.string.autostart_tip_vivo,
        "samsung" to R.string.autostart_tip_samsung,
        "meizu" to R.string.autostart_tip_meizu,
    )

    private fun vendor(): String = Build.MANUFACTURER.orEmpty().lowercase()

    /** 这台机器该怎么操作。认不出牌子就给通用那句。 */
    fun tip(ctx: Context): String = ctx.getString(TIPS[vendor()] ?: R.string.autostart_tip_generic)

    /**
     * 打开自启动设置。逐级退让，保证**一定**能落到某个页面上。
     *
     * `catch (e: Exception)` 不是偷懒：较新的华为机上启动那个组件抛的是
     * **SecurityException**（`requires com.huawei.permission.external_app_settings.USE_COMPONENT`）
     * 而不是 ActivityNotFoundException——只 catch 后者会让 App 当场崩在用户脸上，
     * 而他做的只是点了一下「去设置」。
     */
    fun open(ctx: Context) {
        val v = vendor()

        for (spec in TARGETS[v].orEmpty()) {
            val cn = ComponentName.unflattenFromString(spec) ?: continue
            if (launch(ctx, Intent().setComponent(cn))) return
        }

        FALLBACK_PKG[v]?.let { pkg ->
            val i = runCatching { ctx.packageManager.getLaunchIntentForPackage(pkg) }.getOrNull()
            if (i != null && launch(ctx, i)) return
        }

        // 原生 / 杂牌 ROM 的通用落点：电池优化的应用列表。它在 AOSP 上一定存在。
        if (launch(ctx, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) return

        // 最后一层：本应用的详情页。到这里为止总有一个能开。
        launch(
            ctx,
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", ctx.packageName, null)),
        )
    }

    private fun launch(ctx: Context, intent: Intent): Boolean = try {
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: ActivityNotFoundException) {
        Log.d("自启动页不存在: ${intent.component ?: intent.action}")
        false
    } catch (e: Exception) {
        // SecurityException（华为）、以及各家 ROM 自定义的各种拒绝
        Log.w("打开自启动页被拒: ${intent.component ?: intent.action} ${e.javaClass.simpleName}")
        false
    }
}

private val COLOROS = listOf(
    "com.coloros.safecenter/com.coloros.safecenter.startupapp.StartupAppListActivity",
    "com.coloros.safecenter/com.coloros.safecenter.permission.startup.StartupAppListActivity",
    "com.coloros.safecenter/com.coloros.privacypermissionsentry.PermissionTopActivity",
    "com.oppo.safe/com.oppo.safe.permission.startup.StartupAppListActivity",
)

private val VIVO = listOf(
    "com.vivo.permissionmanager/com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
    "com.iqoo.secure/com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
    "com.iqoo.secure/com.iqoo.secure.safeguard.PurviewTabActivity",
)
