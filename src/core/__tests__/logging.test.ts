import { describe, expect, it } from 'vitest'
import { maskPhone, redact } from '../logging.js'

describe('日志脱敏', () => {
  it('正文只留长度，不泄漏任何片段', () => {
    const out = redact({ content: '您的验证码是 123456' }) as { content: string }
    expect(out.content).not.toContain('123456')
    expect(out.content).toMatch(/^<\d+ chars>$/)
  })

  it('token 类字段整体替换', () => {
    const out = redact({ token: 'abc', bot_token: 'x', password: 'y' }) as Record<string, string>
    expect(Object.values(out)).toEqual(['<redacted>', '<redacted>', '<redacted>'])
  })

  it('号码保留头尾便于辨认来源', () => {
    expect(maskPhone('13800138000')).toBe('138******00')
    expect(maskPhone('95533')).toBe('*****')
  })

  it('递归处理嵌套结构与数组', () => {
    const out = redact({ a: [{ content: 'hello' }] }) as { a: { content: string }[] }
    expect(out.a[0]!.content).toBe('<5 chars>')
  })
})
