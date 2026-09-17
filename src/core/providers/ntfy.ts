/**
 * ntfy 渠道。
 *
 * 存在的理由只有一条：**Bark 只有 iPhone**，而「通知栏直接看到验证码、
 * 点一下就复制」这个体验是这个项目日常体感最重的一处。安卓用户在此之前
 * 没有任何一条通道能做到——Telegram 必须打码（明文转发验证码会被封），
 * Webhook 要自己写接收端。
 *
 * ntfy 的 `copy` 动作按钮是这条通道成立的关键：点一下把验证码进剪贴板，
 * 不用打开任何 App。官方文档注明它只在**安卓 App 与网页版**的通知列表里
 * 出现，桌面浏览器通知里没有——这正好覆盖我们要补的那块。
 *
 * ⚠️ 主题名就是凭证。公共实例 ntfy.sh 上，**任何知道主题名的人都能订阅它**，
 * 没有别的门。所以主题名必须当口令看待（界面上会替用户生成一个长随机串），
 * 能自建就自建，或者用受保护的主题加 token。
 */
import { z } from 'zod'
import { ProviderError, type Provider } from './types.js'
import { copyText, deepLink } from './deeplink.js'

export const NtfyConfig = z.object({
  /** 服务端地址。公共实例是 https://ntfy.sh，自建填自己的 */
  server: z.string().url().default('https://ntfy.sh'),
  /**
   * 主题名。**这就是这条通道的全部凭证**——公共实例上谁知道它谁就能收你的短信。
   * 限制字符集与 ntfy 一致（字母数字加 - 和 _），并要求足够长。
   */
  topic: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, '主题名需 8–64 位，只能用字母、数字、- 和 _'),
  /** 受保护主题的访问令牌（tk_ 开头）。公共开放主题留空 */
  token: z.string().max(200).nullish(),
  /**
   * 通知图标，**JPEG / PNG 的公网地址**，SVG 不认。
   * 和 Bark 同样的道理：去取图的是用户的手机，不是服务端。
   */
  icon: z.string().url().max(500).nullish(),
})
export type NtfyConfig = z.infer<typeof NtfyConfig>

/** ntfy 的五档优先级。4/5 会震动并弹出，1/2 安静地躺在通知栏里 */
export const NTFY_PRIORITY = { min: 1, low: 2, default: 3, high: 4, max: 5 } as const

export const NtfyOptions = z.object({
  /**
   * max 会长震动并弹出横幅，是 ntfy 这边对应「穿透」的那一档。
   * 默认 default：普通通知行为，与 Bark 的 active 对齐。
   */
  priority: z.enum(['min', 'low', 'default', 'high', 'max']).default('default'),
  /** 标签。ntfy 会把已知的 emoji 名渲染成 emoji 缀在标题前 */
  tags: z.array(z.string().max(32)).max(5).default([]),
  /** 点「复制」按钮时复制什么。语义与 Bark 的同名字段一致 */
  copy_mode: z.enum(['code', 'body', 'none']).default('code'),
  /** 点击通知跳转：event=事件详情，compose=预填回复，none=不跳转 */
  deep_link: z.enum(['event', 'compose', 'none']).default('event'),
})
export type NtfyOptions = z.infer<typeof NtfyOptions>

/** 动作按钮最多 3 个，超出 ntfy 会整条拒收 */
const MAX_ACTIONS = 3

export const ntfyProvider: Provider<NtfyConfig> = {
  type: 'ntfy',
  configSchema: NtfyConfig,

  async send(cfg, msg) {
    const o = NtfyOptions.parse((msg.options?.ntfy as unknown) ?? {})

    // 标题是「谁发来的」，正文只放内容——与 Bark 同一条排版规则。
    // 归属信息缀在标题后面，通知栏里正文那几行要留给内容本身
    const title = [msg.title, msg.deviceName, msg.sim].filter(Boolean).join(' · ')

    // high 优先级的规则统一再升一档：银行验证码半夜也得响。
    // 与 bark.ts 的 active→timeSensitive 是同一个判断
    const priority = msg.priority === 'high' && o.priority === 'default'
      ? NTFY_PRIORITY.max
      : NTFY_PRIORITY[o.priority]

    const actions: Record<string, unknown>[] = []
    const copy = copyText(msg, o.copy_mode)
    if (copy) {
      // 这个按钮就是这条通道存在的理由，所以排第一个——
      // ntfy 最多显示 3 个，排在后面可能被挤掉
      actions.push({ action: 'copy', label: msg.code ? '复制验证码' : '复制内容', value: copy })
    }
    const url = deepLink(msg, o.deep_link)
    if (url) actions.push({ action: 'view', label: '在控制台打开', url, clear: false })

    const body: Record<string, unknown> = {
      topic: cfg.topic,
      title,
      message: msg.body,
      priority,
      ...(o.tags.length ? { tags: o.tags } : {}),
      // click 与 view 按钮指向同一处：点通知本体和点按钮都该去那儿
      ...(url ? { click: url } : {}),
      ...(cfg.icon ? { icon: cfg.icon } : {}),
      ...(actions.length ? { actions: actions.slice(0, MAX_ACTIONS) } : {}),
    }

    const res = await fetch(cfg.server.replace(/\/$/, ''), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new ProviderError('ntfy', `网络错误: ${String(e)}`)
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderError(
        'ntfy', `HTTP ${res.status}: ${detail.slice(0, 200)}`,
        // 4xx 是配置错（主题名非法、token 不对），重试多少次都一样
        res.status === 429 || res.status >= 500,
      )
    }
  },
}
