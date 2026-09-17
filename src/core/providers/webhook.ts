/**
 * 通用 Webhook 渠道。
 *
 * 面向自定义集成：把事件推给用户自己的服务。因为目标地址完全由用户指定，
 * 这是唯一一个会把短信正文发往任意第三方的渠道，默认要求 https。
 */
import { z } from 'zod'
import { checkWebhookTarget } from '../ssrf.js'
import { ProviderError, type Provider } from './types.js'

export const WebhookConfig = z.object({
  url: z.string().url(),
  method: z.enum(['POST', 'PUT']).default('POST'),
  /** 自定义请求头，如签名或鉴权 */
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * 允许明文 http。默认禁止：正文里有验证码，走明文等于公开广播。
   * 仅在目标是内网地址且用户明确知情时才该打开。
   */
  allow_insecure: z.boolean().default(false),
  /**
   * 允许指向内网 / 回环地址。**只有管理员能开**（api 层判角色）。
   *
   * 不设这道闸的话，任何注册进来的人都拿到了一个「让服务器替我访问它自己
   * 内网」的原语：云元数据接口、只监听回环的管理端口、同机的数据库端口。
   * 而接收端就在同一台机器上确实是常见需求，所以不是禁死，是收归管理员。
   */
  allow_private: z.boolean().default(false),
})
export type WebhookConfig = z.infer<typeof WebhookConfig>

export const webhookProvider: Provider<WebhookConfig> = {
  type: 'webhook',
  configSchema: WebhookConfig,

  async send(cfg, msg) {
    if (!cfg.allow_insecure && !cfg.url.startsWith('https://')) {
      throw new ProviderError('webhook', '目标地址不是 https，且未显式允许明文', false)
    }
    // 保存时已经判过一次，这里再判一次：配置可能是老版本写进去的，
    // 而这一层是真正发起请求的地方——防护要贴着动作放，不能只放在入口
    const bad = checkWebhookTarget(cfg.url, cfg.allow_private)
    if (bad) throw new ProviderError('webhook', bad, false)

    const res = await fetch(cfg.url, {
      method: cfg.method,
      headers: { 'content-type': 'application/json', ...cfg.headers },
      body: JSON.stringify({
        title: msg.title,
        body: msg.body,
        code: msg.code,
        priority: msg.priority,
        event_id: msg.eventId,
        kind: msg.kind ?? null,
        direction: msg.direction ?? null,
        device: msg.deviceName ?? null,
        sim: msg.sim ?? null,
        occurred_at: msg.occurredAt,
        /** 已按用户时区格式化，省得下游再猜服务端时区 */
        occurred_at_local: msg.localTime ?? null,
        console_url: msg.consoleUrl ?? null,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new ProviderError('webhook', `网络错误: ${String(e)}`)
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderError(
        'webhook', `HTTP ${res.status}: ${detail.slice(0, 200)}`,
        res.status === 429 || res.status >= 500,
      )
    }
  },
}
