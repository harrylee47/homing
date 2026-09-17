import { describe, expect, it } from 'vitest'
import { buildText } from '../providers/telegram.js'
import { clipBytes } from '../providers/types.js'
import type { NotifyMessage } from '../providers/types.js'

/**
 * 正文长度要在**我们这头**收口。
 *
 * 超出对方上限的后果不是「慢一点」，而是 4xx，而 telegram.ts / ntfy.ts 都把
 * 非 429 的 4xx 判成 retryable=false——那条验证码永久丢了，还不会重试。
 * 短信正文上限是 4096（protocol.ts），转义与头部一加就越过 Telegram 的 4096。
 */
const msg = (body: string): NotifyMessage => ({
  kind: 'sms', title: '95533', body,
  sensitive: true, code: '654321', priority: 'high',
  occurredAt: 1_789_000_000_000, eventId: 'evt_x', consoleUrl: null,
  localTime: '2026-09-18 05:00:00',
} as unknown as NotifyMessage)

describe('推送正文按渠道上限收口', () => {
  it('Telegram：4096 个汉字也不超 4096 字符，且 spoiler 标签完整', () => {
    const text = buildText(msg('验'.repeat(4096)), true)
    expect(text.length).toBeLessThanOrEqual(4096)
    // 裁的是标签里面的内容，不是最终串——裁最终串会把闭合标签切掉半截
    expect(text).toContain('<tg-spoiler>')
    expect(text).toContain('</tg-spoiler>')
    expect(text).toContain('已截断')
    // 验证码在最前面，裁尾巴不该碰到它
    expect(text).toContain('🔑 654321')
  })

  it('Telegram：转义会放大长度（一个 & 变五个字符），照样不超', () => {
    const text = buildText(msg('&'.repeat(3000)), true)
    expect(text.length).toBeLessThanOrEqual(4096)
  })

  it('Telegram：短正文一个字都不动', () => {
    const text = buildText(msg('您的验证码是 654321'), true)
    expect(text).toContain('您的验证码是 654321')
    expect(text).not.toContain('已截断')
  })

  it('clipBytes 按字节裁，且不会把一个汉字切成半个', () => {
    const out = clipBytes('验'.repeat(2000), 3800)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(3800)
    // 没有出现替换字符 = 没有切碎多字节序列
    expect(out).not.toContain('�')
    expect(clipBytes('短', 3800)).toBe('短')
  })
})
