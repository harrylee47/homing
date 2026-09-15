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
    events: {
      id: string; from: string; content: string; kind: string
      occurred_at: number; device_name?: string
    }[]
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
  const [{ events }, s] = await Promise.all([api.events({ limit: n }), api.stats()])
  if (events.length === 0) return { text: '还没有消息' }
  const multi = s.devices.filter((d) => d.status !== 'revoked').length > 1
  return { text: [`<b>最近 ${events.length} 条</b>`, '', ...events.map((e) => renderEvent(e, multi))].join('\n\n') }
}

async function search(api: BotApi, q: string): Promise<BotMessage> {
  const [{ events }, s] = await Promise.all([api.events({ limit: 15, q }), api.stats()])
  if (events.length === 0) return { text: `没有匹配「${esc(q)}」的消息` }
  const multi = s.devices.filter((d) => d.status !== 'revoked').length > 1
  return { text: [`<b>「${esc(q)}」共 ${events.length} 条</b>`, '', ...events.map((e) => renderEvent(e, multi))].join('\n\n') }
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
