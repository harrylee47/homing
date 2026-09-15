/**
 * Telegram Bot 操作面（计划 §11.4）。
 *
 * 定位是「与 Web UI 功能基本对等的第二操作面」，适用于手机上快速处理。
 * Bot 只经 REST API 访问数据，绝不直连数据库——否则两端逻辑必然漂移。
 *
 * 命令处理放在 core：Workers 版把 long polling 换成 webhook 时，这部分不变。
 *
 * ⚠️ 所有输出都必须遵守模糊化规则：短信正文包在 <tg-spoiler> 里，
 * 验证码不得单独明文显示（见 providers/telegram.ts 的说明）。
 */

/** /status 与 /devices 用到的设备摘要。 */
export interface BotStatsDevice {
  id: string
  name: string
  status: string
  last_seen_at: number | null
  battery: number | null
  charging?: boolean | null
  net?: {
    wifi?: boolean | null
    type?: string | null
    ssid?: string | null
    carrier?: string | null
    signal?: number | null
    online?: boolean | null
  } | null
}

/** Bot 可用的接口，就是计划 §11.1 能力矩阵的代码化。 */
export interface BotApi {
  stats(): Promise<{
    devices: BotStatsDevice[]
    today: { events: number; outbound: number; outbound_failed: number }
    rules: number
    channels: number
  }>
  outbound(params: { limit?: number; to?: string; status?: string }): Promise<{
    outbound: {
      id: string; to: string; text: string; status: string; error: string | null
      created_at: number; device_name?: string
    }[]
    total: number
  }>
  events(params: { limit?: number; q?: string; from?: string; device?: string; kind?: string; direction?: string }): Promise<{
    events: {
      id: string; from: string; content: string; kind: string
      occurred_at: number; device_name?: string
    }[]
    total: number
    /** false 表示只搜了最近一段，更早的没看。undefined 表示这次查询没走全文扫描 */
    exhausted?: boolean
  }>
  rules(): Promise<{ rules: { name: string; priority: number; enabled: boolean }[] }>
  tasks(): Promise<{
    tasks: { name: string; enabled: boolean; schedule_text: string; to: string; next_run_at: number | null; fail_count: number }[]
  }>
  sendSms(deviceId: string, to: string, text: string): Promise<{ id: string; status: string; error?: string }>
  /** 查回复映射：把用户引用的那条推送还原成「发给谁」 */
  lookupRef(ref: string): Promise<{ sender: string; device_id: string; event_id: string } | null>
  /** 该号码是否在历史记录里出现过 */
  isKnownNumber(n: string): Promise<boolean>
}

export interface BotMessage {
  text: string
  /** 需要用户二次确认时附带的按钮 */
  buttons?: { text: string; data: string }[][]
}

/**
 * 待确认的发送。
 *
 * callback_data 上限 64 字节，塞不下「设备 id + 号码 + 正文」，所以把内容
 * 暂存在这里，按钮只带一个短 token。
 *
 * 这是允许的进程内状态：确认窗口只有几分钟，重启后丢失的后果仅仅是用户
 * 需要重新发一次命令，不涉及任何数据丢失。
 */
const pendingSends = new Map<string, { to: string; text: string; expiresAt: number }>()
const PENDING_TTL_MS = 5 * 60 * 1000

function stashSend(to: string, text: string, now = Date.now()): string {
  // 顺手清理过期项，不需要额外的定时器
  for (const [k, v] of pendingSends) if (v.expiresAt < now) pendingSends.delete(k)
  const token = Math.random().toString(36).slice(2, 10)
  pendingSends.set(token, { to, text, expiresAt: now + PENDING_TTL_MS })
  return token
}

/** 仅供测试。 */
export function resetPendingSends(): void {
  pendingSends.clear()
}

const esc = (s: string): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 正文一律进 spoiler。这是整个 Bot 输出的统一出口，不要绕过它。 */
const spoiler = (s: string): string => `<tg-spoiler>${esc(s)}</tg-spoiler>`

const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

