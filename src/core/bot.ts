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
import { threadKey } from './thread.js'

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
    sims?: {
      slot: number
      carrier?: string | null
      label?: string | null
      tail?: string | null
      signal?: number | null
      default_sms?: boolean | null
    }[] | null
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
  outbound(params: { limit?: number; offset?: number; to?: string; status?: string }): Promise<{
    outbound: {
      id: string; to: string; text: string; status: string; error: string | null
      created_at: number; device_name?: string
    }[]
    total: number
  }>
  events(params: {
    limit?: number; offset?: number; q?: string; from?: string
    device?: string; kind?: string; direction?: string
    /** 放宽扫描预算，对应控制台的「继续往更早搜」 */
    deep?: boolean
  }): Promise<{
    events: {
      id: string; from: string; content: string; kind: string
      occurred_at: number; device_name?: string; sim?: string | null
    }[]
    total: number
    /** false 表示只搜了最近一段，更早的没看。undefined 表示这次查询没走全文扫描 */
    exhausted?: boolean
  }>
  /** 单条详情。列表是截断的，而发出去的内容经常很长 */
  event(id: string): Promise<{
    id: string; from: string; content: string; kind: string
    occurred_at: number; device_id: string; device_name?: string
    sim_slot?: number | null; sim?: string | null; direction?: string
  } | null>
  /** 一个号码的完整往来。回复要用的设备与卡槽由服务端算好一并给出 */
  thread(key: string): Promise<{
    key: string; number: string
    items: { id: string; direction: 'in' | 'out'; text: string; at: number; status?: string | null }[]
    reply_device: string | null
    reply_sim: number | null
  } | null>
  rules(): Promise<{ rules: { name: string; priority: number; enabled: boolean }[] }>
  tasks(): Promise<{
    tasks: { name: string; enabled: boolean; schedule_text: string; to: string; next_run_at: number | null; fail_count: number }[]
  }>
  sendSms(deviceId: string, to: string, text: string, simSlot?: number | null): Promise<{ id: string; status: string; error?: string }>
  /** 查回复映射：把用户引用的那条推送还原成「发给谁」 */
  lookupRef(ref: string): Promise<{ sender: string; device_id: string; event_id: string; sim_slot?: number | null } | null>
  /** 该号码是否在历史记录里出现过 */
  isKnownNumber(n: string): Promise<boolean>
}

