/**
 * 静态服务的几条行为，每一条都有人踩过：
 *  - SPA 深链必须回落到 index.html（Bark 通知点进来落在 /events/:id）
 *  - 落地页要能用 /welcome 访问，不带 .html 后缀
 *  - /welcome2（落地页第二版时期的临时地址）永久跳到 /welcome
 *  - 路径穿越必须挡住
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable, once } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { serveStatic } from '../static.js'

const root = mkdtempSync(join(tmpdir(), 'homing-static-'))
writeFileSync(join(root, 'index.html'), '<!doctype html>SPA')
writeFileSync(join(root, 'welcome.html'), '<!doctype html>LANDING')
writeFileSync(join(root, 'app.js'), 'console.log(1)')
mkdirSync(join(root, 'download'), { recursive: true })
writeFileSync(join(root, 'download', 'homing.apk'), 'PK')

/**
 * res 替身。
 *
 * 必须是**真的可写流**：serveStatic 走的是 `createReadStream(file).pipe(res)`，
 * 对着一个普通对象 pipe 会在测试结束之后才抛 `dest.destroy is not a function`，
 * 表现为「用例全绿但跑出一堆 uncaught exception」。更糟的是 body 永远是空串，
 * 于是下面那条「穿不出根目录」的断言变成了永远成立的空断言——
 * 真漏了文件也测不出来。
 */
const fakeRes = () => {
  const chunks: Buffer[] = []
  const r = new Writable({
    write(c: Buffer, _enc, cb) { chunks.push(Buffer.from(c)); cb() },
  }) as Writable & {
    status: number
    headers: Record<string, string>
    readonly body: string
    writeHead(s: number, h?: Record<string, string>): typeof r
  }
  r.status = 0
  r.headers = {}
  r.writeHead = (s: number, h?: Record<string, string>) => {
    r.status = s
    Object.assign(r.headers, h ?? {})
    return r
  }
  Object.defineProperty(r, 'body', { get: () => Buffer.concat(chunks).toString() })
  return r
}

const get = async (path: string) => {
  const res = fakeRes()
  const handled = serveStatic(root, { url: path, headers: {} } as never, res as never)
  // 没接手就不会有人调 end()，等 finish 会挂住
  if (handled) await once(res, 'finish')
  return { handled, status: res.status, headers: res.headers, body: res.body }
}

describe('静态服务', () => {
  it('真实文件按自己的类型发', async () => {
    const r = await get('/app.js')
    expect(r.headers['content-type']).toContain('javascript')
    expect(r.body).toBe('console.log(1)')
  })

  it('/welcome 落到 welcome.html —— 落地页不该带 .html 后缀', async () => {
    const r = await get('/welcome')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/html')
    expect(r.body).toContain('LANDING')
  })

  it('/welcome2 永久跳到 /welcome —— 第二版时期发出去的链接不能落到 404', async () => {
    for (const p of ['/welcome2', '/welcome2.html']) {
      const r = await get(p)
      expect(r.status).toBe(301)
      expect(r.headers.location).toBe('/welcome')
    }
  })

  it('APK 用安卓包的 MIME，不是 octet-stream', async () => {
    expect((await get('/download/homing.apk')).headers['content-type'])
      .toBe('application/vnd.android.package-archive')
  })

  it('深链回落到 index.html —— Bark 通知点进来就是这条路', async () => {
    const r = await get('/events/evt_123')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/html')
    expect(r.body).toContain('SPA')
  })

  it('穿不出根目录', async () => {
    // URL 构造器会先把 /../../x 规范成 /x，所以穿越在到达这里之前就没了；
    // 真正要断言的是**外面的文件永远取不到**，而不是某个具体状态码
    writeFileSync(join(root, '..', 'homing-secret.txt'), 'SECRET')
    for (const p of ['/../homing-secret.txt', '/..%2Fhoming-secret.txt', '/a/../../homing-secret.txt']) {
      expect((await get(p)).body, p).not.toContain('SECRET')
    }
  })

  it('HTML 一律 no-store —— 控制台会展示全部短信明文', async () => {
    expect((await get('/')).headers['cache-control']).toBe('no-store')
    expect((await get('/app.js')).headers['cache-control']).toBe('no-cache')
  })
})