const ago = (ts: number | null): string => {
  if (!ts) return '从未'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 注册给 Telegram 的命令菜单，用户点输入框旁的菜单按钮就能看到。 */
export const COMMANDS: { command: string; description: string }[] = [
  { command: 'status', description: '设备状态、电量、今日统计' },
  { command: 'recent', description: '最近的消息，可加条数如 /recent 20' },
  { command: 'search', description: '全文检索，如 /search 验证码' },
  { command: 'from', description: '按号码查询，如 /from 95533' },
  { command: 'calls', description: '最近的来电' },
  { command: 'sent', description: '网关发出的短信记录' },
  { command: 'send', description: '发送短信：/send 号码 内容' },
  { command: 'devices', description: '设备列表' },
  { command: 'tasks', description: '计划任务' },
  { command: 'rules', description: '规则列表（只读）' },
  { command: 'help', description: '全部命令说明' },
]

export const HELP = [
  '<b>可用命令</b>',
  '/status — 设备在线状态、电量、充电状态、今日统计',
  '/recent [n] — 最近 n 条消息（默认 10，上限 30）',
  '/search &lt;关键词&gt; — 全文检索',
  '/from &lt;号码&gt; [n] — 按来源号码查询，支持部分匹配',
  '/calls [n] — 最近的来电',
  '/sent [n] — 网关发出的短信及其送达状态',
  '/send &lt;号码&gt; &lt;内容&gt; — 发送短信',
  '/devices — 设备列表',
  '/tasks — 计划任务与下次执行时间',
  '/rules — 规则列表（只读，修改请用控制台）',
  '/help — 这条',
  '',
  '直接<b>引用回复</b>任意一条短信推送，即可把内容作为短信回给对方。',
  '更复杂的筛选（时间范围、按设备、分页）请用控制台。',
].join('\n')

/** 处理一条文本命令。返回 null 表示不响应（例如无法识别的普通消息）。 */
export async function handleCommand(api: BotApi, text: string): Promise<BotMessage | null> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const [rawCmd, ...rest] = trimmed.split(/\s+/)
  // 群组里命令会带 @botname 后缀
  const cmd = (rawCmd ?? '').split('@')[0]!.toLowerCase()
  const arg = rest.join(' ')

  switch (cmd) {
    case '/start':
    case '/help':
      return { text: HELP }

    case '/status':
      return status(api)

    case '/devices':
      return devices(api)

    case '/recent': {
      const n = Math.min(Math.max(Number(arg) || 10, 1), 30)
      return list(api, { limit: n }, `最近 ${n} 条`)
    }

    case '/calls': {
      const n = Math.min(Math.max(Number(arg) || 10, 1), 30)
      return list(api, { limit: n, kind: 'call' }, `最近 ${n} 条来电`)
    }

    case '/sent': {
      const n = Math.min(Math.max(Number(arg) || 10, 1), 30)
      return sentList(api, n)
    }

    case '/search':
      if (!arg) return { text: '用法：/search 关键词' }
      return list(api, { limit: 15, q: arg }, `「${esc(arg)}」`)

    case '/from': {
      const m = arg.match(/^(\S+)(?:\s+(\d+))?$/)
      if (!m) return { text: '用法：/from 号码 [条数]' }
      const n = Math.min(Math.max(Number(m[2]) || 10, 1), 30)
      return list(api, { limit: n, from: m[1]! }, `来自 ${esc(m[1]!)}`)
    }

    case '/tasks':
      return tasksList(api)

    case '/rules':
      return rules(api)

    case '/send': {
      const m = arg.match(/^(\S+)\s+([\s\S]+)$/)
      if (!m) return { text: '用法：/send 号码 内容' }
      return send(api, m[1]!, m[2]!)
    }

    default:
      return { text: '未知命令，/help 查看可用命令' }
  }
}

/**
 * 设备的一行网络与电量描述。
 *
 * **信号格数与上网路径无关，必须单独显示**：手机连着 WiFi、SIM 卡却没信号时，
 * 短信照样收不到——而只看「已连 WiFi」会以为一切正常。这正是最该被看见的故障。
 */
function deviceDetail(d: BotStatsDevice): string[] {
  const out: string[] = []

  if (d.battery != null) {
    const icon = d.charging === true ? '🔌' : d.battery <= 20 ? '🪫' : '🔋'
    out.push(`${icon} ${d.battery}%${d.charging === true ? ' 充电中' : ' 未充电'}`)
  }

  const n = d.net
  if (n) {
    // 信号先说：它决定短信收不收得到
    if (n.signal != null) {
      out.push(`📶 信号 ${'▮'.repeat(n.signal)}${'▯'.repeat(4 - n.signal)}${n.signal <= 1 ? ' ⚠️ 很弱' : ''}`)
    }
    if (n.type === 'wifi') out.push(`🛜 ${n.ssid ? esc(n.ssid) : 'WiFi'}`)
    else if (n.type === 'cellular') out.push('📱 移动数据')
    else if (n.type === 'none') out.push('❌ 无网络')
    if (n.type && n.type !== 'none' && n.online === false) out.push('⚠️ 连着但没网')
    if (n.wifi === false && n.type !== 'wifi') out.push('WiFi 已关')
    if (n.carrier) out.push(esc(n.carrier))
  }
  return out
}

