/**
 * Web Push 渠道：把通知推到浏览器 / 装到主屏幕的网页 App。
 *
 * 它补的是「人在电脑前」那一段：验证码直接弹在屏幕角上，不用摸手机。
 * 但它**替代不了 Bark 和 ntfy**，两条硬限制写在这里，界面上也要说：
 *
 * ① **通知上没法一键复制验证码。** Service Worker 里没有 navigator.clipboard，
 *    而 Clipboard API 要求文档处于聚焦状态——通知点击事件两个条件都不满足。
 *    只能「点通知 → 打开页面 → 页面去复制」，比 Bark 多两步。
 * ② **Chrome / Firefox 把浏览器完全退出就收不到。** Service Worker 只在
 *    浏览器进程还活着时才会被唤起。macOS Safari 不同，它走 APNs，关掉也能收。
 *
 * VAPID 密钥对存在渠道配置里而不是全局设置里：订阅在创建那一刻就和
 * 当时的公钥绑死了，跟着订阅一起存，将来换密钥时老订阅仍然能用。
 */
import { z } from 'zod'
import { ProviderError, retryAfterMsOf, type Provider } from './types.js'
import { describeFetchError } from '../neterror.js'
import { audienceOf, encryptPayload, signVapid } from '../webpush.js'
import { copyText, deepLink } from './deeplink.js'

export const WebPushConfig = z.object({
  /** 推送服务给的地址，形如 https://fcm.googleapis.com/fcm/send/... */
  endpoint: z.string().url(),
  /** 客户端公钥，base64url 的未压缩 P-256 点 */
  p256dh: z.string().min(80).max(200),
  /** 客户端认证密钥，base64url 的 16 字节 */
  auth: z.string().min(16).max(40),
  /** 这个订阅是在哪台设备上建的，给人看的（如「Mac 上的 Chrome」） */
  label: z.string().max(64).nullish(),
  vapid_public: z.string().min(80).max(200),
  vapid_private: z.string().min(40).max(400),
  /** VAPID 的 sub 声明，必须是 mailto: 或 https: */
  subject: z.string().max(200).default('mailto:admin@localhost'),
})
export type WebPushConfig = z.infer<typeof WebPushConfig>

export const WebPushOptions = z.object({
  /**
   * 点通知跳哪。这里没有「不跳转」的实际意义——Web Push 的通知点了
   * 总要做点什么，不给 url 就只是关掉，等于白响一次。
   */
  deep_link: z.enum(['event', 'compose', 'none']).default('event'),
  /**
   * 正文里是否带上提取出的验证码。
   *
   * 和 Bark / ntfy 的 copy_mode 不是一回事：这里没有剪贴板可用，
   * 只能把码放进通知正文让人**看着抄**。默认开，因为看得见总比点进去强。
   */
  show_code: z.boolean().default(true),
})
export type WebPushOptions = z.infer<typeof WebPushOptions>

/** 推送服务对单条载荷的上限普遍是 4KB，减去加密开销留 3000 字节给正文 */
const MAX_BODY = 3000

export const webpushProvider: Provider<WebPushConfig> = {
  type: 'webpush',
  configSchema: WebPushConfig,

  async send(cfg, msg) {
    const o = WebPushOptions.parse((msg.options?.webpush as unknown) ?? {})

    const title = [msg.title, msg.deviceName, msg.sim].filter(Boolean).join(' · ')
    const code = o.show_code ? copyText(msg, 'code') : null
    const body = (code ? `${code}\n` : '') + msg.body

    const payload = JSON.stringify({
      title,
      body: body.slice(0, MAX_BODY),
      url: deepLink(msg, o.deep_link),
      // tag 让同一个发件人的新通知覆盖旧的，而不是堆一屏
      tag: msg.title || 'homing',
      code,
    })

    const encrypted = await encryptPayload(cfg, payload)
    const jwt = await signVapid(
      { publicKey: cfg.vapid_public, privateKey: cfg.vapid_private },
      audienceOf(cfg.endpoint), cfg.subject,
    )

    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        // TTL=0 会让推送服务「送不到就丢」，而浏览器多半没开着。
        // 给 12 小时：下次打开浏览器还能补收到
        ttl: '43200',
        urgency: msg.priority === 'high' ? 'high' : 'normal',
        authorization: `vapid t=${jwt}, k=${cfg.vapid_public}`,
      },
      body: encrypted.slice().buffer as ArrayBuffer,
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new ProviderError('webpush', `网络错误: ${describeFetchError(e)}`)
    })

    if (res.ok) return

    const detail = await res.text().catch(() => '')
    /**
     * 404 / 410 是「这个订阅已经没了」——用户清了浏览器数据、卸载了主屏 App、
     * 或者换了设备。重试多少次都一样，而且再不说就会一直触发跨渠道告警。
     * 明确写成不可重试，并把话说到人能照着做。
     */
    if (res.status === 404 || res.status === 410) {
      throw new ProviderError(
        'webpush',
        '这个浏览器的订阅已失效（清过浏览器数据、卸载了主屏 App，或换了设备）。' +
        '到「设置 → 浏览器通知」重新订阅一次，然后把这条旧渠道删掉。',
        false,
      )
    }
    throw new ProviderError(
      'webpush', `HTTP ${res.status}: ${detail.slice(0, 200)}`,
      res.status === 429 || res.status >= 500,
      retryAfterMsOf(res, detail),
    )
  },
}
