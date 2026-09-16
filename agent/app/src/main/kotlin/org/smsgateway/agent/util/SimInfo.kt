package org.smsgateway.agent.util

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager

/**
 * 一张 SIM 卡。
 *
 * `slot` 是**卡槽序号**（0 = SIM1），不是 subscriptionId。两者极易混淆：
 * subscriptionId 是系统给每张卡发的自增号，重新插拔卡会变大，
 * 在双卡机上常见 1 和 2，也可能是 4、5——直接当卡槽用，
 * SIM1 会被显示成「SIM2」，而且大于 3 时会被整个丢掉。
 */
data class SimCard(
    val slot: Int,
    /** 运营商名。取不到就 null，不要编「未知运营商」 */
    val carrier: String?,
    /** 用户在系统设置里给这张卡起的名字，多数 ROM 默认就是运营商名 */
    val label: String?,
    /**
     * 本机号码的后 4 位。
     *
     * 只取尾号：它足以让人认出「这是哪张卡」，而完整号码是 PII，
     * 且 net_json 这一列并不加密。运营商多数不写号码，取不到是常态。
     */
    val tail: String?,
    /** 这张卡的信号格数 0–4，API 28+ 才有 */
    val signal: Int?,
    /** 是否是系统的默认短信卡 */
    val defaultSms: Boolean,
    /** 是否是当前上网用的数据卡 */
    val defaultData: Boolean,
) {
    /** 「SIM1 · 中国移动 · 尾号 1234」，给短信指令和日志用。 */
    fun describe(): String = buildString {
        append("SIM").append(slot + 1)
        val name = carrier ?: label
        if (!name.isNullOrBlank()) append(" · ").append(name)
        if (tail != null) append(" · 尾号 ").append(tail)
        if (signal != null) append(" · 信号 ").append(signal).append("/4")
    }
}

object SimInfo {

    /**
     * 当前插着的卡。没权限、单卡、读失败都返回空列表——
     * 空列表的意思是「不知道」，界面据此退回到不显示卡槽，而不是显示 0 张卡。
     */
    @SuppressLint("MissingPermission")
    fun read(ctx: Context): List<SimCard> = runCatching {
        val sm = ctx.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
        val list = sm.activeSubscriptionInfoList ?: return emptyList()
        val defaultSms = runCatching { SubscriptionManager.getDefaultSmsSubscriptionId() }.getOrDefault(-1)
        val defaultData = runCatching { SubscriptionManager.getDefaultDataSubscriptionId() }.getOrDefault(-1)

        list.filter { it.simSlotIndex in 0..3 }
            .sortedBy { it.simSlotIndex }
            .map { info ->
                SimCard(
                    slot = info.simSlotIndex,
                    carrier = info.carrierName?.toString()?.trim()?.takeIf { it.isNotEmpty() },
                    label = info.displayName?.toString()?.trim()?.takeIf { it.isNotEmpty() },
                    tail = tailOf(ctx, info.subscriptionId, @Suppress("DEPRECATION") info.number),
                    signal = signalOf(ctx, info.subscriptionId),
                    defaultSms = info.subscriptionId == defaultSms,
                    defaultData = info.subscriptionId == defaultData,
                )
            }
    }.getOrElse {
        Log.w("读取 SIM 卡信息失败：${it.message}")
        emptyList()
    }

    /**
     * subscriptionId → 卡槽序号。
     *
     * 短信广播、短信库的 sub_id 列、通话记录的 phone_account_id 给的都是
     * subscriptionId，全都要经过这一步才能当卡槽用。
     */
    @SuppressLint("MissingPermission")
    fun slotOfSub(ctx: Context, subId: Int): Int? {
        if (subId < 0) return null
        return runCatching {
            ctx.getSystemService(SubscriptionManager::class.java)
                ?.getActiveSubscriptionInfo(subId)?.simSlotIndex?.takeIf { it in 0..3 }
        }.getOrNull()
    }

    /**
     * 通话记录的 `phone_account_id` → 卡槽序号。
     *
     * 这一列是字符串，多数 ROM 写的是 subscriptionId，也有写 iccid 的
     * （长串数字，当 subId 用会得到一个不存在的卡）。所以只认短数字，
     * 其余一律当作不知道——把电话记到错的卡上比不记更糟。
     */
    fun slotOfAccount(ctx: Context, accountId: String?): Int? {
        val id = accountId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val sub = id.toIntOrNull() ?: return null
        return slotOfSub(ctx, sub)
    }

    /** 号码取不到是常态：多数运营商根本没把号码写进卡里。 */
    @SuppressLint("MissingPermission")
    private fun tailOf(ctx: Context, subId: Int, fallback: String?): String? {
        val raw = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ctx.getSystemService(SubscriptionManager::class.java)?.getPhoneNumber(subId)
            } else {
                null
            }
        }.getOrNull()?.takeIf { it.isNotBlank() } ?: fallback

        val digits = raw?.filter { it.isDigit() } ?: return null
        return if (digits.length >= 4) digits.takeLast(4) else null
    }

    /**
     * 每张卡各自的信号。
     *
     * 单卡时 NetStatus 已经给了一个总的信号格数，但双卡下那个值只代表其中一张，
     * 而「另一张卡没信号」恰恰是收不到验证码的原因。
     */
    @SuppressLint("MissingPermission")
    private fun signalOf(ctx: Context, subId: Int): Int? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
        return runCatching {
            ctx.getSystemService(TelephonyManager::class.java)
                ?.createForSubscriptionId(subId)?.signalStrength?.level?.coerceIn(0, 4)
        }.getOrNull()
    }
}