async function status(api: BotApi): Promise<BotMessage> {
  const s = await api.stats()
  const lines = ['<b>状态</b>', '']
  if (s.devices.length === 0) lines.push('还没有设备')
  for (const d of s.devices) {
    const dot = d.status === 'online' ? '🟢' : d.status === 'revoked' ? '🔴' : '⚪️'
    lines.push(`${dot} <b>${esc(d.name)}</b> · 心跳 ${ago(d.last_seen_at)}`)
    const detail = deviceDetail(d)
    // 掉线设备照样报，但要标明是掉线前的——那是排查时最想知道的一句
    if (detail.length > 0) {
      lines.push(`　${d.status === 'online' ? '' : '掉线前 '}${detail.join(' · ')}`)
    }
  }
  lines.push('', `今日事件 ${s.today.events} ｜ 发送 ${s.today.outbound} ｜ 失败 ${s.today.outbound_failed}`)
  lines.push(`${s.rules} 条规则 · ${s.channels} 个渠道`)
  return { text: lines.join('\n') }
}

async function devices(api: BotApi): Promise<BotMessage> {
  const s = await api.stats()
  if (s.devices.length === 0) return { text: '还没有设备' }
  return {
    text: ['<b>设备</b>', '', ...s.devices.map((d) => {
      const detail = deviceDetail(d)
      return `${d.status === 'online' ? '🟢' : d.status === 'revoked' ? '🔴' : '⚪️'} <b>${esc(d.name)}</b>\n` +
        `<code>${esc(d.id)}</code>\n心跳 ${ago(d.last_seen_at)}` +
        (detail.length ? `\n${d.status === 'online' ? '' : '掉线前 '}${detail.join(' · ')}` : '')
    })].join('\n\n'),
  }
}

/** 所有列表类查询的统一出口，保证 spoiler 与设备标注的处理只有一处。 */
async function list(
  api: BotApi,
  params: { limit: number; q?: string; from?: string; kind?: string },
  title: string,
): Promise<BotMessage> {
  const [r, s] = await Promise.all([api.events(params), api.stats()])
  if (r.events.length === 0) {
    return {
      text: r.exhausted === false
        ? `最近一段里没找到（${title}）。更早的还没搜——用控制台可以继续往前翻。`
        : `没有匹配的消息（${title}）`,
    }
  }
  const multi = s.devices.filter((d) => d.status !== 'revoked').length > 1
  const more = r.total > r.events.length
    ? `\n\n共 ${r.total} 条，这里只显示前 ${r.events.length} 条。完整筛选与分页请用控制台。`
    : ''
  // 正文是密文，只能逐条解开比对，一次请求有时间预算。搜不完必须说，
  // 否则「没搜到」会被当成「没有这条消息」
  const partial = r.exhausted === false
    ? '\n\n⚠️ 只搜了最近一段，更早的还没搜。要翻更久以前的请用控制台。'
    : ''
  return {
    text: [`<b>${title} · ${r.events.length} 条</b>`, '', ...r.events.map((e) => renderEvent(e, multi))].join('\n\n') + more + partial,
  }
}

/**
 * 网关自己发出去的短信。正文同样进 spoiler —— 发出去的内容里一样可能有
 * 验证码（转发场景）。
 */
async function sentList(api: BotApi, limit: number): Promise<BotMessage> {
  const [r, s] = await Promise.all([api.outbound({ limit }), api.stats()])
  if (r.outbound.length === 0) return { text: '还没有发送记录' }
  const multi = s.devices.filter((d) => d.status !== 'revoked').length > 1
  const label: Record<string, string> = {
    pending: '待下发', accepted: '已接收', sent: '已发出', delivered: '✅ 已送达', failed: '❌ 失败',
  }
  const more = r.total > r.outbound.length
    ? `\n\n共 ${r.total} 条，这里只显示最近 ${r.outbound.length} 条。`
    : ''
  return {
    text: [`<b>发送记录 · ${r.outbound.length} 条</b>`, '', ...r.outbound.map((o) => {
      const head = multi && o.device_name
        ? `→ ${esc(o.to)} · ${esc(o.device_name)} · ${fmtTime(o.created_at)}`
        : `→ ${esc(o.to)} · ${fmtTime(o.created_at)}`
      return `${head}\n💬 ${spoiler(o.text)}\n${label[o.status] ?? esc(o.status)}` +
        (o.error ? ` · ${esc(o.error)}` : '')
    })].join('\n\n') + more,
  }
}

async function tasksList(api: BotApi): Promise<BotMessage> {
  const { tasks } = await api.tasks()
  if (tasks.length === 0) return { text: '还没有计划任务' }
  const fmtNext = (t: number | null) =>
    t ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  return {
    text: ['<b>计划任务</b>（只读，修改请用控制台）', '', ...tasks.map((t) =>
      `${t.enabled ? '✅' : '⬜️'} ${esc(t.name)}\n${esc(t.schedule_text)} → ${esc(t.to || '未设置')}\n下次 ${fmtNext(t.next_run_at)}` +
      (t.fail_count > 0 ? `  ⚠️ 连续失败 ${t.fail_count} 次` : ''),
    )].join('\n\n'),
  }
}

