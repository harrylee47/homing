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
import { ProviderError, type NotifyMessage, type Provider } from './types.js'

export const BarkConfig = z.object({
  /** 自建服务端地址，如 https://bark.example.com */
  server: z.string().url(),
  /** 设备 key，由 Bark App 生成 */
  key: z.string().min(4).max(128),
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
  /** 自动把验证码复制到剪贴板 */
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

    const body: Record<string, unknown> = {
      title: msg.deviceName ? `${msg.title} · ${msg.deviceName}` : msg.title,
      body: msg.body,
      // high 的规则统一升级为可穿透专注模式：银行验证码半夜也得响
      level: msg.priority === 'high' && o.level === 'active' ? 'timeSensitive' : o.level,
      group,
      isArchive: 1,
    }

    // copy 指定长按通知时复制的内容；autoCopy 在部分 iOS 版本上可直接进剪贴板。
    // 有验证码就只复制验证码——复制整条短信没有意义。
    if (msg.code) {
      body.copy = msg.code
      if (o.auto_copy_code) body.autoCopy = 1
    }

    const url = deepLink(msg, o.deep_link)
    if (url) body.url = url

    const res = await fetch(`${cfg.server.replace(/\/$/, '')}/${encodeURIComponent(cfg.key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new ProviderError('bark', `网络错误: ${String(e)}`)
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderError(
        'bark', `HTTP ${res.status}: ${detail.slice(0, 200)}`,
        res.status === 429 || res.status >= 500,
      )
    }
  },
}

/** 深链指向控制台。没有配 GW_BASE_URL 时不带 url，通知点击就只是展开。 */
export function deepLink(msg: NotifyMessage, mode: BarkOptions['deep_link']): string | null {
  if (mode === 'none' || !msg.consoleUrl) return null
  const base = msg.consoleUrl.replace(/\/$/, '')
  if (mode === 'compose') {
    return `${base}/compose?to=${encodeURIComponent(msg.title)}&ref=${encodeURIComponent(msg.eventId)}`
  }
  return msg.eventId ? `${base}/events/${encodeURIComponent(msg.eventId)}` : base
}
