import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { dispatch, registerProvider, type ChannelConfig } from '../notifier.js'
import { ProviderError, retryAfterMsOf, type NotifyMessage, type Provider } from '../providers/types.js'

describe('从响应里读「等多久再来」', () => {
  const res = (h: Record<string, string>) => new Response(null, { headers: h })

  it('Retry-After 的秒数写法', () => {
    expect(retryAfterMsOf(res({ 'retry-after': '30' }))).toBe(30_000)
  })

  it('Retry-After 的 HTTP 日期写法', () => {
    const at = new Date(Date.now() + 20_000).toUTCString()
    const ms = retryAfterMsOf(res({ 'retry-after': at }))!
    expect(ms).toBeGreaterThan(15_000)
    expect(ms).toBeLessThan(25_000)
  })

  /** Telegram 不发 Retry-After 头，秒数只在响应体的 parameters.retry_after 里 */
  it('Telegram 的 parameters.retry_after', () => {
    const body = '{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":17}}'
    expect(retryAfterMsOf(res({}), body)).toBe(17_000)
  })

  it('读不出来就返回 null —— 猜一个数比不猜更糟', () => {
    expect(retryAfterMsOf(res({}))).toBeNull()
    expect(retryAfterMsOf(res({ 'retry-after': 'not-a-number' }))).toBeNull()
    expect(retryAfterMsOf(res({}), '这不是 JSON')).toBeNull()
  })
})

/**
 * 限流时按对方说的等，不按自己那套 1s/2s 指数退避。
 *
 * 原来三次尝试全落在 3 秒窗口里，而限流方要的是几十秒——
 * 「重试了三次」听着很努力，实际一次都没等够。
 */
describe('429 限流', () => {
  const msg: NotifyMessage = {
    title: 't', body: 'b', priority: 'normal', code: null, eventId: 'e', occurredAt: 0,
  }
  const ch = (type: string): ChannelConfig =>
    ({ id: 'c1', type, name: 'c1', config: {}, enabled: true })

  it('对方说等多久就等多久，比自己的退避长时以对方为准', async () => {
    const waits: number[] = []
    let last = Date.now()
    const p: Provider<Record<string, never>> = {
      type: 'ra1', configSchema: z.object({}),
      async send() {
        const now = Date.now()
        waits.push(now - last)
        last = now
        throw new ProviderError('ra1', 'HTTP 429', true, 120)
      },
    }
    registerProvider(p as unknown as Provider<never>)
    // 自己的退避基数设成 1ms，所以任何等待都只可能来自 retry_after
    await dispatch([ch('ra1')], msg, { retryBaseMs: 1 })
    expect(waits).toHaveLength(3)
    expect(waits[1]).toBeGreaterThanOrEqual(100)
    expect(waits[2]).toBeGreaterThanOrEqual(100)
  })

  it('对方要等太久就不重试了，别把整条推送队列压住', async () => {
    let n = 0
    const p: Provider<Record<string, never>> = {
      type: 'ra2', configSchema: z.object({}),
      async send() { n++; throw new ProviderError('ra2', 'HTTP 429', true, 5000) },
    }
    registerProvider(p as unknown as Provider<never>)
    const r = await dispatch([ch('ra2')], msg, { retryBaseMs: 1, maxRetryAfterMs: 200 })
    expect(n).toBe(1)
    expect(r[0]!.ok).toBe(false)
  })

  it('对方没说等多久，仍走自己的指数退避', async () => {
    let n = 0
    const p: Provider<Record<string, never>> = {
      type: 'ra3', configSchema: z.object({}),
      async send() { n++; throw new ProviderError('ra3', 'HTTP 500', true) },
    }
    registerProvider(p as unknown as Provider<never>)
    await dispatch([ch('ra3')], msg, { retryBaseMs: 1 })
    expect(n).toBe(3)
  })
})
