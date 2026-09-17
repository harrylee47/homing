/**
 * 静态服务的三条行为，每一条都有人踩过：
 *  - SPA 深链必须回落到 index.html（Bark 通知点进来落在 /events/:id）
 *  - 落地页要能用 /welcome 访问，不带 .html 后缀
 *  - 路径穿越必须挡住
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serveStatic } from '../static.js'

const root = mkdtempSync(join(tmpdir(), 'homing-static-'))
writeFileSync(join(root, 'index.html'), '<!doctype html>SPA')
writeFileSync(join(root, 'welcome.html'), '<!doctype html>LANDING')
writeFileSync(join(root, 'app.js'), 'console.log(1)')
mkdirSync(join(root, 'download'), { recursive: true })
writeFileSync(join(root, 'download', 'homing.apk'), 'PK')

/** 最小的 res 替身：只记下状态码、头和写进去的内容 */
const fakeRes = () => {
  const r = {
    status: 0, headers: {} as Record<string, string>, body: '',
    writeHead(s: number, h?: Record<string, string>) { r.status = s; Object.assign(r.headers, h ?? {}); return r },
    end(b?: string) { if (b) r.body = b; return r },
    on() { return r }, emit() { return true }, once() { return r },
  }
  return r
}

const get = (path: string) => {
  const res = fakeRes()
  const handled = serveStatic(root, { url: path, headers: {} } as never, res as never)
  return { handled, ...res }
}

describe('静态服务', () => {
  it('真实文件按自己的类型发', () => {
    expect(get('/app.js').headers['content-type']).toContain('javascript')
  })

  it('/welcome 落到 welcome.html —— 落地页不该带 .html 后缀', () => {
    const r = get('/welcome')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/html')
  })

  it('APK 用安卓包的 MIME，不是 octet-stream', () => {
    expect(get('/download/homing.apk').headers['content-type']).toBe('application/vnd.android.package-archive')
  })

  it('深链回落到 index.html —— Bark 通知点进来就是这条路', () => {
    const r = get('/events/evt_123')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/html')
  })

  it('穿不出根目录', () => {
    // URL 构造器会先把 /../../x 规范成 /x，所以穿越在到达这里之前就没了；
    // 真正要断言的是**外面的文件永远取不到**，而不是某个具体状态码
    writeFileSync(join(root, '..', 'homing-secret.txt'), 'SECRET')
    for (const p of ['/../homing-secret.txt', '/..%2Fhoming-secret.txt', '/a/../../homing-secret.txt']) {
      expect(get(p).body, p).not.toContain('SECRET')
    }
  })

  it('HTML 一律 no-store —— 控制台会展示全部短信明文', () => {
    expect(get('/').headers['cache-control']).toBe('no-store')
    expect(get('/app.js').headers['cache-control']).toBe('no-cache')
  })
})
