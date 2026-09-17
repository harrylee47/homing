/**
 * Bark 渠道（自建 bark-server，计划 §11.3）。
 *
 * Bark 是自托管的，没有 Telegram 那种「转发验证码即封禁」的风险，
 * 所以验证码可以直接放进标题与剪贴板 —— 这是整套系统日常体感提升最大的
 * 一处：常见场景下用户根本不需要打开任何 App，长按通知即可复制验证码。
 *
 * 注意自建的只是服务端，推送通道仍走 Apple APNs；开源版内置推送凭证，
 * 不需要自备证书。
 */
import { z } from 'zod'
import { clipBytes, ProviderError, retryAfterMsOf, type Provider } from './types.js'
import { describeFetchError } from '../neterror.js'
import { copyText, deepLink } from './deeplink.js'

// 深链与「复制什么」和 ntfy 共用一份实现，见 deeplink.ts。
// 这里再导出一次是为了不打断既有的 import 路径
export { deepLink } from './deeplink.js'

export const BarkConfig = z.object({
  /** 自建服务端地址，如 https://bark.example.com */
  server: z.string().url(),
  /** 设备 key，由 Bark App 生成 */
  key: z.string().min(4).max(128),
  /**
   * 通知左侧的小图标，一个公网可达的 **PNG/JPEG** 地址。
   *
   * 三件事要知道：
   * ① **不能给 SVG**。iOS 的通知附件不认，表现是图标位置空着，没有任何报错。
   *    网关自己那张在 `/icon-192.png`（由 web/logo.svg 栅格化而来）。
   * ② 取图的是**用户的 iPhone**，不是服务端。所以地址必须从公网够得到，
   *    填内网地址会静默失败。
   * ③ 它配在渠道上而不是规则上：这是「这条推送来自哪台网关」，
   *    一台网关只有一个身份。随消息类型变化的东西（级别、分组、复制什么）
   *    才配在规则的 action 里。
   */
  icon: z.string().url().max(500).nullish(),
})
export type BarkConfig = z.infer<typeof BarkConfig>

/** 规则里可配的 Bark 专属字段（计划 §11.3）。 */
export const BarkOptions = z.object({
  /**
   * timeSensitive 可穿透专注模式；passive 不亮屏，用于低优先级。
   * 默认 active：普通通知行为。
   */
  level: z.enum(['critical', 'timeSensitive', 'active', 'passive']).default('active'),
  /** 按发件人分组，通知中心不会糊成一片 */
  group: z.string().max(64).nullish(),
  /**
   * 长按通知时复制什么。
   *
   * - `code` 复制提取出的验证码，**要求同一条规则也开了 extract_code**。
   *   只开这个不开那个，是个不报错的死配置：没有码可复制，
   *   Bark 请求里连 copy 字段都不会出现。界面上会拦这种组合。
   * - `body` 复制整条正文。快递单号、取件码、一次性口令这类
   *   「不是 4-8 位数字、但你就是想要那串字」的场景靠它。
   * - `none` 不复制。
   *
   * 默认 code：这是改这个字段之前的行为，老规则升级后表现不变。
   */
  copy_mode: z.enum(['code', 'body', 'none']).default('code'),
  /** 自动复制（部分 iOS 版本上不用长按，通知到达即进剪贴板） */
  auto_copy_code: z.boolean().default(true),
  /** 点击通知跳转：event=事件详情，compose=预填回复，none=不跳转 */
  deep_link: z.enum(['event', 'compose', 'none']).default('event'),
})
export type BarkOptions = z.infer<typeof BarkOptions>

export const barkProvider: Provider<BarkConfig> = {
  type: 'bark',
  configSchema: BarkConfig,

  async send(cfg, msg) {
    const o = BarkOptions.parse((msg.options?.bark as unknown) ?? {})

    // 多设备时把设备名并进分组：Bark 的通知中心按 group 分栏，
    // 这样两张卡的消息不会混在一起
    const group = msg.deviceName
      ? (o.group ? `${o.group} · ${msg.deviceName}` : msg.deviceName)
      : (o.group ?? undefined)

    // 标题是「谁发来的」，正文只放内容。
    // 归属信息缀在标题后面而不是塞进正文——通知栏里正文那几行要留给内容本身，
    // 开头先来一遍号码等于把最该看的挤下去。
    const from = [msg.title, msg.deviceName, msg.sim].filter(Boolean).join(' · ')

    const body: Record<string, unknown> = {
      title: from,
      // APNs 单条载荷 4KB，超了 Bark 服务端会直接拒掉（不可重试）
      body: clipBytes(msg.body, 3500),
      // high 的规则统一升级为可穿透专注模式：银行验证码半夜也得响
      level: msg.priority === 'high' && o.level === 'active' ? 'timeSensitive' : o.level,
      group,
      isArchive: 1,
    }

    // copy 指定长按通知时复制的内容；autoCopy 在部分 iOS 版本上可直接进剪贴板。
    // code 模式下没提取到码就整个不带 copy——宁可不复制，也不要让人长按之后
    // 粘出来一整条「【建设银行】您尾号…」。
    const copy = copyText(msg, o.copy_mode)
    if (copy) {
      body.copy = copy
      if (o.auto_copy_code) body.autoCopy = 1
    }

    // 图标由用户的 iPhone 去取，服务端只是把地址转述过去
    if (cfg.icon) body.icon = cfg.icon

    const url = deepLink(msg, o.deep_link)
    if (url) body.url = url

    const res = await fetch(`${cfg.server.replace(/\/$/, '')}/${encodeURIComponent(cfg.key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new ProviderError('bark', `网络错误: ${describeFetchError(e)}`)
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderError(
        'bark', `HTTP ${res.status}: ${detail.slice(0, 200)}`,
        res.status === 429 || res.status >= 500,
        retryAfterMsOf(res, detail),
      )
    }
  },
}