/**
 * 列表里的正文同样进 spoiler —— /recent 和 /search 是最容易漏掉的两处。
 * 设备名只在多设备时显示，单设备下每行都缀一遍是噪音。
 */
const renderEvent = (
  e: { from: string; content: string; occurred_at: number; device_name?: string },
  showDevice: boolean,
): string => {
  const head = showDevice && e.device_name
    ? `${esc(e.from)} · ${esc(e.device_name)} · ${fmtTime(e.occurred_at)}`
    : `${esc(e.from)} · ${fmtTime(e.occurred_at)}`
  return `${head}\n💬 ${spoiler(e.content)}`
}

async function rules(api: BotApi): Promise<BotMessage> {
  const { rules: rs } = await api.rules()
  if (rs.length === 0) return { text: '还没有规则，当前全部走兜底' }
  return {
    text: ['<b>规则</b>（只读，修改请用控制台）', '',
      ...rs.map((r) => `${r.enabled ? '✅' : '⬜️'} ${esc(r.name)} · 优先级 ${r.priority}`)].join('\n'),
  }
}

/**
 * 发送短信。
 *
 * 两道确认逻辑叠在一起：
 *  - 新号码需要二次确认（计划 §11.4 安全约束②）：Telegram 账号被盗时，
 *    攻击者最直接的变现方式就是用你的卡往外发短信
 *  - 多设备时必须让用户选哪张卡发，不能替他挑一台——收件人看到的号码
 *    取决于用哪张卡，挑错等于用错身份
 *
 * 只有「单设备 + 已知号码」才直接发出。
 */
async function send(api: BotApi, to: string, text: string): Promise<BotMessage> {
  const s = await api.stats()
  const online = s.devices.filter((d) => d.status === 'online')
  if (online.length === 0) return { text: '没有在线设备，无法发送' }

  const known = await api.isKnownNumber(to)

  if (online.length === 1 && known) {
    const r = await api.sendSms(online[0]!.id, to, text)
    return { text: r.status === 'failed' ? `发送失败：${esc(r.error ?? '未知原因')}` : `已提交发送 → ${esc(to)}` }
  }

  const token = stashSend(to, text)
  const head = known
    ? `发给 <b>${esc(to)}</b>，用哪台设备？`
    : `⚠️ <b>${esc(to)}</b> 不在历史记录中，确认要发送吗？`

  return {
    text: `${head}\n\n💬 ${spoiler(text)}`,
    buttons: [
      ...online.map((d) => [{
        text: online.length > 1 ? `用 ${d.name} 发送` : '确认发送',
        data: `send:${token}:${d.id}`,
      }]),
      [{ text: '取消', data: 'cancel' }],
    ],
  }
}

/** 处理引用回复：把回复内容作为短信发回原发件人。 */
export async function handleReply(api: BotApi, replyToRef: string, text: string): Promise<BotMessage | null> {
  const ref = await api.lookupRef(replyToRef)
  // 引用的不是我们推送的短信（比如回复了 /status 的输出），忽略
  if (!ref) return null

  // 用原事件所属的那台设备回复：多卡场景下必须从收到短信的那张卡发回去，
  // 否则对方看到的是一个陌生号码
  const r = await api.sendSms(ref.device_id, ref.sender, text)
  return {
    text: r.status === 'failed'
      ? `发送失败：${esc(r.error ?? '未知原因')}`
      : `已回复 ${esc(ref.sender)}`,
  }
}

/** 处理按钮回调。 */
export async function handleCallback(api: BotApi, data: string, now = Date.now()): Promise<BotMessage | null> {
  if (data === 'cancel') return { text: '已取消' }

  const m = data.match(/^send:([^:]+):(.+)$/)
  if (!m) return null

  const pending = pendingSends.get(m[1]!)
  if (!pending || pending.expiresAt < now) {
    return { text: '这条待发消息已过期，请重新发送命令' }
  }
  pendingSends.delete(m[1]!)

  const deviceId = m[2]!
  const s = await api.stats()
  const device = s.devices.find((d) => d.id === deviceId)
  if (!device || device.status !== 'online') {
    return { text: `${device ? esc(device.name) : '该设备'}当前不在线，未发送` }
  }

  const r = await api.sendSms(deviceId, pending.to, pending.text)
  return {
    text: r.status === 'failed'
      ? `发送失败：${esc(r.error ?? '未知原因')}`
      : `已提交发送 → ${esc(pending.to)}（${esc(device.name)}）`,
  }
}
