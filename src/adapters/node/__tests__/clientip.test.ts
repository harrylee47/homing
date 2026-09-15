import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { clientIp, inCidr, isTrustedProxy, normalizeIp } from '../clientip.js'

const req = (socketIp: string, xff?: string): IncomingMessage =>
  ({ socket: { remoteAddress: socketIp }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as unknown as IncomingMessage

describe('CIDR 匹配', () => {
  it.each([
    ['172.27.0.1', '172.27.0.0/16', true],
    ['172.28.0.1', '172.27.0.0/16', false],
    ['10.0.0.5', '10.0.0.0/8', true],
    ['127.0.0.1', '127.0.0.1/32', true],
    ['127.0.0.2', '127.0.0.1/32', false],
    ['1.2.3.4', '0.0.0.0/0', true],
  ])('%s ∈ %s = %s', (ip, cidr, want) => {
    expect(inCidr(ip, cidr)).toBe(want)
  })

  it('非法输入返回 false 而不是抛异常', () => {
    expect(inCidr('not-an-ip', '10.0.0.0/8')).toBe(false)
    expect(inCidr('10.0.0.1', 'garbage')).toBe(false)
    expect(inCidr('10.0.0.1', '10.0.0.0/99')).toBe(false)
    expect(inCidr('999.0.0.1', '10.0.0.0/8')).toBe(false)
  })

  it('IPv6 映射前缀被剥离', () => {
    expect(normalizeIp('::ffff:172.27.0.1')).toBe('172.27.0.1')
    expect(inCidr('::ffff:172.27.0.1', '172.27.0.0/16')).toBe(true)
  })
})

describe('可信代理判定', () => {
  it('未配置时不信任任何来源', () => {
    expect(isTrustedProxy('172.27.0.1', null)).toBe(false)
    expect(isTrustedProxy('127.0.0.1', '')).toBe(false)
  })

  it('支持多个网段，逗号分隔', () => {
    expect(isTrustedProxy('10.1.2.3', '172.27.0.0/16, 10.0.0.0/8')).toBe(true)
    expect(isTrustedProxy('192.168.1.1', '172.27.0.0/16, 10.0.0.0/8')).toBe(false)
  })
})

describe('真实 IP 解析', () => {
  it('未配置可信代理时用连接地址，忽略 XFF', () => {
    expect(clientIp(req('172.27.0.1', '1.2.3.4'), null)).toBe('172.27.0.1')
  })

  it('来源不可信时忽略 XFF —— 否则任何人都能伪造 IP', () => {
    expect(clientIp(req('8.8.8.8', '1.2.3.4'), '172.27.0.0/16')).toBe('8.8.8.8')
  })

  it('来源可信时采信 XFF', () => {
    expect(clientIp(req('172.27.0.1', '203.0.113.7'), '172.27.0.0/16')).toBe('203.0.113.7')
  })

  it('取最后一项而非第一项 —— 客户端可自带伪造的 XFF', () => {
    // 客户端发 "XFF: 1.1.1.1"，反代追加真实来源 → "1.1.1.1, 203.0.113.7"
    expect(clientIp(req('172.27.0.1', '1.1.1.1, 203.0.113.7'), '172.27.0.0/16')).toBe('203.0.113.7')
  })

  it('可信来源但没有 XFF 时回落到连接地址', () => {
    expect(clientIp(req('172.27.0.1'), '172.27.0.0/16')).toBe('172.27.0.1')
  })

  it('XFF 里的 IPv6 映射前缀也被剥离', () => {
    expect(clientIp(req('172.27.0.1', '::ffff:203.0.113.7'), '172.27.0.0/16')).toBe('203.0.113.7')
  })

  it('连接地址缺失时不返回空串', () => {
    expect(clientIp(req(''), null)).toBe('unknown')
  })
})
