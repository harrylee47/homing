// 控制台。零构建、零依赖——体量不大，别上重框架（计划 §7.1）。
const $ = (s, r = document) => r.querySelector(s)
const app = $('#app')
const nav = $('#nav')

// ── 状态 ────────────────────────────────────────────────────

const TOKEN_KEY = 'gw_token'
let token = localStorage.getItem(TOKEN_KEY) || ''

const setToken = (t) => {
  token = t || ''
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
    // 未认证一律返回 404（不确认接口存在），所以这里等同于「会话失效」
    setToken('')
    go('/login')
    throw new Error('会话已失效，请重新登录')
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

// ── 工具 ────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

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
function battery(d) {
  if (d.battery == null) return ''
  const icon = d.charging === true ? '🔌' : d.battery <= 20 ? '🪫' : '🔋'
  return ` · ${icon} ${d.battery}%`
}

function toast(msg) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2600)
}

const go = (path) => {
  history.pushState({}, '', path)
  route()
}

// 事件委托：视图重绘后不需要重新绑定
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]')
  if (a && !a.target) {
    e.preventDefault()
    go(a.getAttribute('href'))
  }
})
window.addEventListener('popstate', () => route())

// ── 路由 ────────────────────────────────────────────────────

const routes = [
  [/^\/$/, overview],
  [/^\/events\/(.+)$/, eventDetail],
  [/^\/events$/, events],
  [/^\/compose$/, compose],
  [/^\/rules$/, rules],
  [/^\/tasks$/, tasks],
  [/^\/channels$/, channels],
  [/^\/devices$/, devices],
  [/^\/settings$/, settings],
  [/^\/login$/, login],
  [/^\/setup$/, setup],
]

