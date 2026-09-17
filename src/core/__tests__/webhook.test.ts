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

/**
 * 重定向：SSRF 校验必须贴着**每一跳**，不能只校验第一个 URL。
 *
 * fetch 默认 follow，最多跟 20 跳；填一个自己控制的公网地址、让它 302 到
 * 169.254.169.254，这道闸就等于不存在——不需要控制 DNS、不需要卡时序。
 */
describe('Webhook 的重定向', () => {
  const withFetch = async (impl: typeof fetch, fn: () => Promise<unknown>) => {
    const real = globalThis.fetch
    globalThis.fetch = impl
    try { return await fn() } finally { globalThis.fetch = real }
  }
  const redirectTo = (loc: string, status = 302) =>
    new Response(null, { status, headers: { location: loc } })

  it('重定向到内网地址被拒，且不可重试', async () => {
    const cfg = WebhookConfig.parse({ url: 'https://example.com/hook' })
    const seen: string[] = []
    await withFetch(
      (async (u: string | URL | Request) => {
        seen.push(String(u))
        return redirectTo('http://169.254.169.254/latest/meta-data/')
      }) as unknown as typeof fetch,
      async () => {
        await expect(webhookProvider.send(cfg, msg)).rejects.toThrow(/重定向/)
      },
    )
    // 关键：内网那一跳**没有被真的请求出去**
    expect(seen).toEqual(['https://example.com/hook'])
  })

  it('重定向降级到 http 被拒 —— allow_insecure 同样不能只管第一跳', async () => {
    const cfg = WebhookConfig.parse({ url: 'https://example.com/hook' })
    await withFetch(
      (async () => redirectTo('http://example.com/hook')) as unknown as typeof fetch,
      async () => {
        await expect(webhookProvider.send(cfg, msg)).rejects.toThrow(/非 https/)
      },
    )
  })

  it('重定向到另一个公网 https 地址，正常跟过去', async () => {
    const cfg = WebhookConfig.parse({ url: 'https://example.com/hook' })
    const seen: string[] = []
    await withFetch(
      (async (u: string | URL | Request) => {
        seen.push(String(u))
        return seen.length === 1 ? redirectTo('https://elsewhere.example/hook2') : new Response('ok')
      }) as unknown as typeof fetch,
      async () => { await webhookProvider.send(cfg, msg) },
    )
    expect(seen).toEqual(['https://example.com/hook', 'https://elsewhere.example/hook2'])
  })

  it('无限重定向环在上限处停下', async () => {
    const cfg = WebhookConfig.parse({ url: 'https://example.com/hook' })
    let n = 0
    await withFetch(
      (async () => { n++; return redirectTo('https://example.com/hook') }) as unknown as typeof fetch,
      async () => { await expect(webhookProvider.send(cfg, msg)).rejects.toThrow(/超过/) },
    )
    expect(n).toBeLessThanOrEqual(4)
  })
})

/**
 * 目标服务器的响应体会被拼进 ProviderError.message，而那条 message 会进
 * audit_log、跨渠道告警正文（alert:true，Telegram **不加 spoiler**）、
 * 控制台的渠道测试报错、以及 stdout。很多框架会在 4xx 里回显收到的 payload——
 * 而我们的 payload 里就有短信正文和验证码。
 */
describe('Webhook 的错误详情不得回流短信正文', () => {
  const sms: NotifyMessage = {
    title: '95533', body: '您的验证码是 493021，5 分钟内有效', priority: 'high',
    code: '493021', eventId: 'e', occurredAt: 0,
  }
  const withFetch = async (impl: typeof fetch, fn: () => Promise<unknown>) => {
    const real = globalThis.fetch
    globalThis.fetch = impl
    try { return await fn() } finally { globalThis.fetch = real }
  }

  it('响应里回显的正文与验证码被抹掉', async () => {
    const cfg = WebhookConfig.parse({ url: 'https://example.com/hook' })
    await withFetch(
      (async (_u: unknown, init?: RequestInit) =>
        // 模拟「把收到的 payload 原样回显」的框架
        new Response(`400 Bad Request: ${String(init?.body)}`, { status: 400 })) as unknown as typeof fetch,
      async () => {
        const e = await webhookProvider.send(cfg, sms).catch((x: Error) => x)
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).message).not.toContain('493021')
        expect((e as Error).message).not.toContain('您的验证码是')
        expect((e as Error).message).toContain('<已抹去>')
      },
    )
  })

  it('正常的错误详情仍然留着 —— 否则配错了就没线索了', async () => {
    const cfg = WebhookConfig.parse({ url: 'https://example.com/hook' })
    await withFetch(
      (async () => new Response('{"errcode":93000,"errmsg":"invalid webhook url"}', { status: 400 })) as unknown as typeof fetch,
      async () => {
        const e = await webhookProvider.send(cfg, sms).catch((x: Error) => x)
        expect((e as Error).message).toContain('invalid webhook url')
      },
    )
  })
})
