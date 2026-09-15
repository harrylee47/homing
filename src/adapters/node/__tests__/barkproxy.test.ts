import { describe, expect, it } from 'vitest'
import { isBarkAllowed, isBarkPath, isRegisterPath } from '../barkproxy.js'

describe('Bark 路径识别', () => {
  it.each(['/bark', '/bark/', '/bark/ping', '/bark/abc123', '/bark/ping?x=1'])
    ('识别 %s 为 Bark 路径', (u) => expect(isBarkPath(u)).toBe(true))

  it.each(['/barking', '/api/bark', '/', '/events/bark'])
    ('%s 不是 Bark 路径', (u) => expect(isBarkPath(u)).toBe(false))
})

describe('注册路径识别', () => {
  it.each(['/register', '/register/', '/register?devicetoken=x', '/register/sub'])
    ('%s 属于注册', (p) => expect(isRegisterPath(p)).toBe(true))

  it.each(['/ping', '/mykey', '/push', '/registered', '/'])
    ('%s 不属于注册', (p) => expect(isRegisterPath(p)).toBe(false))
})

describe('三档访问控制', () => {
  describe('off：完全关闭', () => {
    it.each(['/bark/ping', '/bark/mykey', '/bark/register'])
      ('拒绝 %s', (u) => expect(isBarkAllowed('off', u)).toBe(false))
  })

  describe('push：允许推送、禁止注册', () => {
    it('允许用已知 key 推送', () => {
      expect(isBarkAllowed('push', '/bark/abcdef123456')).toBe(true)
      expect(isBarkAllowed('push', '/bark/push')).toBe(true)
    })
    it('允许健康检查', () => {
      expect(isBarkAllowed('push', '/bark/ping')).toBe(true)
    })
    it('拒绝注册 —— 陌生人无法把这台服务器当免费中转', () => {
      expect(isBarkAllowed('push', '/bark/register')).toBe(false)
      expect(isBarkAllowed('push', '/bark/register?devicetoken=x')).toBe(false)
    })
    it('不会把以 register 开头的 key 误判成注册', () => {
      // device key 是随机串，理论上可能以 register 开头，但不会恰好等于它
      expect(isBarkAllowed('push', '/bark/registerKEY123')).toBe(true)
    })
  })

  describe('full：注册与推送都开放', () => {
    it.each(['/bark/ping', '/bark/mykey', '/bark/register'])
      ('允许 %s', (u) => expect(isBarkAllowed('full', u)).toBe(true))
  })
})
