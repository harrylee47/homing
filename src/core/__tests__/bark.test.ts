import { describe, expect, it } from 'vitest'
import { BarkConfig, BarkOptions, barkProvider, deepLink } from '../providers/bark.js'
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

describe('复制什么 —— copy_mode', () => {
  /** 拦下 fetch，把真正发给 bark-server 的那个 JSON 取出来 */
  const capture = async (options: Record<string, unknown>, over: Partial<NotifyMessage> = {}, cfgOver = {}) => {
    const orig = globalThis.fetch
    let sent: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) }
    }) as unknown as typeof fetch
    try {
      await barkProvider.send(
        { server: 'https://bark.example.com', key: 'k'.repeat(8), ...cfgOver },
        { ...msg(over), options: { bark: options } },
      )
    } finally { globalThis.fetch = orig }
    return sent
  }

  it('默认复制验证码 —— 和加这个字段之前的行为一致', async () => {
    const b = await capture({})
    expect(b.copy).toBe('123456')
    expect(b.autoCopy).toBe(1)
  })

  it('body 模式复制整条正文', async () => {
    const b = await capture({ copy_mode: 'body' })
    expect(b.copy).toBe('验证码 123456')
  })

  it('none 模式什么都不复制', async () => {
    const b = await capture({ copy_mode: 'none' })
    expect(b.copy).toBeUndefined()
    expect(b.autoCopy).toBeUndefined()
  })

  /**
   * 这正是界面要拦的那个死配置：选了复制验证码但规则没开提取，
   * msg.code 是 null，于是 copy 整个不出现——不报错，就是永远复制不到。
   */
  it('code 模式下没提取到码，就整个不带 copy', async () => {
    const b = await capture({ copy_mode: 'code' }, { code: null })
    expect(b.copy).toBeUndefined()
  })

  it('body 模式下正文为空也不带 copy —— 别送一个空剪贴板', async () => {
    const b = await capture({ copy_mode: 'body' }, { body: '' })
    expect(b.copy).toBeUndefined()
  })

  it('关掉自动复制仍然可以长按复制', async () => {
    const b = await capture({ copy_mode: 'body', auto_copy_code: false })
    expect(b.copy).toBe('验证码 123456')
    expect(b.autoCopy).toBeUndefined()
  })
})

describe('通知图标', () => {
  const capture = async (cfgOver: Record<string, unknown>) => {
    const orig = globalThis.fetch
    let sent: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) }
    }) as unknown as typeof fetch
    try {
      await barkProvider.send(
        { server: 'https://bark.example.com', key: 'k'.repeat(8), ...cfgOver } as never,
        { ...msg(), options: { bark: {} } },
      )
    } finally { globalThis.fetch = orig }
    return sent
  }

  it('配了就带上', async () => {
    expect((await capture({ icon: 'https://gw.example.com/icon-192.png' })).icon)
      .toBe('https://gw.example.com/icon-192.png')
  })

  it('没配就不带 —— 不要送一个 undefined 过去', async () => {
    expect('icon' in (await capture({}))).toBe(false)
  })

  it('配置结构允许省略 icon，老渠道不会因为多了这个字段而校验失败', () => {
    const r = BarkConfig.safeParse({ server: 'https://bark.example.com', key: 'k'.repeat(8) })
    expect(r.success).toBe(true)
  })

  it('icon 必须是合法 URL —— 填个文件名是最常见的错法', () => {
    const r = BarkConfig.safeParse({ server: 'https://bark.example.com', key: 'k'.repeat(8), icon: 'logo.png' })
    expect(r.success).toBe(false)
  })
})
