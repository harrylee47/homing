/**
 * 按号码归拢成会话——控制台里那个「像短信 App 一样」的视图。
 *
 * 为什么需要归一化而不是按号码原样分组：同一个人在历史里会以好几种写法出现，
 * `+8613800138000`、`8613800138000`、`13800138000` 是同一个号，
 * 手机上也是一条对话。按原串分组的话，一条对话会裂成三条，
 * 而「这个号码之前跟我说过什么」恰恰是打开会话视图的全部理由。
 */

/**
 * 会话键：能把同一个号码的几种写法归到一起的标识。
 *
 * 取后 9 位而不是全串：国际区号是最主要的差异来源（+86 / 86 / 无前缀），
 * 9 位足够区分不同的号码，又短到能吃掉所有前缀写法。
 * 位数不足 10 的（服务号 10086、短号 800）原样用——它们本来就没有区号。
 *
 * 纯字母的发件人（giffgaff、ソフトバンク、Information）没有数字可取，
 * 按大小写无关的原串归组。
 */
export function threadKey(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return raw.trim().toLowerCase()
  return digits.length >= 10 ? digits.slice(-9) : digits
}

/** 会话里的一条消息。事件与网关下发的任务合并在同一条时间线上。 */
export interface ThreadItem {
  id: string
  /** in=收到，out=发出 */
  direction: 'in' | 'out'
  text: string
  at: number
  /** 来自事件流还是网关的发送记录。决定点进去看哪个详情页 */
  source: 'event' | 'outbound'
  /** source=outbound 时的投递状态 */
  status?: string | null
  error?: string | null
  sim_slot?: number | null
  device_id?: string | null
}

/** 会话摘要，用于列表页。 */
export interface ThreadSummary {
  key: string
  /** 展示用的号码：取最近一条消息里的写法 */
  number: string
  last_at: number
  last_text: string
  last_direction: 'in' | 'out'
  count: number
  device_id: string | null
  sim_slot: number | null
}

interface Groupable {
  from: string
  text: string
  at: number
  direction: 'in' | 'out'
  device_id?: string | null
  sim_slot?: number | null
}

/**
 * 归拢成会话列表，最近的在前。
 *
 * `count` 是**扫到的条数**，不是这个号码的历史总数——统计总数要把整库解密一遍。
 * 界面上据此说「最近 N 条里有 M 条」，不要写成「共 M 条」。
 */
export function groupThreads(items: Groupable[]): ThreadSummary[] {
  const map = new Map<string, ThreadSummary>()
  for (const it of items) {
    const key = threadKey(it.from)
    const cur = map.get(key)
    if (!cur) {
      map.set(key, {
        key, number: it.from, last_at: it.at, last_text: it.text,
        last_direction: it.direction, count: 1,
        device_id: it.device_id ?? null, sim_slot: it.sim_slot ?? null,
      })
      continue
    }
    cur.count++
    // 号码的展示写法也跟着最新那条走：带区号的那个更完整，但更重要的是「和手机上看到的一致」
    if (it.at > cur.last_at) {
      cur.last_at = it.at
      cur.last_text = it.text
      cur.last_direction = it.direction
      cur.number = it.from
      cur.device_id = it.device_id ?? cur.device_id
      cur.sim_slot = it.sim_slot ?? cur.sim_slot
    }
  }
  return [...map.values()].sort((a, b) => b.last_at - a.last_at)
}

/** 认定为同一条的时间窗。下发与手机落库之间隔着运营商，留足余量。 */
const DUP_WINDOW_MS = 120_000

/**
 * 把事件流与网关的发送记录并进同一条时间线。
 *
 * 两边可能是同一条短信：网关下发后，有的 ROM 会把它写进系统发件箱，
 * 于是 SentSmsObserver 又把它当成「手机上发出的短信」报一遍。
 * 同一条在对话里出现两次很刺眼，所以内容相同且时间接近的只留发送记录那条——
 * 它带着「已送达 / 失败」的状态，比事件流那条信息多。
 */
export function mergeThread(events: ThreadItem[], outbound: ThreadItem[]): ThreadItem[] {
  const kept = events.filter((e) => {
    if (e.direction !== 'out') return true
    const body = e.text.replace(/\s+/g, '')
    return !outbound.some((o) =>
      Math.abs(o.at - e.at) <= DUP_WINDOW_MS && o.text.replace(/\s+/g, '') === body,
    )
  })
  return [...kept, ...outbound].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
