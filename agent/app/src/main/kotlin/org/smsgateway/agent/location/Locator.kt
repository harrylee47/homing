package org.smsgateway.agent.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import org.smsgateway.agent.util.Log

/**
 * 按需定位，用于设备找回。
 *
 * 只在服务端下发 get_location 时执行一次，**不做持续定位** ——
 * 持续 GPS 会显著耗电，而这台机器本来就在跟电量较劲，
 * 而且「查找设备」这个需求本身就是低频的。
 *
 * 用系统的 LocationManager 而不是 Google Play 服务的 FusedLocationProvider：
 * 目标机是白牌 ROM，未必装了 GMS，依赖它等于赌运气。
 */
class Locator(private val ctx: Context) {

    data class Result(
        val lat: Double, val lng: Double, val accuracy: Float?,
        val provider: String, val time: Long, val cached: Boolean,
    )

    fun interface Callback {
        fun onResult(result: Result?, error: String?)
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /**
     * @param timeoutMs 实时定位的等待上限。超时后退回最后已知位置——
     *                  有个几分钟前的旧位置，也比什么都没有强。
     */
    @SuppressLint("MissingPermission")
    fun locate(timeoutMs: Long = 25_000, cb: Callback) {
        if (!hasPermission()) {
            cb.onResult(null, "未授予定位权限")
            return
        }
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (lm == null) {
            cb.onResult(null, "无法获取 LocationManager")
            return
        }

        val cached = lastKnown(lm)
        val enabled = runCatching { lm.getProviders(true) }.getOrDefault(emptyList())
        val providers = enabled.filter {
            it == LocationManager.GPS_PROVIDER || it == LocationManager.NETWORK_PROVIDER
        }
        // 用 info 级：部分 ROM（含目标机的白牌 ROM）会过滤掉 debug 日志，
        // 排查定位问题时看不到就等于没写
        Log.i("定位诊断 可用provider=${enabled.joinToString(",")} 将请求=${providers.joinToString(",")} 有缓存=${cached != null}")
        if (providers.isEmpty()) {
            // 定位服务整体关闭时也把缓存位置给出去，聊胜于无
            if (cached != null) cb.onResult(cached.copy(cached = true), null)
            else cb.onResult(null, "定位服务未开启")
            return
        }

        val handler = Handler(Looper.getMainLooper())
        var done = false
        val listeners = mutableListOf<LocationListener>()

        val finish = { r: Result?, err: String? ->
            if (!done) {
                done = true
                for (l in listeners) runCatching { lm.removeUpdates(l) }
                cb.onResult(r, err)
            }
        }

        for (p in providers) {
            val listener = object : LocationListener {
                override fun onLocationChanged(loc: Location) {
                    finish(loc.toResult(cached = false), null)
                }
                // 老版本 Android 的抽象方法，不实现会在部分 ROM 上崩
                @Deprecated("Deprecated in Java")
                override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
                override fun onProviderEnabled(provider: String) {}
                override fun onProviderDisabled(provider: String) {}
            }
            listeners.add(listener)
            runCatching { lm.requestLocationUpdates(p, 0L, 0f, listener, Looper.getMainLooper()) }
                .onFailure { Log.w("请求定位更新失败 provider=$p: ${it.message}") }
        }

        handler.postDelayed({
            if (cached != null) finish(cached.copy(cached = true), null)
            else finish(null, "定位超时且无缓存位置")
        }, timeoutMs)
    }

    /**
     * 取各 provider 里最新的一个已知位置。
     *
     * **逐个 provider 容错**：部分 ROM 上对 fused / passive 调用
     * getLastKnownLocation 会抛异常，如果把整个链条包在一个 runCatching 里，
     * 一个 provider 抛异常就会让所有缓存位置一起丢掉——实测就踩到了这个。
     */
    @SuppressLint("MissingPermission")
    private fun lastKnown(lm: LocationManager): Result? {
        val all = runCatching { lm.getProviders(true) }.getOrDefault(emptyList())
        var best: Location? = null
        for (p in all) {
            val loc = runCatching { lm.getLastKnownLocation(p) }
                .onFailure { Log.i("读取 $p 的缓存位置失败: ${it.message}") }
                .getOrNull() ?: continue
            if (best == null || loc.time > best!!.time) best = loc
        }
        return best?.toResult(cached = true)
    }

    private fun Location.toResult(cached: Boolean) = Result(
        lat = latitude, lng = longitude,
        accuracy = if (hasAccuracy()) accuracy else null,
        provider = provider ?: "unknown", time = time, cached = cached,
    )
}
