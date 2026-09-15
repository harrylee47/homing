/**
 * 规则引擎（计划 §8）。
 *
 * 定义为可配置 JSON 而非 if-else 硬编码：前期多花两小时，后面每加一条需求省半天。
 * 运行时无关——不依赖任何 Node / Workers API。
 */
import { z } from 'zod'
import { BarkOptions } from './providers/bark.js'
import { EventKind } from './protocol.js'

// ── 匹配条件 ────────────────────────────────────────────────

export const RuleMatch = z.object({
  /** 事件类型。空数组视为不限制。 */
  kind: z.array(EventKind).default([]),
  /** 发件人正则，对整个号码做 test */
  sender_regex: z.string().max(500).nullish(),
  /** 正文包含任一关键词即命中（数组内为 OR） */
  content_contains: z.array(z.string().max(200)).default([]),
  content_regex: z.string().max(500).nullish(),
  /** 生效时段，HH:MM。from > to 表示跨午夜（如 23:00–07:00） */
  time_window: z
    .object({
      from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    })
    .nullish(),
  /** 限定设备。空数组视为不限制。 */
  device_ids: z.array(z.string()).default([]),
})
export type RuleMatch = z.infer<typeof RuleMatch>

// ── 动作 ────────────────────────────────────────────────────

export const RuleAction = z.object({
  /** 目标渠道 id。空数组表示只归档不推送。 */
  channels: z.array(z.string()).default([]),
  priority: z.enum(['normal', 'high']).default('normal'),
  /** 提取 4–8 位验证码，单独放进推送标题，通知栏无需展开即可见 */
  extract_code: z.boolean().default(false),
  /** 支持 {sender} {content} {code} {time} {device} 占位符 */
  template: z.string().max(1000).default('【{sender}】{content}'),
  archive: z.boolean().default(true),
  /** 命中后不再匹配后续规则 */
  stop_processing: z.boolean().default(false),
  /**
   * Bark 专属字段（计划 §11.3）。放在规则里而不是渠道配置里，
   * 是因为它随消息类型变化：银行验证码要穿透专注模式，广告短信不该。
   */
  bark: BarkOptions.optional(),
})
export type RuleAction = z.infer<typeof RuleAction>

export interface Rule {
  id: string
  name: string
  /** 数字小者先匹配 */
  priority: number
  enabled: boolean
  match: RuleMatch
  action: RuleAction
}

/** 参与匹配的事件视图（明文，仅在内存中存在）。 */
export interface MatchableEvent {
  device_id: string
  kind: z.infer<typeof EventKind>
  from: string
  content: string
  occurred_at: number
}

// ── 匹配 ────────────────────────────────────────────────────

/**
 * 单条规则是否命中。
 *
 * 同一规则内多个条件为 AND；数组内多值为 OR；空值视为不限制（计划 §8.1）。
 */
export function matchRule(rule: Rule, e: MatchableEvent, tzOffsetMin = 0): boolean {
  if (!rule.enabled) return false
  const m = rule.match

  if (m.kind.length > 0 && !m.kind.includes(e.kind)) return false
  if (m.device_ids.length > 0 && !m.device_ids.includes(e.device_id)) return false

  if (m.sender_regex) {
    if (!safeTest(m.sender_regex, e.from)) return false
  }

  if (m.content_contains.length > 0) {
    // 数组内是 OR：命中任意一个关键词即可
    if (!m.content_contains.some((k) => e.content.includes(k))) return false
  }

  if (m.content_regex) {
    if (!safeTest(m.content_regex, e.content)) return false
  }

  if (m.time_window) {
    if (!inTimeWindow(e.occurred_at, m.time_window.from, m.time_window.to, tzOffsetMin)) return false
  }

  return true
}

/**
 * 正则来自用户配置，必须容错：写错的正则不应让整条事件处理链崩掉，
 * 否则一条坏规则会导致所有短信都收不到。
 */
function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

