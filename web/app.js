// 控制台。零构建、零依赖——体量不大，别上重框架（计划 §7.1）。
const $ = (s, r = document) => r.querySelector(s)
const app = $('#app')
const nav = $('#nav')

// ── 状态 ────────────────────────────────────────────────────

const TOKEN_KEY = 'gw_token'
/** 登录前想去的那一页，登录成功后跳回去 */
const BACK_KEY = 'gw_back'
/** 上次登录的用户名，只作为输入框的默认值 */
const LAST_USER_KEY = 'gw_user'
/**
 * 不需要登录就能打开的页面。
 *
 * **必须是一处**：这个判断同时决定「要不要踢去登录页」和「要不要藏起导航栏」，
 * 原来两处各写各的硬编码字符串，加一个新公开页时只改一处的后果是
 * 「页面能打开但底下挂着整条导航栏」或者「导航藏对了但一进去就跳登录」。
 */
const PUBLIC_PAGES = new Set(['/login', '/setup', '/recover', '/register', '/privacy'])
/** 当前登录的人。用于显示「你是谁」与判断要不要显示用户管理 */
let me = null
let token = localStorage.getItem(TOKEN_KEY) || ''

const setToken = (t) => {
  token = t || ''
  if (!t) me = null
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

// ── API ─────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }

  if (res.status === 404 && token && !opts.allow404) {
    // 未认证一律返回 404（不确认接口存在），所以这里等同于「会话失效」。
    // 记下当前页：重新登录后回到这里，而不是把人丢回总览
    setToken('')
    if (location.pathname !== '/login') {
      sessionStorage.setItem(BACK_KEY, location.pathname + location.search)
    }
    go('/login')
    throw new Error('会话已失效，请重新登录')
  }
  if (!res.ok) {
    // 把整个响应体挂上去：到期、需要重新验证这类情况，界面要的不只是一句话，
    // 还有 reason 之类的字段才能决定下一步给什么按钮
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.data = data
    err.status = res.status
    throw err
  }
  return data
}

// ── 工具 ────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * 标签输入。
 *
 * 替代「用逗号分隔填一个框」：那种写法在中文输入法下几乎必错——
 * 全角逗号、顿号、前后空格，任何一个都会让关键词悄悄变成另一个词，
 * 而规则失效的表现是「验证码没推过来」，等发现已经晚了。
 *
 * 提交时机：回车、失焦、或输入逗号（半角全角都认）。
 * **不按空格拆**——关键词里本来就可能带空格（verification code）。
 */
function tagInput(host, initial, placeholder = '输入后回车') {
  const vals = [...(initial || [])]

  const paint = () => {
    host.innerHTML = vals.map((v, i) => `
      <span class="tag"><span>${esc(v)}</span><b data-rm="${i}" title="删除">×</b></span>`).join('') +
      `<input placeholder="${esc(vals.length ? '' : placeholder)}">`
    const input = host.querySelector('input')

    for (const b of host.querySelectorAll('[data-rm]')) {
      b.onclick = () => { vals.splice(Number(b.dataset.rm), 1); paint(); host.querySelector('input').focus() }
    }

    const add = (text) => {
      // 全角空格也要去掉：中文输入法下敲出来的空格常常是它
      const parts = String(text).split(/[,，\n]/).map((x) => x.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''))
      let added = false
      for (const x of parts) if (x && !vals.includes(x)) { vals.push(x); added = true }
      return added
    }

    const commit = () => {
      const added = add(input.value)
      input.value = ''
      if (added) { paint(); host.querySelector('input').focus() }
    }

    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      // 空输入时退格删掉最后一个标签，跟各处的标签输入习惯一致
      else if (e.key === 'Backspace' && input.value === '' && vals.length) {
        vals.pop(); paint(); host.querySelector('input').focus()
      }
    }
    input.oninput = () => { if (/[,，]/.test(input.value)) commit() }
    input.onblur = commit
    input.onpaste = (e) => {
      const t = (e.clipboardData || window.clipboardData).getData('text')
      if (!/[,，\n]/.test(t)) return
      // 必须直接切粘贴来的文本：input 元素存不住换行，
      // 先赋给 input.value 再切，多行会被拼成一行（「顺丰\n京东」→「顺丰京东」）
      e.preventDefault()
      if (add(t)) { paint(); host.querySelector('input').focus() }
    }
  }
  paint()
  return {
    /** 取值前先把输入框里还没提交的内容也算上，避免「打完没回车就点保存」丢东西 */
    values: () => {
      const input = host.querySelector('input')
      const rest = (input?.value ?? '').split(/[,，\n]/)
        .map((x) => x.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')).filter(Boolean)
      return [...new Set([...vals, ...rest])]
    },
  }
}

/**
 * 设备配色。
 *
 * 同一台设备在总览、消息列表、发送记录里必须是同一个颜色，否则「按颜色认设备」
 * 这件事就不成立。所以颜色由 id 决定，而不是由它在列表里的位置决定。
 */
function deviceClass(id) {
  let h = 0
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `c-dev${h % 6}`
}

/**
 * 品牌头。只出现在三个地方：登录、首次配置、总览。
 *
 * 其余页面不放——那是日常高频操作的地方，每页顶一个 logo 是纯粹的占地方。
 */
const brand = (sub = '') => `
  <div class="brand">
    <img src="/logo.svg" alt="" width="52" height="52">
    <div class="col">
      <b>Homing</b>
      ${sub ? `<span class="muted">${esc(sub)}</span>` : ''}
    </div>
  </div>`

/** 列表项左侧色带的类别。与 style.css 的 .s-* 对应。 */
const stripeOf = (kind, direction) =>
  direction === 'out' ? 's-out' : `s-${kind}`

/**
 * 次要信息行：设备色点 + 设备名 + 其它补充。
 *
 * 设备只在多设备时显示——单设备下每条都缀一遍是噪音（pipeline.ts 里同样的判断）。
 */
/**
 * 设备上插着的 SIM 卡。服务端把它放在 net.sims 里随心跳上报。
 *
 * 只有一张卡时返回空数组：调用方据此**什么都不显示**。单卡下每处都缀一个
 * 「SIM1」是纯噪音，而双卡下不显示就分不清验证码是哪张卡收的、该用哪张卡回。
 */
function simsOf(device) {
  const sims = device && device.net && device.net.sims
  return Array.isArray(sims) && sims.length > 1 ? sims : []
}

/** 「SIM2 · 尾号1234」。尾号优先于运营商：双卡常常是同一家运营商的两张卡。 */
function simText(sim) {
  const extra = sim.tail ? `尾号${sim.tail}` : (sim.carrier || sim.label || '')
  return extra ? `SIM${sim.slot + 1} · ${extra}` : `SIM${sim.slot + 1}`
}

/**
 * 卡槽下拉。单卡（或读不到卡）时整块隐藏——多一个只有一个选项的下拉，
 * 是在让人怀疑自己是不是漏选了什么。
 *
 * @param selected 预选卡槽，null 表示「系统默认卡」
 */
function simSelect(id, sims, selected) {
  if (sims.length === 0) return ''
  return `<label>用哪张卡发</label>
    <select id="${id}">
      <option value="">系统默认卡</option>
      ${sims.map((x) => `<option value="${x.slot}"${x.slot === selected ? ' selected' : ''}>${
        esc(simText(x))}${x.default_sms ? '（默认）' : ''}</option>`).join('')}
    </select>`
}

function metaLine(parts, deviceId, deviceName, showDevice) {
  const bits = []
  if (showDevice && deviceName) {
    bits.push(`<span class="pip ${deviceClass(deviceId)}"></span><span>${esc(deviceName)}</span>`)
  }
  for (const p of parts.filter(Boolean)) bits.push(`<span>${esc(p)}</span>`)
  if (bits.length === 0) return ''
  return `<div class="meta">${bits.join('<span class="sep">·</span>')}</div>`
}

/**
 * 通话记录的一行，排版对着手机上的通话 App 来：
 * 方向箭头 + 号码（未接标红）/ 第二行是类型与时长 / 右边时间。
 *
 * 通话和短信不是一回事：短信要读正文，通话只需要「谁、什么时候、接没接到」。
 * 用同一套排版就会让「未接来电」这四个字被当成正文摆在那里。
 */
function callRow(e, multi) {
  const missed = e.direction !== 'out' && e.content.includes('未接')
  const arrow = e.direction === 'out' ? '↗' : missed ? '↙' : '↙'
  const what = e.direction === 'out' ? '去电' : missed ? '未接来电' : '已接来电'
  // 正文形如「已接来电 · 通话 1分20秒」，状态那半截由上面的 what 说，这里只留时长
  const dur = String(e.content).replace(/^(已拨出|已接来电|未接来电|已拒接)\s*·?\s*/, '').trim()
  // 箭头跟在第二行而不是单开一列：手机上的通话记录就是这么排的，
  // 号码那一行要留给号码本身
  return `
    <div class="item" data-id="${esc(e.id)}">
      <div class="row">
        <b class="truncate ${missed ? 'missed' : ''}">${esc(e.from)}</b>
        <span class="muted mono" style="font-size:12px;flex:none">${fmt(e.occurred_at)}</span>
      </div>
      <div class="muted" style="margin-top:2px">
        <span class="arrow ${missed ? 'missed' : ''}">${arrow}</span>${what}${dur ? ` · ${esc(dur)}` : ''}
      </div>
      ${metaLine([e.sim, ...e.matched_rules], e.device_id, e.device_name, multi)}
    </div>`
}

/** 事件类型徽章。颜色与 style.css 的 .c-sms/.c-call/.c-notification 对应。 */
function kindBadge(kind, direction) {
  if (direction === 'out') return '<span class="badge c-out">已发出</span>'
  const label = { sms: '短信', call: '来电', notification: '通知' }[kind] || kind
  return `<span class="badge c-${esc(kind)}">${esc(label)}</span>`
}

/** 发送状态：颜色即语义，送达是绿的、失败是红的，中间态留白。 */
const OUTBOUND_STATUS = [
  ['pending', '待下发', ''],
  ['accepted', '已接收', 'info'],
  ['sent', '已发出', 'info'],
  ['delivered', '已送达', 'ok'],
  ['failed', '失败', 'err'],
]
/** 发送记录的色带：成功绿、失败红、在途灰。 */
const outboundStripe = (status) =>
  status === 'delivered' ? 's-ok' : status === 'failed' ? 's-err' : 's-wait'

function statusBadge(status) {
  const hit = OUTBOUND_STATUS.find(([v]) => v === status)
  return hit
    ? `<span class="badge ${hit[2]}">${hit[1]}</span>`
    : `<span class="badge">${esc(status)}</span>`
}

