/**
 * Webhook 的内网防护。
 *
 * 单用户自建时 webhook 打哪儿都无所谓——你只能打到自己。
 * 一旦允许陌生人注册，它就是一个 VPS 内网里的请求原语，
 * 而这台机器上还有意开着数据库端口。
 */
import { describe, expect, it } from 'vitest'
import { checkWebhookTarget, isPrivateHost } from '../ssrf.js'

describe('内网地址识别', () => {
  it('回环', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', 'LOCALHOST']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
  })

  it('私有网段', () => {
    for (const h of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
  })

  it('云元数据地址 —— 这是 SSRF 最常见的目标', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true)
  })

  it('容器名这类无点短名 —— compose 里的服务名就长这样', () => {
    for (const h of ['bark-server', 'redis', 'gateway']) expect(isPrivateHost(h), h).toBe(true)
  })

  it('IPv4 映射的 IPv6 也要剥出来判', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false)
  })

  it('公网地址放行', () => {
    for (const h of ['example.com', '8.8.8.8', '1.1.1.1', 'hooks.slack.com', '172.32.0.1', '192.167.1.1']) {
      expect(isPrivateHost(h), h).toBe(false)
    }
  })
})

describe('Webhook 目标校验', () => {
  it('公网 https 放行', () => {
    expect(checkWebhookTarget('https://example.com/hook', false)).toBeNull()
  })

  it('内网地址默认拒绝', () => {
    expect(checkWebhookTarget('http://127.0.0.1:5432/', false)).toContain('内网')
    expect(checkWebhookTarget('http://169.254.169.254/latest/meta-data/', false)).toContain('内网')
  })

  it('管理员显式放开后才允许 —— 接收端在同一台机器上是合法需求', () => {
    expect(checkWebhookTarget('http://127.0.0.1:9000/hook', true)).toBeNull()
  })

  it('非 http(s) 协议一律拒绝', () => {
    expect(checkWebhookTarget('file:///etc/passwd', true)).toContain('只支持')
    expect(checkWebhookTarget('gopher://x/', true)).toContain('只支持')
  })

  it('乱七八糟的地址不通过', () => {
    expect(checkWebhookTarget('not a url', false)).toContain('格式')
  })
})