/** from > to 表示跨午夜窗口，例如 23:00–07:00。 */
export function inTimeWindow(ts: number, from: string, to: string, tzOffsetMin: number): boolean {
  const d = new Date(ts + tzOffsetMin * 60_000)
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes()
  const f = toMin(from)
  const t = toMin(to)
  return f <= t ? mins >= f && mins <= t : mins >= f || mins <= t
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/** 命中的规则与最终要执行的动作。 */
export interface MatchResult {
  matched: Rule[]
  /** 去重后的目标渠道 */
  channels: string[]
  /** 取命中规则中的最高优先级 */
  priority: 'normal' | 'high'
  archive: boolean
}

/**
 * 按 priority 升序逐条匹配，遇到 stop_processing 即停止。
 *
 * 无任何规则命中时，调用方应走 default 兜底规则——不能静默丢弃，
 * 那正是「漏报」的来源。
 */
export function evaluate(rules: Rule[], e: MatchableEvent, tzOffsetMin = 0): MatchResult {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  const matched: Rule[] = []
  const channels: string[] = []
  let priority: 'normal' | 'high' = 'normal'
  let archive = false

  for (const r of sorted) {
    if (!matchRule(r, e, tzOffsetMin)) continue
    matched.push(r)
    for (const c of r.action.channels) if (!channels.includes(c)) channels.push(c)
    if (r.action.priority === 'high') priority = 'high'
    if (r.action.archive) archive = true
    if (r.action.stop_processing) break
  }

  return { matched, channels, priority, archive }
}

// ── 验证码提取 ──────────────────────────────────────────────

/**
 * 提取验证码。
 *
 * 只认「关键词附近的数字」，不认孤立数字串——否则金额、卡号尾数、
 * 订单号都会被误当成验证码，而验证码要放进推送标题，误报的代价很高。
 */
const CODE_KEYWORDS = [
  '验证码', '校验码', '动态码', '动态密码', '识别码', '確認コード', '認証番号',
  'code', 'otp', 'pin', 'password', 'passcode',
]

export function extractCode(content: string): string | null {
  const lower = content.toLowerCase()

  for (const kw of CODE_KEYWORDS) {
    let idx = lower.indexOf(kw.toLowerCase())
    while (idx !== -1) {
      // 关键词后 30 字符内找 4–8 位数字，这个窗口覆盖「验证码是 123456」
      // 以及「验证码：123456，5分钟内有效」这类常见写法。
      // 前后的数字边界不可省略：否则 13 位的订单号会被截成 8 位当作验证码，
      // 而通知标题里放一个错的验证码比不放更糟。
      const after = content.slice(idx + kw.length, idx + kw.length + 30)
      const m = after.match(/(?<!\d)\d{4,8}(?!\d)/)
      if (m) return m[0]

      // 少数模板把数字放在关键词前面，如「123456 是您的验证码」
      const before = content.slice(Math.max(0, idx - 20), idx)
      const mb = before.match(/(?<!\d)\d{4,8}(?!\d)(?!.*(?<!\d)\d{4,8}(?!\d))/)
      if (mb) return mb[0]

      idx = lower.indexOf(kw.toLowerCase(), idx + 1)
    }
  }
  return null
}

// ── 模板渲染 ────────────────────────────────────────────────

export interface TemplateVars {
  sender: string
  content: string
  code: string
  time: string
  device: string
}

/** 未知占位符原样保留，便于用户发现自己拼错了变量名。 */
export function render(template: string, vars: TemplateVars): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? vars[key as keyof TemplateVars] : whole,
  )
}

/** 无规则命中时的兜底：推送到所有启用渠道并归档（计划 §8.2）。 */
export function defaultAction(allChannelIds: string[]): RuleAction {
  return {
    channels: allChannelIds,
    priority: 'normal',
    extract_code: true,
    template: '【{sender}】{content}',
    archive: true,
    stop_processing: true,
  }
}