export interface BotMessage {
  text: string
  /** 需要用户二次确认时附带的按钮 */
  buttons?: { text: string; data: string }[][]
  /**
   * 原地改写触发它的那条消息，而不是新发一条。
   *
   * 翻页必须这样做：每翻一页新发一条的话，聊天记录会被同一个列表的
   * 十几个版本塞满，而人要找的是最新那一页。
   */
  edit?: boolean
  /**
   * 让 Telegram 客户端自动带上对这条消息的引用，用户直接打字即可。
   *
   * 服务端没有「等待这个人的下一条输入」这种概念——那会是硬约束④
   * 明令之外的新进程状态。forceReply 把这件事交给客户端：
   * 用户回过来的消息自带 reply_to_message，正好接上已有的 message_refs 链路。
   */
  forceReply?: boolean
  /**
   * 随这条消息一起记一条回复映射（发给谁、用哪台设备哪张卡）。
   *
   * 由适配层在拿到 Telegram 分配的 message_id 之后落库——core 这边
   * 拿不到那个 id。有了它，用户对着 forceReply 的提示直接打字，
   * 走的就是和「引用一条短信推送」完全相同的那条路。
   */
  replyTo?: { eventId: string; sender: string; deviceId: string; simSlot: number | null }
  /**
   * 常驻键盘。只在 /start 时下发一次，之后一直挂在输入框上方。
   *
   * 日常动作是「看一眼状态」「翻最近几条」，不该要求人记命令语法。
   */
  keyboard?: string[][]
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
const pendingSends = new Map<string, {
  to: string; text: string; expiresAt: number
  /**
   * 已经兑现过了。**不能直接删掉**——删了的话第二次点按钮和「超时」
   * 走的是同一个分支，回的那句「请重新发送命令」读起来像「没发出去」，
   * 而最自然的下一步就是重发，于是同一条短信发两遍。
   * 发短信是不可撤销的动作，这两种情况必须说成两句话。
   */
  usedAt?: number
}>()
const PENDING_TTL_MS = 5 * 60 * 1000

function stashSend(to: string, text: string, now = Date.now()): string {
  // 顺手清理过期项，不需要额外的定时器
  for (const [k, v] of pendingSends) if (v.expiresAt < now) pendingSends.delete(k)
  const token = Math.random().toString(36).slice(2, 10)
  pendingSends.set(token, { to, text, expiresAt: now + PENDING_TTL_MS })
  return token
}

/**
 * 翻页用的查询暂存。
 *
 * callback_data 硬上限 64 字节，中文关键词塞不进去（`/search 建设银行验证码`
 * 光正文就 30 多字节），所以按钮只带一个短 token，查询条件存这里。
 *
 * 和 pendingSends 一样属于允许的进程内状态：重启后翻页按钮失效，
 * 后果仅仅是用户要重发一次命令，不涉及任何数据丢失。**但必须说出来**——
 * 一个点了没反应的按钮比没有按钮更糟。
 */
interface StashedQuery {
  kind: 'events' | 'outbound'
  params: Record<string, string | number | boolean>
  title: string
  /** 用户当前翻到哪一页，详情页的「返回」按钮要用它回到原处 */
  offset: number
  expiresAt: number
}
const listQueries = new Map<string, StashedQuery>()
const QUERY_TTL_MS = 30 * 60 * 1000

function stashQuery(q: Omit<StashedQuery, 'expiresAt'>, now = Date.now()): string {
  for (const [k, v] of listQueries) if (v.expiresAt < now) listQueries.delete(k)
  const token = Math.random().toString(36).slice(2, 10)
  listQueries.set(token, { ...q, expiresAt: now + QUERY_TTL_MS })
  return token
}

const EXPIRED_QUERY = '这个列表太久了，按钮已失效。重发一次命令即可。'

/** 仅供测试。 */
export function resetPendingSends(): void {
  pendingSends.clear()
  listQueries.clear()
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
  { command: 'thread', description: '和某个号码的往来：/thread 95533' },
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
  '/thread &lt;号码&gt; — 和这个号码的往来，排成一段对话',
  '/help — 这条',
  '',
  '列表下面的<b>数字按钮</b>可以逐条打开看全文，还能翻页。',
  '直接<b>引用回复</b>任意一条短信推送，即可把内容作为短信回给对方。',
  '也可以直接发一个号码或几个字过来——号码当作 /from，其余当作 /search。',
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
    case '/start': {
      /**
       * 深链：t.me/<bot>?start=evt_xxx 直接打开那一条。
       *
       * Bark 深链是这个项目最主要的入口，而 Telegram 侧一直没有等价物——
       * 推送里那个「在控制台打开」按钮会把人丢进浏览器再被登录页拦住。
       * payload 来自任何人构造的链接，但 chat 白名单在传输层已经先挡了一道，
       * 而查询本身走的是带 user_id 作用域的接口。
       */
      if (arg.startsWith('evt_')) return detail(api, arg)
      if (arg.startsWith('thr_')) return threadView(api, arg.slice(4))
      return { text: HELP, keyboard: KEYBOARD }
    }
    case '/help':
      return { text: HELP, keyboard: KEYBOARD }

    case '/thread': {
      if (!arg) return { text: '用法：/thread 号码' }
      return threadView(api, threadKey(arg))
    }

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
 * 常驻键盘。四个键覆盖日常九成动作，剩下的才需要打命令。
 *
 * 它的文本会以普通消息发回来，由 bareText 翻译成对应命令——
 * 所以这两处的字面量必须对上。
 */
const KEYBOARD: string[][] = [['📊 状态', '📨 最近'], ['🧵 发送记录', '🔎 搜索']]

/**
 * 不以 / 开头的普通消息。
 *
 * 原本一律不回——发「95533」或「验证码」都是彻底的沉默，用户分不清
 * 是「Bot 没听懂」还是「Bot 挂了」。现在按最可能的意图翻译一次，
 * **并且把翻译结果说出来**：让人看见它把你的话理解成了什么，
 * 理解错了也知道该怎么改。
 */
export async function handleText(api: BotApi, text: string): Promise<BotMessage | null> {
  const t = text.trim()
  if (!t || t.startsWith('/')) return null

  switch (t) {
    case '📊 状态': return status(api)
    case '📨 最近': return list(api, { limit: 10 }, '最近 10 条')
    case '🧵 发送记录': return sentList(api, 10)
    case '🔎 搜索': return { text: '想搜什么？直接把关键词发过来，或者用 /search 关键词', forceReply: true }
  }

  // 纯数字（或带 + 和分隔符的号码）按「查这个号码」处理，其余按全文检索。
  // 号码更可能是「我想看这个人发来的」而不是「正文里出现过这串数字」
  const looksLikeNumber = /^\+?[\d\s-]{3,20}$/.test(t)
  const hint = looksLikeNumber
    ? `按号码查 <b>${esc(t)}</b> →`
    : `按关键词搜 <b>${esc(t)}</b> →（想按号码查用 /from ${esc(t)}）`
  const r = looksLikeNumber
    ? await list(api, { limit: 10, from: t }, `来自 ${esc(t)}`)
    : await list(api, { limit: 10, q: t }, `「${esc(t)}」`)
  return { ...r, text: `${hint}\n\n${r.text}` }
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
    const sims = n.sims && n.sims.length > 1 ? n.sims : []
    if (sims.length > 0) {
      // 双卡逐卡各报一份：总的那个 signal 只代表其中一张
      for (const sim of sims) {
        const name = sim.tail ? `尾号${sim.tail}` : (sim.carrier ?? sim.label ?? '')
        const lv = sim.signal
        out.push(`📶 SIM${sim.slot + 1}${name ? ` ${esc(name)}` : ''}` +
          (lv == null ? '' : ` ${'▮'.repeat(lv)}${'▯'.repeat(4 - lv)}${lv <= 1 ? ' ⚠️ 很弱' : ''}`))
      }
    } else if (n.signal != null) {
      out.push(`📶 信号 ${'▮'.repeat(n.signal)}${'▯'.repeat(4 - n.signal)}${n.signal <= 1 ? ' ⚠️ 很弱' : ''}`)
    }
    if (n.type === 'wifi') out.push(`🛜 ${n.ssid ? esc(n.ssid) : 'WiFi'}`)
    else if (n.type === 'cellular') out.push('📱 移动数据')
    else if (n.type === 'none') out.push('❌ 无网络')
    if (n.type && n.type !== 'none' && n.online === false) out.push('⚠️ 连着但没网')
    if (n.wifi === false && n.type !== 'wifi') out.push('WiFi 已关')
    // 双卡时运营商已经跟在每张卡后面，再来一个总的会被当成第三张卡
    if (n.carrier && sims.length === 0) out.push(esc(n.carrier))
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

/**
 * 所有列表类查询的统一出口，保证 spoiler 与设备标注的处理只有一处。
 *
 * 列表带三样东西：行号（配合下面的数字按钮逐条打开）、翻页按钮、
 * 以及「这次到底搜到哪儿了」的实话。第三样最容易被省掉，而省掉的代价是
 * 「没搜到」被当成「没有这条消息」。
 */
async function list(
  api: BotApi,
  params: { limit: number; offset?: number; q?: string; from?: string; kind?: string; deep?: boolean },
  title: string,
  token?: string,
): Promise<BotMessage> {
  const offset = params.offset ?? 0
  const [r, s] = await Promise.all([api.events({ ...params, offset }), api.stats()])

  const tok = token ?? stashQuery({ kind: 'events', params: { ...params }, title, offset })
  const stashed = listQueries.get(tok)
  if (stashed) stashed.offset = offset

  if (r.events.length === 0) {
    return {
      text: r.exhausted === false
        ? `最近一段里没找到（${title}）。更早的还没搜。`
        : offset > 0 ? `没有更多了（${title}）` : `没有匹配的消息（${title}）`,
      ...(r.exhausted === false ? { buttons: [[{ text: '🔎 继续往更早搜', data: `dp:${tok}` }]] } : {}),
    }
  }

  const multi = s.devices.filter((d) => d.status !== 'revoked').length > 1
  const head = `<b>${title}</b> · 第 ${offset + 1}–${offset + r.events.length} 条，共 ${r.total} 条`
  // 正文是密文，只能逐条解开比对，一次请求有时间预算。搜不完必须说
  const partial = r.exhausted === false ? '\n\n⚠️ 只搜了最近一段，更早的还没搜。' : ''

  return {
    text: [head, '', ...r.events.map((e, i) => `${offset + i + 1}. ${renderEvent(e, multi)}`)].join('\n\n') + partial,
    buttons: listButtons(r.events.map((e) => e.id), tok, offset, params.limit, r.total, r.exhausted),
  }
}

/**
 * 列表底下那几排按钮：数字键逐条打开，外加翻页。
 *
 * 数字而不是每行一个整宽按钮——10 条就是 10 个整宽按钮，把列表本身挤出屏幕。
 */
function listButtons(
  ids: string[], token: string, offset: number, limit: number, total: number, exhausted?: boolean,
): { text: string; data: string }[][] {
  const rows: { text: string; data: string }[][] = []
  for (let i = 0; i < ids.length; i += 5) {
    rows.push(ids.slice(i, i + 5).map((id, j) => ({
      text: String(offset + i + j + 1),
      data: `ev:${token}:${id}`,
    })))
  }
  const nav: { text: string; data: string }[] = []
  if (offset > 0) nav.push({ text: '‹ 上一页', data: `pg:${token}:${Math.max(0, offset - limit)}` })
  if (offset + ids.length < total) nav.push({ text: '下一页 ›', data: `pg:${token}:${offset + limit}` })
  if (nav.length) rows.push(nav)
  if (exhausted === false) rows.push([{ text: '🔎 继续往更早搜', data: `dp:${token}` }])
  return rows
}

/**
 * 网关自己发出去的短信。正文同样进 spoiler —— 发出去的内容里一样可能有
 * 验证码（转发场景）。
 */
async function sentList(api: BotApi, limit: number, offset = 0, token?: string): Promise<BotMessage> {
  const [r, s] = await Promise.all([api.outbound({ limit, offset }), api.stats()])
  const tok = token ?? stashQuery({ kind: 'outbound', params: { limit }, title: '发送记录', offset })
  const stashed = listQueries.get(tok)
  if (stashed) stashed.offset = offset
  if (r.outbound.length === 0) {
    return { text: offset > 0 ? '没有更多了' : '还没有发送记录' }
  }
  const multi = s.devices.filter((d) => d.status !== 'revoked').length > 1
  const label: Record<string, string> = {
    pending: '待下发', accepted: '已接收', sent: '已发出', delivered: '✅ 已送达', failed: '❌ 失败',
  }
  const nav: { text: string; data: string }[] = []
  if (offset > 0) nav.push({ text: '‹ 上一页', data: `pg:${tok}:${Math.max(0, offset - limit)}` })
  if (offset + r.outbound.length < r.total) nav.push({ text: '下一页 ›', data: `pg:${tok}:${offset + limit}` })
  return {
    ...(nav.length ? { buttons: [nav] } : {}),
    text: [`<b>发送记录</b> · 第 ${offset + 1}–${offset + r.outbound.length} 条，共 ${r.total} 条`, '', ...r.outbound.map((o) => {
      const head = multi && o.device_name
        ? `→ ${esc(o.to)} · ${esc(o.device_name)} · ${fmtTime(o.created_at)}`
        : `→ ${esc(o.to)} · ${fmtTime(o.created_at)}`
      return `${head}\n💬 ${spoiler(o.text)}\n${label[o.status] ?? esc(o.status)}` +
        (o.error ? ` · ${esc(o.error)}` : '')
    })].join('\n\n'),
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

/**
 * 单条详情。
 *
 * 列表里的正文是截断的，而转发来的验证码短信经常很长。这里给全文，
 * 外加三个最常见的下一步：回给对方、看这个号码的往来、回到刚才那一页。
 */
async function detail(api: BotApi, id: string, backToken?: string): Promise<BotMessage> {
  const e = await api.event(id)
  if (!e) return { text: '这条消息不存在，可能已经被删掉了' }

  const head = [esc(e.from), e.device_name ? esc(e.device_name) : null, e.sim ? esc(e.sim) : null, fmtTime(e.occurred_at)]
    .filter(Boolean).join(' · ')
  const kindLabel = e.kind === 'call' ? '📞 通话' : e.kind === 'notification' ? '🔔 应用通知' : (e.direction === 'out' ? '📤 已发送' : '📨 短信')

  const rows: { text: string; data: string }[][] = []
  // 只有短信能回：给一通来电「回复」一条短信不是用户预期的动作
  if (e.kind === 'sms') rows.push([{ text: '↩️ 回复', data: `re:${e.id}` }])
  rows.push([{ text: '🧵 这个号码的往来', data: `th:${threadKey(e.from)}` }])
  if (backToken) rows.push([{ text: '‹ 返回列表', data: `pg:${backToken}:-1` }])

  return { text: `${kindLabel} · ${head}\n\n💬 ${spoiler(e.content)}`, buttons: rows, edit: true }
}

/**
 * 一个号码的往来，按时间正序排成一段对话。
 *
 * 「回复用哪台设备哪张卡」由服务端算好（reply_device / reply_sim）：
 * 多卡场景下从别的卡回过去，对方看到的是陌生号码。
 */
async function threadView(api: BotApi, key: string): Promise<BotMessage> {
  const t = await api.thread(key)
  if (!t || t.items.length === 0) return { text: '这个号码没有往来记录' }

  // 只取最近一段：一段长对话全塞进一条消息会被 Telegram 拒掉
  const items = t.items.slice(-12)
  const lines = items.map((x) =>
    `${x.direction === 'out' ? '→ 你' : `← ${esc(t.number)}`} · ${fmtTime(x.at)}\n💬 ${spoiler(x.text)}`)
  const omitted = t.items.length > items.length
    ? `\n\n（只显示最近 ${items.length} 条，共 ${t.items.length} 条）`
    : ''

  const rows: { text: string; data: string }[][] = []
  const last = [...t.items].reverse().find((x) => x.direction === 'in')
  if (last) rows.push([{ text: '↩️ 回复', data: `re:${last.id}` }])

  return {
    text: [`<b>🧵 ${esc(t.number)}</b>`, '', ...lines].join('\n\n') + omitted,
    ...(rows.length ? { buttons: rows } : {}),
    edit: true,
  }
}

/**
 * 「回复」按钮：下发一条 forceReply 提示，让客户端自动带上引用。
 *
 * 服务端不记「谁正在回复谁」——那是新的进程内状态。取而代之，
 * 适配层会给这条提示消息落一条 message_ref，于是用户打过来的字
 * 走的是和「引用一条短信推送」完全相同的那条路。
 */
async function replyPrompt(api: BotApi, eventId: string): Promise<BotMessage> {
  const e = await api.event(eventId)
  if (!e) return { text: '这条消息不存在，无法回复' }
  const via = [e.device_name, e.sim_slot == null ? null : `SIM${e.sim_slot + 1}`].filter(Boolean).join(' ')
  return {
    text: `回复 <b>${esc(e.from)}</b>${via ? `（用 ${esc(via)}）` : ''}——直接打字发过来即可。`,
    forceReply: true,
    replyTo: { eventId: e.id, sender: e.from, deviceId: e.device_id, simSlot: e.sim_slot ?? null },
  }
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

  // 「一台设备一张卡 + 熟号码」是唯一不需要确认的情形。
  // 双卡时必须问：收件人看到的号码取决于用哪张卡，挑错等于用错身份
  if (online.length === 1 && known && simsOfDevice(online[0]!).length === 0) {
    const r = await api.sendSms(online[0]!.id, to, text)
    return { text: r.status === 'failed' ? `发送失败：${esc(r.error ?? '未知原因')}` : `已提交发送 → ${esc(to)}` }
  }

  const token = stashSend(to, text)
  const multi = online.length > 1
  const head = known
    ? `发给 <b>${esc(to)}</b>，用哪${multi || online.some((d) => simsOfDevice(d).length > 0) ? '张卡' : '台设备'}？`
    : `⚠️ <b>${esc(to)}</b> 不在历史记录中，确认要发送吗？`

  const rows: { text: string; data: string }[][] = []
  for (const d of online) {
    const sims = simsOfDevice(d)
    if (sims.length === 0) {
      rows.push([{ text: multi ? `用 ${d.name} 发送` : '确认发送', data: `send:${token}:${d.id}` }])
      continue
    }
    for (const sim of sims) {
      const name = sim.tail ? `尾号${sim.tail}` : (sim.carrier ?? sim.label ?? '')
      rows.push([{
        text: `${multi ? `${d.name} ` : ''}SIM${sim.slot + 1}${name ? ` ${name}` : ''}`,
        data: `send:${token}:${d.id}:${sim.slot}`,
      }])
    }
  }

  return {
    text: `${head}\n\n💬 ${spoiler(text)}`,
    buttons: [...rows, [{ text: '取消', data: 'cancel' }]],
  }
}

/** 双卡才返回内容：单卡时问「用哪张卡」纯属添乱。 */
function simsOfDevice(d: BotStatsDevice): NonNullable<NonNullable<BotStatsDevice['net']>['sims']> {
  const sims = d.net?.sims
  return sims && sims.length > 1 ? sims : []
}

/** 处理引用回复：把回复内容作为短信发回原发件人。 */
export async function handleReply(api: BotApi, replyToRef: string, text: string): Promise<BotMessage | null> {
  const ref = await api.lookupRef(replyToRef)
  // 引用的不是我们推送的短信（比如回复了 /status 的输出），忽略
  if (!ref) return null

  // 用原事件所属的那台设备、那张卡回复：从别的卡发回去，
  // 对方看到的是一个陌生号码——哪怕是同一台手机上的另一张卡
  const r = await api.sendSms(ref.device_id, ref.sender, text, ref.sim_slot ?? null)
  return {
    text: r.status === 'failed'
      ? `发送失败：${esc(r.error ?? '未知原因')}`
      : `已回复 ${esc(ref.sender)}`,
  }
}

/** 处理按钮回调。 */
export async function handleCallback(api: BotApi, data: string, now = Date.now()): Promise<BotMessage | null> {
  if (data === 'cancel') return { text: '已取消' }

  // ── 翻页 ─────────────────────────────────────────────────
  const pg = data.match(/^pg:([^:]+):(-?\d+)$/)
  if (pg) {
    const q = listQueries.get(pg[1]!)
    if (!q || q.expiresAt < now) return { text: EXPIRED_QUERY, edit: true }
    // -1 是详情页「返回列表」的约定：回到用户刚才停的那一页，而不是第一页
    const off = Number(pg[2]) < 0 ? q.offset : Number(pg[2])
    const r = q.kind === 'outbound'
      ? await sentList(api, Number(q.params.limit ?? 10), off, pg[1]!)
      : await list(api, { ...(q.params as { limit: number }), offset: off }, q.title, pg[1]!)
    return { ...r, edit: true }
  }

  // ── 放宽扫描预算，继续往更早搜 ────────────────────────────
  const dp = data.match(/^dp:([^:]+)$/)
  if (dp) {
    const q = listQueries.get(dp[1]!)
    if (!q || q.expiresAt < now) return { text: EXPIRED_QUERY, edit: true }
    const r = await list(api, { ...(q.params as { limit: number }), offset: 0, deep: true }, `${q.title} · 深搜`, dp[1]!)
    return { ...r, edit: true }
  }

  // ── 打开某一条 ───────────────────────────────────────────
  const ev = data.match(/^ev:([^:]*):(.+)$/)
  if (ev) return detail(api, ev[2]!, ev[1] || undefined)

  const re = data.match(/^re:(.+)$/)
  if (re) return replyPrompt(api, re[1]!)

  const th = data.match(/^th:(.+)$/)
  if (th) return threadView(api, th[1]!)

  // 卡槽是可选的第三段。deviceId 里不含冒号，所以用 [^:]+ 切得干净
  const m = data.match(/^send:([^:]+):([^:]+)(?::(\d))?$/)
  if (!m) return null

  const pending = pendingSends.get(m[1]!)
  if (!pending || pending.expiresAt < now) {
    return { text: '确认窗口已超时（5 分钟），请重新发一次 /send' }
  }
  if (pending.usedAt != null) {
    // 按钮被点第二次。原消息本该在第一次之后就被改写掉，
    // 这里是那条路径失败时的兜底——两层都有，因为代价是重复发一条短信
    return { text: '这条已经发过了，不用再点。要再发一条请重新 /send' }
  }
  pending.usedAt = now

  const deviceId = m[2]!
  const s = await api.stats()
  const device = s.devices.find((d) => d.id === deviceId)
  if (!device || device.status !== 'online') {
    return { text: `${device ? esc(device.name) : '该设备'}当前不在线，未发送` }
  }

  const slot = m[3] == null ? null : Number(m[3])
  const r = await api.sendSms(deviceId, pending.to, pending.text, slot)
  const via = [device.name, slot == null ? null : `SIM${slot + 1}`].filter(Boolean).join(' ')
  return {
    text: r.status === 'failed'
      ? `发送失败：${esc(r.error ?? '未知原因')}`
      : `已提交发送 → ${esc(pending.to)}（${esc(via)}）`,
  }
}
