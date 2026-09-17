/**
 * Service Worker —— 只做两件事：收推送、处理通知点击。
 *
 * ⚠️ **绝不缓存任何东西。**
 *
 * 这是一个展示全部短信明文（含银行验证码）的控制台。Cache Storage 是落盘的，
 * 而且不受 HTTP 的 no-store 约束——缓存过一次验证码，它就长期留在那台电脑上，
 * 谁打开浏览器都能翻出来。所以 fetch 处理器是纯直通：
 * 装它只是为了拿到 Push API，不是为了离线可用。
 *
 * 之所以还要留一个 fetch 处理器：安卓 Chrome 的 beforeinstallprompt
 * 要求存在一个带 fetch handler 的 SW，否则「添加到主屏幕」的原生弹窗不会触发。
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// 纯直通。不读缓存、不写缓存，一个字节都不留在磁盘上
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)) })

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    // 解不开的载荷照样要弹一条：静默丢弃等于漏报，而漏报是这个项目
    // 唯一不能接受的失败
    d = { title: '新消息', body: '内容无法解析，请打开控制台查看' }
  }
  e.waitUntil(self.registration.showNotification(d.title || '新消息', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // 同一个发件人的新通知覆盖旧的，而不是堆一屏
    tag: d.tag || 'homing',
    renotify: true,
    // 验证码要看得见，不能被系统折叠掉
    requireInteraction: false,
    data: { url: d.url || '/', code: d.code || null },
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // 已经开着的窗口就复用，别每点一次开一个新标签
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus()
        if ('navigate' in w) await w.navigate(url)
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})
