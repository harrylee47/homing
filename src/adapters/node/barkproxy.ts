/**
 * 把自建 bark-server 挂到网关自己的域名下（/bark/*）。
 *
 * 这样不必为 Bark 单独建站、单独申请证书：Bark App 里填
 * `https://<网关域名>/bark`，推送与注册都经这条路走。
 *
 * 注意这个路径**不能要求网关的鉴权** —— Bark App 不会带我们的 token，
 * 它的凭证是 bark 自己的 device key。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request } from 'node:http'
import { log } from '../../core/logging.js'

export const BARK_PREFIX = '/bark'

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
