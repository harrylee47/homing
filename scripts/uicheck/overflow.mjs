import WebSocket from 'ws'
const BASE = 'http://127.0.0.1:18790'
const WIDTHS = [360, 402, 430, 768, 1280]
const PAGES = [
  ['/overview', null], ['/events', null], ['/events?kind=call', null],
  ['/compose', null], ['/sent', null], ['/rules', null], ['/channels', null],
  ['/devices', null], ['/notice', null], ['/welcome', null],
  ['/settings', 'general'], ['/settings', 'security'], ['/settings', 'invite'], ['/settings', 'admin'],
]
const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0; const p = new Map()
await new Promise(r => ws.on('open', r))
ws.on('message', m => { const o = JSON.parse(String(m)); if (o.id && p.has(o.id)) { p.get(o.id)(o); p.delete(o.id) } })
const cmd = (m, q = {}) => new Promise((res, rej) => { const i = ++id; p.set(i, o => o.error ? rej(new Error(JSON.stringify(o.error))) : res(o.result)); ws.send(JSON.stringify({ id: i, method: m, params: q })) })
const ev = async e => { const r = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 160) }; return r.result.value }

await cmd('Page.enable'); await cmd('Runtime.enable')
await cmd('Page.navigate', { url: BASE + '/login' }); await new Promise(r => setTimeout(r, 2200))
if (await ev(`!!document.querySelector('#pw')`)) {
  await ev(`(()=>{document.querySelector('#pw').value='UiTest123!';document.querySelector('#go').click()})()`)
  await new Promise(r => setTimeout(r, 2500))
}

const PROBE = `(() => {
  const out = { pageScroll: document.body.scrollWidth > document.documentElement.clientWidth + 1,
                bodyW: document.body.scrollWidth, docW: document.documentElement.clientWidth, items: [] }
  const vw = document.documentElement.clientWidth
  const sel = (e) => {
    let s = e.tagName.toLowerCase()
    if (e.id) s += '#' + e.id
    if (e.className && typeof e.className === 'string') s += '.' + e.className.trim().split(/\\s+/).slice(0,3).join('.')
    return s
  }
  for (const e of document.querySelectorAll('body *')) {
    if (!e.getClientRects().length) continue
    const cs = getComputedStyle(e)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = e.getBoundingClientRect()
    // ① 冲出视口右边（左边也看一眼）
    if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
      out.items.push({ kind: '出视口', sel: sel(e), left: Math.round(r.left), right: Math.round(r.right), vw,
                       text: (e.textContent||'').trim().slice(0,40) })
      continue
    }
    // ② 内容被裁掉（排除刻意可横滚的容器）
    const scrollable = cs.overflowX === 'auto' || cs.overflowX === 'scroll'
    if (!scrollable && e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0) {
      // 单行截断是有意的，.truncate 会 ellipsis，不算 bug
      if (e.classList.contains('truncate')) continue
      out.items.push({ kind: '内容被裁', sel: sel(e), scrollW: e.scrollWidth, clientW: e.clientWidth,
                       text: (e.textContent||'').trim().slice(0,40) })
    }
  }
  // 去重：父子同时命中只留最内层
  const seen = new Set()
  out.items = out.items.filter(i => { const k = i.kind + i.sel; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 12)
  return out
})()`

const report = []
for (const w of WIDTHS) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 700 })
  for (const [path, tabName] of PAGES) {
    await ev(`location.href=${JSON.stringify(path)}`)
    await new Promise(r => setTimeout(r, path === '/welcome' || path === '/notice' ? 2000 : 1600))
    if (tabName) { await ev(`(()=>{const a=document.querySelector('[data-tab="${tabName}"]'); if(a) a.click()})()`); await new Promise(r => setTimeout(r, 1200)) }
    const res = await ev(PROBE)
    if (res?.__err) { report.push({ w, path: path + (tabName ? '#' + tabName : ''), err: res.__err }); continue }
    if (res.pageScroll || res.items.length) report.push({ w, path: path + (tabName ? '#' + tabName : ''), pageScroll: res.pageScroll, bodyW: res.bodyW, docW: res.docW, items: res.items })
  }
}
console.log(JSON.stringify(report, null, 1))
ws.close(); await fetch('http://127.0.0.1:9222/json/close/' + tab.id).catch(() => {})
