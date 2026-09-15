import { describe, expect, it } from 'vitest'
import { WebhookConfig, webhookProvider } from '../providers/webhook.js'
import type { NotifyMessage } from '../providers/types.js'

const msg: NotifyMessage = {
  title: '95533', body: 'x', priority: 'normal',
  code: null, eventId: 'e', occurredAt: 0,
}

describe('Webhook', () => {
  it('默认禁止明文 http —— 正文里有验证码', async () => {
    const cfg = WebhookConfig.parse({ url: 'http://example.com/hook' })
    await expect(webhookProvider.send(cfg, msg)).rejects.toThrow(/不是 https/)
  })

  it('明文失败不可重试（重试多少次都一样）', async () => {
    const cfg = WebhookConfig.parse({ url: 'http://example.com/hook' })
    await webhookProvider.send(cfg, msg).catch((e) => {
      expect(e.retryable).toBe(false)
    })
  })

  it('显式允许后放行明文', () => {
    const cfg = WebhookConfig.parse({ url: 'http://10.0.0.5/hook', allow_insecure: true })
    expect(cfg.allow_insecure).toBe(true)
  })

  it('非法 URL 被拒', () => {
    expect(WebhookConfig.safeParse({ url: 'not-a-url' }).success).toBe(false)
  })

  it('默认方法为 POST，请求头为空', () => {
    const cfg = WebhookConfig.parse({ url: 'https://example.com/h' })
    expect(cfg.method).toBe('POST')
    expect(cfg.headers).toEqual({})
  })
})
