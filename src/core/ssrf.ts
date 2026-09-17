/**
 * Webhook 目标地址的内网防护。
 *
 * Webhook 渠道会让服务端按用户给的地址发一个带自定义请求头的 HTTP 请求，
 * 并把短信正文放进去。单用户自建时这没问题——你只能打到自己。
 * **一旦允许陌生人注册，它就变成了一个 VPS 内网里的请求原语**：
 * 云厂商的元数据接口、只监听回环的管理端口、同一台机器上其他服务的端口
 * （这台机器上的数据库端口就是有意对外开着的），全都在射程内。
 *
 * 所以默认只允许公网地址。要打内网是合法需求（很多人的接收端就在同一台机器上），
 * 但那必须是管理员自己明确开的口子，不能让注册进来的人默认就有。
 *
 * 这里只做「地址长什么样」的判断，不做 DNS 解析——解析放在适配层，
 * core 不碰网络。挡不住 DNS rebinding，但那需要攻击者控制一个域名并
 * 精确卡时序，而本层要挡的是「随手填个 127.0.0.1」这类顺手可得的目标。
 */

/** 回环、私有、链路本地、以及云厂商元数据地址。 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')

  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  // 无点的主机名多半是容器名或内网短名（bark-server、redis、gateway）
  if (!h.includes('.') && !h.includes(':')) return true

  // IPv6：回环、唯一本地(fc00::/7)、链路本地(fe80::/10)
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true
    const p = h.split('%')[0]!
    if (/^f[cd]/.test(p) || /^fe[89ab]/.test(p)) return true
    // ::ffff:a.b.c.d 形式的 IPv4 映射，剥出来再判
    const m = p.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    return m ? isPrivateHost(m[1]!) : false
  }

  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b].some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false

  return (
    a === 0 ||                               // 0.0.0.0/8
    a === 10 ||                              // 10/8
    a === 127 ||                             // 回环
    (a === 100 && b >= 64 && b <= 127) ||    // 运营商级 NAT 100.64/10
    (a === 169 && b === 254) ||              // 链路本地，含云元数据 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||     // 172.16/12
    (a === 192 && b === 168) ||              // 192.168/16
    (a === 198 && (b === 18 || b === 19)) || // 基准测试网段
    a >= 224                                 // 组播与保留
  )
}

/** Webhook 地址是否可用。返回 null 表示可用，否则是拒绝理由。 */
export function checkWebhookTarget(raw: string, allowPrivate: boolean): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return '地址格式不正确'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '只支持 http 与 https'
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    return '不允许指向内网或回环地址。这类地址只有管理员能配——它能让服务器替你访问自己内部的服务'
  }
  return null
}
