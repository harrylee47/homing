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

/** Bot 可用的接口，就是计划 §11.1 能力矩阵的代码化。 */
export interface BotApi {
  stats(): Promise<{
    devices: { id: string; name: string; status: string; last_seen_at: number | null; battery: number | null }[]
    today: { events: number; outbound: number; outbound_failed: number }
    rules: number
    channels: number
  }>
  events(params: { limit?: number; q?: string }): Promise<{
    events: { id: string; from: string; content: string; kind: string; occurred_at: number }[]
  }>
  rules(): Promise<{ rules: { name: string; priority: number; enabled: boolean }[] }>
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

export const HELP = [
  '<b>可用命令</b>',
  '/status — 设备在线状态、电量、今日统计',
  '/recent [n] — 最近 n 条消息（默认 10）',
  '/search &lt;关键词&gt; — 全文检索',
  '/send &lt;号码&gt; &lt;内容&gt; — 发送短信',
  '/devices — 设备列表',
  '/rules — 规则列表（只读）',
  '/help — 这条',
  '',
  '直接<b>引用回复</b>任意一条短信推送，即可把内容作为短信回给对方。',
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
      return recent(api, n)
    }

    case '/search':
      if (!arg) return { text: '用法：/search 关键词' }
      return search(api, arg)

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

async function status(api: BotApi): Promise<BotMessage> {
  const s = await api.stats()
  const lines = ['<b>状态</b>', '']
  if (s.devices.length === 0) lines.push('还没有设备')
  for (const d of s.devices) {
    const dot = d.status === 'online' ? '🟢' : d.status === 'revoked' ? '🔴' : '⚪️'
    lines.push(`${dot} ${esc(d.name)} · 心跳 ${ago(d.last_seen_at)}${d.battery != null ? ` · 电量 ${d.battery}%` : ''}`)
  }
  lines.push('', `今日事件 ${s.today.events} ｜ 发送 ${s.today.outbound} ｜ 失败 ${s.today.outbound_failed}`)
  lines.push(`${s.rules} 条规则 · ${s.channels} 个渠道`)
  return { text: lines.join('\n') }
}

async function devices(api: BotApi): Promise<BotMessage> {
  const s = await api.stats()
  if (s.devices.length === 0) return { text: '还没有设备' }
  return {
    text: ['<b>设备</b>', '', ...s.devices.map((d) =>
      `${d.status === 'online' ? '🟢' : '⚪️'} ${esc(d.name)}\n<code>${esc(d.id)}</code>\n心跳 ${ago(d.last_seen_at)}${d.battery != null ? ` · ${d.battery}%` : ''}`,
    )].join('\n\n'),
  }
}

async function recent(api: BotApi, n: number): Promise<BotMessage> {
  const { events } = await api.events({ limit: n })
  if (events.length === 0) return { text: '还没有消息' }
  return { text: [`<b>最近 ${events.length} 条</b>`, '', ...events.map(renderEvent)].join('\n\n') }
}

async function search(api: BotApi, q: string): Promise<BotMessage> {
  const { events } = await api.events({ limit: 15, q })
  if (events.length === 0) return { text: `没有匹配「${esc(q)}」的消息` }
  return { text: [`<b>「${esc(q)}」共 ${events.length} 条</b>`, '', ...events.map(renderEvent)].join('\n\n') }
}

/** 列表里的正文同样进 spoiler —— /recent 和 /search 是最容易漏掉的两处。 */
const renderEvent = (e: { from: string; content: string; occurred_at: number }): string =>
  `${esc(e.from)} · ${fmtTime(e.occurred_at)}\n💬 ${spoiler(e.content)}`

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
 * 新号码需要二次确认（计划 §11.4 安全约束②）：Telegram 账号被盗时，
 * 攻击者最直接的变现方式就是用你的卡往外发短信。
 */
async function send(api: BotApi, to: string, text: string): Promise<BotMessage> {
  const s = await api.stats()
  const online = s.devices.find((d) => d.status === 'online')
  if (!online) return { text: '没有在线设备，无法发送' }

  if (!(await api.isKnownNumber(to))) {
    return {
      text: `⚠️ <b>${esc(to)}</b> 不在历史记录中，确认要发送吗？\n\n💬 ${spoiler(text)}`,
      buttons: [[
        { text: '确认发送', data: `send:${to}:${encode(text)}` },
        { text: '取消', data: 'cancel' },
      ]],
    }
  }

  const r = await api.sendSms(online.id, to, text)
  return { text: r.status === 'failed' ? `发送失败：${esc(r.error ?? '未知原因')}` : `已提交发送 → ${esc(to)}` }
}

/** 处理引用回复：把回复内容作为短信发回原发件人。 */
export async function handleReply(api: BotApi, replyToRef: string, text: string): Promise<BotMessage | null> {
  const ref = await api.lookupRef(replyToRef)
  // 引用的不是我们推送的短信（比如回复了 /status 的输出），忽略
  if (!ref) return null

  const r = await api.sendSms(ref.device_id, ref.sender, text)
  return {
    text: r.status === 'failed'
      ? `发送失败：${esc(r.error ?? '未知原因')}`
      : `已回复 ${esc(ref.sender)}`,
  }
}

/** 处理按钮回调。 */
export async function handleCallback(api: BotApi, data: string): Promise<BotMessage | null> {
  if (data === 'cancel') return { text: '已取消' }

  const m = data.match(/^send:([^:]+):(.*)$/)
  if (!m) return null

  const to = m[1]!
  const text = decode(m[2]!)
  const s = await api.stats()
  const online = s.devices.find((d) => d.status === 'online')
  if (!online) return { text: '没有在线设备，无法发送' }

  const r = await api.sendSms(online.id, to, text)
  return { text: r.status === 'failed' ? `发送失败：${esc(r.error ?? '未知原因')}` : `已提交发送 → ${esc(to)}` }
}

/**
 * callback_data 上限 64 字节，且短信正文可能含冒号。
 * 用 base64url 编码避开分隔符冲突；超长则截断——确认按钮只用于短消息，
 * 长内容应该用控制台发。
 */
function encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 40)
}

function decode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = new Uint8Array([...bin].map((c) => c.charCodeAt(0)))
  return new TextDecoder().decode(bytes)
}
