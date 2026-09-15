import { describe, expect, it } from 'vitest'
import { BarkOptions, deepLink } from '../providers/bark.js'
import type { NotifyMessage } from '../providers/types.js'

const msg = (o: Partial<NotifyMessage> = {}): NotifyMessage => ({
  title: '95533', body: '验证码 123456', priority: 'normal',
  code: '123456', eventId: 'evt_abc', occurredAt: 0,
  consoleUrl: 'https://gw.example.com', ...o,
})

describe('Bark 深链', () => {
  it('event 模式指向事件详情', () => {
    expect(deepLink(msg(), 'event')).toBe('https://gw.example.com/events/evt_abc')
  })

  it('compose 模式预填收件人与来源', () => {
    expect(deepLink(msg(), 'compose'))
      .toBe('https://gw.example.com/compose?to=95533&ref=evt_abc')
  })

  it('none 模式不生成链接', () => {
    expect(deepLink(msg(), 'none')).toBeNull()
  })

  it('未配置控制台地址时不带链接', () => {
    expect(deepLink(msg({ consoleUrl: null }), 'event')).toBeNull()
  })

  it('尾部斜杠不会产生双斜杠', () => {
    expect(deepLink(msg({ consoleUrl: 'https://gw.example.com/' }), 'event'))
      .toBe('https://gw.example.com/events/evt_abc')
  })

  it('号码中的特殊字符被转义', () => {
    expect(deepLink(msg({ title: '+86 138' }), 'compose')).toContain('to=%2B86%20138')
  })
})

describe('Bark 选项默认值', () => {
  it('默认自动复制验证码并跳转事件详情', () => {
    const o = BarkOptions.parse({})
    expect(o.auto_copy_code).toBe(true)
    expect(o.deep_link).toBe('event')
    expect(o.level).toBe('active')
  })

  it('level 只接受 Bark 支持的取值', () => {
    expect(BarkOptions.safeParse({ level: 'urgent' }).success).toBe(false)
    expect(BarkOptions.safeParse({ level: 'timeSensitive' }).success).toBe(true)
  })
})

describe('Bark 多设备', () => {
  it('设备名并进标题与分组，通知中心按设备分栏', async () => {
    let captured: Record<string, unknown> | null = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      captured = JSON.parse(init!.body!) as Record<string, unknown>
      return { ok: true, status: 200 } as Response
    }) as typeof fetch

    const { barkProvider } = await import('../providers/bark.js')
    await barkProvider.send(
      { server: 'https://b.example.com', key: 'k' },
      { ...msg(), deviceName: 'JP-01', options: { bark: { group: '验证码' } } },
    )
    globalThis.fetch = originalFetch

    expect(captured!.title).toBe('95533 · JP-01')
    expect(captured!.group).toBe('验证码 · JP-01')
  })

  it('无设备名时标题与分组保持原样', async () => {
    let captured: Record<string, unknown> | null = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      captured = JSON.parse(init!.body!) as Record<string, unknown>
      return { ok: true, status: 200 } as Response
    }) as typeof fetch

    const { barkProvider } = await import('../providers/bark.js')
    await barkProvider.send(
      { server: 'https://b.example.com', key: 'k' },
      { ...msg(), deviceName: null, options: { bark: { group: '验证码' } } },
    )
    globalThis.fetch = originalFetch

    expect(captured!.title).toBe('95533')
    expect(captured!.group).toBe('验证码')
  })
})
