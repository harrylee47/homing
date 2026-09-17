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
  // 按规范 manifest 该发这个类型。发成 octet-stream 的话 Safari 会直接拒收，
  // 而表现只是「装不上」，没有任何报错
  '.webmanifest': 'application/manifest+json',
  // APK 由网关自己发。GitHub release 现在匿名访问是 404（账号被标记），
  // 而落地页的读者恰恰都是匿名的——指过去等于给一个打不开的链接
  '.apk': 'application/vnd.android.package-archive',
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

  /**
   * 找不到文件时，先试一次 `<path>.html`，再回落到 SPA 的 index.html。
   *
   * 这样落地页能以 `/welcome` 访问而不用带 .html 后缀，同时不影响
   * 深链回落——那条路径是 Bark 通知点进来的硬要求。
   */
  const htmlAlt = `${abs}.html`
  const found = existsSync(abs) && statSync(abs).isFile() ? abs
    : existsSync(htmlAlt) && statSync(htmlAlt).isFile() ? htmlAlt
    : null

  /**
   * 带扩展名的路径找不到就老实回 404，不要回落到 index.html。
   *
   * 回落是给**前端路由**用的（/events/evt_123 这种没有扩展名的深链），
   * 而 /manifest.webmanifest 少传一个文件时回落，浏览器拿到的是
   * 200 + text/html + 整个 SPA，报出来的错是「manifest 语法错误」——
   * 指向完全错误的方向，人会去改 manifest 内容而不是去看文件在不在。
   * 将来放 sw.js 同理：MIME 成了 text/html，register() 直接失败。
   */
  const looksLikeAsset = /\.[a-z0-9]{1,12}$/i.test(pathname) && !pathname.endsWith('.html')
  if (!found && looksLikeAsset) {
    res.writeHead(404).end()
    return true
  }

  const file = found ?? join(rootAbs, 'index.html')
  if (!existsSync(file)) return false

  const ext = extname(file)
  const stat = statSync(file)
  const lastModified = stat.mtime.toUTCString()

  // 条件请求：内容没变就回 304，既省流量又保证部署后立刻生效
  const since = req.headers['if-modified-since']
  if (since && Date.parse(since) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
    res.writeHead(304, { 'cache-control': 'no-cache', 'last-modified': lastModified })
    res.end()
    return true
  }

  const headers: Record<string, string> = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    /**
     * 一律 no-cache（每次校验，不是不缓存）。
     *
     * 本项目没有构建步骤，文件名里没有内容哈希，所以长缓存会让部署后
     * 一小时内都拿到旧代码——改了口令规则、修了 bug 都看不到。
     * 配合 Last-Modified 回 304，代价只有一个条件请求。
     * HTML 仍是 no-store：控制台会展示全部短信明文。
     */
    'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
    'last-modified': lastModified,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // 前端不加载任何外部资源，CSP 收到最紧
    'content-security-policy':
      // manifest-src 在 CSP 里回落到 default-src，而这里是 'none'——不显式写上
      // 就会被挡掉，表现是控制台一条 "Refused to load manifest"，页面一切正常、
      // 只是永远装不上主屏
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      // worker-src 按规范会回落到 script-src（已经是 'self'），但 Safari 不实现
      // worker-src、各浏览器的回落链历史上有过分歧，显式写出来省事
      "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
      "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  }
  /**
   * Service Worker 的作用域默认只到它自己所在的目录。放在根目录就够了，
   * 但显式给出这个头，将来挪位置时不至于变成一个「注册成功却什么都收不到」
   * 的哑 SW。
   */
  if (pathname === '/sw.js') headers['service-worker-allowed'] = '/'

  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
  return true
}
