import { describe, expect, it } from 'vitest'
import { describeFetchError } from '../neterror.js'

/**
 * 这个函数存在的理由是一次真实故障：生产上 Telegram 每分钟失败一两次，
 * 日志里只有 "TypeError: fetch failed"，看着像链路抖动，查了两个小时。
 * 真正的答案一直在 cause.errors[] 里躺着，只是被 String(e) 丢掉了。
 */
describe('把 fetch 失败的真正原因挖出来', () => {
  it('多地址失败：逐个地址都要带上，因为「哪个族失败」才是答案', () => {
    const e = new TypeError('fetch failed')
    // Node 在 autoSelectFamily 下抛的就是这个形状
    ;(e as { cause?: unknown }).cause = Object.assign(
      new AggregateError([], ''),
      {
        code: 'ETIMEDOUT',
        errors: [
          { code: 'ETIMEDOUT', address: '149.154.166.110' },
          { code: 'ENETUNREACH', address: '2001:67c:4e8:f004::9' },
        ],
      },
    )
    const s = describeFetchError(e)
    expect(s).toContain('ETIMEDOUT/149.154.166.110')
    // 这一串是「一眼看出是 IPv6 出口问题」的全部信息
    expect(s).toContain('ENETUNREACH/2001:67c:4e8:f004::9')
  })

  it('单地址失败：cause.code', () => {
    const e = new TypeError('fetch failed')
    ;(e as { cause?: unknown }).cause = { code: 'ENOTFOUND' }
    expect(describeFetchError(e)).toContain('ENOTFOUND')
  })

  it('同一个 code 不重复打', () => {
    const e = new TypeError('fetch failed')
    ;(e as { cause?: unknown }).cause = { code: 'ECONNREFUSED', errors: [{ code: 'ECONNREFUSED' }] }
    expect(describeFetchError(e).match(/ECONNREFUSED/g)).toHaveLength(1)
  })

  it('超时没有 cause —— 不能因为取不到就把唯一的信息也抹掉', () => {
    // AbortSignal.timeout 拒绝的是 TimeoutError，它没有 cause
    const e = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const s = describeFetchError(e)
    expect(s).toContain('TimeoutError')
    expect(s).toContain('timeout')
  })

  it('不是 Error 的投掷值也不能炸', () => {
    expect(describeFetchError('boom')).toBe('boom')
    expect(describeFetchError(null)).toBe('null')
  })
})
