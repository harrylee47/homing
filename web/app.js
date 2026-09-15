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
      <label>管理员口令（至少 12 位）</label>
      <input id="pw" type="password" autocomplete="new-password">
      <label>再输一次</label>
      <input id="pw2" type="password" autocomplete="new-password">
      <div class="btnrow"><button id="next">下一步</button></div>
      <div id="err" class="err-text"></div>
    </div>`)

  $('#next').onclick = async () => {
    const pw = $('#pw').value, pw2 = $('#pw2').value
    if (pw !== pw2) return ($('#err').textContent = '两次输入不一致')
    if (pw.length < 12) return ($('#err').textContent = '口令至少 12 位')
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
      <p class="muted">用 Google Authenticator、1Password 等扫码或手动添加。两步验证是强制的，不可关闭。</p>
      <label>密钥（手动添加时使用）</label>
      <div class="mono wrap card tight">${esc(r.secret)}</div>
      <label>或复制这条 URI 到认证器</label>
      <div class="mono wrap card tight" style="font-size:11px">${esc(r.uri)}</div>
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
            <div class="muted">最后心跳 ${ago(d.last_seen_at)}${d.battery != null ? ` · 电量 ${d.battery}%` : ''}${d.app_version ? ` · v${esc(d.app_version)}` : ''}</div>
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

async function events() {
  const q = new URLSearchParams(location.search).get('q') || ''
  render(`
    <h1>消息</h1>
    <div class="card tight">
      <input id="q" placeholder="搜索发件人或正文" value="${esc(q)}">
    </div>
    <div id="list"><div class="loading">加载中…</div></div>`)

  const load = async (query) => {
    try {
      const r = await api(`/events?limit=50${query ? `&q=${encodeURIComponent(query)}` : ''}`)
      $('#list').innerHTML = r.events.length ? `<div class="card list">${r.events.map((e) => `
        <div class="item" data-id="${esc(e.id)}">
          <div class="row">
            <b class="truncate">${esc(e.from)}</b>
            <span class="muted">${fmt(e.occurred_at)}</span>
          </div>
          <div class="muted truncate">${esc(e.content)}</div>
        </div>`).join('')}</div>` : '<div class="card muted">没有匹配的消息。</div>'

      for (const el of $('#list').querySelectorAll('.item')) {
        el.onclick = () => go(`/events/${el.dataset.id}`)
      }
    } catch (e) { fail(e) }
  }

  let timer
  $('#q').oninput = (e) => {
    clearTimeout(timer)
    timer = setTimeout(() => load(e.target.value.trim()), 300)
  }
  load(q)
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
        <div class="row"><span class="muted">命中规则</span><span>${e.matched_rules.length ? esc(e.matched_rules.join(', ')) : '兜底规则'}</span></div>
      </div>
      <div class="btnrow">
        <a href="/compose?to=${encodeURIComponent(e.from)}&ref=${encodeURIComponent(e.id)}"><button class="sm">回复</button></a>
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

    render(`
      <h1>发送短信</h1>
      <div class="card">
        <label>设备</label>
        <select id="dev">${online.length
          ? online.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')
          : '<option value="">没有在线设备</option>'}</select>
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
    const [{ rules: rs }, { channels: chs }] = await Promise.all([api('/rules'), api('/channels')])

    render(`
      <h1>规则</h1>
      <p class="muted">按优先级从小到大匹配。没有规则命中时走兜底：推送到全部启用渠道并归档。</p>
      ${rs.length ? `<div class="card list">${rs.map((r) => `
        <div class="item" data-id="${esc(r.id)}">
          <div class="row">
            <div class="col grow">
              <b>${esc(r.name)}</b>
              <span class="muted">优先级 ${r.priority} · ${r.action.channels.length} 个渠道${r.action.extract_code ? ' · 提取验证码' : ''}</span>
            </div>
            <span class="badge ${r.enabled ? 'ok' : ''}">${r.enabled ? '启用' : '停用'}</span>
          </div>
        </div>`).join('')}</div>` : '<div class="card muted">还没有规则，当前全部走兜底。</div>'}
      <div class="btnrow"><button id="add">新建规则</button></div>`)

    $('#add').onclick = () => ruleEditor(null, chs)
    for (const el of app.querySelectorAll('.item')) {
      el.onclick = () => ruleEditor(rs.find((r) => r.id === el.dataset.id), chs)
    }
  } catch (e) { fail(e) }
}

function ruleEditor(rule, chs) {
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
      device_ids: [],
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
    const { channels: cs } = await api('/channels')
    render(`
      <h1>渠道</h1>
      ${cs.length ? `<div class="card list">${cs.map((c) => `
        <div class="item">
          <div class="row">
            <div class="col grow">
              <b>${esc(c.name)}</b><span class="muted">${esc(c.type)}</span>
            </div>
            <div style="display:flex;gap:6px">
              <button class="ghost sm" data-test="${esc(c.id)}">测试</button>
              <button class="danger sm" data-del="${esc(c.id)}">删除</button>
            </div>
          </div>
          <div class="muted" data-result="${esc(c.id)}"></div>
        </div>`).join('')}</div>` : '<div class="card muted">还没有渠道。没有渠道则收到短信不会推送到任何地方。</div>'}
      <h2>新增 Telegram</h2>
      <div class="card">
        <label>名称</label><input id="name" value="主 Telegram">
        <label>Bot Token</label><input id="bt" class="mono" type="password">
        <label>Chat ID</label><input id="cid" class="mono">
        <div class="muted">正文会以模糊形式发送，点击才可见——明文转发验证码会导致 Bot 被封禁。</div>
        <div class="btnrow"><button id="add">添加</button></div>
        <div id="err" class="err-text"></div>
      </div>`)

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

    for (const b of app.querySelectorAll('[data-del]')) {
      b.onclick = async () => {
        if (!confirm('删除这个渠道？')) return
        await api(`/channels/${b.dataset.del}`, { method: 'DELETE' })
        toast('已删除')
        channels()
      }
    }

    $('#add').onclick = async () => {
      try {
        await api('/channels', {
          method: 'POST',
          body: {
            type: 'telegram', name: $('#name').value.trim() || 'Telegram',
            config: { bot_token: $('#bt').value.trim(), chat_id: $('#cid').value.trim() },
          },
        })
        toast('已添加')
        channels()
      } catch (e) { $('#err').textContent = e.message }
    }
  } catch (e) { fail(e) }
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
              <span class="muted">心跳 ${ago(d.last_seen_at)}${d.battery != null ? ` · ${d.battery}%` : ''}</span>
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
    <h2>修改口令</h2>
    <div class="card">
      <label>当前口令</label><input id="old" type="password" autocomplete="current-password">
      <label>新口令（至少 12 位）</label><input id="new" type="password" autocomplete="new-password">
      <div class="muted">修改后所有已登录的会话都会失效，包括当前这个。</div>
      <div class="btnrow"><button id="chpw">修改</button></div>
      <div id="err" class="err-text"></div>
    </div>
    <h2>会话</h2>
    <div class="card tight row">
      <span class="muted">退出登录</span>
      <button class="ghost sm" id="logout">退出</button>
    </div>`)

  $('#chpw').onclick = async () => {
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

// ── 启动 ────────────────────────────────────────────────────

// 明文 HTTP 警告（计划 §12.1②）
if (location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  const b = document.createElement('div')
  b.className = 'banner'
  b.textContent = '当前连接未加密，短信内容与验证码正在明文传输'
  document.body.prepend(b)
}

route()
