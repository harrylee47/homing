import WebSocket from 'ws'
const BASE='http://127.0.0.1:18790'
// 未登录也能开的那几页：里面**没有用户数据**，所以任何中文都是漏翻
const PUBLIC = ['/welcome', '/notice', '/login', '/register', '/privacy', '/recover']
// 控制台内页：短信正文、设备名、渠道名是用户数据，本来就该保持原样
const APP = ['/overview','/events','/compose','/sent','/rules','/channels','/devices',
             '/settings#general','/settings#security','/settings#invite','/settings#admin']
const tab=await (await fetch('http://127.0.0.1:9222/json/new?about:blank',{method:'PUT'})).json()
const ws=new WebSocket(tab.webSocketDebuggerUrl)
let id=0;const p=new Map()
await new Promise(r=>ws.on('open',r))
ws.on('message',m=>{const o=JSON.parse(String(m));if(o.id&&p.has(o.id)){p.get(o.id)(o);p.delete(o.id)}})
const cmd=(m,q={})=>new Promise((res,rej)=>{const i=++id;p.set(i,o=>o.error?rej(new Error(JSON.stringify(o.error))):res(o.result));ws.send(JSON.stringify({id:i,method:m,params:q}))})
const ev=async e=>{const r=await cmd('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return {__err:JSON.stringify(r.exceptionDetails).slice(0,200)};return r.result.value}
await cmd('Page.enable');await cmd('Runtime.enable')
await cmd('Emulation.setDeviceMetricsOverride',{width:402,height:900,deviceScaleFactor:1,mobile:true})
// 切英文
await cmd('Page.navigate',{url:BASE+'/welcome'});await new Promise(r=>setTimeout(r,1800))
await ev(`(()=>{try{localStorage.setItem('gw_lang','en')}catch(e){}})()`)

const PROBE = `(() => {
  const CJK = /[\\u4e00-\\u9fff]/
  const out = []
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  let n
  while ((n = w.nextNode())) {
    const pn = n.parentNode && n.parentNode.nodeName
    if (pn === 'SCRIPT' || pn === 'STYLE') continue
    const t = (n.nodeValue || '').trim()
    if (!t || !CJK.test(t)) continue
    if (!n.parentElement || !n.parentElement.getClientRects().length) continue
    let path = []
    let e = n.parentElement
    for (let i = 0; e && i < 3; i++, e = e.parentElement) {
      path.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
        (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : ''))
    }
    out.push({ t: t.slice(0, 50), where: path.join(' < ') })
  }
  // 属性里的（placeholder / title / aria-label / alt）
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
    for (const a of ['placeholder','title','aria-label','alt']) {
      const v = el.getAttribute(a)
      if (v && CJK.test(v)) out.push({ t: '[' + a + '] ' + v.slice(0, 44), where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') })
    }
  }
  return out
})()`

async function scan(list, label, loginFirst) {
  console.log('\\n######## ' + label + ' ########')
  for (const path of list) {
    const [pth, hash] = path.split('#')
    await ev(`location.href=${JSON.stringify(pth)}`)
    await new Promise(r=>setTimeout(r, pth==='/welcome'||pth==='/notice'?2200:1700))
    if (hash) { await ev(`(()=>{const a=document.querySelector('[data-tab="${hash}"]'); if(a) a.click()})()`); await new Promise(r=>setTimeout(r,1200)) }
    const res = await ev(PROBE)
    if (res?.__err) { console.log(path, 'ERR', res.__err); continue }
    if (!res.length) { console.log('  ✓ ' + path); continue }
    console.log('  ✗ ' + path + '  (' + res.length + ' 处)')
    const seen=new Set()
    for (const r of res) { const k=r.t; if(seen.has(k))continue; seen.add(k); console.log('      ' + JSON.stringify(r.t) + '   @ ' + r.where) }
  }
}
await scan(PUBLIC, '未登录可达的页（任何中文都是漏翻）')
// 登录后再扫内页
await ev(`location.href='/login'`); await new Promise(r=>setTimeout(r,2000))
if (await ev(`!!document.querySelector('#pw')`)) {
  await ev(`(()=>{document.querySelector('#pw').value='UiTest123!';document.querySelector('#go').click()})()`)
  await new Promise(r=>setTimeout(r,2600))
}
await scan(APP, '控制台内页（用户数据本来就是中文，要自己分辨）')
ws.close(); await fetch('http://127.0.0.1:9222/json/close/'+tab.id).catch(()=>{})
