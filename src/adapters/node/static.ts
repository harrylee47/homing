/**
 * 静态文件服务（控制台 SPA）。
 *
 * 深链路由是硬要求：Bark 通知点击后要能直接落在 /events/:id 这类路径上
 * （计划 §11.2），所以非 API、非文件的路径一律回 index.html 交给前端路由。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'

  // 路径穿越防护：规范化后必须仍在 root 之内
  const abs = resolve(join(root, normalize(pathname)))
  const rootAbs = resolve(root)
  if (!abs.startsWith(rootAbs + '/') && abs !== rootAbs) {
    res.writeHead(404).end()
    return true
  }

  const file = existsSync(abs) && statSync(abs).isFile() ? abs : join(rootAbs, 'index.html')
  if (!existsSync(file)) return false

  const ext = extname(file)
  const headers: Record<string, string> = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    // 控制台会展示全部短信明文，任何中间层都不应缓存
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // 前端不加载任何外部资源，CSP 收到最紧
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  }
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
  return true
}
