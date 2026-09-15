/**
 * 把自建 bark-server 挂到网关自己的域名下（/bark/*）。
 *
 * 这样不必为 Bark 单独建站、单独申请证书：Bark App 里填
 * `https://<网关域名>/bark`，注册与令牌刷新经这条路走。
 *
 * 这个路径**不能要求网关的鉴权** —— Bark App 不会带我们的 token，
 * 它的凭证是 bark 自己的 device key。代价是任何知道地址的人都能在这台
 * bark-server 上注册设备、把它当免费推送中转用，因此**默认关闭**，
 * 由控制台按需临时开启（见 settings 的 bark_public）。
 *
 * 网关自己推送不走这条路：渠道配置里的 server 填内部上游地址，
 * 于是关闭对外开放不会影响自己的通知。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request } from 'node:http'
import { log } from '../../core/logging.js'

export const BARK_PREFIX = '/bark'

/**
 * 对外开放程度。
 *
 * - off：完全关闭。只有网关自己（走内部地址）能推送。
 * - push：**允许推送，禁止注册**。其它服务可以拿已知的 device key 推送，
 *   但陌生人无法在这台服务器上注册新设备，也就无法把它当免费中转用。
 *   device key 本身是一串随机值，不知道就推不了——这是推荐档位。
 * - full：注册与推送都开放。仅在 Bark App 首次绑定或换设备时临时开启。
 */
export type BarkAccess = 'off' | 'push' | 'full'

/** 注册类路径。push 档位下拦掉这些，其余放行。 */
const REGISTER_PATHS = ['/register']

export function isRegisterPath(pathAfterPrefix: string): boolean {
  const p = (pathAfterPrefix.split('?')[0] ?? '').replace(/\/+$/, '') || '/'
  return REGISTER_PATHS.some((r) => p === r || p.startsWith(`${r}/`))
}

/** 给定档位，判断这个请求是否放行。 */
export function isBarkAllowed(access: BarkAccess, url: string): boolean {
  if (access === 'off') return false
  if (access === 'full') return true
  return !isRegisterPath(url.slice(BARK_PREFIX.length) || '/')
}

/** 请求体上限：Bark 的推送体很小，给 64KB 足够，超出即拒绝。 */
const MAX_BODY = 64 * 1024

export function isBarkPath(url: string | undefined): boolean {
  const p = (url ?? '').split('?')[0] ?? ''
  return p === BARK_PREFIX || p.startsWith(`${BARK_PREFIX}/`)
}

/**
 * @param upstream 形如 http://bark:8080 —— 同一 compose 网络内的服务名，
 *                 不能写 127.0.0.1：那在容器里指向网关自己。
 */
export function proxyBark(upstream: string, req: IncomingMessage, res: ServerResponse): void {
  const target = new URL(upstream)
  const rest = (req.url ?? '').slice(BARK_PREFIX.length) || '/'

  const proxied = request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: rest,
      method: req.method,
      headers: {
        ...req.headers,
        // 上游按 Host 做路由时不能带我们的域名
        host: target.host,
      },
      timeout: 15_000,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )

  proxied.on('error', (e) => {
    log.error('Bark 上游不可达', { error: String(e) })
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 502, message: 'bark upstream unavailable' }))
  })

  proxied.on('timeout', () => proxied.destroy(new Error('timeout')))

  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_BODY) {
      proxied.destroy(new Error('body too large'))
      if (!res.headersSent) res.writeHead(413).end()
    }
  })
  req.pipe(proxied)
}
