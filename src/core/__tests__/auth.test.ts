import { describe, expect, it } from 'vitest'
import {
  base32Decode, base32Encode, currentTotp, generateSessionToken,
  generateTotpSecret, hashPassword, totpUri, validatePassword, verifyPassword, verifyTotp,
} from '../auth.js'

describe('口令强度', () => {
  it.each([
    ['abc12345', '英文 + 数字'],
    ['abcd!@#$', '英文 + 符号'],
    ['1234!@#$', '数字 + 符号'],
    ['Passw0rd!', '三类都有'],
    ['密码abc123', '非 ASCII 计入符号类'],
  ])('接受 %s（%s）', (pw) => {
    expect(validatePassword(pw).ok).toBe(true)
  })

  it.each([
    ['abc123', '太短'],
    ['a1', '太短'],
    ['', '空'],
  ])('拒绝 %s（%s）', (pw) => {
    const r = validatePassword(pw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('8 位')
  })

  it.each([
    ['abcdefgh', '纯英文'],
    ['12345678', '纯数字'],
    ['!@#$%^&*', '纯符号'],
  ])('拒绝 %s（%s，只有一类）', (pw) => {
    const r = validatePassword(pw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('两类')
  })

  it('恰好 8 位且两类即通过', () => {
    expect(validatePassword('abcdefg1').ok).toBe(true)
  })
})

describe('口令', () => {
  it('哈希可验证', async () => {
    const h = await hashPassword('correct horse battery staple')
    expect(verifyPassword('correct horse battery staple', h)).toBe(true)
    expect(verifyPassword('wrong', h)).toBe(false)
  })

  it('相同口令两次哈希不同（盐随机）', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'))
  })

  it('哈希里内嵌参数，便于将来调参而不失效', async () => {
    expect(await hashPassword('x')).toMatch(/^argon2id\$2\$19456\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  })

  it('格式损坏的哈希返回 false 而不抛异常', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false)
    expect(verifyPassword('x', 'argon2id$2$19456$1$zz$zz')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
  })

  it('空口令也能哈希验证（是否允许空由上层决定）', async () => {
    const h = await hashPassword('')
    expect(verifyPassword('', h)).toBe(true)
    expect(verifyPassword('a', h)).toBe(false)
  })
})

describe('base32', () => {
  it('编解码往返', () => {
    for (const len of [1, 5, 10, 20]) {
      const b = crypto.getRandomValues(new Uint8Array(len))
      expect([...base32Decode(base32Encode(b))]).toEqual([...b])
    }
  })

  it('解码忽略大小写与空格', () => {
    const s = base32Encode(new Uint8Array([1, 2, 3, 4, 5]))
    expect([...base32Decode(s.toLowerCase())]).toEqual([...base32Decode(s)])
  })

  it('非法字符抛异常', () => {
    expect(() => base32Decode('1890')).toThrow()
  })
})

describe('TOTP', () => {
  it('同一时间窗内验证通过', async () => {
    const s = generateTotpSecret()
    const code = await currentTotp(s)
    expect(await verifyTotp(s, code)).toBe(true)
  })

  it('容忍 ±30 秒时钟漂移', async () => {
    const s = generateTotpSecret()
    const now = 1_757_894_400_000
    const code = await currentTotp(s, now)
    expect(await verifyTotp(s, code, now - 30_000)).toBe(true)
    expect(await verifyTotp(s, code, now + 30_000)).toBe(true)
  })

  it('超出窗口即失效', async () => {
    const s = generateTotpSecret()
    const now = 1_757_894_400_000
    const code = await currentTotp(s, now)
    expect(await verifyTotp(s, code, now + 120_000)).toBe(false)
  })

  it('错误验证码不通过', async () => {
    const s = generateTotpSecret()
    expect(await verifyTotp(s, '000000')).toBe(false)
  })

  it('格式不对直接拒绝，不做哈希运算', async () => {
    const s = generateTotpSecret()
    expect(await verifyTotp(s, 'abcdef')).toBe(false)
    expect(await verifyTotp(s, '12345')).toBe(false)
    expect(await verifyTotp(s, '1234567')).toBe(false)
  })

  it('接受带空格的输入（认证器 App 常显示为 123 456）', async () => {
    const s = generateTotpSecret()
    const code = await currentTotp(s)
    expect(await verifyTotp(s, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true)
  })

  it('不同密钥产生不同验证码', async () => {
    const now = 1_757_894_400_000
    expect(await currentTotp(generateTotpSecret(), now))
      .not.toBe(await currentTotp(generateTotpSecret(), now))
  })

  it('RFC 6238 测试向量（SHA-1, 密钥 12345678901234567890）', async () => {
    // RFC 附录 B 的密钥是 ASCII "12345678901234567890"
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'))
    expect(await currentTotp(secret, 59_000)).toBe('287082')
    expect(await currentTotp(secret, 1_111_111_109_000)).toBe('081804')
    expect(await currentTotp(secret, 1_234_567_890_000)).toBe('005924')
  })

  it('otpauth URI 结构正确', () => {
    const uri = totpUri('ABC234', 'admin')
    expect(uri).toContain('otpauth://totp/')
    expect(uri).toContain('secret=ABC234')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })
})

describe('会话令牌', () => {
  it('64 位 hex 且每次不同', () => {
    const a = generateSessionToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(generateSessionToken()).not.toBe(a)
  })
})
