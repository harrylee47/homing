/**
 * 通用 Webhook 渠道。
 *
 * 面向自定义集成：把事件推给用户自己的服务。因为目标地址完全由用户指定，
 * 这是唯一一个会把短信正文发往任意第三方的渠道，默认要求 https。
 */
import { z } from 'zod'
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
})
export type WebhookConfig = z.infer<typeof WebhookConfig>

export const webhookProvider: Provider<WebhookConfig> = {
  type: 'webhook',
  configSchema: WebhookConfig,

  async send(cfg, msg) {
    if (!cfg.allow_insecure && !cfg.url.startsWith('https://')) {
      throw new ProviderError('webhook', '目标地址不是 https，且未显式允许明文', false)
    }

    const res = await fetch(cfg.url, {
      method: cfg.method,
      headers: { 'content-type': 'application/json', ...cfg.headers },
      body: JSON.stringify({
        title: msg.title,
        body: msg.body,
        code: msg.code,
        priority: msg.priority,
        event_id: msg.eventId,
        occurred_at: msg.occurredAt,
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
