/**
 * 客户端真实 IP 解析（计划 §11.6）。
 *
 * X-Forwarded-For 只有在确知请求来自可信反代时才可采信。配错的后果是
 * 限速与 IP 告警全部可被伪造绕过——这是反代后认证绕过的经典成因，
 * 所以默认不信任任何来源，必须显式配置 GW_TRUSTED_PROXY。
 */
import type { IncomingMessage } from 'node:http'

/** 去掉 IPv6 映射前缀，::ffff:1.2.3.4 → 1.2.3.4 */
export const normalizeIp = (ip: string): string => ip.replace(/^::ffff:/i, '')

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255 || p === '') return null
    n = n * 256 + v
  }
  return n
}

/** 仅支持 IPv4 CIDR。容器网络与内网反代都是 IPv4，暂不需要 IPv6。 */
export function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/')
  if (!range) return false
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const a = ipv4ToInt(normalizeIp(ip))
  const b = ipv4ToInt(range)
  if (a === null || b === null) return false
  if (bits === 0) return true

  const mask = bits === 32 ? -1 : ~((1 << (32 - bits)) - 1)
  return (a & mask) === (b & mask)
}

export function isTrustedProxy(ip: string, trusted: string | null): boolean {
  if (!trusted) return false
  return trusted.split(',').map((s) => s.trim()).filter(Boolean).some((c) => inCidr(ip, c))
}

/**
 * 解析真实客户端 IP。
 *
 * 取 XFF 的**最后一项**而不是第一项：客户端可以自带伪造的 XFF，
 * 反代会把真实来源追加在后面，所以最右侧那个才是反代亲自写入的。
 * 取第一项等于直接采信客户端的自述。
 */
export function clientIp(req: IncomingMessage, trustedProxy: string | null): string {
  const socketIp = normalizeIp(req.socket.remoteAddress ?? '')
  if (!isTrustedProxy(socketIp, trustedProxy)) return socketIp || 'unknown'

  const xff = req.headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff.join(',') : xff
  if (!raw) return socketIp

  const parts = raw.split(',').map((s) => normalizeIp(s.trim())).filter(Boolean)
  return parts[parts.length - 1] ?? socketIp
}