async function route() {
  const path = location.pathname
  nav.hidden = true

  try {
    // 未初始化时一切导向向导——不存在「启动即裸奔」的窗口
    const st = await api('/setup/status', { allow404: true })
    if (!st?.initialized) return setup()
  } catch { /* 网络异常时继续尝试渲染，由各视图报错 */ }

  if (!token && path !== '/login') return login()

  for (const [re, view] of routes) {
    const m = path.match(re)
    if (m) {
      nav.hidden = path === '/login' || path === '/setup'
      for (const a of nav.querySelectorAll('a')) {
        a.classList.toggle('active', a.dataset.nav === (path.startsWith('/events') ? '/events' : path))
      }
      return view(m[1])
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
    <h1>初始配置</h1>
    <div class="steps"><div class="on"></div><div id="s2"></div></div>
    <div class="card">
      <p class="muted">这台服务器将存放你的全部短信内容，包括银行验证码。先设置管理员口令。</p>
      <label>管理员口令（至少 8 位，含英文 / 数字 / 符号中的两类）</label>
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
      const r = await api('/setup/password', { method: 'POST', body: { password: pw }, allow404: true })
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
      <p class="muted">用 Google Authenticator、1Password、iOS 自带密码 App 等扫码。两步验证是强制的，不可关闭。</p>
      ${r.qr ? `<div class="qr">${r.qr}</div>` : ''}
      <details>
        <summary class="muted">扫不了？手动添加</summary>
        <label>密钥</label>
        <div class="mono wrap card tight" style="user-select:all">${esc(r.secret)}</div>
        <div class="muted">类型选「基于时间」，算法 SHA1，位数 6，周期 30 秒。</div>
      </details>
      <label>输入认证器显示的 6 位验证码</label>
      <input id="code" inputmode="numeric" maxlength="6" class="mono" style="font-size:20px;letter-spacing:4px">
      <div class="btnrow"><button id="done">完成</button></div>
      <div id="err" class="err-text"></div>
    </div>`)

  $('#done').onclick = async () => {
    $('#done').disabled = true
    try {
      await api('/setup/verify', { method: 'POST', body: { code: $('#code').value }, allow404: true })
      toast('初始化完成')
      go('/login')
    } catch (e) {
      $('#err').textContent = e.message
      $('#done').disabled = false
    }
  }
}

// ── 登录 ────────────────────────────────────────────────────

function login() {
  nav.hidden = true
  render(`
    <h1>登录</h1>
    <div class="card">
      <label>口令</label>
      <input id="pw" type="password" autocomplete="current-password">
      <label>两步验证码</label>
      <input id="code" inputmode="numeric" maxlength="6" class="mono" style="letter-spacing:4px">
      <div class="btnrow"><button id="go">登录</button></div>
      <div id="err" class="err-text"></div>
    </div>`)

  const submit = async () => {
    $('#go').disabled = true
    try {
      const r = await api('/auth/login', {
        method: 'POST', allow404: true,
        body: { password: $('#pw').value, code: $('#code').value },
      })
      setToken(r.token)
      go('/')
    } catch (e) {
      $('#err').textContent = e.message
      $('#go').disabled = false
    }
  }
  $('#go').onclick = submit
  $('#code').onkeydown = (e) => { if (e.key === 'Enter') submit() }
}

// ── 总览 ────────────────────────────────────────────────────

async function overview() {
  render('<div class="loading">加载中…</div>')
  try {
    const s = await api('/stats')
    // 最显眼的位置是设备状态，不是短信列表（计划 §10.4）
    const deviceCards = s.devices.length ? s.devices.map((d) => `
      <div class="card">
        <div class="row">
          <div class="col grow">
            <div><span class="dot ${d.status}"></span><b>${esc(d.name)}</b></div>
            <div class="muted">最后心跳 ${ago(d.last_seen_at)}${battery(d)}${d.app_version ? ` · v${esc(d.app_version)}` : ''}</div>
          </div>
          <span class="badge ${d.status === 'online' ? 'ok' : d.status === 'revoked' ? 'err' : ''}">${
            d.status === 'online' ? '在线' : d.status === 'revoked' ? '已吊销' : '离线'}</span>
        </div>
      </div>`).join('') : '<div class="card muted">还没有设备。到「设备」页生成配对码。</div>'

    render(`
      <h1>总览</h1>
      ${deviceCards}
      <div class="card">
        <div class="stat">
          <div><b>${s.today.events}</b><span class="muted">今日事件</span></div>
          <div><b>${s.today.outbound}</b><span class="muted">今日发送</span></div>
          <div><b class="${s.today.outbound_failed ? 'err' : ''}">${s.today.outbound_failed}</b><span class="muted">发送失败</span></div>
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
      </div>`)
  } catch (e) { fail(e) }
}

// ── 消息 ────────────────────────────────────────────────────

/**
 * 消息列表。
 *
 * 筛选条件放在 URL 查询串里：刷新、前进后退、把链接发给自己都能还原当前视图，
 * 而不是刷新一下筛选就没了。
 */
async function events() {
  const p = new URLSearchParams(location.search)
  const get = (k, d = '') => p.get(k) ?? d
  const limit = Number(get('limit', '30'))
  const offset = Number(get('offset', '0'))

  const devs = await api('/devices').catch(() => ({ devices: [] }))
  const activeDevs = devs.devices.filter((d) => d.status !== 'revoked')

  const toDateInput = (ts) => {
    if (!ts) return ''
    const d = new Date(Number(ts))
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  render(`
    <h1>消息</h1>
    <div class="card">
      <input id="f_q" placeholder="搜索发件人或正文" value="${esc(get('q'))}">
      <details id="adv" ${['from', 'device', 'kind', 'since', 'until'].some((k) => get(k)) ? 'open' : ''}>
        <summary class="muted">更多筛选</summary>
        <label>来源号码</label>
        <input id="f_from" inputmode="tel" value="${esc(get('from'))}" placeholder="支持部分匹配，如 955">
        ${activeDevs.length > 1 ? `
          <label>设备</label>
          <select id="f_device">
            <option value="">全部设备</option>
            ${activeDevs.map((d) => `<option value="${esc(d.id)}"${get('device') === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
          </select>` : ''}
        <label>类型</label>
        <select id="f_kind">
          <option value="">全部</option>
          <option value="sms"${get('kind') === 'sms' ? ' selected' : ''}>短信</option>
          <option value="call"${get('kind') === 'call' ? ' selected' : ''}>来电</option>
        </select>
        <div style="display:flex;gap:8px">
          <div class="grow"><label>起始日期</label><input id="f_since" type="date" value="${toDateInput(get('since'))}"></div>
          <div class="grow"><label>结束日期</label><input id="f_until" type="date" value="${toDateInput(get('until'))}"></div>
        </div>
        <div class="btnrow">
          <button id="f_apply" class="sm">应用筛选</button>
          <button id="f_clear" class="ghost sm">清空</button>
        </div>
      </details>
    </div>
    <div id="list"><div class="loading">加载中…</div></div>`)

  const buildQuery = (over = {}) => {
    const q = new URLSearchParams()
    const vals = {
      q: $('#f_q').value.trim(),
      from: $('#f_from')?.value.trim() ?? '',
      device: $('#f_device')?.value ?? '',
      kind: $('#f_kind')?.value ?? '',
      // 结束日期按当天 23:59:59 算，否则选了同一天会查不到任何东西
      since: $('#f_since')?.value ? new Date(`${$('#f_since').value}T00:00:00`).getTime() : '',
      until: $('#f_until')?.value ? new Date(`${$('#f_until').value}T23:59:59`).getTime() : '',
      limit, offset: 0,
      ...over,
    }
    for (const [k, v] of Object.entries(vals)) if (v !== '' && v != null) q.set(k, String(v))
    return q
  }

  const apply = (over) => go(`/events?${buildQuery(over).toString()}`)
  $('#f_apply').onclick = () => apply({})
  $('#f_clear').onclick = () => go('/events')
  $('#f_q').onkeydown = (e) => { if (e.key === 'Enter') apply({}) }

  try {
    const query = new URLSearchParams(location.search)
    query.set('limit', String(limit))
    query.set('offset', String(offset))
    const r = await api(`/events?${query.toString()}`)

    const from = r.total === 0 ? 0 : offset + 1
    const to = Math.min(offset + limit, r.total)
    const multi = activeDevs.length > 1

    $('#list').innerHTML = `
      <div class="card tight row">
        <span class="muted">${r.total === 0 ? '没有匹配的消息' : `第 ${from}–${to} 条，共 ${r.total} 条`}${r.truncated ? '（结果已截断）' : ''}</span>
        <select id="f_limit" style="width:auto">
          ${[30, 50, 100].map((n) => `<option value="${n}"${limit === n ? ' selected' : ''}>每页 ${n}</option>`).join('')}
        </select>
      </div>
      ${r.events.length ? `<div class="card list">${r.events.map((e) => `
        <div class="item" data-id="${esc(e.id)}">
          <div class="row">
            <b class="truncate">${esc(e.from)}</b>
            <span class="muted">${multi ? `${esc(e.device_name)} · ` : ''}${fmt(e.occurred_at)}</span>
          </div>
          <div class="muted truncate">${esc(e.content)}</div>
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
  } catch (e) { fail(e) }
}

async function eventDetail(id) {
  render('<div class="loading">加载中…</div>')
  try {
    const r = await api(`/events?limit=200`)
    const e = r.events.find((x) => x.id === id)
    if (!e) return render('<div class="card muted">消息不存在或已删除。</div>')

    render(`
      <h1>${esc(e.from)}</h1>
      <div class="card">
        <div class="wrap">${esc(e.content)}</div>
      </div>
      <div class="card tight">
        <div class="row"><span class="muted">发生时间</span><span>${new Date(e.occurred_at).toLocaleString('zh-CN', { hour12: false })}</span></div>
        <div class="row"><span class="muted">上报延迟</span><span>${e.received_at - e.occurred_at} ms</span></div>
        <div class="row"><span class="muted">类型</span><span>${esc(e.kind)}</span></div>
        <div class="row"><span class="muted">接收设备</span><span>${esc(e.device_name || e.device_id)}</span></div>
        <div class="row"><span class="muted">命中规则</span><span>${e.matched_rules.length ? esc(e.matched_rules.join(', ')) : '兜底规则'}</span></div>
      </div>
      <div class="btnrow">
        <a href="/compose?to=${encodeURIComponent(e.from)}&ref=${encodeURIComponent(e.id)}&dev=${encodeURIComponent(e.device_id)}"><button class="sm">回复</button></a>
        <button class="ghost sm" id="copy">复制正文</button>
      </div>`)

    $('#copy').onclick = async () => {
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
      <h1>发送短信</h1>
      <div class="card">
        <label>设备</label>
        <select id="dev">${online.length
          ? online.map((d) => `<option value="${esc(d.id)}"${d.id === preferred ? ' selected' : ''}>${esc(d.name)}</option>`).join('')
          : '<option value="">没有在线设备</option>'}</select>
        ${preferred && !online.some((d) => d.id === preferred)
          ? '<div class="muted" style="color:var(--warn)">收到这条消息的设备当前不在线，换用其他设备发送时对方看到的会是另一个号码。</div>'
          : ''}
        <label>收件人</label>
        <input id="to" inputmode="tel" value="${esc(p.get('to') || '')}">
        <label>内容</label>
        <textarea id="text"></textarea>
        <div class="btnrow"><button id="send" ${online.length ? '' : 'disabled'}>发送</button></div>
        <div id="err" class="err-text"></div>
      </div>
      <div id="status"></div>`)

    $('#send').onclick = async () => {
      const to = $('#to').value.trim(), text = $('#text').value
      if (!to || !text) return ($('#err').textContent = '收件人与内容都要填')
      $('#send').disabled = true
      $('#err').textContent = ''
      try {
        const r = await api('/outbound', {
          method: 'POST',
          body: { device_id: $('#dev').value, to, text },
        })
        trackOutbound(r.id)
      } catch (e) {
        $('#err').textContent = e.message
        $('#send').disabled = false
      }
    }
  } catch (e) { fail(e) }
}

/** 状态机进度：accepted → sent → delivered，每一步都可见（计划 §5.5）。 */
function trackOutbound(id) {
  const steps = [['accepted', '已接收'], ['sent', '已发出'], ['delivered', '已送达']]
  const paint = (status, error) => {
    const idx = steps.findIndex(([s]) => s === status)
    $('#status').innerHTML = `
      <div class="card">
        <div class="row">${steps.map(([s, label], i) => `
          <span class="badge ${status === 'failed' ? (i === 0 ? 'err' : '') : i <= idx ? 'ok' : ''}">${label}</span>
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
        <p class="muted">可以一键写入四条建议规则，按顺序匹配：<br>
        <b>验证码</b> 高优先级、自动提取、穿透专注模式<br>
        <b>广告推广</b> 只归档不推送<br>
        <b>普通短信</b> 前两者都不是，正常推送<br>
        <b>来电</b> 单独分组，点击可预填回复<br>
        之后随时可改。</p>
        <div class="btnrow"><button id="seed" class="sm">写入建议规则</button></div>
      </div>` : ''}
      ${rs.length ? `<div class="card list">${rs.map((r) => `
        <div class="item" data-id="${esc(r.id)}">
          <div class="row">
            <div class="col grow">
              <b>${esc(r.name)}</b>
              <span class="muted">优先级 ${r.priority} · ${r.action.channels.length} 个渠道${r.action.extract_code ? ' · 提取验证码' : ''}</span>
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

function ruleEditor(rule, chs, devs = []) {
  const r = rule || {
    id: null, name: '', priority: 100, enabled: true,
    match: { kind: [], sender_regex: null, content_contains: [], content_regex: null, device_ids: [] },
    action: { channels: [], priority: 'normal', extract_code: true, template: '【{sender}】{content}', archive: true, stop_processing: false },
  }

  render(`
    <h1>${rule ? '编辑规则' : '新建规则'}</h1>
    <div class="card">
      <label>名称</label><input id="name" value="${esc(r.name)}">
      <label>优先级（数字小者先匹配）</label><input id="prio" type="number" value="${r.priority}">
      <label>启用</label>
      <select id="enabled"><option value="1"${r.enabled ? ' selected' : ''}>是</option><option value="0"${r.enabled ? '' : ' selected'}>否</option></select>
    </div>
    <h2>匹配条件（留空表示不限制）</h2>
    <div class="card">
      <label>事件类型</label>
      <select id="kind">
        <option value=""${!r.match.kind.length ? ' selected' : ''}>全部</option>
        <option value="sms"${r.match.kind[0] === 'sms' ? ' selected' : ''}>短信</option>
        <option value="call"${r.match.kind[0] === 'call' ? ' selected' : ''}>来电</option>
      </select>
      <label>发件人正则</label><input id="sender" class="mono" value="${esc(r.match.sender_regex || '')}" placeholder="^(95533|95588)$">
      <label>正文包含（逗号分隔，任一命中即可）</label><input id="contains" value="${esc((r.match.content_contains || []).join(','))}" placeholder="验证码,动态密码">

      <label>限定设备</label>
      ${devs.length > 1 ? `
        <div class="muted">不勾选表示不限制。勾选后这条规则只对选中的设备生效——
        不同卡走不同渠道就靠这里，给每张卡各建一条规则即可。</div>
        ${devs.map((d) => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0">
          <input type="checkbox" data-dev="${esc(d.id)}" style="width:auto"${(r.match.device_ids || []).includes(d.id) ? ' checked' : ''}>
          <span>${esc(d.name)} <span class="muted">${d.status === 'online' ? '在线' : '离线'}</span></span></label>`).join('')}
      ` : `<div class="muted">当前只有 ${devs.length} 台设备，无需限定。多设备时这里可以让不同的卡走不同的渠道。</div>`}
    </div>
    <h2>动作</h2>
    <div class="card">
      <label>推送渠道</label>
      ${chs.length ? chs.map((c) => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0">
        <input type="checkbox" data-ch="${esc(c.id)}" style="width:auto"${r.action.channels.includes(c.id) ? ' checked' : ''}>
        <span>${esc(c.name)} <span class="muted">(${esc(c.type)})</span></span></label>`).join('')
        : '<div class="muted">还没有渠道，去「设置 → 渠道」添加。</div>'}
      <label>模板</label><input id="tpl" class="mono" value="${esc(r.action.template)}">
      <div class="muted">可用占位符：{sender} {content} {code} {time} {device}</div>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="extract" style="width:auto"${r.action.extract_code ? ' checked' : ''}><span>提取验证码</span></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="stop" style="width:auto"${r.action.stop_processing ? ' checked' : ''}><span>命中后不再匹配后续规则</span></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="high" style="width:auto"${r.action.priority === 'high' ? ' checked' : ''}><span>高优先级（推送时出声）</span></label>
    </div>
    <div class="btnrow">
      <button id="save">保存</button>
      <button class="ghost sm" id="test">用历史消息试跑</button>
      ${rule ? '<button class="danger sm" id="del">删除</button>' : ''}
      <button class="ghost sm" id="back">返回</button>
    </div>
    <div id="err" class="err-text"></div>
    <div id="testout"></div>`)

  const collect = () => ({
    id: r.id || undefined,
    name: $('#name').value.trim() || '未命名规则',
    priority: Number($('#prio').value) || 100,
    enabled: $('#enabled').value === '1',
    match: {
      kind: $('#kind').value ? [$('#kind').value] : [],
      sender_regex: $('#sender').value.trim() || null,
      content_contains: $('#contains').value.split(',').map((x) => x.trim()).filter(Boolean),
      content_regex: null,
      device_ids: [...app.querySelectorAll('[data-dev]')].filter((c) => c.checked).map((c) => c.dataset.dev),
    },
    action: {
      channels: [...app.querySelectorAll('[data-ch]')].filter((c) => c.checked).map((c) => c.dataset.ch),
      priority: $('#high').checked ? 'high' : 'normal',
      extract_code: $('#extract').checked,
      template: $('#tpl').value,
      archive: true,
      stop_processing: $('#stop').checked,
    },
  })

  $('#back').onclick = () => go('/rules')
  $('#save').onclick = async () => {
    try {
      await api('/rules', { method: 'POST', body: collect() })
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

// ── 渠道 ────────────────────────────────────────────────────

async function channels() {
  render('<div class="loading">加载中…</div>')
  try {
    const [{ channels: cs }, bark] = await Promise.all([
      api('/channels'),
      api('/bark/info').catch(() => null),
    ])
    render(`
      <h1>渠道</h1>
      ${cs.length ? `<div class="card list">${cs.map((c) => `
        <div class="item">
          <div class="row">
            <div class="col grow">
              <b>${esc(c.name)}</b>
              <span class="muted">${esc(c.type)}${c.enabled ? '' : ' · 已停用'}</span>
            </div>
            <div style="display:flex;gap:6px">
              <button class="ghost sm" data-edit="${esc(c.id)}">编辑</button>
              <button class="ghost sm" data-test="${esc(c.id)}">测试</button>
            </div>
          </div>
          <div class="muted" data-result="${esc(c.id)}"></div>
        </div>`).join('')}</div>` : '<div class="card muted">还没有渠道。没有渠道则收到短信不会推送到任何地方。</div>'}
      <h2>新增渠道</h2>
      <div class="card">
        <label>类型</label>
        <select id="type">
          <option value="bark">Bark（推荐用于验证码）</option>
          <option value="telegram">Telegram</option>
          <option value="webhook">Webhook</option>
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
        <label>开放档位</label>
        <select id="barkaccess">
          <option value="push"${bark.access === 'push' ? ' selected' : ''}>允许推送，禁止注册（推荐）</option>
          <option value="full"${bark.access === 'full' ? ' selected' : ''}>完全开放（注册 + 推送）</option>
          <option value="off"${bark.access === 'off' ? ' selected' : ''}>完全关闭</option>
        </select>
        <div class="muted" id="barkdesc" style="margin-top:8px"></div>
      </div>` : ''}`)

    const sel = $('#barkaccess')
    if (sel) {
      const DESC = {
        push: '其它服务可以拿已知的设备 Key 推送。陌生人无法注册新设备，也就无法把这台服务器当免费中转用——Key 是随机串，不知道就推不了。',
        full: '注册也开放。只在用 Bark App 绑定新设备时才需要，绑完建议调回「允许推送」。',
        off: '外部完全不可用。网关自己的推送走内部地址，不受影响；arm 上的其它服务仍可用 127.0.0.1:2334。',
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
                 <b>第一步：在 Bark App 里注册</b>
                 <div class="muted" style="margin:6px 0 4px">先把下方「开放档位」调成「完全开放」，然后 iOS 装 Bark → 右上角「服务器」→ 填：</div>
                 <div class="mono wrap" style="font-size:13px;padding:6px 0"><b>${esc(bark?.public_url || `${location.origin}/bark`)}</b></div>
                 <button class="ghost sm" id="copyurl" type="button">复制地址</button>
                 <div class="muted" style="margin-top:8px">App 首页会显示一串设备 Key，填到下面，然后把档位调回「允许推送」。</div>
               </div>
               <label>推送地址（网关内部使用，不走公网）</label>
               <input id="f_server" class="mono" value="${esc(bark?.upstream || '')}" placeholder="http://bark:8080">
               <label>设备 Key</label><input id="f_key" class="mono" placeholder="Bark App 首页显示的那串">
               <div class="muted">验证码会放进通知标题，长按即可复制，无需打开任何 App。</div>`,
        collect: () => ({ server: $('#f_server').value.trim(), key: $('#f_key').value.trim() }),
      },
      telegram: {
        name: '主 Telegram',
        html: `<label>Bot Token</label><input id="f_bt" class="mono" type="password" autocomplete="off">
               <label>Chat ID</label>
               <input id="f_cid" class="mono" autocomplete="off">
               <button class="ghost sm" id="discover" type="button" style="margin-top:8px">自动获取 Chat ID</button>
               <div class="muted" id="discovered" style="margin-top:6px">
                 Chat ID 是「你」的标识，和用哪个 Bot 无关。换 Bot 后先给它发一条 /start，再点上面的按钮。
               </div>
               <div class="muted" style="margin-top:8px">正文会以模糊形式发送，点击才可见——明文转发验证码会导致 Bot 被封禁。</div>`,
        collect: () => ({ bot_token: $('#f_bt').value.trim(), chat_id: $('#f_cid').value.trim() }),
      },
      webhook: {
        name: 'Webhook',
        html: `<label>目标地址</label><input id="f_url" class="mono" placeholder="https://example.com/hook">
               <div class="muted">正文会发往这个地址，必须是 https。</div>`,
        collect: () => ({ url: $('#f_url').value.trim() }),
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
          out.innerHTML = r.ok
            ? '<span class="badge ok">测试消息已发出</span>'
            : `<span class="badge err">失败：${esc(r.error)}</span>`
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
    ],
    webhook: [{ key: 'url', label: '目标地址', secret: false }],
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
      <p class="muted">留空表示不修改。密钥不会回显，这是有意的。</p>
      ${fields.map((f) => `
        <label>${esc(f.label)}</label>
        <input id="c_${esc(f.key)}" class="mono" type="${f.secret ? 'password' : 'text'}"
               placeholder="${esc(f.placeholder || (f.secret ? '留空则不变' : '留空则不变'))}" autocomplete="off">
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
      const v = $(`#c_${f.key}`).value.trim()
      if (v) config[f.key] = v
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
      $('#c_result').innerHTML = r.ok
        ? '<span class="badge ok">测试消息已发出</span>'
        : `<span class="badge err">失败：${esc(r.error)}</span>`
    } catch (e) { $('#c_result').innerHTML = `<span class="badge err">${esc(e.message)}</span>` }
  }

  $('#c_del').onclick = async () => {
    if (!confirm(`删除渠道「${c.name}」？命中它的规则将不再推送到这里。`)) return
    await api(`/channels/${c.id}`, { method: 'DELETE' })
    toast('已删除')
    go('/channels')
  }
}

// ── 设备 ────────────────────────────────────────────────────

async function devices() {
  render('<div class="loading">加载中…</div>')
  try {
    const { devices: ds } = await api('/devices')
    render(`
      <h1>设备</h1>
      ${ds.length ? `<div class="card list">${ds.map((d) => `
        <div class="item">
          <div class="row">
            <div class="col grow">
              <div><span class="dot ${d.status}"></span><b>${esc(d.name)}</b></div>
              <span class="muted mono" style="font-size:11px">${esc(d.id)}</span>
              <span class="muted">心跳 ${ago(d.last_seen_at)}${battery(d)}</span>
            </div>
            ${d.status !== 'revoked' ? `<button class="danger sm" data-revoke="${esc(d.id)}">吊销</button>` : '<span class="badge err">已吊销</span>'}
          </div>
        </div>`).join('')}</div>` : '<div class="card muted">还没有设备。</div>'}
      <h2>添加设备</h2>
      <div class="card">
        <label>设备名称</label><input id="dn" value="JP-Gateway-01">
        <div class="btnrow"><button id="gen">生成配对码</button></div>
        <div id="code"></div>
      </div>`)

    $('#gen').onclick = async () => {
      try {
        const r = await api('/devices/pairing-code', { method: 'POST', body: { name: $('#dn').value.trim() || '未命名设备' } })
        $('#code').innerHTML = `
          <div class="code mono">${esc(r.code)}</div>
          <div class="muted" style="text-align:center">在 Agent 里输入这个配对码，${Math.floor(r.ttl_sec / 60)} 分钟内有效，只能用一次。</div>`
      } catch (e) { $('#code').innerHTML = `<div class="err-text">${esc(e.message)}</div>` }
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

async function settings() {
  render(`
    <h1>设置</h1>
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

    <div id="battery"></div>

    <h2>时区</h2>
    <div class="card">
      <p class="muted">计划任务按这个时区的墙上时间执行。服务端跑在 UTC，不设对的话「每天 9 点」会差几个小时。</p>
      <input id="tz" class="mono" placeholder="Asia/Tokyo">
      <div class="btnrow"><button id="tz_save" class="sm">保存</button></div>
      <div id="tz_err" class="err-text"></div>
    </div>

    <h2>修改口令</h2>
    <div class="card">
      <label>当前口令</label><input id="old" type="password" autocomplete="current-password">
      <label>新口令（至少 8 位，含英文 / 数字 / 符号中的两类）</label><input id="new" type="password" autocomplete="new-password">
      <label>再输一次新口令</label><input id="new2" type="password" autocomplete="new-password">
      <div class="muted">修改后所有已登录的会话都会失效，包括当前这个。没有找回流程，请先存好。</div>
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

  $('#revokeall').onclick = async () => {
    if (!confirm('断开所有会话？你也会被登出。')) return
    try { await api('/auth/revoke-all', { method: 'POST' }) } catch { /* 已经失效也算成功 */ }
    setToken('')
    toast('已全端下线')
    go('/login')
  }

  void paintBattery()
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
  try {
    const r = await api('/timezone')
    el.value = r.timezone
  } catch { return }
  $('#tz_save').onclick = async () => {
    try {
      await api('/timezone', { method: 'POST', body: { timezone: el.value.trim() } })
      toast('已保存')
    } catch (e) { $('#tz_err').textContent = e.message }
  }
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
      <p class="muted">电量耗尽关机后验证码完全收不到，而且不会有任何告警——因为告警也要靠设备上报。阈值填 0 表示关闭该项。</p>
      <label>低于多少电量时告警（%）</label>
      <input id="bt_low" type="number" min="0" max="100" value="${c.low}">
      <label>充电到多少时提醒拔电（%）</label>
      <input id="bt_full" type="number" min="0" max="100" value="${c.full}">
      <div class="muted">长期保持满电会加速电池老化。这台机器常年插电，填 90 左右比较合适；不需要就填 0。</div>
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

    render(`
      <h1>计划任务</h1>
      <p class="muted">定时发送短信。最常见的用法是<b>保号</b>——国内号码长期零消费加异地漫游可能被停机，
      而停机不会有任何提示。每张卡各建一个任务：保号针对的是具体号码，用别的卡发等于没保。</p>
      ${ts.length ? `<div class="card list">${ts.map((t) => `
        <div class="item" data-id="${esc(t.id)}">
          <div class="row">
            <div class="col grow">
              <b>${esc(t.name)}</b>
              <span class="muted">${esc(t.schedule_text)} · ${esc(devName(t.device_id))} → ${esc(t.to || '未设置')}</span>
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

  const paintSched = () => {
    const type = $('#t_type').value
    const time = sc.time || '09:00'
    const box = $('#t_sched')
    if (type === 'interval') {
      box.innerHTML = `<label>每隔多少天</label><input id="s_days" type="number" min="1" max="3650" value="${sc.days || 30}">
        <div class="muted">从上次执行时间往后推。新建的任务会立即执行第一次。</div>`
    } else if (type === 'once') {
      box.innerHTML = `<label>执行时刻</label><input id="s_at" type="datetime-local" value="${toLocalInput(sc.at)}">
        <div class="muted">执行一次后任务自动停用。</div>`
    } else if (type === 'daily') {
      box.innerHTML = `<label>每天几点</label><input id="s_time" type="time" value="${time}">`
    } else if (type === 'weekly') {
      box.innerHTML = `<label>星期几（可多选）</label>
        ${WD.map((n, i) => `<label style="display:flex;gap:8px;align-items:center;margin:4px 0">
          <input type="checkbox" data-wd="${i}" style="width:auto"${(sc.weekdays || []).includes(i) ? ' checked' : ''}><span>${n}</span></label>`).join('')}
        <label>几点</label><input id="s_time" type="time" value="${time}">`
    } else if (type === 'monthly') {
      box.innerHTML = `<label>每月几号（逗号分隔，可多个）</label>
        <input id="s_days_of_month" value="${(sc.days || [1]).join(',')}">
        <div class="muted">超出当月天数的日期会落到当月最后一天，例如 31 号在 2 月执行于 28/29 号。</div>
        <label>几点</label><input id="s_time" type="time" value="${time}">`
    } else {
      box.innerHTML = `<label>几月</label><input id="s_month" type="number" min="1" max="12" value="${sc.month || 1}">
        <label>几号</label><input id="s_day" type="number" min="1" max="31" value="${sc.day || 1}">
        <label>几点</label><input id="s_time" type="time" value="${time}">`
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
      return { type, time, days: $('#s_days_of_month').value.split(',').map((x) => Number(x.trim())).filter((x) => x >= 1 && x <= 31) }
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