/** 只给日期，用于「搜到哪天为止」这类说明 */
const fmtDate = (ts) => {
  const d = new Date(Number(ts))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const fmt = (ts) => {
  if (!ts) return '—'
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const t = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return sameDay ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`
}

const ago = (ts) => {
  if (!ts) return '从未'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 与服务端 core/auth.ts 的 validatePassword 保持一致。前端只为即时反馈，服务端才是准的。 */
function checkPassword(pw) {
  if (pw.length < 8) return '口令至少 8 位'
  const classes = [/[a-zA-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length
  if (classes < 2) return '口令需包含英文、数字、符号中的至少两类'
  return null
}

/** 电量显示。充电状态用图标区分，一眼看出插没插上。 */
/** 已吊销设备的电量。在用的设备走 statusBadges，那里说得更全（含充不充电）。 */
function battery(d) {
  if (d.battery == null) return ''
  const icon = d.charging === true ? '🔌' : d.battery <= 20 ? '🪫' : '🔋'
  return ` · ${icon} ${d.battery}%`
}

/**
 * 设备状态徽章：网络、信号、充电。
 *
 * 「设备不在线」只有一个比特的信息量，排查时真正有用的是「为什么」——
 * WiFi 关了、信号 0 格、没插电，这三件事直接决定你要不要跑回去看一眼。
 * 所以它们平铺在设备卡片上，而不是藏进详情。
 */
function statusBadges(d) {
  const n = d.net || {}
  const out = []

  // 信号排第一：它和「有没有网」是两件事。手机连着 WiFi、SIM 卡却没信号时，
  // 短信照样收不到——只看「已连 WiFi」会以为一切正常，而这正是最该被看见的故障。
  const bars = (lv) => `${'▮'.repeat(lv)}${'▯'.repeat(4 - lv)}`
  const sims = simsOf(d)
  if (sims.length > 0) {
    // 双卡：逐卡各报一格条。上面那个总的 signal 只代表其中一张，
    // 而「另一张卡没信号」恰恰是收不到验证码的原因
    for (const sim of sims) {
      const lv = sim.signal == null ? null : Math.max(0, Math.min(4, sim.signal))
      const tone = lv === 0 ? 'err' : lv != null && lv <= 1 ? 'warn' : 'ok'
      const name = sim.tail ? `尾号${sim.tail}` : (sim.carrier || sim.label || '')
      out.push(`<span class="badge ${lv == null ? 'plain' : tone}">📶 SIM${sim.slot + 1}${
        name ? ` ${esc(name)}` : ''}${lv == null ? '' : ` ${bars(lv)}`}${lv != null && lv <= 1 ? ' 信号弱' : ''}</span>`)
    }
  } else if (n.signal != null) {
    const lv = Math.max(0, Math.min(4, n.signal))
    const tone = lv === 0 ? 'err' : lv <= 1 ? 'warn' : 'ok'
    out.push(`<span class="badge ${tone}">📶 ${bars(lv)}${lv <= 1 ? ' 信号弱' : ''}</span>`)
  }

  // 上网路径
  if (n.type === 'wifi') {
    out.push(`<span class="badge info">🛜 ${n.ssid ? esc(n.ssid) : 'WiFi'}</span>`)
  } else if (n.type === 'cellular') {
    out.push('<span class="badge info">📱 移动数据</span>')
  } else if (n.type === 'none') {
    out.push('<span class="badge err">✕ 无网络</span>')
  } else if (n.type === 'other') {
    out.push('<span class="badge plain">其他网络</span>')
  }

  // 双卡时运营商已经跟在每张卡后面了，再来一个总的只会让人以为是第三张卡
  if (n.carrier && sims.length === 0) {
    // 单卡也把号码尾号带上：这是「这台手机拿的是哪个号」，一台设备只出现一次，
    // 不是每条消息都缀一遍的那种噪音——多设备时最想确认的恰恰是这个
    const all = (n.sims || [])
    const tail = all.length === 1 && all[0].tail ? ` · 尾号${all[0].tail}` : ''
    out.push(`<span class="badge plain">${esc(n.carrier)}${esc(tail)}</span>`)
  }

  // 电量总是显示，包括「没在充电」——这台机器要常年插着电，
  // 「未充电」不是常态而是异常，藏起来等于把最该报的那条藏了。
  if (d.battery != null) {
    const tone = d.battery <= 20 ? 'err' : d.charging === true ? 'ok' : d.battery <= 40 ? 'warn' : 'plain'
    const icon = d.charging === true ? '⚡' : d.battery <= 20 ? '🪫' : '🔋'
    out.push(`<span class="badge ${tone}">${icon} ${d.battery}%${d.charging === true ? ' 充电中' : d.charging === false ? ' 未充电' : ''}</span>`)
  } else if (d.charging === true) {
    out.push('<span class="badge ok">⚡ 充电中</span>')
  }

  // WiFi 开着却没走 WiFi：多半是没连上或信号太弱，这种「半好不坏」最容易被忽略
  if (n.wifi === false && n.type !== 'wifi') out.push('<span class="badge plain">WiFi 已关</span>')
  if (n.type && n.type !== 'none' && n.online === false) out.push('<span class="badge warn">连着但没网</span>')

  if (out.length === 0) return ''
  // 掉线设备也显示——「掉线前是 1 格信号」正是排查时最想知道的那一句。
  // 但要标清楚是旧数据，不能让人以为它现在还是这样。
  const stale = d.status !== 'online'
  return `<div class="row" style="justify-content:flex-start;gap:6px;flex-wrap:wrap;margin-top:7px${stale ? ';opacity:.6' : ''}">
    ${stale ? '<span class="muted" style="font-size:12px">掉线前</span>' : ''}${out.join('')}
  </div>`
}

function toast(msg) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2600)
}

/**
 * 每一页离开时的滚动位置。
 *
 * 不记的话，从一条消息返回列表就回到最顶上，刚才翻了半天的位置全丢了——
 * 而「点进去看一眼再回来接着翻」正是这个列表最常见的用法。
 */
const scrollMem = new Map()
/** 当前这一页的地址。popstate 时 location 已经变了，得自己记着上一页是谁 */
let curPath = location.pathname + location.search
/** 本次会话里有没有跳转过。决定「返回」是走浏览器后退还是跳到指定的上级 */
let navDepth = 0
/** 视图自己滚过了（会话要停在最新一条），路由就别再把它拉回顶部 */
let viewScrolled = false

const rememberScroll = () => scrollMem.set(curPath, window.scrollY)

const go = (path) => {
  rememberScroll()
  navDepth++
  history.pushState({}, '', path)
  curPath = path
  route()
}

/**
 * 返回上一层。
 *
 * 优先走浏览器后退：只有这条路能带回滚动位置，而「回到列表还得重新往下翻」
 * 是详情页最烦人的地方。直接打开详情页（Bark 深链就是这样）时没有上一页，
 * 才退到给定的地址。
 */
const goBack = (fallback) => {
  if (navDepth > 0) { navDepth--; history.back() } else go(fallback)
}

// 事件委托：视图重绘后不需要重新绑定
document.addEventListener('click', (e) => {
  const back = e.target.closest('[data-back]')
  if (back) {
    e.preventDefault()
    return goBack(back.dataset.back)
  }
  const a = e.target.closest('a[href^="/"]')
  if (a && !a.target) {
    e.preventDefault()
    go(a.getAttribute('href'))
  }
})
window.addEventListener('popstate', () => {
  rememberScroll()
  curPath = location.pathname + location.search
  route(true)
})

// ── 路由 ────────────────────────────────────────────────────

const routes = [
  [/^\/$/, overview],
  [/^\/threads\/(.+)$/, thread],
  [/^\/threads$/, () => { history.replaceState({}, '', THREAD_HOME); return threads() }],
  [/^\/events\/(.+)$/, eventDetail],
  [/^\/events$/, events],
  [/^\/compose$/, compose],
  [/^\/sent\/(.+)$/, sentDetail],
  [/^\/sent$/, sent],
  [/^\/rules$/, rules],
  [/^\/tasks$/, tasks],
  [/^\/channels$/, channels],
  [/^\/devices\/(.+)\/logs$/, deviceLogs],
  [/^\/devices$/, devices],
  [/^\/settings$/, settings],
  [/^\/login$/, login],
  [/^\/recover$/, recover],
  [/^\/privacy$/, privacy],
  [/^\/register$/, register],
  [/^\/setup$/, setup],
]

async function route(restore = false) {
  const path = location.pathname
  curPath = path + location.search
  nav.hidden = true
  viewScrolled = false

  try {
    // 未初始化时一切导向向导——不存在「启动即裸奔」的窗口
    const st = await api('/setup/status', { allow404: true })
    if (!st?.initialized) return setup()
  } catch { /* 网络异常时继续尝试渲染，由各视图报错 */ }

  if (!token && !PUBLIC_PAGES.has(path)) {
    // 记下想去哪，登录完直接回去（Telegram 通知里的按钮就是这条路）
    sessionStorage.setItem(BACK_KEY, path + location.search)
    return login()
  }

  for (const [re, view] of routes) {
    const m = path.match(re)
    if (m) {
      nav.hidden = PUBLIC_PAGES.has(path)
      for (const a of nav.querySelectorAll('a')) {
        // 会话和消息是同一件事的两种看法，导航上归到「消息」
        const group = path.startsWith('/events') || path.startsWith('/threads') ? '/events'
          : path.startsWith('/sent') ? '/compose' : path
        a.classList.toggle('active', a.dataset.nav === group)
      }
      await view(m[1])
      // 视图是异步的，等它画完才有高度可滚
      requestAnimationFrame(() => {
        // 后退回来接着刚才的位置看；进新页面从头看，
        // 除非视图自己有主张（会话要停在最新一条）
        if (restore && scrollMem.has(curPath)) window.scrollTo(0, scrollMem.get(curPath))
        else if (!viewScrolled) window.scrollTo(0, 0)
      })
      return
    }
  }
  overview()
}

const render = (html) => { app.innerHTML = html }
const fail = (e) => render(`<div class="card"><div class="err-text">${esc(e.message)}</div></div>`)

// ── 首次配置向导（计划 §12.1①）──────────────────────────────

async function setup() {
  nav.hidden = true
  render(`
    ${brand('第一次使用，先做两件事')}
    <div class="steps"><div class="on"></div><div id="s2"></div></div>
    <div class="card">
      <p class="muted">这台服务器将存放你的全部短信内容，包括银行验证码。先建一个管理员账号。</p>
      <label>用户名</label>
      <input id="name" value="admin" autocomplete="username">
      <div class="muted">字母、数字、- 和 _，2–24 个字符。之后可以再建别的账号，
      每个账号在控制台里只看到自己的数据。</div>
      <label>口令（至少 8 位，含英文 / 数字 / 符号中的两类）</label>
      <input id="pw" type="password" autocomplete="new-password">
      <label>再输一次</label>
      <input id="pw2" type="password" autocomplete="new-password">
      <div class="btnrow"><button id="next">下一步</button></div>
      <div id="err" class="err-text"></div>
    </div>`)

  $('#next').onclick = async () => {
    const pw = $('#pw').value, pw2 = $('#pw2').value
    if (pw !== pw2) return ($('#err').textContent = '两次输入不一致')
    const bad = checkPassword(pw)
    if (bad) return ($('#err').textContent = bad)
    $('#next').disabled = true
    try {
      const r = await api('/setup/password', {
        method: 'POST', body: { password: pw, name: $('#name').value.trim() }, allow404: true,
      })
      setupTotp(r)
    } catch (e) {
      $('#err').textContent = e.message
      $('#next').disabled = false
    }
  }
}

function setupTotp(r) {
  render(`
    <h1>绑定两步验证</h1>
    <div class="steps"><div class="on"></div><div class="on"></div></div>
    <div class="card">
      <p class="muted">用 Google Authenticator、1Password、iOS 自带密码 App 等扫码。
      这个网页上能看到你所有的短信，建议开着——开了之后只是登录时多输 6 位数字。</p>
      ${r.qr ? `<div class="qr">${r.qr}</div>` : ''}
      <details>
        <summary class="muted">扫不了？手动添加</summary>
        <label>密钥</label>
        <div class="mono wrap card tight" style="user-select:all">${esc(r.secret)}</div>
        <div class="muted">类型选「基于时间」，算法 SHA1，位数 6，周期 30 秒。</div>
      </details>
      <label>输入认证器显示的 6 位验证码</label>
      <input id="code" inputmode="numeric" maxlength="6" class="mono" style="font-size:20px;letter-spacing:4px">
      <div class="btnrow">
        <button id="done">完成</button>
        <button class="ghost sm" id="skip">暂不开启</button>
      </div>
      <div id="err" class="err-text"></div>
      <div class="muted" style="margin-top:8px">不开也能用，之后随时可以在「设置 → 两步验证」打开。
      </div>
    </div>`)

  const finish = async (body) => {
    $('#done').disabled = true
    $('#skip').disabled = true
    try {
      await api('/setup/verify', { method: 'POST', body, allow404: true })
      toast('初始化完成')
      go('/login')
    } catch (e) {
      $('#err').textContent = e.message
      $('#done').disabled = false
      $('#skip').disabled = false
    }
  }
  $('#done').onclick = () => finish({ code: $('#code').value })
  $('#skip').onclick = () => {
    if (!confirm('暂不开启两步验证？\n\n这个控制台上能看到你所有的短信，包括银行验证码。')) return
    finish({ skip: true })
  }
}

// ── 登录 ────────────────────────────────────────────────────

function login() {
  nav.hidden = true
  // 从别处跳来的（比如 Telegram 通知里的按钮）：登录完要回到那一页，
  // 而不是把人丢到总览让他自己再找一遍
  const back = location.pathname !== '/login' ? location.pathname + location.search : null
  if (back) sessionStorage.setItem(BACK_KEY, back)

  render(`
    ${brand('把消息带到你身边')}
    ${back ? '<div class="card tight muted">登录后回到你要看的那条消息。</div>' : ''}
    <div class="card">
      <label>用户名</label>
      <input id="user" autocomplete="username" value="${esc(localStorage.getItem(LAST_USER_KEY) || '')}" placeholder="留空则按管理员登录">
      <label>口令</label>
      <input id="pw" type="password" autocomplete="current-password">
      <label>两步验证码（没开就留空）</label>
      <input id="code" inputmode="numeric" maxlength="6" class="mono" style="letter-spacing:4px">
      <!--
        这一栏对**所有人**都显示，哪怕这个账号没绑两步验证。
        不能按账号决定显不显示：那等于做了一个「这个用户名有没有开两步验证」
        的探针，而用户名是可以枚举的。所以只能靠文案说清楚。
      -->
      <div class="muted"><b>没绑过认证器就把这一栏留空</b>，直接点登录；
      绑过的话填认证器 App 上每 30 秒变一次的 6 位数字。</div>
      <label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:14px">
        <input type="checkbox" id="trust" style="width:auto" checked>
        <span>在这台设备上保持登录 30 天</span>
      </label>
      <div class="muted">勾选后这台设备 30 天内不用再输，换 WiFi / 流量也不掉线。
      公用设备请取消勾选。任何时候都可以在「设置 → 会话 → 全端下线」一次性作废。</div>
      <div class="btnrow"><button id="go">登录</button></div>
      <div id="err" class="err-text"></div>
      <div class="row" style="margin-top:10px">
        <a href="/recover" class="muted">忘记口令？</a>
        <a href="/register" class="muted" id="toreg" hidden>用邀请码注册 →</a>
      </div>
    </div>
    <div class="card" id="expired" hidden>
      <div class="notice">账号到期了，但<b>数据都还在</b>。有新的邀请码可以自己续上。</div>
      <input id="exp_name" type="hidden">
      <label>邀请码</label>
      <input id="exp_code" class="mono" style="letter-spacing:3px;text-transform:uppercase">
      <div class="muted">口令和两步验证码用上面填的那份。</div>
      <div class="btnrow"><button id="exp_go" class="sm">续期并登录</button></div>
      <div id="exp_err" class="err-text"></div>
    </div>`)

  const submit = async () => {
    $('#go').disabled = true
    try {
      const r = await api('/auth/login', {
        method: 'POST', allow404: true,
        body: {
          name: $('#user').value.trim(),
          password: $('#pw').value, code: $('#code').value, trust: $('#trust').checked,
        },
      })
      setToken(r.token)
      // 记住上次登录的用户名：一家人共用一台机器时，每次都要重打一遍很烦。
      // 只是个输入框的默认值，不构成任何凭证
      try { localStorage.setItem(LAST_USER_KEY, r.user?.name || '') } catch { /* 隐私模式 */ }
      me = r.user || null
      // 回到当初想去的那一页
      const to = sessionStorage.getItem(BACK_KEY)
      sessionStorage.removeItem(BACK_KEY)
      go(to || '/')
    } catch (e) {
      $('#err').textContent = e.message
      $('#go').disabled = false
      // 到期不是「登录失败」，是「账号停在那儿等续期」——给他下一步，不要只丢一句红字
      if (e.data?.reason === 'expired') {
        $('#expired').hidden = false
        $('#exp_name').value = $('#user').value.trim()
      }
    }
  }
  $('#go').onclick = submit
  $('#code').onkeydown = (e) => { if (e.key === 'Enter') submit() }

  $('#exp_go').onclick = async () => {
    $('#exp_go').disabled = true
    $('#exp_err').textContent = ''
    try {
      const r = await api('/account/renew', {
        method: 'POST', allow404: true,
        body: {
          name: $('#exp_name').value.trim(),
          password: $('#pw').value,
          code: $('#code').value.trim(),
          invite: $('#exp_code').value.trim(),
        },
      })
      toast(r.expires_at ? `已续期到 ${new Date(r.expires_at).toLocaleDateString('zh-CN')}` : '已设为永久')
      $('#expired').hidden = true
      submit()
    } catch (e) {
      $('#exp_err').textContent = e.message
      $('#exp_go').disabled = false
    }
  }

  // 开了邀请制才显示注册入口。没开的话摆个进不去的链接只会让人白跑一趟
  void api('/register/status', { allow404: true })
    .then((r) => { if (r?.open) $('#toreg').hidden = false })
    .catch(() => { /* 取不到就不显示 */ })
}

/**
 * 隐私与风险声明。
 *
 * 写在前端而不是从接口取：它是**注册前**要读的东西，那时还没有会话；
 * 而且它必须和代码同版本走——改了实现却忘了改声明，比没有声明更糟。
 *
 * 一条底线：这里面不许出现任何做不到的承诺。这个项目做不到端到端加密，
 * 服务端必须解开正文才能跑规则和转发；说「我们看不到你的短信」是假话。
 * 能说的只有真的：加密挡得住谁、挡不住谁，以及不放心就自己部署一份。
 */
/**
 * 注册页上那段勾选前必须看到的话。
 *
 * 写法上刻意收敛：它是**声明**，不是劝说，也不是科普。原来那版
 * （「会存下你手机收到的全部短信，包括银行验证码」）把同一件事说得
 * 过于直白，读起来像在吓唬人，而该说清的责任边界反而没说全。
 * 现在三句各管一件事：数据、可用性、使用限制。
 */
const PRIVACY_SUMMARY = [
  '使用本服务时，你的短信内容经本服务器转发，数据加密入库。密钥与数据位于同一服务器，运营方在技术上具备读取能力。',
  '本服务**无法保证绝对的数据安全，也不保证不产生遗漏通知**。请勿将其作为验证码的唯一接收手段。',
  '仅限本人使用本人合法持有的号码，不得用于任何违法违规用途。',
]

/**
 * 《隐私与风险声明》正文。
 *
 * 写法约束：**这是一份声明，不是科普，也不是劝说。** 每一条只回答
 * 「会发生什么 / 我们不保证什么 / 你不能拿它做什么」，不解释原理、不讲故事、
 * 不用反问和感叹。改动正文要同时动下面的 PRIVACY_VERSION。
 */
const PRIVACY_TEXT = [
  ['服务说明', [
    '本服务将你配对的安卓设备上接收到的短信、通话记录与指定应用的通知，经本服务器转发至你配置的接收渠道，并在本服务器上留存。',
    '使用本服务即表示你已阅读并同意本声明全部内容。',
  ]],
  ['收集的信息', [
    '来自你配对的设备（以你在设备上授予的权限为限）：',
    '· 短信：完整正文与发件人号码',
    '· 通话：来电、去电、未接的号码、时间与通话时长',
    '· 应用通知：你指定的应用的通知标题与正文',
    '· 你在该设备上发出的短信',
    '· 设备状态：电量、充电状态、网络与运营商信息、信号强度、应用版本',
    '· 位置：仅在你主动发起定位请求时获取单次位置，不进行持续定位；每次获取与每次查看均记录审计日志',
    '· 若使用历史导入功能，还包括设备上此前已存在的短信与通话记录',
    '来自你在控制台的操作：接收渠道的凭证，以及登录与操作日志（时间、IP、浏览器标识、操作内容）。',
    '本服务不收集通讯录、相册、录音、持续位置轨迹，以及其他应用的账号信息。',
  ]],
  ['存储与留存', [
    '数据存储于本服务器的数据库中。短信正文、号码、位置坐标与渠道凭证均以 AES-256-GCM 加密后入库。',
    '你可在设置中为短信、通话、应用通知分别设定保留上限，超出部分将自动删除，**该删除不可恢复**。',
    '你可随时按时间或类型清理历史、删除设备及其历史记录、删除渠道与规则。注销账号将一并删除该账号的设备、消息、规则与任务。',
    '**已推送至外部渠道的内容不在本服务控制范围内**，包括聊天软件中的消息记录、设备上已弹出的通知，以及你自行配置的 Webhook 接收方所保存的数据。',
    '运营方可能出于故障恢复目的备份数据库。你删除的数据不一定同时从备份中移除。',
  ]],
  ['加密的范围与限制', [
    '入库加密可防止数据库文件副本泄露导致的内容暴露。',
    '**加密不能防止有服务器访问权限者读取内容。** 密钥与数据位于同一服务器；且服务端必须解密正文才能匹配规则并生成推送内容，因此**本服务无法实现端到端加密**。',
    '运营方在技术上具备读取任意账号短信内容的能力。',
  ]],
  ['账号之间的隔离', [
    '各账号的设备、渠道、规则与消息相互独立，由程序强制隔离，管理员无法在控制台中查看其他账号的消息。',
    '但下列两点属于隔离范围之外：',
    '1. 管理员可重置任意账号的口令，并以该账号身份登录。此操作记入审计日志，并向被重置账号的接收渠道推送通知。',
    '2. 具备服务器访问权限者可直接读取数据库。',
    '因此该隔离用于防止误操作与越权读取，不构成对运营方的技术约束。',
  ]],
  ['接收渠道带来的额外风险', [
    '配置接收渠道后，消息内容将离开本服务器：',
    '· 聊天软件类渠道：内容经该平台服务器传输并保存在聊天记录中，可被转发或截屏',
    '· 推送通知类渠道：内容经推送服务送达设备，**可能以明文显示在锁屏界面**',
    '· Webhook：内容原样发送至你指定的地址，该地址的归属与日志留存由你自行负责',
  ]],
  ['对设备的操作能力', [
    '你可通过控制台指令使配对设备发送短信、获取单次位置。',
    '短信指令为可选功能。启用后，携带口令的短信可查询该设备的状态与位置。口令以明文形式存在于短信正文中，无法避免。该功能仅支持查询状态、网络、电量、位置与重连，**不支持发送短信**。建议配置号码白名单，不使用时关闭。',
  ]],
  ['账号有效期与注销', [
    '账号可能设有有效期。到期后服务停止：无法登录控制台、设备断开连接、不再转发消息、计划任务不再执行。',
    '到期不删除数据，续期后自动恢复。',
    '你可随时申请注销账号，注销后数据不可恢复。',
  ]],
  ['使用限制', [
    '本服务仅限用于转发**你本人合法持有**的号码所接收的消息。',
    '**不得**用于代收他人验证码、账号批量注册与买卖、规避实名认证，或任何违反所在地法律法规的用途。',
    '违反上述限制的账号将被停用，由此产生的法律责任由使用者自行承担。',
  ]],
  ['免责', [
    '**本服务不保证消息必达。** 设备断电、断网、被系统关闭、运营商延迟等任一环节均可能导致消息延迟或丢失。请勿将本服务作为验证码的唯一接收手段，涉及资金的操作尤应注意。',
    '**本服务不保证持续可用。** 服务器可能重启、迁移或停止运行。',
    '**本服务不保证绝对的数据安全。**',
    '运营方不对因使用本服务产生的任何损失承担责任。',
  ]],
]

/** 声明的版本号。改了上面的正文就要动它，让已经同意过的人重新看一遍 */
const PRIVACY_VERSION = '2026-09-18'

/** 把正文里的 **粗体** 渲染出来。只支持这一种标记，够用且不会出意外 */
const mdBold = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

function privacyHtml() {
  return PRIVACY_TEXT.map(([title, paras], i) => `
    <h2>${i + 1}. ${esc(title)}</h2>
    ${paras.map((t) => `<p class="${t.startsWith('·') || /^\d\./.test(t) ? 'pitem' : ''}">${mdBold(t)}</p>`).join('')}
  `).join('')
}

/**
 * 自助注册。
 *
 * 邀请码从 **URL 的 fragment** 里取（`/register#CODE`）：fragment 不会发给
 * 服务器，所以它不进反代日志、不进访问日志、也不出现在 Referer 里——
 * 而这个码等于一个能看银行验证码的账号。
 */
async function register() {
  nav.hidden = true
  const fromLink = decodeURIComponent(location.hash.slice(1)).trim().toUpperCase()
  /**
   * 读完立刻把码从地址栏擦掉。
   *
   * 邀请码放在 fragment 里，图的就是它不发给服务器——不进反代日志、不进
   * 访问日志、不进 Referer（api.ts 里生成链接那处写了这段来历）。但读完不擦，
   * 它就留在**浏览器历史**里，也留在截图和「把这个链接发给我看看」里，
   * 而这个码等于一个能看银行验证码的账号。
   *
   * 用 replaceState 不用 pushState：擦掉这一步不该在后退栈里多一格。
   */
  if (fromLink) history.replaceState(null, '', location.pathname)
  const pub = await api('/register/status', { allow404: true }).catch(() => null)
  const contact = pub?.admin_contact || ''

  if (!pub?.open) {
    render(`
      ${brand('注册')}
      <div class="card">
        <div class="notice">这台服务器<b>没有开放注册</b>。</div>
        <p class="muted">它是个人自建的服务，账号由管理员发放。
        ${contact ? `想要一个账号，联系：<b>${esc(contact)}</b>` : '想要一个账号，请联系这台服务器的管理员。'}</p>
        <p class="muted">也可以<b>自己搭一套</b>——本项目开源。</p>
        <div class="btnrow"><a href="/welcome"><button class="ghost sm">了解这是什么</button></a></div>
      </div>
      <div class="card tight row"><a href="/login" class="muted">← 回登录</a></div>`)
    return
  }

  render(`
    ${brand('创建账号')}
    <div class="card">
      <label>邀请码</label>
      <input id="code" class="mono" style="letter-spacing:3px;text-transform:uppercase"
             value="${esc(fromLink)}" placeholder="向邀请你的人要一个">
      <label>用户名</label>
      <input id="name" autocomplete="username" placeholder="字母、数字、- 和 _，2–24 位">
      <label>口令（至少 8 位，字母 / 数字 / 符号里占两类）</label>
      <input id="pw" type="password" autocomplete="new-password">
      <label>再输一次</label>
      <input id="pw2" type="password" autocomplete="new-password">
      <div class="notice" style="margin-top:14px">
        ${PRIVACY_SUMMARY.map((t) => `<div>${mdBold(t)}</div>`).join('')}
      </div>
      <label style="display:flex;gap:9px;align-items:flex-start;text-transform:none;letter-spacing:0;font-size:14px;line-height:1.6;margin-top:10px">
        <input type="checkbox" id="agree" style="width:auto;margin-top:3px">
        <span>我已阅读并同意<a href="/privacy">《隐私与风险声明》</a>，
        知悉本服务<b>无法保证绝对的数据安全及消息送达</b>，并承诺仅将其用于本人合法用途。</span>
      </label>
      <div class="btnrow"><button id="go">创建账号</button></div>
      <div id="err" class="err-text"></div>
      ${contact ? `<div class="muted" style="margin-top:10px">这台服务器由 <b>${esc(contact)}</b> 运行。</div>` : ''}
    </div>
    <div class="card tight row"><a href="/login" class="muted">← 已经有账号了</a></div>`)

  $('#go').onclick = async () => {
    const name = $('#name').value.trim()
    const pw = $('#pw').value
    if (!$('#agree').checked) return ($('#err').textContent = '要先读完并同意隐私与风险声明')
    if (pw !== $('#pw2').value) return ($('#err').textContent = '两次输入的口令不一致')
    const bad = checkPassword(pw)
    if (bad) return ($('#err').textContent = bad)

    $('#go').disabled = true
    $('#err').textContent = ''
    try {
      await api('/register', {
        method: 'POST', allow404: true,
        body: { code: $('#code').value.trim(), name, password: pw, agree: true },
      })
      try { localStorage.setItem(LAST_USER_KEY, name) } catch { /* 隐私模式 */ }
      toast('账号已创建，请登录')
      go('/login')
    } catch (e) {
      $('#err').textContent = e.message
      $('#go').disabled = false
    }
  }
}

async function privacy() {
  nav.hidden = true
  const pub = await api('/register/status', { allow404: true }).catch(() => null)
  render(`
    ${brand('隐私与风险声明')}
    <div class="card tight muted">版本 ${esc(PRIVACY_VERSION)}${
      pub?.admin_contact ? ` · 这台服务器由 <b>${esc(pub.admin_contact)}</b> 运行` : ''}</div>
    <div class="card prose">
      <p>注册前请读完。</p>
      ${privacyHtml()}
    </div>
    <div class="card tight row">
      <a href="/register" class="muted">← 回注册</a>
      <a href="/login" class="muted">去登录</a>
    </div>`)
}

/**
 * 找回口令。
 *
 * 两条路**让用户自己选**，不做「填进来我猜是哪种」：这两条失败时的下一步
 * 完全不同——渠道那条收不到就重发、或者去查渠道是不是配错了；验证器那条
 * 填错多半是手机时间不准。合成一个框就只能给一句模棱两可的「验证码不正确」，
 * 而那正是人最需要指引的时刻。
 *
 * 两个选项**永远都摆出来**，不问服务端这个账号绑没绑验证器——
 * 那个回答会连带确认账号是否存在。选错了在提交那一步告诉他。
 */
async function recover() {
  nav.hidden = true
  const pub = await api('/register/status', { allow404: true }).catch(() => null)
  const contact = pub?.admin_contact || ''

  const state = { step: 'who', name: '', method: 'channel' }

  const help = () => `
    <details class="card tight" style="margin-top:10px">
      <summary class="muted">❓ 收不到验证码</summary>
      <p class="muted" style="margin:8px 0 0">可能是这几种情况：</p>
      <ul class="muted" style="margin:6px 0 0;padding-left:20px;line-height:1.7">
        <li><b>还没配过推送渠道</b>——换用两步验证器，或联系管理员重置</li>
        <li>渠道配错了。登录后到「设置 → 渠道」点一下测试按钮就能确认</li>
        <li>通知被手机静音或屏蔽了，去通知设置里看一眼</li>
      </ul>
      <p class="muted" style="margin:8px 0 0">${contact
        ? `还是不行就联系管理员：<b>${esc(contact)}</b>`
        : '还是不行就联系这台服务器的管理员，让他帮你重置。'}</p>
    </details>`

  const paint = () => {
    if (state.step === 'who') {
      render(`
        ${brand('找回口令')}
        <div class="card">
          <label>用户名</label>
          <input id="name" autocomplete="username" value="${esc(state.name)}">
          <label>用哪种方式找回</label>
          <div class="pickrow">
            <button type="button" class="pick ${state.method === 'channel' ? 'on' : ''}" data-m="channel">
              <b>📨 推送渠道</b>
              <span class="muted">把验证码发到你配好的 Bark / Telegram / Webhook</span>
            </button>
            <button type="button" class="pick ${state.method === 'totp' ? 'on' : ''}" data-m="totp">
              <b>🔐 两步验证器</b>
              <span class="muted">用认证器 App 上的 6 位动态码</span>
            </button>
          </div>
          <div class="btnrow"><button id="next">下一步</button></div>
          <div id="err" class="err-text"></div>
          <div class="muted" style="margin-top:10px">两样都没有？只能请管理员重置${
            contact ? `：<b>${esc(contact)}</b>` : '。'}</div>
        </div>
        <div class="card tight row"><a href="/login" class="muted">← 回登录</a></div>`)

      for (const b of app.querySelectorAll('[data-m]')) {
        b.onclick = () => { state.method = b.dataset.m; paint() }
      }
      $('#name').oninput = () => { state.name = $('#name').value }
      $('#next').onclick = async () => {
        state.name = $('#name').value.trim()
        if (!state.name) return ($('#err').textContent = '请填用户名')
        if (state.method === 'channel') {
          $('#next').disabled = true
          // 无论账号存不存在都回同一句话，所以这里不用判结果
          await api('/auth/recover/start', { method: 'POST', body: { name: state.name }, allow404: true }).catch(() => {})
        }
        state.step = 'code'
        paint()
      }
      return
    }

    // 第二步：填码 + 设新口令
    const isCh = state.method === 'channel'
    render(`
      ${brand('找回口令')}
      <div class="card">
        ${isCh ? `
          <div class="notice">已向 <b>${esc(state.name)}</b> 配置的<b>所有渠道</b>发送了验证码，10 分钟内有效。
          手机上没动静的话，看看下面那条。</div>`
        : `
          <div class="notice">打开你的认证器 App，找到这一条：
          <div class="mono card tight" style="margin:8px 0 0;user-select:all">SMS Gateway: ${esc(state.name)}</div>
          <span class="muted">输入它当前显示的 6 位数字。动态码对时间很敏感，手机时间不准会一直失败。</span></div>`}
        <label>验证码</label>
        <input id="code" class="mono" inputmode="${isCh ? 'text' : 'numeric'}"
               maxlength="${isCh ? 8 : 6}" style="letter-spacing:4px;font-size:18px"
               autocomplete="one-time-code" placeholder="${isCh ? '8 位' : '6 位'}">
        <label>设置新口令（至少 8 位，字母 / 数字 / 符号里占两类）</label>
        <input id="pw" type="password" autocomplete="new-password">
        <label>再输一次</label>
        <input id="pw2" type="password" autocomplete="new-password">
        <div class="btnrow">
          <button id="go">完成</button>
          ${isCh ? '<button class="ghost sm" id="resend">重新发送</button>' : ''}
          <button class="ghost sm" id="back">换一种方式</button>
        </div>
        <div id="err" class="err-text"></div>
        ${isCh ? help() : `<div class="muted" style="margin-top:10px">认证器丢了？改用推送渠道找回，或联系管理员${
          contact ? `：<b>${esc(contact)}</b>` : '重置。'}</div>`}
      </div>`)

    $('#back').onclick = () => { state.step = 'who'; paint() }
    const resend = $('#resend')
    if (resend) resend.onclick = async () => {
      resend.disabled = true
      await api('/auth/recover/start', { method: 'POST', body: { name: state.name }, allow404: true }).catch(() => {})
      toast('已重新发送')
      setTimeout(() => { resend.disabled = false }, 5000)
    }

    $('#go').onclick = async () => {
      const pw = $('#pw').value
      if (pw !== $('#pw2').value) return ($('#err').textContent = '两次输入的新口令不一致')
      const bad = checkPassword(pw)
      if (bad) return ($('#err').textContent = bad)
      $('#go').disabled = true
      $('#err').textContent = ''
      try {
        await api('/auth/recover/finish', {
          method: 'POST', allow404: true,
          body: { name: state.name, method: state.method, code: $('#code').value.trim(), password: pw },
        })
        toast('口令已重置，请用新口令登录')
        go('/login')
      } catch (e) {
        $('#err').textContent = e.message
        $('#go').disabled = false
      }
    }
  }

  paint()
}

// ── 总览 ────────────────────────────────────────────────────

/**
 * 上手清单。
 *
 * 落地页对外承诺的是「其实只有三件事」，登进来却是一个空仪表盘加三个 0——
 * 承诺到这儿就断了。这张卡把同一套说法接上：同样三步、同样的顺序、
 * 同样的颜色（青 → 黄 → 薄荷，终点落在薄荷 = 成功）。
 *
 * 三条自我约束，免得它变成又一条烦人的横幅：
 *
 * ① **三步都完成后永久消失**，不留「太好了，全部完成！」这种庆祝横幅——
 *    它此刻唯一的作用就是占地方。
 * ② **只高亮当前这一步**，后面的步骤压暗但仍可点。顺序是建议不是强制：
 *    先配渠道再配手机也完全能用，挡住反而是添乱。
 * ③ **第三步没有按钮**。它不是一件要做的事，是前两步做对了自然会发生的事；
 *    给它一个按钮等于让人去找一件根本不存在的操作。
 */
function onboardCard(ob) {
  if (!ob || (ob.paired && ob.channel_tested && ob.got_event)) return ''

  const steps = [
    { done: ob.paired, color: 'c1', title: '配对那台安卓机',
      desc: '在「设备」页生成配对码，用装好 App 的那台手机扫一下。',
      href: '/devices', btn: '去配对' },
    { done: ob.channel_tested, color: 'c2', title: '配一个通知渠道，然后按测试',
      // 这句是整张卡里最重要的一句：配错的表现是「什么都没发生」
      desc: '<b>一定要按那个「测试」按钮。</b>渠道配错不会报错，' +
        '表现就是什么都没发生——等你发现时已经漏了几条。',
      href: '/channels', btn: '去配置' },
    { done: ob.got_event, color: 'c3', title: '收到第一条消息',
      desc: '前两步做完就会自动发生。让人给那张卡发条短信，或者等一条自己来。',
      href: null, btn: null },
  ]
  // 当前这一步 = 第一个没做完的
  const cur = steps.findIndex((x) => !x.done)

  return `
    <h2>先把这三件事做完</h2>
    <div class="card onboard">
      ${steps.map((x, i) => `
        <div class="ob-step${x.done ? ' done' : ''}${i === cur ? ' cur' : ''}">
          <span class="ob-n ${x.color}">${x.done ? '✓' : i + 1}</span>
          <div class="ob-body">
            <b>${x.title}</b>
            <p class="muted">${x.desc}</p>
          </div>
          ${x.btn && !x.done ? `<a href="${x.href}"><button class="sm${i === cur ? '' : ' ghost'}">${x.btn}</button></a>` : ''}
        </div>`).join('')}
    </div>`
}

async function overview() {
  render('<div class="loading">加载中…</div>')
  try {
    const s = await api('/stats')
    // 最显眼的位置是设备状态，不是短信列表（计划 §10.4）
    const deviceCards = s.devices.length ? s.devices.map((d) => `
      <div class="card">
        <div class="row">
          <div class="col grow">
            <div class="row" style="justify-content:flex-start;gap:7px">
              <span class="badge ${deviceClass(d.id)}">${esc(d.name)}</span>
              <span class="dot ${d.status}"></span>
            </div>
            <div class="muted">最后心跳 ${ago(d.last_seen_at)}${d.status === 'revoked' ? battery(d) : ''}${d.app_version ? ` · v${esc(d.app_version)}` : ''}</div>
            ${d.status === 'revoked' ? '' : statusBadges(d)}
          </div>
          <span class="badge ${d.status === 'online' ? 'ok' : d.status === 'revoked' ? 'err' : 'plain'}">${
            d.status === 'online' ? '在线' : d.status === 'revoked' ? '已吊销' : '离线'}</span>
        </div>
      </div>`).join('') : ''

    /**
     * 新用户第一眼看到的是清单，不是三个 0。
     *
     * 而「还没有设备。到『设备』页生成配对码。」这句在清单出现时就不出——
     * 它和第 1 步说的是同一件事，两条并排放着只会让人以为是两件待办。
     * 清单走完之后它才回来：那时候它的意思变成了「你的设备都没了」，
     * 是个异常信号，该显眼。
     */
    const onboard = onboardCard(s.onboarding)
    const noDevice = (s.devices.length || onboard) ? ''
      : '<div class="card muted">还没有设备。到「设备」页生成配对码。</div>'

    render(`
      ${brand()}
      ${onboard}
      ${deviceCards}${noDevice}
      <div class="card">
        <div class="stat">
          <div><b>${s.today.events}</b><span class="muted">今日事件</span></div>
          <div><b>${s.today.outbound}</b><span class="muted">今日发送</span></div>
          <div class="${s.today.outbound_failed ? 'bad' : ''}"><b>${s.today.outbound_failed}</b><span class="muted">发送失败</span></div>
        </div>
      </div>
      <div class="card tight row">
        <span class="muted">${s.rules} 条规则 · ${s.channels} 个渠道</span>
        <a href="/channels"><button class="ghost sm">管理渠道</button></a>
      </div>
      <h2>快捷发送</h2>
      <div class="card tight row">
        <span class="muted">给某个号码发条短信</span>
        <a href="/compose"><button class="sm">去发送</button></a>
      </div>
      <div id="a2hs_tip"></div>`)
    paintA2HSTip()
  } catch (e) { fail(e) }
}

/**
 * 总览底部那条「装到主屏幕」的提示。
 *
 * 默认推荐装成主屏 App——网页是这里唯一的全功能入口，而每次从浏览器里
 * 翻书签打开它，摩擦大到人就不看了。
 *
 * 三条自我约束，免得它变成一条烦人的横幅：
 * ① 已经装了（standalone）就不出现；② 桌面浏览器不出现——那儿本来就没这个必要；
 * ③ 关掉之后永久不再出现（记在 localStorage，不占服务端存储）。
 */
const A2HS_TIP_KEY = 'gw_a2hs_tip'

function paintA2HSTip() {
  const box = $('#a2hs_tip')
  if (!box) return
  const standalone = matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches
    || navigator.standalone === true
  // 触点数而不是 UA：iPadOS 的 Safari 默认报 Mac 的 UA
  const mobile = navigator.maxTouchPoints > 1 || /Android|iPhone|iPad|iPod/.test(navigator.userAgent)
  let dismissed = false
  try { dismissed = localStorage.getItem(A2HS_TIP_KEY) === 'off' } catch { /* 隐私模式 */ }
  if (standalone || !mobile || dismissed) return

  box.innerHTML = `
    <div class="card tight" style="background:var(--bg)">
      <div class="row">
        <div class="col grow">
          <span><b>把它装到主屏幕</b></span>
          <span class="muted">全屏打开，不用每次在浏览器里找。设置页里有对应你手机的步骤。</span>
        </div>
      </div>
      <div class="btnrow" style="margin-top:8px">
        <a href="/settings"><button class="sm">怎么装</button></a>
        <button class="ghost sm" id="a2hs_no">不用了</button>
      </div>
    </div>`
  $('#a2hs_no').onclick = () => {
    try { localStorage.setItem(A2HS_TIP_KEY, 'off') } catch { /* 隐私模式下就每次都提示，无妨 */ }
    box.innerHTML = ''
  }
}

// ── 消息 ────────────────────────────────────────────────────

/**
 * 消息列表。
 *
 * 筛选条件放在 URL 查询串里：刷新、前进后退、把链接发给自己都能还原当前视图，
 * 而不是刷新一下筛选就没了。
 */
/** 短信的两种看法，选过就记住——每次进来都要再点一次是很烦的 */
const VIEW_KEY = 'gw_sms_view'
/** 会话列表的规范地址。详情页的返回、深链都指这里 */
const THREAD_HOME = '/events?kind=sms&view=thread'

/** 消息页的分段控件。类型是类型，看法是看法，不混在一起。 */
function msgSegs(current, segLink) {
  const segs = [['', '全部'], ['sms', '短信'], ['call', '通话'], ['notification', '通知']]
  return `<div class="segs">
    ${segs.map(([k, t]) =>
      `<a href="${segLink ? segLink(k) : `/events${k ? `?kind=${k}` : ''}`}" class="${current === k ? 'on' : ''}" data-seg="${k}">${t}</a>`,
    ).join('')}
  </div>`
}

/**
 * 会话 / 列表 的切换。
 *
 * 只在「短信」下出现：会话是同一批数据的另一种排法，不是另一种类型——
 * 通话和应用通知没有「对话」可言，给它们一个切换只会让人去点然后发现没用。
 */
function viewToggle(view) {
  const link = (v, t) => `<a href="/events?kind=sms&view=${v}" class="${view === v ? 'on' : ''}">${t}</a>`
  return `<div class="viewtoggle">${link('thread', '💬 会话')}${link('list', '☰ 列表')}</div>`
}

/** 短信默认按会话看：和手机上一致。选过就以选的为准。 */
function smsView(param) {
  if (param === 'thread' || param === 'list') {
    try { localStorage.setItem(VIEW_KEY, param) } catch { /* 隐私模式下存不了，不影响这一次 */ }
    return param
  }
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'thread' } catch { return 'thread' }
}

async function events() {
  const p = new URLSearchParams(location.search)
  const get = (k, d = '') => p.get(k) ?? d
  const limit = Number(get('limit', '30'))
  const offset = Number(get('offset', '0'))

  // 短信有两种看法，会话是默认的那种。其余类别没有「对话」可言，只有列表
  if (get('kind') === 'sms' && !p.get('q') && !p.get('from') && smsView(p.get('view')) === 'thread') {
    return threads()
  }

  const devs = await api('/devices').catch(() => ({ devices: [] }))
  const activeDevs = devs.devices.filter((d) => d.status !== 'revoked')

  const toDateInput = (ts) => {
    if (!ts) return ''
    const d = new Date(Number(ts))
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  // 类别切换放在最外层，而不是埋在「更多筛选」里：
  // 「我要看通话记录」是个独立意图，不该让人先想到它是一种「消息筛选」
  const kindNow = get('kind')
  const segLink = (k) => {
    const q = new URLSearchParams(location.search)
    k ? q.set('kind', k) : q.delete('kind')
    q.delete('offset')
    return `/events?${q.toString()}`
  }

  render(`
    <h1>${kindNow === 'call' ? '通话记录' : kindNow === 'notification' ? '应用通知' : '消息'}</h1>
    ${msgSegs(kindNow, segLink)}
    ${kindNow === 'sms' ? viewToggle('list') : ''}
    <div class="card">
      <input id="f_q" placeholder="${kindNow === 'call' ? '搜索号码' : '搜索发件人或正文'}" value="${esc(get('q'))}">
      <details id="adv" ${['from', 'device', 'direction', 'since', 'until'].some((k) => get(k)) ? 'open' : ''}>
        <summary class="muted">更多筛选</summary>
        <label>来源号码</label>
        <input id="f_from" inputmode="tel" value="${esc(get('from'))}" placeholder="支持部分匹配，如 955">
        ${activeDevs.length > 1 ? `
          <label>设备</label>
          <select id="f_device">
            <option value="">全部设备</option>
            ${activeDevs.map((d) => `<option value="${esc(d.id)}"${get('device') === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
          </select>` : ''}
        <label>方向</label>
        <select id="f_direction">
          <option value="">全部</option>
          <option value="in"${get('direction') === 'in' ? ' selected' : ''}>${kindNow === 'call' ? '来电' : '收到的'}</option>
          <option value="out"${get('direction') === 'out' ? ' selected' : ''}>${kindNow === 'call' ? '去电' : '本机发出的'}</option>
        </select>
        <div style="display:flex;gap:8px">
          <div class="grow"><label>起始日期</label><input id="f_since" type="date" value="${toDateInput(get('since'))}"></div>
          <div class="grow"><label>结束日期</label><input id="f_until" type="date" value="${toDateInput(get('until'))}"></div>
        </div>
        <div class="btnrow">
          <button id="f_apply" class="sm">应用筛选</button>
          <button id="f_clear" class="ghost sm">清空</button>
          <button id="f_del" class="danger sm">删除符合条件的</button>
        </div>
        <div class="muted">删除按上面的<b>设备、类型、方向、时间范围</b>执行，
        不含关键词与号码——那两项要逐条解密才能判断，条件写错就是不可逆的误删。</div>
      </details>
    </div>
    <div id="list"><div class="loading">加载中…</div></div>`)

  const buildQuery = (over = {}) => {
    const q = new URLSearchParams()
    const vals = {
      q: $('#f_q').value.trim(),
      from: $('#f_from')?.value.trim() ?? '',
      device: $('#f_device')?.value ?? '',
      kind: kindNow,
      direction: $('#f_direction')?.value ?? '',
      // 结束日期按当天 23:59:59 算，否则选了同一天会查不到任何东西
      since: $('#f_since')?.value ? new Date(`${$('#f_since').value}T00:00:00`).getTime() : '',
      until: $('#f_until')?.value ? new Date(`${$('#f_until').value}T23:59:59`).getTime() : '',
      limit, offset: 0,
      ...over,
    }
    for (const [k, v] of Object.entries(vals)) if (v !== '' && v != null) q.set(k, String(v))
    return q
  }

  for (const a of app.querySelectorAll('[data-seg]')) {
    a.onclick = (e) => { e.preventDefault(); go(a.getAttribute('href')) }
  }

  const apply = (over) => go(`/events?${buildQuery(over).toString()}`)

  $('#f_del').onclick = async () => {
    const body = {
      device: $('#f_device')?.value || undefined,
      kind: kindNow || undefined,
      direction: $('#f_direction')?.value || undefined,
      since: $('#f_since')?.value ? new Date(`${$('#f_since').value}T00:00:00`).getTime() : undefined,
      until: $('#f_until')?.value ? new Date(`${$('#f_until').value}T23:59:59`).getTime() : undefined,
      confirm: true,
    }
    const conds = [
      body.device ? `设备 ${activeDevs.find((d) => d.id === body.device)?.name ?? body.device}` : '',
      body.kind ? `类型 ${(RULE_KINDS.find(([v]) => v === body.kind) || [, body.kind])[1]}` : '',
      body.direction ? (body.direction === 'out' ? '本机发出的' : '收到的') : '',
      body.since || body.until ? '指定时间范围内' : '',
    ].filter(Boolean)

    const what = conds.length ? conds.join('、') : '【全部消息】'
    if (!confirm(`要删除的是：${what}\n\n删了就没了，没有回收站。确定吗？`)) return
    // 无条件清空是最危险的一种，再问一次
    if (conds.length === 0 && !confirm('再确认一次：这会清空所有历史消息。')) return

    try {
      const r = await api('/events/bulk-delete', { method: 'POST', body })
      toast(`已删除 ${r.deleted} 条`)
      events()
    } catch (e) { toast(e.message) }
  }
  $('#f_apply').onclick = () => apply({})
  // 清空筛选但保留当前类别：在「通话」页点清空却跳回「全部」是反直觉的
  $('#f_clear').onclick = () => go(kindNow ? `/events?kind=${kindNow}` : '/events')
  $('#f_q').onkeydown = (e) => { if (e.key === 'Enter') apply({}) }

  try {
    const query = new URLSearchParams(location.search)
    query.set('limit', String(limit))
    query.set('offset', String(offset))
    const r = await api(`/events?${query.toString()}`)

    const from = r.total === 0 ? 0 : offset + 1
    const to = Math.min(offset + limit, r.total)
    const multi = activeDevs.length > 1

    // 没搜完时不能假装 total 是总数：这里区分「共 N 条」和「已找到 N 条」
    const counter = r.total === 0
      ? (r.exhausted === false ? '这一段时间里没找到' : '没有匹配的消息')
      : r.exhausted === false
        ? `已找到 ${r.total} 条`
        : `第 ${from}–${to} 条，共 ${r.total} 条`

    $('#list').innerHTML = `
      <div class="card tight row">
        <span class="muted">${counter}</span>
        <select id="f_limit" class="sm">
          ${[30, 50, 100].map((n) => `<option value="${n}"${limit === n ? ' selected' : ''}>每页 ${n}</option>`).join('')}
        </select>
      </div>
      ${r.exhausted === false ? `
        <div class="card">
          <div class="row">
            <span class="badge warn">只搜了最近的部分</span>
            <span class="muted mono" style="font-size:12px">已扫 ${r.scanned} 条</span>
          </div>
          <div class="muted" style="margin-top:8px">
            号码和正文是加密存的，只能逐条解开再比对，所以一次请求有时间预算。
            ${r.scanned_to ? `这次搜到 <b>${fmtDate(r.scanned_to)}</b> 为止，更早的还没搜。` : ''}
          </div>
          <div class="btnrow">
            <button class="sm" id="deep">继续往更早搜</button>
            <button class="ghost sm" id="bydate">改用时间范围找</button>
          </div>
        </div>` : ''}
      ${r.events.length ? `<div class="card list">${r.events.map((e) =>
        e.kind === 'call' ? callRow(e, multi) : `
        <div class="item striped ${stripeOf(e.kind, e.direction)}" data-id="${esc(e.id)}">
          <div class="row">
            <b class="truncate">${e.direction === 'out' && e.kind === 'sms' ? '→ ' : ''}${esc(e.from)}</b>
            <span class="muted mono" style="font-size:12px;flex:none">${fmt(e.occurred_at)}</span>
          </div>
          <div class="muted truncate" style="margin-top:3px">${esc(e.content)}</div>
          ${metaLine(
            // e.sim 由服务端算：只有一张卡时是空串，不显示
            [e.sim, e.direction === 'out' && e.kind === 'sms' ? '本机发出' : '', ...e.matched_rules],
            e.device_id, e.device_name, multi,
          )}
        </div>`).join('')}</div>` : ''}
      ${r.total > limit ? `
        <div class="card tight row">
          <button class="ghost sm" id="p_prev" ${offset === 0 ? 'disabled' : ''}>上一页</button>
          <span class="muted">${Math.floor(offset / limit) + 1} / ${Math.ceil(r.total / limit)}</span>
          <button class="ghost sm" id="p_next" ${to >= r.total ? 'disabled' : ''}>下一页</button>
        </div>` : ''}`

    for (const el of $('#list').querySelectorAll('.item')) {
      el.onclick = () => go(`/events/${el.dataset.id}`)
    }
    $('#f_limit').onchange = (e) => apply({ limit: Number(e.target.value), offset: 0 })
    const prev = $('#p_prev'); if (prev) prev.onclick = () => apply({ offset: Math.max(0, offset - limit) })
    const next = $('#p_next'); if (next) next.onclick = () => apply({ offset: offset + limit })

    const deep = $('#deep')
    if (deep) deep.onclick = () => {
      deep.disabled = true
      deep.textContent = '搜索中，可能要几秒…'
      apply({ deep: 1, offset: 0 })
    }
    const byDate = $('#bydate')
    if (byDate) byDate.onclick = () => {
      $('#adv').open = true
      $('#f_since').focus()
      toast('填上起止日期，搜索会先按时间缩小范围')
    }
  } catch (e) { fail(e) }
}

const KIND_LABEL = { sms: '短信', call: '来电', notification: '应用通知' }

async function eventDetail(id) {
  render('<div class="loading">加载中…</div>')
  try {
    let e
    try { e = await api(`/events/${encodeURIComponent(id)}`) }
    catch { return render('<div class="card muted">消息不存在或已删除。</div>') }

    render(`
      <div class="pagehead row" style="align-items:flex-start">
        <h1 class="wrap" style="margin:0">${esc(e.from)}</h1>
        <a href="/events" data-back="/events" class="muted" style="flex:none">← 返回</a>
      </div>
      <div class="row" style="justify-content:flex-start;gap:6px;margin-bottom:12px">
        ${kindBadge(e.kind, e.direction)}
        <span class="badge ${deviceClass(e.device_id)}">${esc(e.device_name || e.device_id)}</span>
        ${e.sim ? `<span class="badge plain">${esc(e.sim)}</span>` : ''}
      </div>
      <div class="card">
        <div class="wrap" style="font-size:16px">${esc(e.content)}</div>
      </div>
      <div class="card tight">
        <div class="row"><span class="muted">发生时间</span><span class="mono">${new Date(e.occurred_at).toLocaleString('zh-CN', { hour12: false })}</span></div>
        <div class="row"><span class="muted">上报延迟</span><span class="mono">${e.received_at - e.occurred_at} ms</span></div>
        <div class="row"><span class="muted">类型</span><span>${KIND_LABEL[e.kind] || esc(e.kind)}${e.direction === 'out' ? '（手机发出）' : ''}</span></div>
        <div class="row"><span class="muted">命中规则</span><span>${e.matched_rules.length ? esc(e.matched_rules.join('、')) : '兜底规则'}</span></div>
      </div>
      <div class="btnrow">
        ${e.kind === 'call' ? `<a href="tel:${encodeURIComponent(e.from)}"><button class="sm">拨回</button></a>` : ''}
        <a href="/compose?to=${encodeURIComponent(e.from)}&ref=${encodeURIComponent(e.id)}&dev=${encodeURIComponent(e.device_id)}${e.sim_slot == null ? '' : `&sim=${e.sim_slot}`}"><button class="${e.kind === 'call' ? 'ghost sm' : 'sm'}">${e.kind === 'call' ? '发短信' : '回复'}</button></a>
        ${e.kind === 'call' ? '' : '<button class="ghost sm" id="copy">复制正文</button>'}
        <button class="danger sm" id="del">删除</button>
      </div>`)

    $('#del').onclick = async () => {
      // 没有回收站，所以确认框里要把内容摆出来，让人看清删的是哪条
      if (!confirm(`删除这条消息？\n\n${e.from}：${e.content.slice(0, 40)}\n\n删了就没了，没有回收站。`)) return
      try {
        await api(`/events/${encodeURIComponent(e.id)}`, { method: 'DELETE' })
        toast('已删除')
        go('/events')
      } catch (err) { toast(err.message) }
    }

    const copy = $('#copy')
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(e.content); toast('已复制') }
      catch { toast('复制失败，请手动选择') }
    }
  } catch (e) { fail(e) }
}

// ── 发送 ────────────────────────────────────────────────────

async function compose() {
  const p = new URLSearchParams(location.search)
  render('<div class="loading">加载中…</div>')
  try {
    const { devices: ds } = await api('/devices')
    const online = ds.filter((d) => d.status === 'online')

    // 从消息详情点「回复」过来时预选原设备：多卡场景下必须从收到短信的
    // 那张卡发回去，否则对方看到的是一个陌生号码
    const preferred = p.get('dev')
    render(`
      <div class="row">
        <h1>发送短信</h1>
        <a href="/sent" class="muted">发送记录 →</a>
      </div>
      <div class="card">
        <label>设备</label>
        <select id="dev">${online.length
          ? online.map((d) => `<option value="${esc(d.id)}"${d.id === preferred ? ' selected' : ''}>${esc(d.name)}</option>`).join('')
          : '<option value="">没有在线设备</option>'}</select>
        ${preferred && !online.some((d) => d.id === preferred)
          ? '<div class="muted" style="color:var(--warn)">收到这条消息的设备当前不在线，换用其他设备发送时对方看到的会是另一个号码。</div>'
          : ''}
        <!-- 卡槽跟着设备走，换设备要重画 -->
        <div id="simbox"></div>
        <label>收件人</label>
        <input id="to" inputmode="tel" value="${esc(p.get('to') || '')}">
        <label>内容</label>
        <textarea id="text"></textarea>
        <div class="btnrow"><button id="send" ${online.length ? '' : 'disabled'}>发送</button></div>
        <div id="err" class="err-text"></div>
      </div>
      <div id="status"></div>`)

    // 回复时预选原来那张卡：多卡场景下从别的卡发回去，对方看到的是陌生号码
    const prefSim = p.get('sim') === null ? null : Number(p.get('sim'))
    const drawSims = () => {
      const dev = online.find((d) => d.id === $('#dev').value)
      $('#simbox').innerHTML = simSelect('sim', simsOf(dev), prefSim)
    }
    drawSims()
    $('#dev').onchange = drawSims

    $('#send').onclick = async () => {
      const to = $('#to').value.trim(), text = $('#text').value
      if (!to || !text) return ($('#err').textContent = '收件人与内容都要填')
      $('#send').disabled = true
      $('#err').textContent = ''
      try {
        const sim = $('#sim')
        const r = await api('/outbound', {
          method: 'POST',
          body: { device_id: $('#dev').value, to, text, ...(sim && sim.value !== '' ? { sim_slot: Number(sim.value) } : {}) },
        })
        trackOutbound(r.id)
      } catch (e) {
        $('#err').textContent = e.message
        $('#send').disabled = false
      }
    }
  } catch (e) { fail(e) }
}

/**
 * 网关自己发出去的短信记录。
 *
 * 与「消息」页分开：那边是收到的，这边是发出的，混在一起看反而费劲。
 * 设备上用户手动发的短信会作为 direction=out 的事件进「消息」页，
 * 这里只收网关下发的任务——两条路径的失败原因完全不同。
 */
// ── 会话（像短信 App 一样） ──────────────────────────────────

/**
 * 按号码归拢的会话列表。
 *
 * 和「消息」页是两种看法：那边是一条时间线，用来找「刚才那条验证码」；
 * 这边按人分组，用来回答「这个号码之前跟我说过什么」——
 * 后者在一列时间戳里翻是很费劲的，而手机上本来就是分好组的。
 */
async function threads() {
  render(`
    <h1>短信</h1>
    ${msgSegs('sms')}
    ${viewToggle('thread')}
    <div id="list"><div class="loading">加载中…</div></div>`)

  try {
    const r = await api('/threads')
    $('#list').innerHTML = r.threads.length ? `
      ${r.truncated ? `<div class="card tight muted">按最近 ${r.scanned} 条记录归组。更早的记录进到会话里还能继续往前翻。</div>` : ''}
      <div class="card list">${r.threads.map((t) => `
        <div class="item" data-key="${esc(t.key)}">
          <div class="thline">
            <div class="avatar ${deviceClass(t.key)}">${esc(avatarOf(t.number))}</div>
            <div class="col grow" style="min-width:0">
              <div class="row">
                <b class="truncate">${esc(t.number)}</b>
                <span class="muted mono" style="font-size:12px;flex:none">${fmt(t.last_at)}</span>
              </div>
              <div class="muted truncate">${t.last_direction === 'out' ? '你：' : ''}${esc(t.last_text)}</div>
            </div>
          </div>
        </div>`).join('')}</div>`
      : '<div class="card muted">还没有短信往来。</div>'

    for (const el of app.querySelectorAll('.item')) {
      el.onclick = () => go(`/threads/${encodeURIComponent(el.dataset.key)}`)
    }
  } catch (e) { fail(e) }
}

/**
 * 头像位：号码取后两位，字母发件人取首字母。
 *
 * 底色由号码哈希决定（和设备色是同一套），因为后两位撞得很厉害——
 * 一屏里能出现三个「00」。真正让人一眼认出是谁的是颜色，不是那两个数字。
 */
function avatarOf(number) {
  const digits = String(number).replace(/\D/g, '')
  if (digits.length >= 2) return digits.slice(-2)
  return String(number).trim().slice(0, 2).toUpperCase() || '#'
}

/** 一条会话：气泡对话 + 底部直接回复。 */
async function thread(key) {
  render('<div class="loading">加载中…</div>')
  try {
    const r = await api(`/threads/${encodeURIComponent(key)}`)
    const devs = (await api('/devices').catch(() => ({ devices: [] }))).devices
    const online = devs.filter((d) => d.status === 'online')
    const multi = devs.filter((d) => d.status !== 'revoked').length > 1

    // 回复默认用最近一条收到的消息那台设备、那张卡：
    // 换一张卡发回去，对方看到的是陌生号码
    const prefDev = online.some((d) => d.id === r.reply_device) ? r.reply_device : (online[0]?.id ?? '')

    let lastDay = ''
    const bubbles = r.items.map((x) => {
      const day = new Date(x.at).toLocaleDateString('zh-CN')
      const sep = day === lastDay ? '' : `<div class="daysep">${esc(dayLabel(x.at))}</div>`
      lastDay = day
      const failed = x.source === 'outbound' && x.status === 'failed'
      const meta = [
        new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        multi && x.device_name ? esc(x.device_name) : '',
        x.sim ? esc(x.sim) : '',
        x.source === 'outbound' ? esc((OUTBOUND_STATUS.find(([v]) => v === x.status) || [, x.status ?? ''])[1]) : '',
        failed && x.error ? esc(x.error) : '',
      ].filter(Boolean).join(' · ')
      return `${sep}<div class="bub ${x.direction === 'out' ? 'out' : 'in'}${failed ? ' fail' : ''}"
        data-id="${esc(x.id)}" data-src="${esc(x.source)}">${esc(x.text)}<span class="stamp">${meta}</span></div>`
    }).join('')

    render(`
      <div class="pagehead row" style="align-items:flex-start">
        <h1 class="wrap" style="margin:0">${esc(r.number)}</h1>
        <a href="${esc(THREAD_HOME)}" data-back="${esc(THREAD_HOME)}" class="muted" style="flex:none">← 返回</a>
      </div>
      ${r.truncated ? '<div class="card tight muted">只列出了最近的往来。</div>' : ''}
      <div class="card"><div class="thread">${bubbles}</div></div>
      <div class="card">
        ${online.length ? `
          <label>回复</label>
          <textarea id="t_text" rows="2" placeholder="输入内容，回车换行"></textarea>
          ${multi ? `<label>用哪台设备</label>
            <select id="t_dev">${online.map((d) =>
              `<option value="${esc(d.id)}"${d.id === prefDev ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
          <div id="t_simbox"></div>
          <div class="btnrow"><button id="t_send">发送</button></div>
          <div id="t_err" class="err-text"></div>`
          : '<div class="muted">没有在线设备，暂时无法回复。</div>'}
      </div>`)

    for (const el of app.querySelectorAll('.bub')) {
      el.onclick = () => go(`${el.dataset.src === 'outbound' ? '/sent/' : '/events/'}${encodeURIComponent(el.dataset.id)}`)
    }
    // 打开就停在最新一条：对话是从下往上看的
    const last = app.querySelector('.bub:last-of-type')
    if (last) { last.scrollIntoView({ block: 'center' }); viewScrolled = true }

    if (!online.length) return

    const devOf = () => devs.find((d) => d.id === ($('#t_dev')?.value || prefDev))
    const drawSims = () => {
      $('#t_simbox').innerHTML = simSelect('t_sim', simsOf(devOf()), r.reply_sim)
    }
    drawSims()
    if ($('#t_dev')) $('#t_dev').onchange = drawSims

    $('#t_send').onclick = async () => {
      const text = $('#t_text').value
      if (!text.trim()) return ($('#t_err').textContent = '内容不能为空')
      $('#t_send').disabled = true
      $('#t_err').textContent = ''
      try {
        const sim = $('#t_sim')
        await api('/outbound', {
          method: 'POST',
          body: {
            device_id: $('#t_dev')?.value || prefDev,
            to: r.number, text,
            ...(sim && sim.value !== '' ? { sim_slot: Number(sim.value) } : {}),
          },
        })
        toast('已提交发送')
        thread(key)
      } catch (e) {
        $('#t_err').textContent = e.message
        $('#t_send').disabled = false
      }
    }
  } catch (e) { fail(e) }
}

/** 今天/昨天说人话，再往前给日期。 */
function dayLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = (a, b) => a.toDateString() === b.toDateString()
  if (sameDay(d, today)) return `今天 ${d.toLocaleDateString('zh-CN')}`
  const y = new Date(today.getTime() - 86400000)
  if (sameDay(d, y)) return `昨天 ${d.toLocaleDateString('zh-CN')}`
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

async function sent() {
  const p = new URLSearchParams(location.search)
  const get = (k, d = '') => p.get(k) ?? d
  const limit = Number(get('limit', '30'))
  const offset = Number(get('offset', '0'))

  const devs = await api('/devices').catch(() => ({ devices: [] }))
  const activeDevs = devs.devices.filter((d) => d.status !== 'revoked')
  const STATUS = [['', '全部状态'], ...OUTBOUND_STATUS.map(([v, t]) => [v, t])]

  render(`
    <div class="row">
      <h1>发送记录</h1>
      <a href="/compose" class="muted">← 发送短信</a>
    </div>
    <div class="card">
      <input id="f_to" inputmode="tel" placeholder="按收件人号码筛选" value="${esc(get('to'))}">
      <div style="display:flex;gap:8px">
        <div class="grow">
          <label>状态</label>
          <select id="f_status">
            ${STATUS.map(([v, t]) => `<option value="${v}"${get('status') === v ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        ${activeDevs.length > 1 ? `
          <div class="grow">
            <label>设备</label>
            <select id="f_device">
              <option value="">全部设备</option>
              ${activeDevs.map((d) => `<option value="${esc(d.id)}"${get('device') === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
            </select>
          </div>` : ''}
      </div>
      <div class="btnrow">
        <button id="f_apply" class="sm">应用筛选</button>
        <button id="f_clear" class="ghost sm">清空</button>
      </div>
    </div>
    <div id="list"><div class="loading">加载中…</div></div>`)

  const buildQuery = (over = {}) => {
    const q = new URLSearchParams()
    const vals = {
      to: $('#f_to').value.trim(),
      status: $('#f_status').value,
      device: $('#f_device')?.value ?? '',
      limit, offset: 0,
      ...over,
    }
    for (const [k, v] of Object.entries(vals)) if (v !== '' && v != null) q.set(k, String(v))
    return q
  }
  const apply = (over) => go(`/sent?${buildQuery(over).toString()}`)
  $('#f_apply').onclick = () => apply({})
  $('#f_clear').onclick = () => go('/sent')
  $('#f_to').onkeydown = (e) => { if (e.key === 'Enter') apply({}) }

  try {
    const query = new URLSearchParams(location.search)
    query.set('limit', String(limit))
    query.set('offset', String(offset))
    const r = await api(`/outbound?${query.toString()}`)

    const from = r.total === 0 ? 0 : offset + 1
    const to = Math.min(offset + limit, r.total)
    const multi = activeDevs.length > 1

    $('#list').innerHTML = `
      <div class="card tight row">
        <span class="muted">${r.total === 0 ? '还没有发送记录' : `第 ${from}–${to} 条，共 ${r.total} 条`}</span>
        <select id="f_limit" class="sm">
          ${[30, 50, 100].map((n) => `<option value="${n}"${limit === n ? ' selected' : ''}>每页 ${n}</option>`).join('')}
        </select>
      </div>
      ${r.outbound.length ? `<div class="card list">${r.outbound.map((o) => `
        <div class="item striped ${outboundStripe(o.status)}" data-id="${esc(o.id)}">
          <div class="row">
            <b class="truncate">→ ${esc(o.to)}</b>
            <span class="muted mono" style="font-size:12px;flex:none">${fmt(o.created_at)}</span>
          </div>
          <div class="muted truncate" style="margin-top:3px">${esc(o.text)}</div>
          <div class="row" style="justify-content:flex-start;gap:6px;margin-top:6px">
            ${statusBadge(o.status)}
            ${o.error ? `<span class="badge err">${esc(o.error)}</span>` : ''}
          </div>
          ${metaLine([o.sim], o.device_id, o.device_name, multi)}
        </div>`).join('')}</div>` : ''}
      ${r.total > limit ? `
        <div class="card tight row">
          <button class="ghost sm" id="p_prev" ${offset === 0 ? 'disabled' : ''}>上一页</button>
          <span class="muted">${Math.floor(offset / limit) + 1} / ${Math.ceil(r.total / limit)}</span>
          <button class="ghost sm" id="p_next" ${to >= r.total ? 'disabled' : ''}>下一页</button>
        </div>` : ''}`

    for (const el of $('#list').querySelectorAll('.item')) {
      el.onclick = () => go(`/sent/${el.dataset.id}`)
    }
    $('#f_limit').onchange = (e) => apply({ limit: Number(e.target.value), offset: 0 })
    const prev = $('#p_prev'); if (prev) prev.onclick = () => apply({ offset: Math.max(0, offset - limit) })
    const next = $('#p_next'); if (next) next.onclick = () => apply({ offset: offset + limit })
  } catch (e) { fail(e) }
}

/**
 * 单条发送记录。
 *
 * 列表里正文是截断的，而发出去的内容恰恰经常很长（保号短信、转发的验证码），
 * 看不到全文就没法判断「这条到底发的是什么」。
 */
async function sentDetail(id) {
  render('<div class="loading">加载中…</div>')
  try {
    let o
    try { o = await api(`/outbound/${encodeURIComponent(id)}`) }
    catch { return render('<div class="card muted">发送记录不存在。</div>') }

    const steps = OUTBOUND_STATUS.filter(([v]) => v !== 'failed')
    const idx = steps.findIndex(([v]) => v === o.status)
    const failed = o.status === 'failed'

    render(`
      <div class="pagehead row" style="align-items:flex-start">
        <h1 class="wrap" style="margin:0">→ ${esc(o.to)}</h1>
        <a href="/sent" data-back="/sent" class="muted" style="flex:none">← 返回</a>
      </div>
      <div class="row" style="justify-content:flex-start;gap:6px;margin-bottom:12px">
        ${statusBadge(o.status)}
        <span class="badge ${deviceClass(o.device_id)}">${esc(o.device_name)}</span>
        ${o.sim ? `<span class="badge plain">${esc(o.sim)}</span>` : ''}
      </div>

      <div class="card">
        <div class="wrap" style="font-size:16px">${esc(o.text)}</div>
        <div class="muted" style="margin-top:8px">${[...o.text].length} 字${[...o.text].length > 70 ? '（超过 70 字会拆成多条发送）' : ''}</div>
      </div>

      <h2>投递过程</h2>
      <div class="card">
        <div class="track">
          ${steps.map(([v, t], i) => `
            <span class="badge ${failed ? (i === 0 ? 'err' : 'plain') : i <= idx ? 'ok' : 'plain'}">${t}</span>`).join('')}
          ${failed ? '<span class="badge err">失败</span>' : ''}
        </div>
        ${o.error ? `<div class="err-text">${esc(o.error)}</div>` : ''}
        ${o.status === 'sent' ? '<div class="muted" style="margin-top:10px">已交给运营商。停在这一步通常是对方网络没回送达报告，不代表没收到。</div>' : ''}
        ${o.status === 'pending' ? '<div class="muted" style="margin-top:10px">还没送到设备。设备离线时会一直停在这里。</div>' : ''}
      </div>

      <div class="card tight">
        <div class="row"><span class="muted">创建时间</span><span class="mono">${new Date(o.created_at).toLocaleString('zh-CN', { hour12: false })}</span></div>
        <div class="row"><span class="muted">最后更新</span><span class="mono">${new Date(o.updated_at).toLocaleString('zh-CN', { hour12: false })}</span></div>
        <div class="row"><span class="muted">耗时</span><span class="mono">${o.updated_at > o.created_at ? `${((o.updated_at - o.created_at) / 1000).toFixed(1)} s` : '—'}</span></div>
        <div class="row"><span class="muted">任务号</span><span class="mono truncate" style="max-width:60%">${esc(o.id)}</span></div>
      </div>

      <div class="btnrow">
        <a href="/compose?to=${encodeURIComponent(o.to)}&dev=${encodeURIComponent(o.device_id)}"><button class="sm">再发一条</button></a>
        <button class="ghost sm" id="copy">复制正文</button>
        <button class="danger sm" id="del">删除记录</button>
      </div>`)

    $('#del').onclick = async () => {
      // 说清楚删的是什么：短信早就发出去了，删记录不等于撤回
      if (!confirm(`删除这条发送记录？\n\n→ ${o.to}：${o.text.slice(0, 40)}\n\n短信已经发出去了，删的只是这条记录。`)) return
      try {
        await api(`/outbound/${encodeURIComponent(o.id)}`, { method: 'DELETE' })
        toast('已删除')
        go('/sent')
      } catch (err) { toast(err.message) }
    }

    $('#copy').onclick = async () => {
      try { await navigator.clipboard.writeText(o.text); toast('已复制') }
      catch { toast('复制失败，请手动选择') }
    }
  } catch (e) { fail(e) }
}

/** 状态机进度：accepted → sent → delivered，每一步都可见（计划 §5.5）。 */
function trackOutbound(id) {
  const steps = OUTBOUND_STATUS.filter(([v]) => v !== 'pending' && v !== 'failed')
  const paint = (status, error) => {
    const idx = steps.findIndex(([s]) => s === status)
    $('#status').innerHTML = `
      <div class="card">
        <div class="track">${steps.map(([s, label], i) => `
          <span class="badge ${status === 'failed' ? (i === 0 ? 'err' : 'plain') : i <= idx ? 'ok' : 'plain'}">${label}</span>
        `).join('')}</div>
        ${status === 'failed' ? `<div class="err-text">发送失败：${esc(error || '未知原因')}</div>` : ''}
        ${status === 'delivered' ? '<div class="muted" style="margin-top:8px">已送达对方手机</div>' : ''}
      </div>`
  }
  paint('pending')

  let n = 0
  const timer = setInterval(async () => {
    n++
    try {
      const o = await api(`/outbound/${id}`)
      paint(o.status, o.error)
      if (o.status === 'delivered' || o.status === 'failed' || n > 30) {
        clearInterval(timer)
        $('#send').disabled = false
      }
    } catch { clearInterval(timer) }
  }, 1500)
}

// ── 规则 ────────────────────────────────────────────────────

async function rules() {
  render('<div class="loading">加载中…</div>')
  try {
    const [{ rules: rs }, { channels: chs }, { devices: devs }] = await Promise.all([
      api('/rules'), api('/channels'), api('/devices'),
    ])
    const activeDevs = devs.filter((d) => d.status !== 'revoked')

    render(`
      <h1>规则</h1>
      <p class="muted">按优先级从小到大匹配。没有规则命中时走兜底：推送到全部启用渠道并归档。</p>
      ${!rs.length && chs.length ? `<div class="card">
        <b>还没有规则</b>
        <p class="muted">可以一键写入建议规则，按顺序匹配：<br>
        <b>验证码</b> 高优先级、自动提取、穿透专注模式<br>
        <b>广告推广</b> 只归档不推送<br>
        <b>应用通知</b> App 推送来的验证码走这条<br>
        <b>已发送短信</b> 本机发出的，只归档不推送<br>
        <b>普通短信</b> 以上都不是，正常推送<br>
        <b>来电</b> 单独分组，点击可预填回复<br>
</p>
        <div class="btnrow"><button id="seed" class="sm">写入建议规则</button></div>
      </div>` : ''}
      ${rs.length ? `<div class="card list">${rs.map((r) => `
        <div class="item" data-id="${esc(r.id)}">
          <div class="row">
            <div class="col grow">
              <b>${esc(r.name)}</b>
              <span class="muted">优先级 ${r.priority} · ${r.action.channels.length ? `${r.action.channels.length} 个渠道` : '只归档'}${r.action.extract_code ? ' · 提取验证码' : ''}</span>
              <span class="muted">${esc(matchSummary(r.match))}</span>
              ${r.match.device_ids?.length
                ? `<span class="muted">仅限 ${r.match.device_ids.map((id) => esc(activeDevs.find((d) => d.id === id)?.name || id)).join('、')}</span>`
                : ''}
              ${r.dangling_channels?.length ? '<span class="badge err">推送目标已失效，命中后不会送达</span>' : ''}
            </div>
            <span class="badge ${r.enabled ? 'ok' : ''}">${r.enabled ? '启用' : '停用'}</span>
          </div>
        </div>`).join('')}</div>` : '<div class="card muted">还没有规则，当前全部走兜底。</div>'}
      <div class="btnrow"><button id="add">新建规则</button></div>`)

    $('#add').onclick = () => ruleEditor(null, chs, activeDevs)
    const seedBtn = $('#seed')
    if (seedBtn) seedBtn.onclick = async () => {
      seedBtn.disabled = true
      try {
        const r = await api('/rules/seed', { method: 'POST', body: { channels: chs.map((c) => c.id) } })
        toast(`已写入 ${r.created} 条规则`)
        rules()
      } catch (e) { toast(e.message); seedBtn.disabled = false }
    }
    for (const el of app.querySelectorAll('.item')) {
      el.onclick = () => ruleEditor(rs.find((r) => r.id === el.dataset.id), chs, activeDevs)
    }
  } catch (e) { fail(e) }
}

/**
 * 一行话概括这条规则匹配什么。
 *
 * 列表页只显示名字的话，「验证码」和「验证码2」放在一起根本分不清谁是谁，
 * 只能一条条点进去看。
 */
function matchSummary(m) {
  const parts = []
  if (m.kind?.length) parts.push(m.kind.map((k) => (RULE_KINDS.find(([v]) => v === k) || [, k])[1]).join('/'))
  if (m.direction?.length === 1) parts.push(m.direction[0] === 'out' ? '发出的' : '收到的')
  if (m.sender?.values?.length) {
    const label = (SENDER_MODES.find(([v]) => v === m.sender.mode) || [, m.sender.mode])[1]
    parts.push(`发件人${label} ${m.sender.values.slice(0, 3).join('/')}${m.sender.values.length > 3 ? '…' : ''}`)
  } else if (m.sender_regex) {
    parts.push(`发件人正则 ${m.sender_regex}`)
  }
  if (m.content_contains?.length) {
    parts.push(`含 ${m.content_contains.slice(0, 3).join('/')}${m.content_contains.length > 3 ? '…' : ''}`)
  }
  if (m.content_excludes?.length) parts.push(`排除 ${m.content_excludes.slice(0, 2).join('/')}`)
  if (m.time_window) parts.push(`${m.time_window.from}–${m.time_window.to}`)
  if (m.device_ids?.length) parts.push(`限 ${m.device_ids.length} 台设备`)
  return parts.length ? parts.join(' · ') : '匹配全部消息'
}

/** 事件类型的显示名。列表页、筛选、规则编辑共用一份，免得三处各写各的。 */
const RULE_KINDS = [['sms', '短信'], ['call', '来电'], ['notification', '应用通知']]

const SENDER_MODES = [
  ['contains', '包含'], ['equals', '等于'], ['prefix', '开头是'],
  ['suffix', '尾号是'], ['regex', '正则（高级）'],
]

function ruleEditor(rule, chs, devs = []) {
  const r = rule || {
    id: null, name: '', priority: 100, enabled: true,
    match: {
      kind: [], sender: null, sender_regex: null,
      content_contains: [], content_excludes: [], content_regex: null,
      device_ids: [], direction: [], time_window: null,
    },
    action: {
      channels: [], priority: 'normal', extract_code: true,
      template: '【{sender}】{content}', archive: true, stop_processing: false,
    },
  }
  const m = r.match

  // 老规则只有 sender_regex，把它按正则模式显示出来，不让用户看见「两个发件人字段」
  const sender = m.sender && m.sender.values?.length
    ? { mode: m.sender.mode, values: m.sender.values }
    : m.sender_regex
      ? { mode: 'regex', values: [m.sender_regex] }
      : { mode: 'contains', values: [] }

  const win = m.time_window || null
  // 所有设备上的卡槽合起来去重：规则是全局的，不绑定某一台设备。
  // 单卡设备的 simsOf 返回空，所以只有真的有双卡机时这一节才出现
  const allSims = [...new Map(
    devs.flatMap((d) => simsOf(d)).map((x) => [x.slot, x]),
  ).values()].sort((a, b) => a.slot - b.slot)
  const bark = {
    level: 'active', group: '', copy_mode: 'code', auto_copy_code: true, deep_link: 'event',
    ...(r.action.bark || {}),
  }
  const ntfy = {
    priority: 'default', tags: [], copy_mode: 'code', deep_link: 'event',
    ...(r.action.ntfy || {}),
  }
  const webpush = { show_code: true, deep_link: 'event', ...(r.action.webpush || {}) }

  render(`
    <h1>${rule ? '编辑规则' : '新建规则'}</h1>
    <div class="card">
      <label>名称</label><input id="name" value="${esc(r.name)}">
      <label>优先级（数字小者先匹配）</label><input id="prio" type="number" value="${r.priority}">
      <label>启用</label>
      <select id="enabled"><option value="1"${r.enabled ? ' selected' : ''}>是</option><option value="0"${r.enabled ? '' : ' selected'}>否</option></select>
    </div>

    <h2>匹配条件</h2>
    <div class="card">
      <div class="muted">留空的条件表示不限制。多个条件之间是「都要满足」，同一条件里的多个值是「满足其一」。</div>

      <label>事件类型</label>
      <div class="chips">
        ${RULE_KINDS.map(([v, t]) => `
          <label class="tag" style="cursor:pointer">
            <input type="checkbox" data-kind="${v}" style="width:auto;margin-right:4px"${(m.kind || []).includes(v) ? ' checked' : ''}>
            <span>${t}</span>
          </label>`).join('')}
      </div>

      <label>方向</label>
      <select id="direction">
        <option value=""${!(m.direction || []).length ? ' selected' : ''}>全部</option>
        <option value="in"${(m.direction || []).join() === 'in' ? ' selected' : ''}>收到的</option>
        <option value="out"${(m.direction || []).join() === 'out' ? ' selected' : ''}>本机发出的</option>
      </select>

      <label>发件人</label>
      <select id="smode">
        ${SENDER_MODES.map(([v, t]) => `<option value="${v}"${sender.mode === v ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
      <div id="sbox" style="margin-top:7px"></div>
      <div class="muted" id="shint"></div>

      <label>正文包含</label>
      <div id="cbox"></div>

      <label>正文不包含</label>
      <div id="xbox"></div>
      <div class="muted">命中任意一个就排除掉，优先于上面的包含。常用来把带「退订」的营销短信挑出去。</div>

      <label>生效时段</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="w_from" type="time" value="${esc(win?.from || '')}" style="flex:1">
        <span class="muted">到</span>
        <input id="w_to" type="time" value="${esc(win?.to || '')}" style="flex:1">
      </div>
      <div class="muted">两个都留空表示全天。起点晚于终点表示跨午夜，如 23:00 到 07:00。按「设置 → 时区」里配的时区算。</div>

      <label>限定设备</label>
      ${devs.length > 1 ? `
        <div class="muted">勾选后这条规则只对选中的设备生效。不同卡走不同渠道就靠这里，
        给每张卡各建一条规则。</div>
        ${devs.map((d) => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0">
          <input type="checkbox" data-dev="${esc(d.id)}" style="width:auto"${(m.device_ids || []).includes(d.id) ? ' checked' : ''}>
          <span>${esc(d.name)} <span class="muted">${d.status === 'online' ? '在线' : '离线'}</span></span></label>`).join('')}
      ` : `<div class="muted">当前只有 ${devs.length} 台设备，无需限定。多设备时这里可以让不同的卡走不同的渠道。</div>`}
      ${allSims.length ? `
        <label>限定卡槽</label>
        <div class="muted">双卡机上两张卡的用途往往完全不同：一张收银行验证码，
        一张是垃圾短信重灾区，靠号码是分不完的。
        <b>卡槽未知的消息不会命中</b>（老版本 Agent 或系统不给这个信息）。</div>
        ${allSims.map((x) => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0">
          <input type="checkbox" data-sim="${x.slot}" style="width:auto"${(m.sim_slot || []).includes(x.slot) ? ' checked' : ''}>
          <span>${esc(simText(x))}</span></label>`).join('')}
      ` : ''}
    </div>

    <h2>动作</h2>
    <div class="card">
      <label>推送渠道</label>
      ${chs.length ? chs.map((c) => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0">
        <input type="checkbox" data-ch="${esc(c.id)}" style="width:auto"${r.action.channels.includes(c.id) ? ' checked' : ''}>
        <span>${esc(c.name)} <span class="muted">(${esc(c.type)})</span></span></label>`).join('')
        : '<div class="muted">还没有渠道，去「设置 → 渠道」添加。</div>'}
      <div class="muted">一个都不勾 = 只归档不推送。</div>

      <label>推送内容模板</label>
      <input id="tpl" class="mono" value="${esc(r.action.template)}">
      <div class="chips">
        ${TEMPLATE_VARS.map(([k, t]) => `<button type="button" class="ghost" data-var="${k}">${t}</button>`).join('')}
      </div>

      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="extract" style="width:auto"${r.action.extract_code ? ' checked' : ''}><span>提取验证码</span></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="stop" style="width:auto"${r.action.stop_processing ? ' checked' : ''}><span>命中后不再匹配后续规则</span></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="high" style="width:auto"${r.action.priority === 'high' ? ' checked' : ''}><span>高优先级（推送时出声）</span></label>

      <!-- 预览放在这些开关之后：它们都会改变通知的样子，先因后果 -->
      <div class="preview" id="tplpv"></div>
    </div>

    ${chs.some((c) => c.type === 'bark') ? `
      <h2>Bark 行为</h2>
      <div class="card">
        <div class="muted">这几项按消息类型配，所以放在规则里。对非 Bark 渠道无影响。</div>
        <label>通知级别</label>
        <select id="b_level">
          ${BARK_LEVELS.map(([v, t]) => `<option value="${v}"${bark.level === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <label>分组名</label>
        <input id="b_group" value="${esc(bark.group || '')}" placeholder="如 验证码">
        <div class="muted">通知中心按分组分栏。多设备时会自动再缀上设备名。</div>
        <label>长按通知复制什么</label>
        <select id="b_copymode">
          <option value="code"${(bark.copy_mode ?? 'code') === 'code' ? ' selected' : ''}>验证码（需同时开启下方「提取验证码」）</option>
          <option value="body"${bark.copy_mode === 'body' ? ' selected' : ''}>整条正文</option>
          <option value="none"${bark.copy_mode === 'none' ? ' selected' : ''}>不复制</option>
        </select>
        <div class="muted" id="b_copywarn"></div>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="b_copy" style="width:auto"${bark.auto_copy_code ? ' checked' : ''}><span>不用长按，通知到达即进剪贴板（部分 iOS 版本支持）</span></label>
        <label>点击通知跳转到</label>
        <select id="b_link">
          <option value="event"${bark.deep_link === 'event' ? ' selected' : ''}>消息详情</option>
          <option value="compose"${bark.deep_link === 'compose' ? ' selected' : ''}>预填回复</option>
          <option value="none"${bark.deep_link === 'none' ? ' selected' : ''}>不跳转</option>
        </select>
      </div>` : ''}
    ${chs.some((c) => c.type === 'webpush') ? `
      <h2>浏览器通知行为</h2>
      <div class="card">
        <div class="muted">浏览器通知上<b>没有复制按钮</b>——Service Worker 拿不到剪贴板。
        验证码只能放进正文。对非浏览器渠道无影响。</div>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="w_code" style="width:auto"${webpush.show_code ? ' checked' : ''}><span>正文开头带上提取出的验证码</span></label>
        <label>点击通知跳转到</label>
        <select id="w_link">
          <option value="event"${webpush.deep_link === 'event' ? ' selected' : ''}>消息详情</option>
          <option value="compose"${webpush.deep_link === 'compose' ? ' selected' : ''}>预填回复</option>
          <option value="none"${webpush.deep_link === 'none' ? ' selected' : ''}>不跳转</option>
        </select>
      </div>` : ''}
    ${chs.some((c) => c.type === 'ntfy') ? `
      <h2>ntfy 行为</h2>
      <div class="card">
        <div class="muted">字段与 Bark 那几项对齐，同一条规则在两个渠道上表现一致。对非 ntfy 渠道无影响。</div>
        <label>通知级别</label>
        <select id="n_prio">
          ${NTFY_LEVELS.map(([v, t]) => `<option value="${v}"${ntfy.priority === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <label>标签（可选）</label>
        <div id="n_tags"></div>
        <div class="muted">ntfy 认识一批 emoji 名（如 <span class="mono">warning</span>、
        <span class="mono">bank</span>），会渲染成 emoji 缀在标题前。</div>
        <label>点「复制」按钮时复制什么</label>
        <select id="n_copymode">
          <option value="code"${ntfy.copy_mode === 'code' ? ' selected' : ''}>验证码（需同时开启上方「提取验证码」）</option>
          <option value="body"${ntfy.copy_mode === 'body' ? ' selected' : ''}>整条正文</option>
          <option value="none"${ntfy.copy_mode === 'none' ? ' selected' : ''}>不放这个按钮</option>
        </select>
        <div class="muted" id="n_copywarn"></div>
        <label>点击通知跳转到</label>
        <select id="n_link">
          <option value="event"${ntfy.deep_link === 'event' ? ' selected' : ''}>消息详情</option>
          <option value="compose"${ntfy.deep_link === 'compose' ? ' selected' : ''}>预填回复</option>
          <option value="none"${ntfy.deep_link === 'none' ? ' selected' : ''}>不跳转</option>
        </select>
      </div>` : ''}
    <div class="btnrow">
      <button id="save">保存</button>
      <button class="ghost sm" id="test">用历史消息试跑</button>
      ${rule ? '<button class="danger sm" id="del">删除</button>' : ''}
      <button class="ghost sm" id="back">返回</button>
    </div>
    <div id="err" class="err-text"></div>
    <div id="testout"></div>`)

  // ── 发件人：正则模式用单行输入，其余用标签 ──────────────
  let senderTags = null
  const paintSender = () => {
    const mode = $('#smode').value
    const box = $('#sbox')
    if (mode === 'regex') {
      box.innerHTML = `<input id="sregex" class="mono" value="${esc(sender.mode === 'regex' ? (sender.values[0] || '') : '')}" placeholder="^(95533|95588)$">`
      senderTags = null
      $('#shint').textContent = '对完整发件人做正则匹配。写错的正则会让这条规则永不命中，先用下面的试跑确认。'
    } else {
      box.innerHTML = '<div class="tags"></div>'
      senderTags = tagInput(box.firstElementChild, sender.mode === 'regex' ? [] : sender.values, '如 95533，回车添加')
      $('#shint').textContent = {
        contains: '发件人里出现其中任意一段即可，不用管国际区号前缀。',
        equals: '完整相等才算。带不带 +86 是两个不同的值。',
        prefix: '常用于 106 开头的服务号。',
        suffix: '常用于只认尾号的场景，带不带国际区号都能命中。',
      }[mode]
    }
  }
  $('#smode').onchange = paintSender
  paintSender()

  const contentTags = tagInput(
    Object.assign($('#cbox'), { className: 'tags' }), m.content_contains || [], '如 验证码，回车添加',
  )
  const excludeTags = tagInput(
    Object.assign($('#xbox'), { className: 'tags' }), m.content_excludes || [], '如 退订，回车添加',
  )

  // ── 模板：点占位符插到光标处，并实时预览 ────────────────
  const tpl = $('#tpl')
  for (const b of app.querySelectorAll('[data-var]')) {
    b.onclick = () => {
      const token = `{${b.dataset.var}}`
      const at = tpl.selectionStart ?? tpl.value.length
      tpl.value = tpl.value.slice(0, at) + token + tpl.value.slice(tpl.selectionEnd ?? at)
      tpl.focus()
      tpl.selectionStart = tpl.selectionEnd = at + token.length
      paintPreview()
    }
  }
  const paintPreview = () => {
    const kinds = [...app.querySelectorAll('[data-kind]')].filter((c) => c.checked).map((c) => c.dataset.kind)
    const dir = $('#direction').value
    $('#tplpv').innerHTML = notifyPreview(tpl.value, {
      kind: kinds.length === 1 ? kinds[0] : 'sms',
      direction: dir || 'in',
      extractCode: $('#extract').checked,
      copyMode: $('#b_copymode')?.value,
      // 设备名与卡槽只在真的分得清的时候才出现在通知里，预览也照这个来
      device: devs.filter((d) => d.status !== 'revoked').length > 1 ? '日本卡' : '',
      sim: allSims.length > 1 ? simText(allSims[0]) : '',
    })
  }
  tpl.oninput = paintPreview
  // spoiler 点一下展开：CSP 不让写内联 onclick，事件在这里挂
  app.addEventListener('click', (e) => {
    if (e.target.classList?.contains('spoiler')) e.target.classList.toggle('show')
  })
  /**
   * 「复制验证码」和「提取验证码」是两个开关，但只有一个能单独生效。
   *
   * 选了复制验证码却没开提取，是个**不报错的死配置**：没有码可复制，
   * 发给 Bark 的请求里连 copy 字段都不会出现。踩到的人只会觉得
   * 「长按复制怎么没反应」，而界面上两个勾都好好地开着。
   * 拦不住（用户可能正要去开提取），但必须说出来。
   */
  const paintCopyWarn = () => {
    const msg = '<span class="badge err">这样配不会复制任何东西</span> 选了复制验证码，'
      + '但「提取验证码」没开——没有码可复制。要么把它打开，要么改成「整条正文」。'
    for (const [sel, warnId] of [['#b_copymode', '#b_copywarn'], ['#n_copymode', '#n_copywarn']]) {
      const warn = $(warnId)
      if (!warn) continue
      warn.innerHTML = $(sel).value === 'code' && !$('#extract').checked ? msg : ''
    }
  }

  // 类型、方向、提取验证码都会改变通知的样子，改哪个都要重画
  $('#extract').onchange = () => { paintPreview(); paintCopyWarn() }
  $('#direction').onchange = paintPreview
  for (const id of ['#b_copymode', '#n_copymode']) {
    if ($(id)) $(id).onchange = () => { paintPreview(); paintCopyWarn() }
  }
  // ntfy 的标签走标签输入，理由同关键词：中文输入法下逗号/顿号随时混进来
  const ntfyTagBox = $('#n_tags')
  const ntfyTags = ntfyTagBox
    ? tagInput(Object.assign(ntfyTagBox, { className: 'tags' }), ntfy.tags || [], '如 bank，回车添加')
    : null
  for (const c of app.querySelectorAll('[data-kind]')) c.addEventListener('change', paintPreview)
  paintPreview()
  paintCopyWarn()

  const collect = () => {
    const kinds = [...app.querySelectorAll('[data-kind]')].filter((c) => c.checked).map((c) => c.dataset.kind)
    const mode = $('#smode').value
    const values = mode === 'regex'
      ? [$('#sregex').value.trim()].filter(Boolean)
      : senderTags.values()
    const from = $('#w_from').value, to = $('#w_to').value
    return {
      id: r.id || undefined,
      name: $('#name').value.trim() || '未命名规则',
      priority: Number($('#prio').value) || 100,
      enabled: $('#enabled').value === '1',
      match: {
        kind: kinds,
        sender: values.length ? { mode, values } : null,
        // 迁到 sender 之后就把老字段清掉，否则两个条件会同时生效（AND）
        sender_regex: null,
        content_contains: contentTags.values(),
        content_excludes: excludeTags.values(),
        content_regex: m.content_regex ?? null,
        device_ids: [...app.querySelectorAll('[data-dev]')].filter((c) => c.checked).map((c) => c.dataset.dev),
        sim_slot: [...app.querySelectorAll('[data-sim]')].filter((c) => c.checked).map((c) => Number(c.dataset.sim)),
        direction: $('#direction').value ? [$('#direction').value] : [],
        // 只填了一半的时段是无意义的，当没填处理
        time_window: from && to ? { from, to } : null,
      },
      action: {
        channels: [...app.querySelectorAll('[data-ch]')].filter((c) => c.checked).map((c) => c.dataset.ch),
        priority: $('#high').checked ? 'high' : 'normal',
        extract_code: $('#extract').checked,
        template: $('#tpl').value,
        archive: true,
        stop_processing: $('#stop').checked,
        // 界面上没有 Bark 区块时（没有 Bark 渠道）保留原值，
        // 不能因为没显示就把用户配过的东西抹掉
        bark: $('#b_level')
          ? {
              level: $('#b_level').value,
              group: $('#b_group').value.trim() || null,
              copy_mode: $('#b_copymode').value,
              auto_copy_code: $('#b_copy').checked,
              deep_link: $('#b_link').value,
            }
          : (r.action.bark ?? undefined),
        // 同理：界面上没有 ntfy 区块时保留原值，别因为没显示就抹掉
        ntfy: $('#n_prio')
          ? {
              priority: $('#n_prio').value,
              tags: ntfyTags ? ntfyTags.values() : [],
              copy_mode: $('#n_copymode').value,
              deep_link: $('#n_link').value,
            }
          : (r.action.ntfy ?? undefined),
        webpush: $('#w_link')
          ? { show_code: $('#w_code').checked, deep_link: $('#w_link').value }
          : (r.action.webpush ?? undefined),
      },
    }
  }

  $('#back').onclick = () => go('/rules')
  $('#save').onclick = async () => {
    const c = collect()
    const from = $('#w_from').value, to = $('#w_to').value
    if ((from && !to) || (!from && to)) {
      return ($('#err').textContent = '生效时段要么两个都填，要么都留空')
    }
    try {
      await api('/rules', { method: 'POST', body: c })
      toast('已保存')
      go('/rules')
    } catch (e) { $('#err').textContent = e.message }
  }

  // 规则写错的反馈周期否则是「等下一条真实短信」，调试极其痛苦（计划 §7.4）
  $('#test').onclick = async () => {
    $('#testout').innerHTML = '<div class="loading">试跑中…</div>'
    try {
      const c = collect()
      const out = await api('/rules/test', { method: 'POST', body: { match: c.match, action: c.action } })
      $('#testout').innerHTML = `
        <h2>试跑结果：${out.matched} / ${out.total} 条命中</h2>
        ${out.matched === 0 ? '<div class="card muted">一条都没命中。条件太严，或者历史消息里本来就没有这类消息。</div>' : ''}
        <div class="card list">${out.results.map((x) => `
          <div class="item">
            <div class="row">
              <b class="truncate">${esc(x.from)}</b>
              <span class="badge ${x.matched ? 'ok' : ''}">${x.matched ? '命中' : '未命中'}</span>
            </div>
            ${x.device_name ? `<div class="muted" style="font-size:12px">${esc(x.device_name)}</div>` : ''}
            <div class="muted truncate">${esc(x.content)}</div>
            ${x.matched ? `<div class="muted wrap" style="margin-top:4px">→ ${esc(x.preview)}${x.code ? ` <span class="badge ok">${esc(x.code)}</span>` : ''}</div>` : ''}
          </div>`).join('')}</div>`
    } catch (e) { $('#testout').innerHTML = `<div class="err-text">${esc(e.message)}</div>` }
  }

  if (rule) $('#del').onclick = async () => {
    if (!confirm(`删除规则「${r.name}」？`)) return
    await api(`/rules/${r.id}`, { method: 'DELETE' })
    toast('已删除')
    go('/rules')
  }
}

const BARK_LEVELS = [
  ['active', '普通'],
  ['timeSensitive', '时效性（可穿透专注模式）'],
  ['critical', '重要警告（静音也会响）'],
  ['passive', '安静（不亮屏）'],
]

/** 与 core/providers/ntfy.ts 的 NTFY_PRIORITY 对应。ntfy 只有五档，没有 Bark 那种「静音也响」 */
const NTFY_LEVELS = [
  ['default', '普通'],
  ['max', '最高（长震动 + 弹出横幅）'],
  ['high', '较高（震动 + 弹出）'],
  ['low', '安静（不震动不响）'],
  ['min', '最低（折叠在「其它通知」里）'],
]

/** 占位符清单与服务端 core/rules.ts 的 TemplateVars 一一对应，改动要同步。 */
const TEMPLATE_VARS = [
  ['sender', '发件人'], ['content', '正文'], ['code', '验证码'],
  ['time', '时间'], ['device', '设备名'], ['sim', '卡槽'],
]

/** 模板预览用的样例消息。挑的是验证码短信——模板最常调的就是这一类。 */
const SAMPLE = {
  sms: { sender: '95533', content: '【建设银行】您的验证码是 902431，5 分钟内有效，请勿泄露', code: '902431' },
  call: { sender: '+8613800138000', content: '未接来电', code: '' },
  notification: { sender: '微信', content: '张三: 验证码 902431，请勿转发', code: '902431' },
}

function renderTemplate(template, kind = 'sms') {
  const s = SAMPLE[kind] || SAMPLE.sms
  const sample = { ...s, time: fmt(Date.now()), device: '日本卡', sim: 'SIM1' }
  return String(template).replace(/\{(\w+)\}/g, (whole, k) => (k in sample ? sample[k] : whole))
}

/**
 * 通知长什么样的预览。
 *
 * 光预览「模板渲染成什么字符串」是不够的——真正发出去的那条消息里，
 * 发件人、时间、设备、卡槽是**渠道自己**加的头部。看不到这部分，
 * 就会写出一个把发件人又拼一遍的模板，而那正是之前默认模板的毛病。
 *
 * 排版与 core/providers/telegram.ts 的 buildText 一一对应，改一处要改两处。
 */
function notifyPreview(template, opts) {
  const kind = opts.kind || 'sms'
  const s = SAMPLE[kind] || SAMPLE.sms
  const body = renderTemplate(template, kind)
  const code = opts.extractCode ? s.code : ''
  const head = { sms: ['📨', '新短信', '发件人'], call: ['📞', '来电', '号码'], notification: ['🔔', '应用通知', '来源'] }[kind]
  const label = kind === 'sms' && opts.direction === 'out' ? '已发送' : head[1]
  const field = kind === 'sms' && opts.direction === 'out' ? '收件人' : head[2]

  const lines = [
    `${head[0]} <b>${label}</b> · <span class="mono">${esc(fmtFull(Date.now()))}</span>`,
    `${field}: ${esc(s.sender)}`,
  ]
  if (opts.sim) lines.push(`SIM: ${esc(opts.sim)}`)
  if (opts.device) lines.push(`设备: ${esc(opts.device)}`)

  const inner = (code ? `🔑 ${code}\n\n` : '') + body
  const barkTitle = [s.sender, opts.device, opts.sim].filter(Boolean).join(' · ')

  return `
    <div class="pvhead">Telegram</div>
    <div class="pvbubble">
      <div>${lines.join('<br>')}</div>
      <div style="margin-top:8px">💬 <span class="spoiler" title="点一下看看">${esc(inner).replace(/\n/g, '<br>')}</span></div>
    </div>
    <div class="muted" style="font-size:12px;margin:4px 0 10px">正文在 Telegram 里是模糊的，点一下才显示——明文转发验证码的 Bot 会被封。这里点一下同样能看。</div>
    <div class="pvhead">Bark / 通知栏</div>
    <div class="pvbubble">
      <div><b>${esc(barkTitle)}</b></div>
      <div style="margin-top:2px">${esc(body).replace(/\n/g, '<br>')}</div>
      ${copyHint(opts.copyMode, code, body)}
    </div>`
}

/**
 * 预览里那句「长按可复制 …」。
 *
 * 要照着 bark.ts 的分支算，别只在有验证码时才显示——否则选了「复制整条正文」
 * 的人在预览里什么都看不到，会以为没生效。code 模式下没提取到码时
 * 明确说「复制不到」，这正是那个死配置的样子。
 */
function copyHint(mode, code, body) {
  const m = mode || 'code'
  const line = (t) => `<div class="muted" style="font-size:12px;margin-top:6px">${t}</div>`
  if (m === 'none') return ''
  if (m === 'body') return line(`长按可复制整条正文（${esc(body.slice(0, 16))}${body.length > 16 ? '…' : ''}）`)
  return code
    ? line(`长按可复制 ${esc(code)}`)
    : line('<span class="badge err">复制不到</span> 选的是复制验证码，但没开「提取验证码」')
}

/** 带秒的时间，与通知头部一致——两条几乎同时到的消息要分得出先后。 */
function fmtFull(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ── 渠道 ────────────────────────────────────────────────────

async function channels() {
  render('<div class="loading">加载中…</div>')
  try {
    /**
     * `me` 要在这儿补一次。
     *
     * 它平时是登录那一下赋上的，但整页刷新（书签、总览上手清单里的「去配置」、
     * 或者直接输地址）之后它是 null——于是 `me?.role === 'admin'` 恒为假，
     * 管理员专属的那一项（webhook 的「允许内网地址」）**永远不出现**，
     * 而且不报错，只是静静地少一个勾选框。
     */
    const [{ channels: cs }, bark] = await Promise.all([
      api('/channels'),
      api('/bark/info').catch(() => null),
      me ? null : api('/auth/me').then((r) => { me = r.user }).catch(() => null),
    ])
    render(`
      <h1>渠道</h1>
      ${cs.length ? `<div class="card list">${cs.map((c) => `
        <div class="item">
          <div class="row">
            <div class="col grow">
              <b>${esc(c.name)}</b>
              <span class="muted">${c.type === 'webpush' ? '浏览器通知' : esc(c.type)}${c.enabled ? '' : ' · 已停用'}</span>
            </div>
            <div style="display:flex;gap:6px">
              <button class="ghost sm" data-edit="${esc(c.id)}">编辑</button>
              <button class="ghost sm" data-test="${esc(c.id)}">测试</button>
            </div>
          </div>
          <div class="muted" data-result="${esc(c.id)}"></div>
        </div>`).join('')}</div>` : '<div class="card muted">还没有渠道，在下面添加一个。</div>'}
      <h2>新增渠道</h2>
      <div class="card">
        <label>类型</label>
        <select id="type">
          <option value="bark">Bark（iPhone，验证码首选）</option>
          <option value="ntfy">ntfy（安卓，验证码首选）</option>
          <option value="telegram">Telegram</option>
          <option value="webhook">Webhook</option>
          <!-- 没有 webpush：订阅信息来自浏览器，手填不出来，只能从「设置 → 浏览器通知」订阅 -->
        </select>
        <label>名称</label><input id="name" value="">
        <div id="fields"></div>
        <div class="btnrow"><button id="add">添加</button></div>
        <div id="err" class="err-text"></div>
      </div>
      ${bark?.upstream ? `
      <h2>Bark 服务对外开放</h2>
      <div class="card">
        <p class="muted">这台自建 Bark 也可以给你的其它服务用，推送地址：</p>
        <div class="mono wrap card tight" style="font-size:12px">${esc(bark.public_url || '')}/&lt;设备Key&gt;</div>
        <div class="muted">要在别的手机上加这台服务器，在 Bark App 的服务器页点 + 扫这个码：</div>
        <div id="barkqr2" class="qr"></div>
        <label>开放档位</label>
        <select id="barkaccess">
          <option value="push"${bark.access === 'push' ? ' selected' : ''}>允许推送，禁止注册（推荐）</option>
          <option value="full"${bark.access === 'full' ? ' selected' : ''}>完全开放（注册 + 推送）</option>
          <option value="off"${bark.access === 'off' ? ' selected' : ''}>完全关闭</option>
        </select>
        <div class="muted" id="barkdesc" style="margin-top:8px"></div>
      </div>` : ''}`)

    const qr2 = $('#barkqr2')
    if (qr2) {
      if (bark?.qr) qr2.innerHTML = bark.qr
      else qr2.remove()
    }

    const sel = $('#barkaccess')
    if (sel) {
      const DESC = {
        push: '其它服务拿已知的设备 Key 就能推送，陌生人注册不了新设备。',
        full: '注册也开放。只在用 Bark App 绑定新设备时才需要，绑完建议调回「允许推送」。',
        off: '外部完全不可用。网关自己的推送走内部地址，不受影响；同一台机器上的其它服务仍可用本机地址访问。',
      }
      const paintDesc = () => { $('#barkdesc').textContent = DESC[sel.value] }
      paintDesc()
      sel.onchange = async () => {
        const v = sel.value
        sel.disabled = true
        try {
          await api('/bark/access', { method: 'POST', body: { access: v } })
          bark.access = v
          paintDesc()
          toast('已切换')
        } catch (e) { toast(e.message) }
        sel.disabled = false
      }
    }

    const FORMS = {
      bark: {
        name: '主 Bark',
        html: `<div class="card tight" style="background:var(--bg)">
                 <b>第一步：把这台服务器加进 Bark App</b>
                 <div class="muted" style="margin:6px 0 4px">先把下方「开放档位」调成「完全开放」，
                 然后在 Bark App 的「服务器」页点右上角 <b>+</b> → 扫下面这个码：</div>
                 <div id="barkqr" class="qr"></div>
                 <div class="muted" style="text-align:center">扫不了就手动填这个地址：</div>
                 <div class="mono wrap" style="font-size:13px;padding:6px 0;text-align:center"><b>${esc(bark?.public_url || `${location.origin}/bark`)}</b></div>
                 <div style="text-align:center"><button class="ghost sm" id="copyurl" type="button">复制地址</button></div>
                 <div class="muted" style="margin-top:10px"><b>第二步：把设备 Key 填到下面</b>，然后把档位调回「允许推送」。</div>
               </div>
               <label>推送地址（网关内部使用，不走公网）</label>
               <input id="f_server" class="mono" value="${esc(bark?.upstream || '')}" placeholder="http://bark:8080">
               <label>设备 Key</label><input id="f_key" class="mono" placeholder="22 位左右的随机串">
               <div class="muted">Bark App 首页不会单独把 Key 列出来，它藏在示例地址里：
               <span class="mono">…/bark/<b>这一段就是 Key</b>/推送内容</span>。
               嫌麻烦就点 App 里任意一条示例右上角的复制按钮，把整条地址粘到下面，自动认。</div>
               <input id="f_paste" class="mono" placeholder="或粘贴整条推送地址，自动提取 Key">
               <div class="muted" id="f_pastehint"></div>
               <label>通知图标（可选）</label>
               <input id="f_icon" class="mono" value="${esc(iconUrl())}" placeholder="留空则不显示图标">
               <div class="muted">显示在通知左侧，让人一眼认出这条是网关发的。
               去图的是<b>你的 iPhone</b> 而不是服务器，所以地址必须公网可达；
               而且只认 <b>PNG / JPEG</b>——填 .svg 的话图标位置会是空的，不报错。
               上面预填的是本网关自己的图标。</div>
`,
        collect: () => ({
          server: $('#f_server').value.trim(),
          key: $('#f_key').value.trim(),
          // 空串要送 null 而不是 ''：schema 是 .url()，空串过不了校验，
          // 而「不要图标」是个合法选择
          icon: $('#f_icon').value.trim() || null,
        }),
      },
      telegram: {
        name: '主 Telegram',
        /**
         * Telegram 是四个渠道里**唯一需要你先去别处造一个东西**的：
         * Bark 装个 App、ntfy 起个名字就完了，这里得先有一个自己的 Bot。
         * 原来的表单只有两个空框，等于默认「你已经知道 Bot 是怎么来的」——
         * 而不知道的人在这儿就卡死了，还不知道自己卡在哪。
         */
        html: `<div class="card tight" style="background:var(--bg)">
                 <b>第一步：造一个属于你自己的 Bot</b>
                 <ol class="howto">
                   <li>在 Telegram 里搜 <b class="mono">@BotFather</b>（认准带蓝勾的那个），给它发
                       <b class="mono">/newbot</b>。</li>
                   <li>按它问的填两个名字：显示名随便起；用户名必须以
                       <b class="mono">bot</b> 结尾、且全网唯一。</li>
                   <li>成功后它会回一串
                       <span class="mono">123456789:AAH...</span> —— <b>那就是 Bot Token</b>，填到下面。</li>
                 </ol>
                 <div class="warn-line"><b>要用你自己新建的，不能和别人共用一个。</b>
                 Telegram 只允许一个程序拉取一个 Bot 的消息，两边同时用会互相把对方的命令吃掉，
                 表现是「Bot 时灵时不灵」。保存时这里会拦住重复的 token。</div>
               </div>
               <label>Bot Token</label>
               <input id="f_bt" class="mono" type="password" autocomplete="off" placeholder="123456789:AAH…">

               <div class="card tight" style="background:var(--bg);margin-top:12px">
                 <b>第二步：让它认识你</b>
                 <div class="muted" style="margin:6px 0 0">在 Telegram 里<b>搜你刚建的那个 Bot</b>，
                 点开，发一句 <b class="mono">/start</b>。<b>顺序不能反</b>——Telegram 只让 Bot 读到
                 「已经有人跟它说过话」之后的消息，没发过就点下面的按钮，永远是空的。</div>
               </div>
               <label>Chat ID</label>
               <input id="f_cid" class="mono" autocomplete="off" placeholder="点下面的按钮自动填">
               <button class="ghost sm" id="discover" type="button" style="margin-top:8px">自动获取 Chat ID</button>
               <div class="muted" id="discovered" style="margin-top:6px">
                 Chat ID 是<b>「你」</b>的标识，不是 Bot 的——换了 Bot 它也不变。
                 想发到群里就把 Bot 拉进群、在群里发一句话，这里会多出一个负数的 ID。
               </div>

               <div class="notice" style="margin-top:12px"><b>验证码在 Telegram 里是打码的，要点一下才看得见。</b>
               这不是设计取舍：Telegram 的反欺诈系统会封禁转发验证码的 Bot，明文发等于让它随时失效
               —— 上一版网关就是这么被封的。想要「通知栏直接看到码、长按即复制」，用 Bark 或 ntfy。</div>`,
        collect: () => ({ bot_token: $('#f_bt').value.trim(), chat_id: $('#f_cid').value.trim() }),
      },
      ntfy: {
        name: '我的 ntfy',
        html: `<div class="card tight" style="background:var(--bg)">
                 <b>为什么给安卓推荐它</b>
                 <div class="muted" style="margin:6px 0 0">Bark 只有 iPhone。ntfy 在安卓上能做到同一件事：
                 验证码显示在通知栏，通知上直接有一个<b>「复制验证码」按钮</b>，不用打开 App。iOS 上也有客户端，但那个复制按钮官方只保证安卓 App 与网页版有。</div>
               </div>
               <label>服务器地址</label>
               <input id="f_server" class="mono" value="https://ntfy.sh" placeholder="https://ntfy.sh">
               <div class="muted">用公共实例就保持默认。自己搭了就填自己的地址。</div>
               <label>主题名</label>
               <div style="display:flex;gap:8px">
                 <div class="grow"><input id="f_topic" class="mono" placeholder="8–64 位，字母数字与 - _"></div>
                 <button class="ghost sm" id="f_gen" type="button" style="flex:none">随机生成</button>
               </div>
               <div class="notice" style="margin-top:8px"><b>主题名就是这条通道的口令。</b>
               在公共实例上，<b>任何知道主题名的人都能订阅它</b>，没有别的门——而这里流的是你的银行验证码。
               所以别用「sms」「mycode」这种；点上面的按钮生成一串随机的，或者自己搭一个 ntfy 并用受保护主题。</div>
               <label>访问令牌（可选）</label>
               <input id="f_token" class="mono" type="password" autocomplete="off" placeholder="tk_… 受保护主题才需要">
               <label>通知图标（可选）</label>
               <input id="f_icon" class="mono" value="${esc(iconUrl())}" placeholder="留空则不显示图标">
               <div class="muted">和 Bark 一样：去取图的是<b>你的手机</b>，地址要公网可达，且只认 PNG / JPEG。</div>
               <div class="muted"><b>手机上怎么收：</b>应用商店装 ntfy → 点 <b>+</b> 订阅主题 →
               服务器填上面那个地址、主题填上面那个名字。装完回来点「测试」。</div>`,
        collect: () => ({
          server: $('#f_server').value.trim() || 'https://ntfy.sh',
          topic: $('#f_topic').value.trim(),
          token: $('#f_token').value.trim() || null,
          icon: $('#f_icon').value.trim() || null,
        }),
      },
      webhook: {
        name: 'Webhook',
        /**
         * 这是唯一一个把短信正文**发往你指定的任意地址**的渠道，所以：
         * ① 先把这件事说清楚，别让人以为它和前面几个一样只是「换个 App 收」；
         * ② 把收到的 JSON 长什么样直接列出来——不然对接方要靠猜，
         *    而「猜错字段名」的表现同样是「什么都没发生」；
         * ③ 自定义请求头暴露出来。schema 里一直支持，界面上一直没有，
         *    结果是所有需要鉴权的接口都对接不了。
         */
        html: `<label>目标地址</label>
               <input id="f_url" class="mono" placeholder="https://example.com/hook">
               <div class="muted">企业微信机器人、钉钉机器人，或者你自己的接口都行。
               群机器人的地址在群设置里「群机器人 → 添加 → 复制 Webhook 地址」。</div>

               <div class="notice" style="margin-top:10px"><b>短信正文会明文发到这个地址。</b>
               别的渠道是把消息送到你自己的手机上，这一个是送到<b>你填的那台服务器</b>——
               它归谁、日志留多久、谁能看，网关这边管不着。填之前想清楚。</div>

               <details style="margin-top:10px"><summary class="muted">对方会收到什么（JSON 字段）</summary>
                 <pre class="mono wrap" style="font-size:12px;line-height:1.6;margin:8px 0 0">{
  "title": "95533",          发件人
  "body": "…",               短信正文
  "code": "493021",          提取到的验证码，没有则 null
  "priority": "high",
  "event_id": "evt_…",
  "kind": "sms",             sms / call / notification
  "direction": "in",
  "device": "家里的备用机",
  "sim": "SIM1 · 8868",
  "occurred_at": 1789…,      毫秒时间戳
  "occurred_at_local": "…",  已按你的时区格式化
  "console_url": "https://…"
}</pre></details>

               <label style="margin-top:10px">自定义请求头（可选）</label>
               <textarea id="f_headers" class="mono" rows="2" placeholder="Authorization: Bearer xxx&#10;X-Token: yyy"></textarea>
               <div class="muted">一行一个，<span class="mono">名字: 值</span>。接口要鉴权时用。</div>

               <label style="margin-top:10px"><input type="checkbox" id="f_insecure" style="width:auto;margin-right:6px">允许 http（不加密）</label>
               <div class="muted">默认只允许 https——正文里有验证码，走明文等于沿途公开广播。
               只有目标在内网、你清楚在做什么时才勾。</div>
               ${me?.role === 'admin' ? `
               <label style="margin-top:10px"><input type="checkbox" id="f_private" style="width:auto;margin-right:6px">允许指向内网 / 本机地址</label>
               <div class="warn-line"><b>只有管理员看得到这一项，因为它能让服务器替你访问它自己的内网。</b>
               云厂商的元数据接口、只监听回环的管理端口、同机的数据库端口，都在这道闸后面。
               接收端确实就在这台机器上时才勾（比如同机的 n8n、Home Assistant）。</div>` : ''}`,
        collect: () => {
          const headers = {}
          for (const line of ($('#f_headers').value || '').split('\n')) {
            const i = line.indexOf(':')
            if (i <= 0) continue
            const k = line.slice(0, i).trim()
            const v = line.slice(i + 1).trim()
            if (k && v) headers[k] = v
          }
          return {
            url: $('#f_url').value.trim(),
            headers,
            allow_insecure: $('#f_insecure').checked,
            // 非管理员根本没有这个框；服务端也会再判一次角色，
            // 这里送 true 也没用（sanitizeChannelConfig 会静默降成 false）
            allow_private: $('#f_private')?.checked === true,
          }
        },
      },
    }

    const paintForm = () => {
      const t = $('#type').value
      $('#fields').innerHTML = FORMS[t].html
      if (!$('#name').value.trim()) $('#name').value = FORMS[t].name
      const dis = $('#discover')
      if (dis) dis.onclick = async () => {
        const bt = $('#f_bt').value.trim()
        if (!bt) { $('#discovered').textContent = '请先填 Bot Token'; return }
        dis.disabled = true
        $('#discovered').textContent = '查询中…'
        try {
          const r = await api('/channels/telegram/discover-chat', { method: 'POST', body: { bot_token: bt } })
          if (r.chats.length === 0) {
            $('#discovered').textContent = r.hint || '没读到消息'
          } else {
            $('#discovered').innerHTML = r.chats.map((c) =>
              `<button class="ghost sm" type="button" data-chat="${esc(c.id)}" style="margin:4px 4px 0 0">${esc(c.id)}${c.name ? ` · ${esc(c.name)}` : ''}</button>`,
            ).join('')
            for (const b of $('#discovered').querySelectorAll('[data-chat]')) {
              b.onclick = () => { $('#f_cid').value = b.dataset.chat; toast('已填入') }
            }
          }
        } catch (e) { $('#discovered').textContent = e.message }
        dis.disabled = false
      }

      /**
       * 随机主题名。
       *
       * 这不是「方便」，是安全默认值：公共实例上主题名就是唯一的门，
       * 让人自己想一个的结果是「sms」「yzm」这种——等于把银行验证码挂在公开频道上。
       * 用 crypto.getRandomValues 而不是 Math.random。
       */
      const gen = $('#f_gen')
      if (gen) gen.onclick = () => {
        const A = 'abcdefghijkmnpqrstuvwxyz23456789'
        const r = crypto.getRandomValues(new Uint8Array(20))
        $('#f_topic').value = 'homing-' + Array.from(r, (x) => A[x % A.length]).join('')
      }

      // Bark 服务器二维码：内容就是服务器地址本身，Bark App 的「添加服务器」认这个
      const qrBox = $('#barkqr')
      if (qrBox) {
        if (bark?.qr) qrBox.innerHTML = bark.qr
        else qrBox.remove()
      }

      const paste = $('#f_paste')
      if (paste) paste.oninput = () => {
        const k = barkKeyFrom(paste.value)
        if (!k) {
          $('#f_pastehint').textContent = paste.value.trim() ? '没从这段文本里认出 Key' : ''
          return
        }
        $('#f_key').value = k
        $('#f_pastehint').innerHTML = `已填入 Key：<span class="mono">${esc(k)}</span>`
      }

      const cp = $('#copyurl')
      if (cp) cp.onclick = async () => {
        try { await navigator.clipboard.writeText(bark?.public_url || `${location.origin}/bark`); toast('已复制') }
        catch { toast('复制失败，请手动选择') }
      }
    }
    $('#type').onchange = () => { $('#name').value = ''; paintForm() }
    paintForm()

    for (const b of app.querySelectorAll('[data-test]')) {
      b.onclick = async () => {
        const id = b.dataset.test
        const out = app.querySelector(`[data-result="${id}"]`)
        out.textContent = '发送中…'
        b.disabled = true
        try {
          const r = await api(`/channels/${id}/test`, { method: 'POST' })
          out.innerHTML = testResultHtml(r)
        } catch (e) { out.innerHTML = `<span class="badge err">${esc(e.message)}</span>` }
        b.disabled = false
      }
    }

    for (const b of app.querySelectorAll('[data-edit]')) {
      b.onclick = () => channelEditor(cs.find((c) => c.id === b.dataset.edit), bark)
    }

    $('#add').onclick = async () => {
      const t = $('#type').value
      try {
        await api('/channels', {
          method: 'POST',
          body: { type: t, name: $('#name').value.trim() || FORMS[t].name, config: FORMS[t].collect() },
        })
        toast('已添加')
        channels()
      } catch (e) { $('#err').textContent = e.message }
    }
  } catch (e) { fail(e) }
}

/**
 * 渠道编辑。
 *
 * 密钥字段一律留空显示——服务端从不把它们返回给前端。留空提交即沿用旧值，
 * 想更换才填新的。
 */
function channelEditor(c, bark) {
  const SECRET_FIELDS = {
    telegram: [
      { key: 'bot_token', label: 'Bot Token', secret: true },
      { key: 'chat_id', label: 'Chat ID', secret: false },
    ],
    bark: [
      { key: 'server', label: '推送地址（内部）', secret: false, placeholder: bark?.upstream || 'http://bark:8080' },
      { key: 'key', label: '设备 Key', secret: true },
      { key: 'icon', label: '通知图标（PNG/JPEG 的公网地址）', secret: false, placeholder: iconUrl(), clearable: true },
    ],
    ntfy: [
      { key: 'server', label: '服务器地址', secret: false, placeholder: 'https://ntfy.sh' },
      { key: 'topic', label: '主题名（就是这条通道的口令）', secret: false },
      { key: 'token', label: '访问令牌', secret: true, clearable: true },
      { key: 'icon', label: '通知图标（PNG/JPEG 的公网地址）', secret: false, placeholder: iconUrl(), clearable: true },
    ],
    webhook: [
      { key: 'url', label: '目标地址', secret: false },
      // headers 在这里只能整体替换不能逐条改，但有总比完全够不着强
      // headers 在库里是对象，界面上是「一行一个」的文本 —— 用 parse 把两者接上。
      // 不给 parse 的话这里送出去的是字符串，schema 当场 400，而报错只会说
      // 「配置不合法」，看不出是哪一项
      { key: 'headers', label: '自定义请求头（一行一个「名字: 值」）', secret: false, clearable: true,
        parse: (v) => {
          const out = {}
          for (const line of v.split('\n')) {
            const i = line.indexOf(':')
            if (i <= 0) continue
            const k = line.slice(0, i).trim(); const val = line.slice(i + 1).trim()
            if (k && val) out[k] = val
          }
          return out
        } },
    ],
    // 订阅信息由浏览器生成，手改只会改坏。要换就去「设置 → 浏览器通知」重订
    webpush: [],
  }
  const fields = SECRET_FIELDS[c.type] ?? []

  render(`
    <h1>编辑渠道</h1>
    <div class="card">
      <label>名称</label><input id="c_name" value="${esc(c.name)}">
      <label>类型</label>
      <div class="mono muted">${esc(c.type)}（不可更改，需要换类型请新建）</div>
      <label>状态</label>
      <select id="c_enabled">
        <option value="1"${c.enabled ? ' selected' : ''}>启用</option>
        <option value="0"${c.enabled ? '' : ' selected'}>停用</option>
      </select>
    </div>
    <h2>配置</h2>
    <div class="card">
      <p class="muted">留空表示不修改。密钥不会回显。</p>
      ${fields.map((f) => `
        <label>${esc(f.label)}</label>
        ${f.parse
          ? `<textarea id="c_${esc(f.key)}" class="mono" rows="2"
               placeholder="${esc(f.placeholder || '留空则不变')}"></textarea>`
          : `<input id="c_${esc(f.key)}" class="mono" type="${f.secret ? 'password' : 'text'}"
               placeholder="${esc(f.placeholder || '留空则不变')}" autocomplete="off">`}
        ${f.clearable ? `<label style="text-transform:none;letter-spacing:0;font-size:13px;color:var(--fg)">
          <input type="checkbox" id="c_${esc(f.key)}_clear" style="width:auto;margin-right:6px">清空这一项</label>` : ''}
      `).join('')}
    </div>
    <div class="btnrow">
      <button id="c_save">保存</button>
      <button class="ghost sm" id="c_test">测试</button>
      <button class="danger sm" id="c_del">删除</button>
      <button class="ghost sm" id="c_back">返回</button>
    </div>
    <div id="c_err" class="err-text"></div>
    <div id="c_result" class="muted" style="margin-top:8px"></div>`)

  $('#c_back').onclick = () => go('/channels')

  $('#c_save').onclick = async () => {
    const config = {}
    for (const f of fields) {
      // 勾了「清空」就送显式 null——服务端把 null 当清空、把空串当「没填」
      if (f.clearable && $(`#c_${f.key}_clear`)?.checked) { config[f.key] = null; continue }
      const v = $(`#c_${f.key}`).value.trim()
      if (v) config[f.key] = f.parse ? f.parse(v) : v
    }
    try {
      await api(`/channels/${c.id}`, {
        method: 'PUT',
        body: {
          name: $('#c_name').value.trim(),
          enabled: $('#c_enabled').value === '1',
          ...(Object.keys(config).length ? { config } : {}),
        },
      })
      toast('已保存')
      go('/channels')
    } catch (e) { $('#c_err').textContent = e.message }
  }

  $('#c_test').onclick = async () => {
    $('#c_result').textContent = '发送中…'
    try {
      const r = await api(`/channels/${c.id}/test`, { method: 'POST' })
      $('#c_result').innerHTML = testResultHtml(r)
    } catch (e) { $('#c_result').innerHTML = `<span class="badge err">${esc(e.message)}</span>` }
  }

  $('#c_del').onclick = async () => {
    if (!confirm(`删除渠道「${c.name}」？命中它的规则将不再推送到这里。`)) return
    await api(`/channels/${c.id}`, { method: 'DELETE' })
    toast('已删除')
    go('/channels')
  }
}

/**
 * 从 Bark App 复制出来的整条地址里取出设备 Key。
 *
 * Bark 首页只给「https://服务器/<key>/标题/内容」这种示例，不单独把 Key 列出来，
 * 不少人因此不知道该往「设备 Key」里填什么。让人整条粘进来，我们自己认。
 *
 * 也接受直接粘一串裸 Key。
 */
/**
 * 本网关自己那张通知图标的公网地址。
 *
 * 取 location.origin 而不是配置里的 GW_BASE_URL：去取这张图的是**用户的 iPhone**，
 * 而用户此刻正是从这个地址打开的控制台——他能访问到，他的手机多半也能。
 */
/**
 * 渠道测试的结果。
 *
 * 成功时必须把「发给了谁」显示出来（Telegram 会回 chat 身份）：
 * chat_id 填错的后果是把自己的全部短信长期转发给陌生人，
 * 而收不到的是填错的人自己——操作者这边只会看到一个绿色的「已发出」。
 * 这一行是他当场发现填错的唯一机会。
 */
function testResultHtml(r) {
  if (!r.ok) return `<span class="badge err">失败：${esc(r.error || '未知错误')}</span>`
  return '<span class="badge ok">测试消息已发出</span>'
    + (r.to ? ` 发给了 <b>${esc(r.to)}</b><div class="muted" style="font-size:12px;margin-top:4px">不是你？那就是接收地址填错了，改掉它——否则你的短信会一直发到那里。</div>` : '')
}

function iconUrl() {
  return `${location.origin}/icon-192.png`
}

function barkKeyFrom(text) {
  const t = String(text || '').trim()
  if (!t) return ''
  // 裸 Key：Bark 的 key 是大小写字母加数字的随机串
  if (/^[A-Za-z0-9]{10,40}$/.test(t)) return t
  let path
  try {
    path = new URL(t).pathname
  } catch {
    // 不是完整 URL，就按路径处理
    path = t.replace(/^https?:\/\/[^/]+/, '')
  }
  // 反代场景下前面还有 /bark，所以取第一个长得像 key 的段，而不是第一段
  const seg = path.split('/').filter(Boolean)
  return seg.find((x) => /^[A-Za-z0-9]{10,40}$/.test(x)) || ''
}

// ── 设备 ────────────────────────────────────────────────────

/**
 * 一台设备的连接日志。
 *
 * 「设备不在线」只有一个比特的信息量，排查时真正有用的是**在那之前发生了什么**。
 * 这些全是服务端这一侧看得见的事，不需要设备配合——所以**设备离线时照样能看**，
 * 而那正是最需要看的时候。
 */
async function deviceLogs(id) {
  render('<div class="loading">加载中…</div>')
  try {
    const [{ logs }, { devices: ds }] = await Promise.all([
      api(`/devices/${encodeURIComponent(id)}/logs?limit=200`),
      api('/devices').catch(() => ({ devices: [] })),
    ])
    const dev = ds.find((d) => d.id === id)
    const LABEL = {
      online: '上线', offline: '掉线',
      auth_failed: '凭证不匹配', auth_revoked: '凭证已吊销', account_inactive: '账号停用或到期',
    }
    const DOT = { info: 'ok', warn: 'plain', error: 'err' }

    render(`
      <div class="pagehead">
        <a href="/devices" data-back="/devices" class="muted" style="flex:none">← 返回</a>
        <b class="truncate">${esc(dev ? dev.name : id)} · 连接日志</b>
      </div>
      <p class="muted">服务端这一侧看到的事，<b>设备离线时照样能看</b>。保留 30 天。</p>
      ${logs.length ? `<div class="card list">${logs.map((l) => `
        <div class="item">
          <div class="row">
            <span class="badge ${DOT[l.level] ?? 'plain'}">${esc(LABEL[l.event] ?? l.event)}</span>
            <span class="muted mono" style="font-size:12px;flex:none">${fmtFull(l.created_at)}</span>
          </div>
          ${l.detail ? `<div class="muted" style="margin-top:4px">${esc(l.detail)}</div>` : ''}
        </div>`).join('')}</div>` : '<div class="card muted">还没有记录。设备连上来之后这里就会有东西。</div>'}
      <h2>手机里的日志</h2>
      <div class="card">
        <p class="muted" style="margin:0">上面那些是<b>服务端看到的</b>。手机内部发生了什么
        （哪条采集链路没起来、为什么反复重连）要问设备本身，<b>需要它在线</b>。</p>
        ${dev && dev.status === 'online'
          ? `<div class="btnrow" style="margin-top:10px">
               <button class="sm" id="ag_get">取最近 200 行</button>
               <select id="ag_level" style="width:auto">
                 <option value="info">info 以上</option>
                 <option value="debug">全部（含 debug）</option>
                 <option value="warn">只看 warn 与 error</option>
               </select>
             </div>`
          : `<div class="notice" style="margin-top:10px">设备当前不在线，取不到。
             这时候用<b>短信指令</b>问它——那条路不经过服务器，正是为这种情况设计的。</div>`}
        <div class="err-text" id="ag_err"></div>
        <div id="ag_out" style="margin-top:10px"></div>
      </div>`)

    const get = $('#ag_get')
    if (get) get.onclick = async () => {
      get.disabled = true
      $('#ag_err').textContent = ''
      $('#ag_out').innerHTML = '<div class="loading">向设备要日志中…</div>'
      try {
        const r = await api(`/devices/${encodeURIComponent(id)}/agent-logs`, {
          method: 'POST', body: { limit: 200, min_level: $('#ag_level').value },
        })
        const LV = { debug: 'plain', info: 'ok', warn: 'plain', error: 'err' }
        $('#ag_out').innerHTML = r.lines.length
          ? (r.dropped ? `<div class="muted" style="margin-bottom:8px">缓冲满了，更早的 ${r.dropped} 行已经被挤掉。</div>` : '')
            + `<div class="card list">${r.lines.slice().reverse().map((l) => `
              <div class="item">
                <div class="row">
                  <span class="badge ${LV[l.level] ?? 'plain'}">${esc(l.level)}</span>
                  <span class="muted mono" style="font-size:12px;flex:none">${fmtFull(l.at)}</span>
                </div>
                <div class="mono wrap" style="font-size:12px;margin-top:4px">${esc(l.msg)}</div>
              </div>`).join('')}</div>`
            + '<div class="muted" style="margin-top:8px;font-size:12px">日志在内存里，'
            + '<b>App 被系统杀掉重启后就清空了</b>。正文与验证码在写进日志时已经擦掉。</div>'
          : '<div class="muted">设备上暂时没有日志。</div>'
      } catch (e) {
        $('#ag_out').innerHTML = ''
        $('#ag_err').textContent = e.message
      }
      get.disabled = false
    }
  } catch (e) { fail(e) }
}

async function devices() {
  render('<div class="loading">加载中…</div>')
  try {
    const { devices: ds } = await api('/devices')
    const online = ds.filter((d) => d.status === 'online')
    render(`
      <h1>设备</h1>
      ${ds.length ? `<div class="card list">${ds.map((d) => `
        <div class="item">
          <div class="row">
            <div class="col grow">
              <div><span class="dot ${d.status}"></span><b>${esc(d.name)}</b></div>
              <span class="muted mono" style="font-size:11px">${esc(d.id)}</span>
              <span class="muted">心跳 ${ago(d.last_seen_at)}${d.status === 'revoked' ? battery(d) : ''}${d.app_version ? ` · v${esc(d.app_version)}` : ''}</span>
              ${d.status === 'revoked' ? '' : statusBadges(d)}
            </div>
            <div style="display:flex;gap:6px;flex-direction:column;align-items:flex-end">
              <a href="/devices/${esc(d.id)}/logs"><button class="ghost sm">连接日志</button></a>
              ${d.status === 'online' ? `<button class="ghost sm" data-refresh="${esc(d.id)}">刷新状态</button>` : ''}
              ${d.status === 'online' ? `<button class="ghost sm" data-locate="${esc(d.id)}">定位</button>` : ''}
              ${d.status !== 'revoked'
                ? `<button class="danger sm" data-revoke="${esc(d.id)}">吊销</button>`
                : `<span class="badge err">已吊销</span>
                   <button class="ghost sm" data-del="${esc(d.id)}">删除记录</button>`}
            </div>
          </div>
          <div class="muted" data-loc="${esc(d.id)}" style="margin-top:6px">
            ${d.has_location ? `上次定位 ${ago(d.location_at)} · <a href="#" data-showloc="${esc(d.id)}">查看</a>` : ''}
          </div>
        </div>`).join('')}</div>` : '<div class="card muted">还没有设备。</div>'}
      <h2>同步手机里已有的短信和通话</h2>
      <div class="card">
        <p class="muted">网关只能捕获<b>启用之后</b>发生的事。装网关之前手机里就存着的短信、
        通话记录（收发都算），可以从这里一次性同步进来。</p>
        ${online.length === 0 ? `
          <div class="badge warn">没有在线设备</div>
          <div class="muted" style="margin-top:8px">同步要现读手机本地的数据库，设备必须在线。
          等它连上再回来。</div>` : `
          <label>设备</label>
          <select id="imp_dev">
            ${online.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
          </select>
          <label>导入多久以内的</label>
          <select id="imp_days">
            <option value="30">最近 30 天</option>
            <option value="90">最近 90 天</option>
            <option value="365">最近一年</option>
            <option value="0">全部（可能很多）</option>
          </select>
          <label>每类最多导入</label>
          <select id="imp_limit">
            <option value="500">500 条</option>
            <option value="1000" selected>1000 条</option>
            <option value="5000">5000 条</option>
          </select>
          <div class="muted">同步进来的记录<b>只进历史，不会推送</b>——否则几千条旧短信会一次性
          砸到你手机上。重复同步不会产生重复记录，放心多点几次。</div>
          <div class="btnrow">
            <button id="imp_go" class="sm">同步（只增不删）</button>
            <button id="rec_go" class="ghost sm">与手机对齐</button>
          </div>
          <div class="muted"><b>对齐</b>会双向：手机上有网关没有的补进来，<b>手机上已经删掉的，网关里也删掉</b>。
          删之前会先让你看一眼要删什么。</div>
          <div id="imp_out" class="muted"></div>`}
      </div>

      <h2>添加设备</h2>
      <div class="card">
        <label>设备名称</label><input id="dn" value="JP-Gateway-01">
        <div class="btnrow"><button id="gen">生成配对码</button></div>
        <div id="code"></div>
      </div>`)

    const impGo = $('#imp_go')
    if (impGo) impGo.onclick = async () => {
      impGo.disabled = true
      $('#imp_out').textContent = '正在读取手机里的记录，可能要一会儿…'
      try {
        const r = await api(`/devices/${$('#imp_dev').value}/import-history`, {
          method: 'POST',
          body: { days: Number($('#imp_days').value), limit: Number($('#imp_limit').value) },
        })
        $('#imp_out').innerHTML = `已从手机读取短信 <b>${r.sms}</b> 条、通话 <b>${r.calls}</b> 条，正在陆续上传。` +
          (r.skipped ? ` <span class="badge warn">有 ${r.skipped} 类因缺权限被跳过</span>` : '') +
          '<br>其中已经在库里的会自动跳过，所以「消息」页增加的条数通常比这个少。'
      } catch (e) { $('#imp_out').innerHTML = `<span class="err-text">${esc(e.message)}</span>` }
      impGo.disabled = false
    }

    /**
     * 与手机对齐。
     *
     * 分两步：先拿计划（不动手），让人看清要删什么再确认。
     * 删除不可逆，而「手机上那条到底还在不在」的判断依赖指纹比对，
     * 不给人一次看清楚的机会是不负责任的。
     */
    const recGo = $('#rec_go')
    if (recGo) recGo.onclick = async () => {
      const days = Number($('#imp_days').value)
      const limit = Number($('#imp_limit').value)
      const dev = $('#imp_dev').value
      recGo.disabled = true
      $('#imp_out').textContent = '正在比对手机上的记录…'
      try {
        const plan = await api(`/devices/${dev}/reconcile`, { method: 'POST', body: { days, limit } })
        const imp = plan.imported || {}
        const range = plan.window
          ? `${fmtDate(plan.window.since)} 到 ${fmtDate(plan.window.until)}`
          : '（无）'

        if (plan.stale === 0) {
          $('#imp_out').innerHTML =
            `已从手机读取短信 <b>${imp.sms ?? 0}</b> 条、通话 <b>${imp.calls ?? 0}</b> 条（重复的自动跳过）。` +
            `<br>比对范围 ${range}，<b>没有需要删除的</b>，两边是一致的。` +
            (plan.reason ? `<br><span class="badge warn">${esc(plan.reason)}</span>` : '')
          recGo.disabled = false
          return
        }

        const sample = (plan.preview || [])
          .map((p) => `· ${p.from}：${p.content}`).join('\n')
        const ok = confirm(
          `手机上已经没有、网关里还留着的：${plan.stale} 条\n\n` +
          `${sample}${plan.stale > 5 ? `\n…等共 ${plan.stale} 条` : ''}\n\n` +
          `比对范围：${range}\n（比这更早的记录不会被动——那是网关的长期归档）\n\n` +
          `删掉它们？删了就没了。`,
        )
        if (!ok) {
          $('#imp_out').innerHTML = `已从手机读取短信 <b>${imp.sms ?? 0}</b> 条、通话 <b>${imp.calls ?? 0}</b> 条。删除已取消。`
          recGo.disabled = false
          return
        }

        const r = await api(`/devices/${dev}/reconcile`, { method: 'POST', body: { days, limit, apply: true } })
        $('#imp_out').innerHTML =
          `对齐完成：从手机读取 <b>${(r.imported?.sms ?? 0) + (r.imported?.calls ?? 0)}</b> 条（重复的自动跳过），` +
          `删除手机上已不存在的 <b>${r.deleted}</b> 条。`
      } catch (e) { $('#imp_out').innerHTML = `<span class="err-text">${esc(e.message)}</span>` }
      recGo.disabled = false
    }

    $('#gen').onclick = async () => {
      try {
        const r = await api('/devices/pairing-code', { method: 'POST', body: { name: $('#dn').value.trim() || '未命名设备' } })
        $('#code').innerHTML = `
          ${r.qr ? `
            <div class="qr">${r.qr}</div>
            <div class="muted" style="text-align:center">用 Agent 里的「扫码配对」对准这个二维码，地址和配对码都不用手打。</div>
            <div class="muted" style="text-align:center;margin-top:10px">扫不了就手动填：</div>` : ''}
          <div class="code mono">${esc(r.code)}</div>
          <div class="muted" style="text-align:center">
            ${r.ws_url ? `服务器地址 <span class="mono">${esc(r.ws_url)}</span><br>` : ''}
            ${Math.floor(r.ttl_sec / 60)} 分钟内有效，只能用一次。
          </div>`
      } catch (e) { $('#code').innerHTML = `<div class="err-text">${esc(e.message)}</div>` }
    }

    /**
     * 定位用于设备找回。每次请求都会写审计——能定位这台设备的人也能看到
     * 你全部的验证码，至少要留下谁在什么时候查过的痕迹。
     */
    const showLocation = (id, loc) => {
      const out = app.querySelector(`[data-loc="${id}"]`)
      const acc = loc.accuracy != null ? `±${Math.round(loc.accuracy)} 米` : '精度未知'
      const when = new Date(loc.time).toLocaleString('zh-CN', { hour12: false })
      const map = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`
      out.innerHTML = `
        <div class="mono" style="font-size:12px">${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}</div>
        <div>${esc(loc.provider)} · ${acc} · ${esc(when)}${loc.cached ? ' · <b>缓存位置</b>' : ''}</div>
        <a href="${map}" target="_blank" rel="noreferrer noopener">在地图中打开</a>`
    }

    /**
   * 「刷新状态」：发一帧 ping，等 pong 回来再重画。
   *
   * 心跳是 30 秒一次，排查时盯着一个 29 秒前的读数干等很难受。
   * 这里不新增指令——pong 本来就带回全量状态。
   */
  for (const b of app.querySelectorAll('[data-refresh]')) {
    b.onclick = async () => {
      b.disabled = true
      const was = b.textContent
      b.textContent = '刷新中…'
      try {
        await api(`/devices/${b.dataset.refresh}/refresh`, { method: 'POST' })
        // pong 是异步回来的，给它一点时间再去读
        await new Promise((r) => setTimeout(r, 1200))
        devices()
        return
      } catch (e) { toast(e.message) }
      b.textContent = was
      b.disabled = false
    }
  }

  for (const b of app.querySelectorAll('[data-locate]')) {
      b.onclick = async () => {
        const id = b.dataset.locate
        const out = app.querySelector(`[data-loc="${id}"]`)
        out.textContent = '定位中…（GPS 冷启动可能要十几秒）'
        b.disabled = true
        try {
          showLocation(id, await api(`/devices/${id}/locate`, { method: 'POST' }))
        } catch (e) {
          out.innerHTML = `<span class="badge err">${esc(e.message)}</span>`
        }
        b.disabled = false
      }
    }

    for (const a of app.querySelectorAll('[data-showloc]')) {
      a.onclick = async (ev) => {
        ev.preventDefault()
        const id = a.dataset.showloc
        try {
          showLocation(id, await api(`/devices/${id}/location`))
        } catch (e) { toast(e.message) }
      }
    }

    /**
     * 删除设备记录。只对已吊销的设备开放——删一台还在线的，
     * 它的 Agent 会收到不可重试的 AUTH_UNKNOWN_DEVICE 彻底停下来，
     * 得跑到手机跟前重新配对。
     */
    for (const b of app.querySelectorAll('[data-del]')) {
      b.onclick = async () => {
        const id = b.dataset.del
        const dev = ds.find((d) => d.id === id)
        // 先问清历史怎么处理：设备没了不代表那些验证码就不该存在
        const purge = confirm(
          `删除设备「${dev?.name ?? id}」的记录。\n\n` +
          `它的历史消息怎么处理？\n\n` +
          `确定 = 连历史消息和发送记录一起删掉\n` +
          `取消 = 只删设备，历史消息留着`,
        )
        if (!confirm(`最后确认：删除设备「${dev?.name ?? id}」${purge ? '**以及它的全部历史消息**' : '（历史消息保留）'}？`)) return
        try {
          const r = await api(`/devices/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' })
          toast(purge ? `已删除，清理了 ${r.events} 条消息` : '已删除')
          devices()
        } catch (e) { toast(e.message) }
      }
    }

    for (const b of app.querySelectorAll('[data-revoke]')) {
      b.onclick = async () => {
        if (!confirm('吊销后该设备立即断开且无法重连，需要重新配对。继续？')) return
        await api(`/devices/${b.dataset.revoke}/token`, { method: 'DELETE' })
        toast('已吊销')
        devices()
      }
    }
  } catch (e) { fail(e) }
}

// ── 设置 ────────────────────────────────────────────────────

/**
 * 用户管理。
 *
 * 管理员能做的只有建号、停用、重置、删号——**看不到别人的数据**。
 * 留一个「管理员查看全部」的后门，多用户就白做了。
 */
async function paintUsers() {
  const box = $('#users')
  if (!box) return
  try {
    const { users } = await api('/users')
    box.innerHTML = `<div class="list">${users.map((u) => `
      <div class="item">
        <div class="row">
          <b>${esc(u.name)}${u.is_me ? ' <span class="muted">（你）</span>' : ''}</b>
          ${u.disabled ? '<span class="badge err">已停用</span>' : ''}
        </div>
        <span class="muted">${u.role === 'admin' ? '管理员' : '普通用户'} · ${u.devices} 台设备 · ${
          u.totp ? '已开两步验证' : '未开两步验证'} · ${validityText(u)}</span>
        ${u.is_me ? '' : `
          <!-- 按钮横排在下面一行，不挤在名字旁边：窄屏上三个按钮竖着排会把行撑得很高 -->
          <div class="row" style="justify-content:flex-start;gap:6px;flex-wrap:wrap;margin-top:8px">
            <button class="ghost sm" data-renew="${esc(u.id)}" data-name="${esc(u.name)}">改有效期</button>
            <button class="ghost sm" data-reset="${esc(u.id)}">重置口令</button>
            <button class="ghost sm" data-toggle="${esc(u.id)}" data-on="${u.disabled ? '0' : '1'}">${
              u.disabled ? '启用' : '停用'}</button>
            <button class="danger sm" data-del="${esc(u.id)}" data-name="${esc(u.name)}">删除</button>
          </div>`}
      </div>`).join('')}</div>`

    for (const b of box.querySelectorAll('[data-toggle]')) {
      b.onclick = async () => {
        try {
          await api(`/users/${encodeURIComponent(b.dataset.toggle)}`, {
            method: 'PUT', body: { disabled: b.dataset.on === '1' },
          })
          toast('已更新')
          paintUsers()
        } catch (e) { toast(e.message) }
      }
    }
    for (const b of box.querySelectorAll('[data-renew]')) {
      b.onclick = async () => {
        const pick = prompt(
          `给「${b.dataset.name}」续多久？\n\n`
          + '输入天数：7 / 30 / 90 / 180 / 365\n输入 0 表示永久不过期\n\n'
          + '（续期从原到期时刻往后接，还没用完的部分不会被抹掉）',
          '30',
        )
        if (pick === null) return
        const days = Number(pick)
        try {
          const r = await api(`/users/${encodeURIComponent(b.dataset.renew)}/renew`, {
            method: 'POST',
            body: days === 0 ? { permanent: true } : { days },
          })
          toast(r.expires_at ? `到期时间：${fmtDay(r.expires_at)}` : '已设为永久')
          paintUsers()
        } catch (e) { toast(e.message) }
      }
    }
    for (const b of box.querySelectorAll('[data-reset]')) {
      b.onclick = async () => {
        if (!confirm('重置后对方要用新口令和新的二维码重新登录，旧的立刻作废。继续？')) return
        try {
          const r = await api(`/users/${encodeURIComponent(b.dataset.reset)}/reset`, { method: 'POST' })
          showNewUser(r, '已重置')
        } catch (e) { toast(e.message) }
      }
    }
    for (const b of box.querySelectorAll('[data-del]')) {
      b.onclick = async () => {
        const n = b.dataset.name
        // 删号连数据一起删，所以要求把名字打一遍——这一步不可逆
        if (prompt(`删除「${n}」会连同他的设备、全部短信、通话、规则一起删掉，不可恢复。\n\n确认请输入用户名：`) !== n) return
        try {
          const r = await api(`/users/${encodeURIComponent(b.dataset.del)}?confirm=1`, { method: 'DELETE' })
          toast(`已删除：${Object.entries(r.removed).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join('、') || '无数据'}`)
          paintUsers()
        } catch (e) { toast(e.message) }
      }
    }
  } catch (e) {
    box.innerHTML = `<div class="err-text">${esc(e.message)}</div>`
  }
}

/**
 * 两步验证的开关。
 *
 * 绑与不绑的差别只有一处：登录时多不多一道动态码。口令规则、会话时长、
 * 找回能力都一样。所以这里不吓唬人，只把那一处差别说清楚。
 */
/**
 * 「装到主屏幕」。
 *
 * 三条必须说实话的地方，不说的话装完会觉得被骗：
 *
 * ① **要重新登录一次。** 两个各自独立的原因，堵住任何搬 token 的偏方：
 *    iOS 的主屏 App 与 Safari 存储完全隔离（localStorage 是空的）；
 *    就算不隔离也过不了——standalone 模式的 UA 去掉了 Version/Safari 两段，
 *    与登录时记下的 ua_hash 对不上，会话会被判无效。缓解办法只有
 *    「保持登录 30 天」，所以这里要点它一句。
 * ② **iOS 上通知点进去仍然开 Safari。** Apple 不给主屏 Web App 做 link
 *    capturing，没有变通。而 Bark 深链恰恰是这个项目最主要的入口，
 *    所以装完是两份登录状态：Safari 一份、主屏一份。安卓相反，
 *    Chrome 装的是 WebAPK，有 link capturing。
 * ③ **这一版不带推送。** iOS 16.4 起主屏 Web App 其实能收 Web Push，
 *    但那要 Service Worker + VAPID，是另一摊；而且 Web Push 做不到
 *    Bark 的长按复制，替代不了它。
 */
/**
 * 浏览器通知（Web Push）。
 *
 * 定位要说清楚，否则人会拿它当 Bark 用然后失望。两条限制是硬的：
 *
 * ① **通知上没法一键复制验证码。** Service Worker 里没有 navigator.clipboard，
 *    Clipboard API 又要求文档处于聚焦状态，通知点击两个条件都不满足。
 *    所以验证码只能放进正文让人看着抄，或者点进去复制。
 * ② **Chrome / Firefox 把浏览器完全退出就收不到。** SW 只在浏览器进程
 *    还活着时才会被唤起。macOS Safari 走 APNs，关掉也能收。
 *
 * 订阅本身是一条渠道，所以规则、测试按钮、按用户隔离全都直接复用。
 */
/**
 * 备份。
 *
 * 界面上这两个按钮**不能画得一样重**：
 * 配置 JSON 是明文的，不需要任何钥匙就能读，里面是规则、号码、任务正文；
 * 消息导出更甚，那是全部短信正文。而数据库文件加上 GW_DEK 才是真正的
 * 「整机备份」，那条路是运维动作，不在浏览器里做。
 */
function paintBackup() {
  const box = $('#backup')
  if (!box) return
  box.innerHTML = `
    <p class="muted" style="margin:0 0 10px">导出规则、计划任务、渠道设置。
    <b>渠道密钥不在里面</b>（Bot Token、Bark Key、ntfy 主题、Webhook 地址），
    恢复后要重新填一次。</p>
    <div class="btnrow">
      <button class="sm" id="bk_export">导出配置</button>
      <button class="ghost sm" id="bk_import">从文件恢复</button>
    </div>
    <div class="notice" style="margin-top:10px">导出的是<b>明文文件</b>：没有密钥，
    但规则、号码、任务正文都能直接读。别放进会自动同步的目录。</div>

    <label style="margin-top:14px">导出消息</label>
    <div class="muted">全部短信、通话、通知的正文，NDJSON 一行一条。
    这个文件<b>是你全部短信的明文</b>。</div>
    <div class="btnrow" style="margin-top:8px">
      <button class="ghost sm" id="bk_sms">短信</button>
      <button class="ghost sm" id="bk_call">通话</button>
      <button class="ghost sm" id="bk_all">全部</button>
    </div>
    <div class="muted" style="margin-top:14px;font-size:12px">
      <b>真正的整机备份</b>是服务器上的 <span class="mono">data/</span> 目录加上
      <span class="mono">GW_DEK</span>，两者<b>要分开存</b>——放在一起等于没加密。
      那是运维动作，控制台里做不了，也不该做。</div>
    <div class="err-text" id="bk_err"></div>
    <div class="muted" id="bk_out" style="margin-top:8px"></div>`

  const save = (blob, name) => {
    // 鉴权走 Bearer 不是 Cookie，所以 <a href> 直接下载会 404，只能 fetch 成 Blob。
    // 也别用 window.open(blobUrl)——那是导航，各浏览器行为不一致
    const u = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = u
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(u), 1000)
  }
  const stamp = () => new Date().toISOString().slice(0, 10)

  $('#bk_export').onclick = async () => {
    $('#bk_err').textContent = ''
    try {
      const r = await api('/backup/config')
      save(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), `homing-config-${stamp()}.json`)
      const missing = r.channels.flatMap((c) => c.missing)
      $('#bk_out').textContent = `已导出：规则 ${r.rules.length}、任务 ${r.tasks.length}、渠道 ${r.channels.length}`
        + (missing.length ? `。渠道密钥没有导出，恢复后要重填。` : '')
    } catch (e) { $('#bk_err').textContent = e.message }
  }

  $('#bk_import').onclick = () => {
    const f = document.createElement('input')
    f.type = 'file'
    f.accept = 'application/json,.json'
    f.onchange = async () => {
      const file = f.files && f.files[0]
      if (!file) return
      $('#bk_err').textContent = ''
      $('#bk_out').textContent = '恢复中…'
      try {
        const r = await api('/backup/config', { method: 'POST', body: JSON.parse(await file.text()) })
        $('#bk_out').innerHTML = `已恢复：规则 +${r.rules}、任务 +${r.tasks}、渠道 +${r.channels}、设置 +${r.settings}`
          + (r.skipped ? `，同名的跳过 ${r.skipped} 条` : '')
          + (r.failed.length ? `<br><span class="badge err">${r.failed.length} 条没导进来</span> ${esc(r.failed.join('、'))}` : '')
          + '<br>恢复出来的<b>渠道和任务都是停用的</b>：渠道缺密钥，任务缺设备，'
          + '填好之后再自己打开。'
      } catch (e) {
        $('#bk_out').textContent = ''
        $('#bk_err').textContent = e.message
      }
    }
    f.click()
  }

  for (const [id, kind, label] of [['#bk_sms', 'sms', '短信'], ['#bk_call', 'call', '通话'], ['#bk_all', '', '全部']]) {
    $(id).onclick = async () => {
      const b = $(id)
      b.disabled = true
      $('#bk_err').textContent = ''
      $('#bk_out').textContent = '导出中，消息多的话要等一会儿…'
      try {
        const r = await fetch(`/api/backup/events${kind ? `?kind=${kind}` : ''}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (!r.ok) throw new Error(`导出失败（${r.status}）`)
        const blob = await r.blob()
        save(blob, `homing-${kind || 'all'}-${stamp()}.ndjson`)
        $('#bk_out').textContent = `已导出${label}，${(blob.size / 1024).toFixed(0)} KB`
      } catch (e) { $('#bk_err').textContent = e.message }
      b.disabled = false
    }
  }
}

async function paintWebPush() {
  const box = $('#webpush')
  if (!box) return

  const supported = 'serviceWorker' in navigator && 'PushManager' in window
  if (!supported) {
    box.innerHTML = `<p class="muted" style="margin:0">这个浏览器不支持 Web Push。
      iPhone 上要先把控制台<b>添加到主屏幕</b>，从主屏图标打开才能订阅——Safari 标签页里不行。</p>`
    return
  }

  const perm = Notification.permission
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null)
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null

  const limits = `<p class="muted" style="font-size:12px;margin:10px 0 0">
    两条限制：通知上<b>没有「复制」按钮</b>（浏览器不给 Service Worker 访问剪贴板），
    验证码放在正文里，点通知会打开那条消息。
    Chrome、Firefox 上<b>把浏览器完全退出就收不到</b>；macOS 的 Safari 关掉也能收。</p>`

  if (perm === 'denied') {
    box.innerHTML = `<p class="muted" style="margin:0">通知权限被拒绝了。
      要用的话去浏览器的网站设置里把这个站点的通知改成「允许」，再回来订阅。</p>` + limits
    return
  }

  if (sub) {
    /**
     * 浏览器有订阅 ≠ 真的收得到。
     *
     * 两者是两套状态：订阅在浏览器里，而「往哪推」在服务端的渠道表里。
     * 服务端那条被删掉、或者当初订阅时那次 API 调用失败了，浏览器这边
     * 照样显示「已订阅」——而实际上一条都不会到。这是个纯粹的静默失败。
     *
     * 所以每次进来都把订阅重新登记一次（服务端按 endpoint 去重，是幂等的），
     * 用这一次调用的成败来决定显示什么，而不是只看浏览器。
     */
    const j = sub.toJSON()
    let reg2 = null
    try {
      reg2 = await api('/push/subscribe', {
        method: 'POST',
        body: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, label: browserLabel() },
      })
    } catch (e) {
      box.innerHTML = `<div class="notice">这个浏览器订阅过，但<b>服务端没登记上</b>，
        所以推送不会到达。刷新页面重试，或者退订后重新订阅一次。</div>
        <div class="err-text">${esc(e.message)}</div>
        <div class="btnrow" style="margin-top:10px">
          <button class="danger sm" id="wp_off">退订这个浏览器</button>
        </div>` + limits
      $('#wp_off').onclick = async () => {
        try { await sub.unsubscribe() } catch { /* 已经没了也算成功 */ }
        void paintWebPush()
  paintBackup()
      }
      return
    }

    box.innerHTML = `<div class="row">
        <div class="col grow">
          <span><b>这个浏览器已订阅</b></span>
          <span class="muted">它在「渠道」页里是一条渠道，可以点测试、也能被规则选中。</span>
        </div>
        <span class="badge ${reg2.enabled ? 'ok' : 'plain'}">${reg2.enabled ? '已订阅' : '渠道已停用'}</span>
      </div>
      ${reg2.enabled ? '' : '<div class="notice" style="margin-top:8px">这条渠道在渠道页里被停用了，停用期间收不到通知。</div>'}
      <div class="btnrow" style="margin-top:10px">
        <a href="/channels"><button class="ghost sm">去渠道页</button></a>
        <button class="danger sm" id="wp_off">退订这个浏览器</button>
      </div>` + limits
    $('#wp_off').onclick = async () => {
      if (!confirm('退订之后这个浏览器就不再收到通知。渠道页里那条记录要自己删。')) return
      try { await sub.unsubscribe() } catch { /* 已经没了也算成功 */ }
      toast('已退订')
      void paintWebPush()
  paintBackup()
    }
    return
  }

  box.innerHTML = `<p class="muted" style="margin:0">让验证码直接弹在这台电脑（或这个浏览器）的通知里，
    人在电脑前时不用摸手机。</p>
    <div class="btnrow" style="margin-top:10px"><button class="sm" id="wp_on">在这个浏览器上订阅</button></div>
    <div class="err-text" id="wp_err"></div>` + limits

  $('#wp_on').onclick = async () => {
    const btn = $('#wp_on')
    btn.disabled = true
    $('#wp_err').textContent = ''
    try {
      // 权限弹窗必须由真实的用户手势触发，不能在页面加载时自动调
      const p = await Notification.requestPermission()
      if (p !== 'granted') throw new Error('没有拿到通知权限')

      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const { key } = await api('/push/key')
      const s = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uToBytes(key),
      })
      const j = s.toJSON()
      await api('/push/subscribe', {
        method: 'POST',
        body: {
          endpoint: j.endpoint,
          p256dh: j.keys.p256dh,
          auth: j.keys.auth,
          label: browserLabel(),
        },
      })
      toast('已订阅，去渠道页点一下测试')
      void paintWebPush()
  paintBackup()
    } catch (e) {
      $('#wp_err').textContent = e.message
      btn.disabled = false
    }
  }
}

/** applicationServerKey 只收 Uint8Array，不认 base64url 字符串 */
function b64uToBytes(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** 给这条订阅起个人认得出的名字——一个人可能在好几个浏览器上订阅 */
function browserLabel() {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? '安卓'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '浏览器'
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  return [os, br, standalone ? '主屏' : ''].filter(Boolean).join(' ')
}

function paintA2HS() {
  const box = $('#a2hs')
  if (!box) return

  const standalone = matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches
    || navigator.standalone === true
  const ua = navigator.userAgent
  const iOS = /iPhone|iPad|iPod/.test(ua)
    // iPadOS 13+ 的 Safari 默认报 Mac 的 UA，靠触点数区分
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)

  if (standalone) {
    box.innerHTML = `<div class="row">
      <div class="col grow">
        <span><b>已经是主屏 App</b></span>
        <span class="muted">你正从主屏图标打开控制台。</span>
      </div>
      <span class="badge ok">已安装</span>
    </div>
    <p class="muted" style="margin:10px 0 0">这里和 Safari 里是<b>两份独立的登录状态</b>，各自都可以勾「保持登录 30 天」。</p>`
    return
  }

  const caveats = `
    <div class="notice" style="margin-top:10px">
      <b>装上之后要再登录一次。</b>主屏 App 和浏览器是两个独立的存储空间，
      浏览器里的登录状态带不过去。登录时记得勾「保持登录 30 天」，否则每次都要重输。
    </div>
    <p class="muted" style="margin:10px 0 0">
      ${iOS
        ? 'Bark 通知点进去会在 Safari 里打开，<b>不会进主屏 App</b>——iOS 不支持，没有变通。'
        : '安卓装的是 WebAPK，通知或链接点进去会直接落在这个 App 里。'}
      这一版<b>不带推送通知</b>，验证码仍然靠 Bark / Telegram 送到你手上。
    </p>`

  box.innerHTML = `
    <p class="muted" style="margin:0">把控制台放到主屏幕，像 App 一样打开：全屏、没有地址栏、
    不用每次在浏览器里找书签。</p>
    <div id="a2hs_how"></div>
    ${caveats}`

  const how = $('#a2hs_how')
  if (iOS) {
    how.innerHTML = `<ol class="howto" style="margin-top:10px">
      <li>点 Safari 底部中间的<b>分享</b>键（方框里一个向上的箭头）。</li>
      <li>在列表里往下找<b>「添加到主屏幕」</b>。</li>
      <li>右上角点<b>「添加」</b>。</li>
    </ol>
    <p class="muted" style="font-size:12px;margin:0">必须用 <b>Safari</b>——从微信、Chrome 等
    App 内置的浏览器里打开是没有这个选项的。</p>`
    return
  }

  // 安卓 Chrome 才有 beforeinstallprompt，而且它需要 Service Worker 才可靠触发，
  // 这一版没有 SW，所以多半拿不到 prompt——按钮要能优雅退化成图文引导
  how.innerHTML = `<div class="btnrow" style="margin-top:10px">
      <button class="sm" id="a2hs_go">添加到主屏幕</button>
    </div>
    <div class="muted" id="a2hs_hint" style="margin-top:6px"></div>`
  const hint = $('#a2hs_hint')
  $('#a2hs_go').onclick = async () => {
    if (deferredInstall) {
      deferredInstall.prompt()
      const r = await deferredInstall.userChoice.catch(() => null)
      deferredInstall = null
      hint.textContent = r?.outcome === 'accepted' ? '正在安装…' : '已取消。想装的话从浏览器菜单里也能装。'
      return
    }
    hint.innerHTML = '浏览器没给出安装入口。点右上角的 <b>⋮</b> 菜单，'
      + '找<b>「安装应用」</b>或<b>「添加到主屏幕」</b>。'
  }
}

/**
 * 安卓 Chrome 的安装事件。必须在事件发生的那一刻接住并阻止默认行为，
 * 之后才能由我们自己的按钮触发——它不会重复发。
 */
let deferredInstall = null
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredInstall = e
})

async function paintTotp() {
  const box = $('#totpbox')
  if (!box) return
  const on = me?.totp === true

  box.innerHTML = on ? `
    <div class="row">
      <div class="col grow">
        <span><b>已开启</b></span>
        <span class="muted">登录时要多输一次认证器上的 6 位动态码。</span>
      </div>
      <span class="badge ok">开</span>
    </div>
    <div class="btnrow"><button class="danger sm" id="t_off">关闭两步验证</button></div>
    <div id="t_err" class="err-text"></div>`
  : `
    <div class="row">
      <div class="col grow">
        <span><b>没有开启</b></span>
        <span class="muted">登录只要用户名和口令。这个网页上能看到你所有的短信，
        建议开一下——只是登录时多输 6 位数字。</span>
      </div>
      <span class="badge plain">关</span>
    </div>
    <div class="btnrow"><button class="sm" id="t_on">开启两步验证</button></div>
    <div id="t_setup"></div>
    <div id="t_err" class="err-text"></div>`

  const onBtn = $('#t_on')
  if (onBtn) onBtn.onclick = async () => {
    onBtn.disabled = true
    try {
      const r = await api('/auth/totp/setup', { method: 'POST' })
      $('#t_setup').innerHTML = `
        <div class="card" style="margin-top:12px">
          <p class="muted">用 Google Authenticator、1Password、iOS 自带密码 App 等扫码。</p>
          ${r.qr ? `<div class="qr">${r.qr}</div>` : ''}
          <details>
            <summary class="muted">扫不了？手动添加</summary>
            <div class="mono wrap card tight" style="user-select:all">${esc(r.secret)}</div>
          </details>
          <label>输入认证器显示的 6 位验证码</label>
          <input id="t_code" inputmode="numeric" maxlength="6" class="mono" style="font-size:20px;letter-spacing:4px">
          <div class="btnrow"><button class="sm" id="t_done">完成绑定</button></div>
        </div>`
      $('#t_done').onclick = async () => {
        try {
          await api('/auth/totp/enable', { method: 'POST', body: { code: $('#t_code').value.trim() } })
          me = (await api('/auth/me')).user
          toast('两步验证已开启')
          paintTotp()
        } catch (e) { $('#t_err').textContent = e.message }
      }
    } catch (e) {
      $('#t_err').textContent = e.message
      onBtn.disabled = false
    }
  }

  const offBtn = $('#t_off')
  if (offBtn) offBtn.onclick = async () => {
    const pw = prompt('关闭两步验证。\n\n关掉之后，口令就是这个账号唯一的钥匙。\n\n请输入当前口令：')
    if (pw === null) return
    const code = prompt('再输入认证器上当前显示的 6 位动态码：')
    if (code === null) return
    try {
      await api('/auth/totp/disable', { method: 'POST', body: { password: pw, code: code.trim() } })
      me = (await api('/auth/me')).user
      toast('两步验证已关闭')
      paintTotp()
    } catch (e) { $('#t_err').textContent = e.message }
  }
}

/** 账号有效期的人话。到期了要说出来，不能只显示一个日期让人自己算 */
function validityText(u) {
  if (u.expires_at == null) return '永久'
  if (u.days_left <= 0) return `已于 ${fmtDay(u.expires_at)} 到期`
  if (u.days_left <= 7) return `还有 ${u.days_left} 天到期`
  return `${fmtDay(u.expires_at)} 到期`
}

const fmtDay = (ts) => new Date(ts).toLocaleDateString('zh-CN')

/**
 * 邀请码管理。
 *
 * 码只在生成那一次给出明文——之后库里只有哈希，列表里显示不出来。
 * 所以备注是必需的人类把手：没有它，管理员不知道该撤销哪一条。
 */
/** 注册开关的当前状态。生成邀请码那一刻要用它决定提不提醒 */
let regOpen = false

async function paintInvites() {
  const box = $('#invites')
  if (!box) return
  try {
    const [{ invites }, reg] = await Promise.all([api('/invites'), api('/registration')])
    $('#reg_mode').value = reg.mode
    regOpen = reg.mode === 'invite'

    /**
     * 注册关着的时候，列表里每一个「未使用」的码其实都用不了。
     *
     * 不提醒的话失败发生在看不见的地方：你把链接发出去，对方点开只看到
     * 「这台服务器没有开放注册」，两个人都不知道少了哪一步。
     */
    const live = invites.filter((i) => !i.used_at && !i.expired).length
    const warn = !regOpen && live > 0
      ? `<div class="notice" style="margin-bottom:10px">注册当前是<b>关闭</b>的，下面那 ${live} 个还没用的码现在都注册不了。把上面的开关改成「凭邀请码注册」才生效。</div>`
      : ''

    box.innerHTML = warn + (invites.length ? `<div class="list">${invites.map((i) => {
      const state = i.used_at ? `已被 ${esc(i.used_by ?? '某人')} 使用`
        : i.expired ? '已过期'
        : `未使用 · ${fmtDay(i.expires_at)} 前有效`
      return `<div class="item">
        <div class="row">
          <b class="truncate">${i.note ? esc(i.note) : '（没写备注）'}</b>
          <span class="muted mono" style="font-size:12px;flex:none">${fmt(i.created_at)}</span>
        </div>
        <span class="muted">${state} · 开出的账号${i.valid_days ? ` ${i.valid_days} 天` : '永久'}有效</span>
        ${i.used_at || i.expired ? '' : `<div class="btnrow" style="margin-top:6px">
          <button class="danger sm" data-revoke="${esc(i.code_hash)}">撤销</button>
        </div>`}
      </div>`
    }).join('')}</div>` : '<div class="muted">还没有发过邀请码。</div>')

    for (const b of box.querySelectorAll('[data-revoke]')) {
      b.onclick = async () => {
        if (!confirm('撤销这个邀请码？还没用的话就作废了。')) return
        try {
          await api(`/invites/${encodeURIComponent(b.dataset.revoke)}`, { method: 'DELETE' })
          toast('已撤销')
          paintInvites()
        } catch (e) { toast(e.message) }
      }
    }
  } catch (e) {
    box.innerHTML = `<div class="err-text">${esc(e.message)}</div>`
  }
}

/** 生成之后把码、链接、二维码一次性摆出来——之后再也拿不到明文 */
function showInvite(r) {
  $('#inv_new').innerHTML = `
    <div class="card" style="margin-top:12px">
      <div style="font-weight:800;margin-bottom:6px">邀请码已生成</div>
      <p class="muted">这串码<b>只显示这一次</b>。把它或下面的链接发给对方，
      链接里的码放在 # 后面，不会进服务器日志。</p>
      <label>邀请码</label>
      <div class="mono wrap card tight" style="user-select:all;font-size:18px;letter-spacing:3px">${esc(r.code)}</div>
      ${r.url ? `<label>注册链接</label>
        <div class="mono wrap card tight" style="user-select:all;font-size:12px">${esc(r.url)}</div>` : `
        <div class="muted">没配 GW_BASE_URL，给不出链接——让对方自己打开控制台的注册页填码。</div>`}
      <div class="muted" style="margin-top:8px">码本身在 ${fmt(r.expires_at)} 前有效。</div>
      ${regOpen ? '' : `<div class="notice" style="margin-top:8px">注意：注册现在是<b>关闭</b>的，这个码发出去对方也注册不了。发之前先把上面的开关改成「凭邀请码注册」。</div>`}
      <div class="btnrow"><button class="ghost sm" id="inv_hide">我记下了，隐藏</button></div>
    </div>`
  $('#inv_hide').onclick = () => { $('#inv_new').innerHTML = '' }
}

/** 新建或重置后，口令与二维码**只显示这一次**。 */
function showNewUser(r, what = '已创建') {
  $('#u_new').innerHTML = `
    <div class="card" style="margin-top:12px">
      <!-- 不用 h2：它是全大写的，而用户名要原样显示 -->
      <div style="font-weight:800;margin-bottom:6px">${esc(what)}：${esc(r.name)}</div>
      <p class="muted">口令和二维码<b>只显示这一次</b>。让对方当面扫码，
      并在他登录后立刻自己改口令。</p>
      <label>初始口令</label>
      <div class="mono wrap card tight" style="user-select:all">${esc(r.password)}</div>
      ${r.qr ? `<div class="qr">${r.qr}</div>` : ''}
      <details>
        <summary class="muted">扫不了？手动添加</summary>
        <div class="mono wrap card tight" style="user-select:all">${esc(r.secret)}</div>
      </details>
      <div class="btnrow"><button class="ghost sm" id="u_hide">我记下了，隐藏</button></div>
    </div>`
  $('#u_hide').onclick = () => { $('#u_new').innerHTML = '' }
}

async function settings() {
  // 「我是谁」要先问清楚：用户管理只对管理员显示
  if (!me) me = (await api('/auth/me').catch(() => null))?.user ?? null

  render(`
    <h1>设置</h1>
    ${me ? `<div class="card tight row">
      <div class="col grow">
        <span>当前登录 <b>${esc(me.name)}</b></span>
        <span class="muted">${me.role === 'admin' ? '管理员 · 可以建号、停用、续期、重置口令' : '普通用户'}</span>
      </div>
    </div>` : ''}
    ${me?.role === 'admin' ? `
      <h2>用户</h2>
      <div class="card">
        <p class="muted">每个账号在控制台里只能看到自己的设备、渠道、规则和消息。
        家人合用一台网关时，各自配各自的卡。</p>
        <div class="card tight" style="background:var(--bg)">
          <b>管理员能看到什么</b>
          <p class="muted" style="margin:6px 0 0">这是<b>应用层</b>的隔离，不是密码学隔离。
          你作为管理员能重置任何人的口令，从而以他的身份登录看到他全部的短信——
          这个动作会写审计，并且会推一条通知到<b>他自己</b>的渠道。
          持有这台服务器和密钥的人，技术上能读到库里的一切。
          给朋友开号前请让他知道这件事。</p>
        </div>
        <div id="users"><div class="loading">加载中…</div></div>
        <label>新用户的登录名</label>
        <input id="u_name" placeholder="字母数字，2–24 位">
        <div class="btnrow"><button id="u_add" class="sm">创建</button></div>
        <div id="u_err" class="err-text"></div>
        <div id="u_new"></div>
      </div>

      <h2>开放注册</h2>
      <div class="card">
        <p class="muted">开了之后，拿到邀请码的人可以自己注册。
        <b>没有「完全开放」这一档</b>：这台服务器能解密所有注册者的短信，码发给了谁你得清楚。</p>
        <label>注册方式</label>
        <select id="reg_mode">
          <option value="off">关闭（只有你能建号）</option>
          <option value="invite">凭邀请码自助注册</option>
        </select>
        <label>你的联系方式</label>
        <input id="admin_contact" placeholder="如 Telegram @yourname，或邮箱">
        <div class="muted">界面上到处写着「联系管理员续期 / 重置」，得让对方知道找谁。
        会显示在注册页、找回页和到期提示里。</div>
        <div class="btnrow"><button id="reg_save" class="sm">保存</button></div>

        <h2 style="margin-top:22px">邀请码</h2>
        <div id="invites"><div class="loading">加载中…</div></div>
        <label>备注（发给谁）</label>
        <input id="inv_note" placeholder="如 给小鱼">
        <div style="display:flex;gap:8px">
          <div class="grow">
            <label>账号能用多久</label>
            <select id="inv_days">
              <option value="">永久</option>
              <option value="7">7 天</option>
              <option value="30" selected>30 天</option>
              <option value="90">90 天</option>
              <option value="180">180 天</option>
              <option value="365">1 年</option>
            </select>
          </div>
          <div class="grow">
            <label>码本身多久失效</label>
            <select id="inv_ttl">
              <option value="1">1 小时</option>
              <option value="24">1 天</option>
              <option value="72">3 天</option>
              <option value="168" selected>7 天</option>
              <option value="720">30 天</option>
            </select>
          </div>
        </div>
        <div class="btnrow"><button id="inv_add" class="sm">生成邀请码</button></div>
        <div id="inv_err" class="err-text"></div>
        <div id="inv_new"></div>
      </div>` : ''}

      <h2>两步验证</h2>
      <div class="card" id="totpbox"><div class="loading">加载中…</div></div>
    <div class="card tight row">
      <span>通知渠道</span>
      <a href="/channels"><button class="ghost sm">管理</button></a>
    </div>
    <h2>计划任务</h2>
    <div class="card tight row">
      <div class="col grow">
        <span>定时发送短信</span>
        <span class="muted">保号、提醒等。每张卡各建一个任务。</span>
      </div>
      <a href="/tasks"><button class="ghost sm">管理</button></a>
    </div>

    <div id="retention"></div>
    <div id="notify"></div>
    <div id="battery"></div>
    <div id="smscmd"></div>

    <h2>备份</h2>
    <div class="card" id="backup"></div>

    <h2>浏览器通知</h2>
    <div class="card" id="webpush"></div>

    <h2>装到主屏幕</h2>
    <div class="card" id="a2hs"></div>

    <h2>时区</h2>
    <div class="card">
      <p class="muted">计划任务的执行时间、规则的生效时段、推送模板里的 {time} 都按这个时区算。
      服务端跑在 UTC，不设对的话「每天 9 点」会差几个小时。</p>
      <select id="tz"></select>
      <div class="muted" id="tz_now"></div>
      <div class="btnrow"><button id="tz_save" class="sm">保存</button></div>
      <div id="tz_err" class="err-text"></div>
    </div>

    <h2>修改口令</h2>
    <div class="card">
      <label>当前口令</label><input id="old" type="password" autocomplete="current-password">
      <label>新口令（至少 8 位，含英文 / 数字 / 符号中的两类）</label><input id="new" type="password" autocomplete="new-password">
      <label>再输一次新口令</label><input id="new2" type="password" autocomplete="new-password">
      <div class="muted">修改后所有已登录的会话都会失效，包括当前这个。忘了可以在登录页用「忘记口令」找回。</div>
      <div class="btnrow"><button id="chpw">修改</button></div>
      <div id="err" class="err-text"></div>
    </div>
    <h2>会话</h2>
    <div class="card">
      <div class="row">
        <span class="muted">退出当前设备</span>
        <button class="ghost sm" id="logout">退出</button>
      </div>
      <div class="row" style="margin-top:10px">
        <div class="col grow">
          <span>全端下线</span>
          <span class="muted">断开所有已登录会话。怀疑凭证泄露时用，不必改口令。</span>
        </div>
        <button class="danger sm" id="revokeall">全端下线</button>
      </div>
    </div>`)

  void paintTotp()
  paintA2HS()
  void paintWebPush()
  paintBackup()

  if (me?.role === 'admin') {
    void paintUsers()
    void paintInvites()
    void (async () => {
      const r = await api('/admin-contact').catch(() => null)
      if (r) $('#admin_contact').value = r.contact || ''
    })()
    $('#reg_save').onclick = async () => {
      try {
        await api('/registration', { method: 'POST', body: { mode: $('#reg_mode').value } })
        await api('/admin-contact', { method: 'POST', body: { contact: $('#admin_contact').value.trim() } })
        toast('已保存')
      } catch (e) { toast(e.message) }
    }
    $('#inv_add').onclick = async () => {
      $('#inv_add').disabled = true
      $('#inv_err').textContent = ''
      try {
        const r = await api('/invites', {
          method: 'POST',
          body: {
            note: $('#inv_note').value.trim(),
            days: $('#inv_days').value ? Number($('#inv_days').value) : undefined,
            ttl_hours: Number($('#inv_ttl').value),
          },
        })
        $('#inv_note').value = ''
        showInvite(r)
        paintInvites()
      } catch (e) { $('#inv_err').textContent = e.message }
      $('#inv_add').disabled = false
    }
    $('#u_add').onclick = async () => {
      const name = $('#u_name').value.trim()
      if (!name) return ($('#u_err').textContent = '请填用户名')
      $('#u_add').disabled = true
      $('#u_err').textContent = ''
      try {
        const r = await api('/users', { method: 'POST', body: { name } })
        $('#u_name').value = ''
        showNewUser(r)
        paintUsers()
      } catch (e) { $('#u_err').textContent = e.message }
      $('#u_add').disabled = false
    }
  }

  $('#revokeall').onclick = async () => {
    if (!confirm('断开所有会话？你也会被登出。')) return
    try { await api('/auth/revoke-all', { method: 'POST' }) } catch { /* 已经失效也算成功 */ }
    setToken('')
    me = null
    toast('已全端下线')
    go('/login')
  }

  void paintRetention()
  void paintNotifyCapture()
  void paintBattery()
  void paintSmsCommand()
  void paintTimezone()

  $('#chpw').onclick = async () => {
    // 两次输入一致再校验强度：口令改错又无找回流程，等于把自己锁在门外
    if ($('#new').value !== $('#new2').value) {
      return ($('#err').textContent = '两次输入的新口令不一致')
    }
    const bad = checkPassword($('#new').value)
    if (bad) return ($('#err').textContent = bad)
    try {
      await api('/auth/password', { method: 'POST', body: { old: $('#old').value, new: $('#new').value } })
      setToken('')
      toast('口令已修改，请重新登录')
      go('/login')
    } catch (e) { $('#err').textContent = e.message }
  }

  $('#logout').onclick = async () => {
    try { await api('/auth/logout', { method: 'POST' }) } catch { /* 本地清掉即可 */ }
    setToken('')
    me = null
    go('/login')
  }
}

/**
 * 保号任务设置。
 *
 * 国内号码长期零消费 + 异地漫游可能被停机，而停机是静默的——
 * 到你需要验证码那天才会发现。
 */
async function paintTimezone() {
  const el = $('#tz')
  if (!el) return
  let current
  try {
    current = (await api('/timezone')).timezone
  } catch { return }

  // 浏览器自带完整的 IANA 时区表，不用我们维护一份；老浏览器退回常用几个
  let zones = []
  try { zones = Intl.supportedValuesOf('timeZone') } catch { zones = [] }
  if (zones.length === 0) zones = TZ_FALLBACK
  // 当前值可能不在表里（服务端设过一个浏览器不认的），也要能选中，不能悄悄改掉
  if (!zones.includes(current)) zones = [current, ...zones]

  // 本机时区置顶：绝大多数情况下用户要的就是它
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  const top = [...new Set([current, local].filter((z) => z && zones.includes(z)))]

  const group = (list) => {
    const byRegion = new Map()
    for (const z of list) {
      const region = z.includes('/') ? z.split('/')[0] : '其它'
      if (!byRegion.has(region)) byRegion.set(region, [])
      byRegion.get(region).push(z)
    }
    return [...byRegion.entries()].map(([r, zs]) =>
      `<optgroup label="${esc(r)}">${zs.map((z) => `<option value="${esc(z)}"${z === current ? ' selected' : ''}>${esc(z)}</option>`).join('')}</optgroup>`,
    ).join('')
  }

  el.innerHTML =
    `<optgroup label="常用">${top.map((z) =>
      `<option value="${esc(z)}"${z === current ? ' selected' : ''}>${esc(z)}${z === local ? '（本机）' : ''}</option>`).join('')}</optgroup>` +
    group(zones.filter((z) => !top.includes(z)))
  el.value = current

  // 把选中时区的当前时间显示出来：时区名看不出对不对，时间能看出来
  const paintNow = () => {
    try {
      $('#tz_now').textContent = `该时区现在是 ${new Date().toLocaleString('zh-CN', { timeZone: el.value, hour12: false })}`
    } catch { $('#tz_now').textContent = '' }
  }
  paintNow()
  el.onchange = paintNow

  $('#tz_save').onclick = async () => {
    try {
      await api('/timezone', { method: 'POST', body: { timezone: el.value } })
      current = el.value
      toast('已保存')
    } catch (e) { $('#tz_err').textContent = e.message }
  }
}

/** Intl.supportedValuesOf 不可用时的退路，覆盖这个项目实际会用到的几个。 */
const TZ_FALLBACK = [
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore',
  'Asia/Seoul', 'Asia/Bangkok', 'Asia/Dubai', 'Europe/London', 'Europe/Paris',
  'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC',
]

/**
 * 通知捕获设置。
 *
 * 两种范围：「全部应用」省心，新装的应用不用回来改列表，代价是通知量大；
 * 「仅选定应用」精准但要维护列表。默认后者。
 */

/**
 * 消息保留上限。
 *
 * 三条自我约束：
 *
 * ① **有限集合给下拉不给文本框**（CLAUDE.md）。手写一个 999 和手写一个 99
 *    在界面上长得差不多，而后者会多删掉 900 条。
 * ② **保存前必须把「会删掉多少条」摆在脸上。** 只给一个下拉让人选 999，
 *    他不会知道那意味着当场少掉三万条。这个数字是这个功能唯一的刹车。
 * ③ **确认框里要打出具体条数**，不能只写「确定吗」。人人都会点掉的弹窗
 *    等于没有弹窗。
 */
async function paintRetention() {
  const box = $('#retention')
  if (!box) return
  const KINDS = [
    { k: 'sms', label: '短信' },
    { k: 'call', label: '通话记录' },
    { k: 'notification', label: '应用通知' },
  ]
  let d
  try { d = await api('/retention') } catch { box.innerHTML = ''; return }

  const opt = (cur) => d.choices.map((n) =>
    `<option value="${n}"${n === cur ? ' selected' : ''}>${n === 0 ? '不限制（全部保留）' : `最新 ${n} 条`}</option>`).join('')

  const paint = () => {
    box.innerHTML = `
      <h2>消息保留上限</h2>
      <div class="card">
        <p class="muted">超出上限的旧消息会被自动删除，<b>删除不可恢复</b>。三类各算各的。</p>
        ${KINDS.map(({ k, label }) => `
          <label>${label}<span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400"> · 当前 ${d.counts[k]} 条</span></label>
          <select id="ret_${k}">${opt(d.retention[k])}</select>
          <div class="muted" id="ret_${k}_hint" style="margin-bottom:10px"></div>`).join('')}
        <div class="btnrow"><button id="ret_save" class="sm">保存</button></div>
        <div id="ret_err" class="err-text"></div>
      </div>`

    // 选中的那一刻就把代价算出来，不等到点保存
    const recount = () => {
      let total = 0
      for (const { k, label } of KINDS) {
        const v = Number($(`#ret_${k}`).value)
        const over = v > 0 ? Math.max(d.counts[k] - v, 0) : 0
        total += over
        $(`#ret_${k}_hint`).innerHTML = over > 0
          ? `<span class="badge err">保存后删除 ${over} 条</span>`
          : (v > 0 ? '当前条数没超过上限，不会删除。' : '不限制。')
        void label
      }
      $('#ret_save').textContent = total > 0 ? `保存并删除 ${total} 条` : '保存'
    }
    for (const { k } of KINDS) $(`#ret_${k}`).onchange = recount
    recount()

    $('#ret_save').onclick = async () => {
      const next = {}
      let total = 0
      const lines = []
      for (const { k, label } of KINDS) {
        next[k] = Number($(`#ret_${k}`).value)
        const over = next[k] > 0 ? Math.max(d.counts[k] - next[k], 0) : 0
        if (over > 0) { total += over; lines.push(`${label} ${over} 条`) }
      }
      // 会删东西才拦一下，而且把具体条数打出来——「确定吗」这种问法人人都会点掉
      if (total > 0 && !confirm(`将永久删除 ${lines.join('、')}，共 ${total} 条。\n\n删除后无法恢复。确定继续吗？`)) return
      $('#ret_save').disabled = true
      $('#ret_err').textContent = ''
      try {
        const r = await api('/retention', { method: 'POST', body: { retention: next, confirm: total > 0 } })
        toast(r.deleted > 0
          ? (r.done ? `已保存，删除了 ${r.deleted} 条` : `已保存，已删除 ${r.deleted} 条，剩下的在后台继续`)
          : '已保存')
        d = await api('/retention')
        paint()
      } catch (e) {
        $('#ret_err').textContent = e.message
        $('#ret_save').disabled = false
      }
    }
  }
  paint()
}

async function paintNotifyCapture() {
  const box = $('#notify')
  if (!box) return
  let cfg, devs
  try {
    ;[cfg, devs] = await Promise.all([api('/notify-capture'), api('/devices').catch(() => ({ devices: [] }))])
  } catch { return }

  const online = devs.devices.filter((d) => d.status === 'online')
  let scope = cfg.scope === 'all' ? 'all' : 'selected'
  let picked = new Set(cfg.packages)
  let apps = null
  let allApps = null
  let showSystem = false

  const paint = () => {
    box.innerHTML = `
      <h2>应用通知捕获</h2>
      <div class="card">
        <p class="muted">很多验证码走 App 推送而不是短信（微信、支付宝、银行 App 的登录确认）。
        捕获到的通知会像短信一样走规则与渠道。</p>
        <p class="muted">需要在 Agent 里单独授予「通知使用权」——这是系统的特殊权限，
        不能由 App 自己申请，要你在手机上手动打开。</p>
        <label>总开关</label>
        <select id="nc_on">
          <option value="1"${cfg.enabled ? ' selected' : ''}>启用</option>
          <option value="0"${cfg.enabled ? '' : ' selected'}>停用</option>
        </select>

        <div id="nc_scopebox"${cfg.enabled ? '' : ' hidden'}>
          <label>捕获范围</label>
          <select id="nc_scope">
            <option value="selected"${scope === 'selected' ? ' selected' : ''}>仅选定应用</option>
            <option value="all"${scope === 'all' ? ' selected' : ''}>全部应用（含以后新装的）</option>
          </select>
          <div class="muted">
            ${scope === 'all'
              ? '所有应用的通知都转发，手机上新装的应用无需回来更新列表。通知量会明显变大，建议配合规则过滤。'
              : '只转发下面选中的应用。新装的应用要回到这里手动加。'}
          </div>

          <div id="nc_sel"${scope === 'all' ? ' hidden' : ''}>
            <label>捕获哪些应用（已选 ${picked.size} 个）</label>
            ${picked.size === 0 ? '<div class="muted">一个都没选等于不捕获。</div>' : ''}
            <div id="nc_picked">
              ${[...picked].map((p) => `
                <label style="display:flex;gap:8px;align-items:center;margin:4px 0">
                  <input type="checkbox" checked data-pkg="${esc(p)}" style="width:auto">
                  <span class="mono" style="font-size:12px">${esc(p)}</span>
                </label>`).join('')}
            </div>

            ${online.length > 0 ? `
              <div class="btnrow">
                <button class="ghost sm" id="nc_load">从设备读取应用列表</button>
              </div>` : '<div class="muted">没有在线设备，无法读取应用列表。</div>'}
            <div id="nc_apps"></div>
          </div>
        </div>

        <div class="btnrow"><button id="nc_save" class="sm">保存</button></div>
        <div class="muted">保存后设备会立即重连以应用新配置。</div>
        <div id="nc_err" class="err-text"></div>
      </div>`

    for (const c of box.querySelectorAll('[data-pkg]')) {
      c.onchange = () => { c.checked ? picked.add(c.dataset.pkg) : picked.delete(c.dataset.pkg); paint() }
    }

    $('#nc_on').onchange = (e) => { $('#nc_scopebox').hidden = e.target.value !== '1' }
    $('#nc_scope').onchange = (e) => { scope = e.target.value; paint() }

    const load = $('#nc_load')
    if (load) load.onclick = async () => {
      $('#nc_apps').innerHTML = '<div class="loading">读取中…</div>'
      load.disabled = true
      try {
        allApps = await api(`/devices/${online[0].id}/apps`, { method: 'POST' })
        apps = allApps.filter((a) => !a.system)
        paintApps()
      } catch (e) { $('#nc_apps').innerHTML = `<div class="err-text">${esc(e.message)}</div>` }
      load.disabled = false
    }

    if (apps) paintApps()

    $('#nc_save').onclick = async () => {
      try {
        await api('/notify-capture', {
          method: 'POST',
          body: { enabled: $('#nc_on').value === '1', scope, packages: [...picked] },
        })
        toast('已保存，设备正在重连')
        paintNotifyCapture()
      } catch (e) { $('#nc_err').textContent = e.message }
    }
  }

  const paintApps = () => {
    const box2 = $('#nc_apps')
    if (!box2 || !apps || scope === 'all') return
    box2.innerHTML = `
      <label>设备上的应用</label>
      <input id="nc_filter" placeholder="筛选应用名或包名">
      <label style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <input type="checkbox" id="nc_sys" style="width:auto"${showSystem ? ' checked' : ''}>
        <span>显示系统应用</span>
      </label>
      <div class="muted">这台机器上有用的可能恰恰是系统应用（如自带短信、通话）。</div>
      <div id="nc_list" style="max-height:280px;overflow-y:auto;margin-top:8px"></div>`

    const renderList = (kw = '') => {
      const list = apps.filter((a) => !kw || a.label.toLowerCase().includes(kw) || a.package.toLowerCase().includes(kw))
      $('#nc_list').innerHTML = list.slice(0, 200).map((a) => `
        <label style="display:flex;gap:8px;align-items:center;margin:4px 0">
          <input type="checkbox" data-app="${esc(a.package)}" style="width:auto"${picked.has(a.package) ? ' checked' : ''}>
          <span class="col" style="gap:0">
            <span>${esc(a.label)}</span>
            <span class="muted mono" style="font-size:11px">${esc(a.package)}</span>
          </span>
        </label>`).join('') + (list.length > 200 ? '<div class="muted">只显示前 200 个，用上面的筛选框缩小范围。</div>' : '')

      for (const c of $('#nc_list').querySelectorAll('[data-app]')) {
        c.onchange = () => { c.checked ? picked.add(c.dataset.app) : picked.delete(c.dataset.app) }
      }
    }
    renderList()
    $('#nc_filter').oninput = (e) => renderList(e.target.value.trim().toLowerCase())
    $('#nc_sys').onchange = (e) => {
      showSystem = e.target.checked
      apps = showSystem ? allApps : allApps.filter((a) => !a.system)
      paintApps()
    }
  }

  paint()
}

/**
 * 短信指令清单。与 Agent 的 SmsCommand.ALIASES 对应，改一端要改两端。
 *
 * 写成「指令（用途）」而不是一串词：人在外面着急的时候，
 * 看到「网络」两个字未必想得起来它到底答的是什么。
 */
const SMS_COMMANDS = [
  ['状态', '一条短信看全：连没连上服务端、WiFi、电量、有没有积压', 'status / st'],
  ['网络', 'WiFi 开没开、连的哪个、走的是 WiFi 还是移动数据', 'wifi / net'],
  ['电量', '剩多少电、在不在充电', 'battery / bat'],
  ['定位', '回一条带地图链接的位置', '位置 / locate'],
  ['重连', '让网关立刻重连服务端，不用等退避', '重启 / reconnect'],
]

/**
 * 短信指令。
 *
 * 场景：人不在手机旁，手机也联不上服务端——这时候唯一还通的就是短信。
 * 所以指令必须在手机本地执行完，不经过服务端。
 *
 * 口令明文躺在短信里是这条链路的物理限制（人在外面算不了签名），
 * 因此能力刻意做窄：只查状态、重连、定位，**不含发短信**。
 */
async function paintSmsCommand() {
  const box = $('#smscmd')
  if (!box) return
  let cfg
  try { cfg = await api('/sms-command') } catch { return }

  const paint = () => {
    box.innerHTML = `
      <h2>短信指令</h2>
      <div class="card">
        <p class="muted">给这台设备的号码发一条短信就能查状态——手机断网、掉线、被挪走的时候，
        这是唯一还通的一条路。指令在手机本地执行，不经过服务端。</p>
        <label>启用</label>
        <select id="sc_on">
          <option value="1"${cfg.enabled ? ' selected' : ''}>启用</option>
          <option value="0"${cfg.enabled ? '' : ' selected'}>停用</option>
        </select>

        <div id="sc_body"${cfg.enabled ? '' : ' hidden'}>
          <label>口令</label>
          <div class="row">
            <code class="mono grow" id="sc_secret">${esc(cfg.secret || '（保存后生成）')}</code>
            <button class="ghost sm" id="sc_regen">重置口令</button>
          </div>

          <label>怎么用</label>
          <div class="card tight" style="background:var(--bg)">
            <div>给<b>这台设备的手机号</b>发一条短信，内容是<b>口令 + 指令</b>：</div>
            <div class="mono" style="font-size:15px;padding:8px 0">
              ${esc(cfg.secret || 'xxxxxxxxx')} 状态
            </div>
            <div class="muted">
              口令区分大小写。中间的空格<b>可有可无</b>，半角空格、全角空格、冒号、逗号都认——
              <code class="mono">${esc(cfg.secret || 'xxxxxxxxx')}状态</code> 也一样能用。
            </div>
            ${cfg.secret ? `<div class="btnrow"><button class="ghost sm" id="sc_copy">复制「${esc(cfg.secret)} 状态」</button></div>` : ''}
          </div>

          <label>能用哪些指令</label>
          <div class="card tight" style="background:var(--bg)">
            ${SMS_COMMANDS.map(([cmd, use, alias]) => `
              <div class="row" style="align-items:flex-start;padding:5px 0">
                <code class="mono" style="min-width:3em"><b>${cmd}</b></code>
                <div class="col grow" style="text-align:right">
                  <span>${use}</span>
                  <span class="muted" style="font-size:12px">也可以写 ${alias}</span>
                </div>
              </div>`).join('')}
          </div>
          <div class="muted">只发口令、不写指令，会回一条指令清单。
          故意<b>不支持发短信</b>：口令是明文传输的，万一被人拿到，最多只能问出手机还活着，偷不走验证码。</div>

          <label>允许下指令的号码（每行一个，留空表示不限制）</label>
          <textarea id="sc_allow" rows="3" class="mono" placeholder="13800138000">${esc((cfg.allow_numbers || []).join('\n'))}</textarea>
          <div class="muted">按号码后缀匹配，带不带国际区号都认。主叫号码可以伪造，
          所以这只是第二道防线，真正拦人的是口令 + 限速。</div>

          <label>短信回复结果</label>
          <select id="sc_reply">
            <option value="1"${cfg.reply ? ' selected' : ''}>回复（每条指令回一条短信，按条计费）</option>
            <option value="0"${cfg.reply ? '' : ' selected'}>不回复（结果只推到渠道）</option>
          </select>
          <div class="muted">关掉的话，结果要走网络推送——而网络可能正是坏掉的那一环。</div>
        </div>

        <div class="btnrow"><button id="sc_save" class="sm">保存</button></div>
        <div class="muted">保存后设备会立即重连以应用新配置。每次指令执行都会作为一条消息推送给你。</div>
        <div id="sc_err" class="err-text"></div>
      </div>`

    $('#sc_on').onchange = (e) => { $('#sc_body').hidden = e.target.value !== '1' }

    const copy = $('#sc_copy')
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(`${cfg.secret} 状态`); toast('已复制，粘到短信里发给这台设备') }
      catch { toast('复制失败，请手动选择') }
    }

    const save = async (regenerate) => {
      try {
        cfg = await api('/sms-command', {
          method: 'POST',
          body: {
            enabled: $('#sc_on').value === '1',
            reply: $('#sc_reply')?.value !== '0',
            allow_numbers: ($('#sc_allow')?.value ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
            regenerate,
          },
        })
        toast(regenerate ? '口令已重置' : '已保存')
        paint()
      } catch (e) { $('#sc_err').textContent = e.message }
    }
    $('#sc_save').onclick = () => save(false)
    const regen = $('#sc_regen')
    if (regen) regen.onclick = () => {
      if (!confirm('重置口令？旧口令立刻失效，记得更新你自己那边记的那份。')) return
      save(true)
    }
  }
  paint()
}

/** 电量告警：阈值为 0 表示关闭该项。 */
async function paintBattery() {
  const box = $('#battery')
  if (!box) return
  let c
  try { c = await api('/battery-alerts') } catch { return }

  box.innerHTML = `
    <h2>电量告警</h2>
    <div class="card">
      <p class="muted">关机后不会有任何告警——告警本身也要靠设备上报。阈值填 0 表示关闭该项。</p>
      <label>低于多少电量时告警（%）</label>
      <input id="bt_low" type="number" min="0" max="100" value="${c.low}">
      <label>充电到多少时提醒拔电（%）</label>
      <input id="bt_full" type="number" min="0" max="100" value="${c.full}">
      <div class="muted">长期保持满电会加速电池老化。常年插电的话填 90 左右比较合适。</div>
      <label style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <input type="checkbox" id="bt_chg" style="width:auto"${c.notify_charging_change ? ' checked' : ''}>
        <span>充电状态变化时通知</span>
      </label>
      <div class="muted">插拔电源是日常操作，开了会比较吵，默认关闭。</div>
      <div class="btnrow"><button id="bt_save" class="sm">保存</button></div>
      <div id="bt_err" class="err-text"></div>
    </div>`

  $('#bt_save').onclick = async () => {
    try {
      await api('/battery-alerts', {
        method: 'POST',
        body: {
          low: Number($('#bt_low').value),
          full: Number($('#bt_full').value),
          notify_charging_change: $('#bt_chg').checked,
        },
      })
      toast('已保存')
      paintBattery()
    } catch (e) { $('#bt_err').textContent = e.message }
  }
}

// ── 计划任务 ────────────────────────────────────────────────

async function tasks() {
  render('<div class="loading">加载中…</div>')
  try {
    const [{ tasks: ts, timezone }, { devices: devs }] = await Promise.all([
      api('/tasks'), api('/devices'),
    ])
    const activeDevs = devs.filter((d) => d.status !== 'revoked')
    const fmtTs = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')
    const devName = (id) => (id ? (activeDevs.find((d) => d.id === id)?.name || id) : '任意在线设备')
    // 列表里也要标出用哪张卡：两条「保号」任务只差一张卡，不标就分不清
    const simName = (t) => {
      const sims = simsOf(activeDevs.find((d) => d.id === t.device_id))
      const one = sims.find((x) => x.slot === t.sim_slot)
      return one ? ` · ${simText(one)}` : ''
    }

    render(`
      <h1>计划任务</h1>
      <p class="muted">定时发送短信。最常见的用法是<b>保号</b>——国内号码长期零消费加异地漫游可能被停机，
      而停机不会有任何提示。每张卡各建一个任务：保号针对的是具体号码，用别的卡发等于没保。</p>
      ${ts.length ? `<div class="card list">${ts.map((t) => `
        <div class="item" data-id="${esc(t.id)}">
          <div class="row">
            <div class="col grow">
              <b>${esc(t.name)}</b>
              <span class="muted">${esc(t.schedule_text)} · ${esc(devName(t.device_id))}${esc(simName(t))} → ${esc(t.to || '未设置')}</span>
              <span class="muted">下次 ${t.enabled ? fmtTs(t.next_run_at) : '未启用'}</span>
            </div>
            <div class="col" style="align-items:flex-end;gap:4px">
              <span class="badge ${t.enabled ? 'ok' : ''}">${t.enabled ? '启用' : '停用'}</span>
              ${t.fail_count > 0 ? `<span class="badge err">失败 ${t.fail_count} 次</span>` : ''}
            </div>
          </div>
        </div>`).join('')}</div>` : '<div class="card muted">还没有任务。</div>'}
      <div class="btnrow"><button id="add">新建任务</button></div>
      <div class="muted" style="margin-top:8px">时区：${esc(timezone)}（在设置页修改）</div>`)

    $('#add').onclick = () => taskEditor(null, activeDevs)
    for (const el of app.querySelectorAll('.item')) {
      el.onclick = () => taskEditor(ts.find((t) => t.id === el.dataset.id), activeDevs)
    }
  } catch (e) { fail(e) }
}

function taskEditor(task, devs) {
  const t = task || {
    id: null, name: '保号', enabled: false,
    device_id: devs.length === 1 ? devs[0].id : '',
    sim_slot: null,
    to: '', text: '保号',
    schedule: { type: 'interval', days: 30 },
    last_run_at: null, next_run_at: null, fail_count: 0, last_status: null,
  }
  const sc = t.schedule || { type: 'interval', days: 30 }
  const toLocalInput = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const fmtTs = (x) => (x ? new Date(x).toLocaleString('zh-CN', { hour12: false }) : '—')
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  render(`
    <h1>${task ? '编辑任务' : '新建任务'}</h1>
    <div class="card">
      <label>名称</label><input id="t_name" value="${esc(t.name)}">
      <label>启用</label>
      <select id="t_on">
        <option value="1"${t.enabled ? ' selected' : ''}>启用</option>
        <option value="0"${t.enabled ? '' : ' selected'}>停用</option>
      </select>
      <label>用哪台设备发</label>
      <select id="t_dev">
        <option value=""${!t.device_id ? ' selected' : ''}>任意在线设备${devs.length > 1 ? '（多设备下不建议）' : ''}</option>
        ${devs.map((d) => `<option value="${esc(d.id)}"${t.device_id === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>
      <!-- 保号是按卡的事：双卡机上两张卡各建一个任务，各自绑一张卡 -->
      <div id="t_simbox"></div>
      <label>收件人</label><input id="t_to" inputmode="tel" value="${esc(t.to || '')}">
      <label>内容</label><input id="t_text" value="${esc(t.text || '')}">
    </div>

    <h2>执行时间</h2>
    <div class="card">
      <label>重复方式</label>
      <select id="t_type">
        <option value="interval"${sc.type === 'interval' ? ' selected' : ''}>每隔 N 天</option>
        <option value="daily"${sc.type === 'daily' ? ' selected' : ''}>每天</option>
        <option value="weekly"${sc.type === 'weekly' ? ' selected' : ''}>每周</option>
        <option value="monthly"${sc.type === 'monthly' ? ' selected' : ''}>每月</option>
        <option value="yearly"${sc.type === 'yearly' ? ' selected' : ''}>每年</option>
        <option value="once"${sc.type === 'once' ? ' selected' : ''}>仅一次</option>
      </select>
      <div id="t_sched"></div>
    </div>

    ${task ? `<div class="card tight">
      <div class="row"><span class="muted">上次执行</span><span>${fmtTs(t.last_run_at)}${t.last_status ? ` · ${t.last_status === 'ok' ? '成功' : '失败'}` : ''}</span></div>
      <div class="row"><span class="muted">下次执行</span><span>${t.enabled ? fmtTs(t.next_run_at) : '未启用'}</span></div>
    </div>` : ''}

    <div class="btnrow">
      <button id="t_save">保存</button>
      ${task ? '<button class="ghost sm" id="t_test">立即测试发送</button>' : ''}
      ${task ? '<button class="danger sm" id="t_del">删除</button>' : ''}
      <button class="ghost sm" id="t_back">返回</button>
    </div>
    <div id="t_err" class="err-text"></div>
    <div id="t_result" class="muted" style="margin-top:6px"></div>`)

  /**
   * 只在排期类型没变时才沿用原值。
   *
   * `interval.days` 是数字、`monthly.days` 是数组——两个类型共用同一个字段名。
   * 不判类型直接读的话，从「每隔 N 天」切到「每月」会对数字调 .join() 抛异常，
   * 表单停在原来那个上不动，看起来就像「每月没有日期设置」。
   */
  const from = (type, key, fallback) => (sc.type === type && sc[key] != null ? sc[key] : fallback)

  // 卡槽跟着设备走。选「任意在线设备」时不给卡槽选项——
  // 换一台设备时同一个卡槽序号是另一张卡，指定它没有意义
  const paintSims = () => {
    const dev = devs.find((d) => d.id === $('#t_dev').value)
    $('#t_simbox').innerHTML = simSelect('t_sim', simsOf(dev), t.sim_slot)
  }
  paintSims()
  $('#t_dev').onchange = paintSims

  const paintSched = () => {
    const type = $('#t_type').value
    const time = sc.time || '09:00'
    const box = $('#t_sched')
    const timeRow = `<label>几点</label><input id="s_time" type="time" value="${time}">`

    if (type === 'interval') {
      box.innerHTML = `<label>每隔多少天</label>
        <input id="s_days" type="number" min="1" max="3650" value="${from('interval', 'days', 30)}">
        <div class="muted">从上次执行时间往后推。新建的任务会立即执行第一次。</div>`
    } else if (type === 'once') {
      box.innerHTML = `<label>执行时刻</label><input id="s_at" type="datetime-local" value="${toLocalInput(sc.at)}">
        <div class="muted">执行一次后任务自动停用。</div>`
    } else if (type === 'daily') {
      box.innerHTML = `<label>每天几点</label><input id="s_time" type="time" value="${time}">`
    } else if (type === 'weekly') {
      const on = from('weekly', 'weekdays', [1])
      box.innerHTML = `<label>星期几（可多选）</label>
        <div class="chips">${WD.map((n, i) => `
          <label class="tag" style="cursor:pointer">
            <input type="checkbox" data-wd="${i}" style="width:auto;margin-right:4px"${on.includes(i) ? ' checked' : ''}>
            <span>${n}</span>
          </label>`).join('')}</div>
        ${timeRow}`
    } else if (type === 'monthly') {
      const on = from('monthly', 'days', [1])
      box.innerHTML = `<label>每月几号（可多选）</label>
        <div class="chips">${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `
          <label class="tag" style="cursor:pointer;min-width:38px;justify-content:center">
            <input type="checkbox" data-dom="${d}" style="width:auto;margin-right:3px"${on.includes(d) ? ' checked' : ''}>
            <span>${d}</span>
          </label>`).join('')}</div>
        <div class="muted">超出当月天数的会落到当月最后一天——31 号在 2 月执行于 28 / 29 号。</div>
        ${timeRow}`
    } else {
      box.innerHTML = `<div style="display:flex;gap:8px">
          <div class="grow"><label>几月</label>
            <select id="s_month">${Array.from({ length: 12 }, (_, i) => i + 1).map((m) =>
              `<option value="${m}"${from('yearly', 'month', 1) === m ? ' selected' : ''}>${m} 月</option>`).join('')}</select>
          </div>
          <div class="grow"><label>几号</label>
            <select id="s_day">${Array.from({ length: 31 }, (_, i) => i + 1).map((d) =>
              `<option value="${d}"${from('yearly', 'day', 1) === d ? ' selected' : ''}>${d} 号</option>`).join('')}</select>
          </div>
        </div>
        ${timeRow}`
    }
  }
  $('#t_type').onchange = paintSched
  paintSched()

  const collectSchedule = () => {
    const type = $('#t_type').value
    if (type === 'interval') return { type, days: Number($('#s_days').value) }
    if (type === 'once') return { type, at: $('#s_at').value ? new Date($('#s_at').value).getTime() : 0 }
    const time = $('#s_time').value
    if (type === 'daily') return { type, time }
    if (type === 'weekly') {
      return { type, time, weekdays: [...app.querySelectorAll('[data-wd]')].filter((c) => c.checked).map((c) => Number(c.dataset.wd)) }
    }
    if (type === 'monthly') {
      return { type, time, days: [...app.querySelectorAll('[data-dom]')].filter((c) => c.checked).map((c) => Number(c.dataset.dom)) }
    }
    return { type, time, month: Number($('#s_month').value), day: Number($('#s_day').value) }
  }

  $('#t_back').onclick = () => go('/tasks')

  $('#t_save').onclick = async () => {
    try {
      await api('/tasks', {
        method: 'POST',
        body: {
          ...(t.id ? { id: t.id } : {}),
          name: $('#t_name').value.trim(),
          enabled: $('#t_on').value === '1',
          device_id: $('#t_dev').value,
          sim_slot: $('#t_sim') && $('#t_sim').value !== '' ? Number($('#t_sim').value) : null,
          to: $('#t_to').value.trim(),
          text: $('#t_text').value,
          schedule: collectSchedule(),
        },
      })
      toast('已保存')
      go('/tasks')
    } catch (e) { $('#t_err').textContent = e.message }
  }

  if (task) {
    // 配好之后必须能当场验证链路：定时任务失败是静默的
    $('#t_test').onclick = async () => {
      $('#t_result').textContent = '发送中…（未保存的修改不会生效，请先保存）'
      $('#t_test').disabled = true
      try {
        const r = await api(`/tasks/${t.id}/test`, { method: 'POST' })
        $('#t_result').innerHTML = r.sent
          ? '<span class="badge ok">已下发，到发送记录里看状态机流转</span>'
          : `<span class="badge err">${esc(r.reason || '失败')}</span>`
      } catch (e) { $('#t_result').innerHTML = `<span class="badge err">${esc(e.message)}</span>` }
      $('#t_test').disabled = false
    }
    $('#t_del').onclick = async () => {
      if (!confirm(`删除任务「${t.name}」？`)) return
      await api(`/tasks/${t.id}`, { method: 'DELETE' })
      toast('已删除')
      go('/tasks')
    }
  }
}

// ── 启动 ────────────────────────────────────────────────────

// 明文 HTTP 警告（计划 §12.1②）
if (location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  const b = document.createElement('div')
  b.className = 'banner'
  b.textContent = '当前连接未加密，短信内容与验证码正在明文传输'
  document.body.prepend(b)
}

route()
