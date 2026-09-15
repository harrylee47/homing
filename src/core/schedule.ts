/**
 * 计划任务的排期计算。
 *
 * 全部按**用户时区的墙上时间**计算，而不是 UTC：服务端跑在 UTC，用户在东京，
 * 「每天早上 9 点」指的显然是东京的 9 点。早期的保号任务用 UTC 日期判断，
 * 这是个隐蔽的错误——大部分时候看起来对，跨日界时就差一天。
 *
 * 运行时无关：只用 Intl，Node 与 Workers 都有。
 */
import { z } from 'zod'

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM')

export const Schedule = z.discriminatedUnion('type', [
  /** 只执行一次。执行后任务自动停用。 */
  z.object({ type: z.literal('once'), at: z.number().int().positive() }),
  /** 每 N 天。从上次执行时间往后推，与一天中的时刻无关。 */
  z.object({ type: z.literal('interval'), days: z.number().int().min(1).max(3650) }),
  z.object({ type: z.literal('daily'), time: HHMM }),
  /** 周几（0=周日 … 6=周六），可多选 */
  z.object({ type: z.literal('weekly'), time: HHMM, weekdays: z.array(z.number().int().min(0).max(6)).min(1) }),
  /**
   * 每月的第几天，可多选。
   * 超出当月天数的日期自动落到当月最后一天——31 号在 2 月不该被跳过。
   */
  z.object({ type: z.literal('monthly'), time: HHMM, days: z.array(z.number().int().min(1).max(31)).min(1) }),
  z.object({
    type: z.literal('yearly'), time: HHMM,
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  }),
])
export type Schedule = z.infer<typeof Schedule>

/**
 * 未设置时区时的默认值。
 *
 * **必须只有这一处**：计划任务按 api 的默认值算、规则时段按 pipeline 的默认值算，
 * 两处各写各的默认值，就会出现「同一台网关里两个子系统差 9 小时」——
 * 而且只在用户没主动设过时区时才发作，最难想到。
 *
 * 不用 UTC：机器跑在 UTC，人不在。默认给人所在的时区，错了也是一眼能看出来的错。
 */
export const DEFAULT_TIMEZONE = 'Asia/Tokyo'

// ── 时区换算 ────────────────────────────────────────────────

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partsIn(epoch: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map((x) => [x.type, x.value]))
  return {
    // Intl 在 hour12:false 下午夜可能给出 "24"，归一到 0
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
  }
}

/** 该时刻在指定时区的 UTC 偏移（毫秒）。 */
export function offsetMs(epoch: number, tz: string): number {
  const p = partsIn(epoch, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epoch
}

/**
 * 把「某时区的墙上时间」换算成绝对时刻。
 *
 * 需要迭代：偏移本身依赖于结果时刻（夏令时切换日的偏移前后不同）。
 * 两轮足够收敛——第一轮用估算偏移得到近似时刻，第二轮用该时刻的真实偏移修正。
 */
export function wallTimeToEpoch(
  tz: string, year: number, month: number, day: number, hour: number, minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0)
  let epoch = naive - offsetMs(naive, tz)
  epoch = naive - offsetMs(epoch, tz)
  return epoch
}

const parseTime = (t: string): [number, number] => {
  const [h, m] = t.split(':')
  return [Number(h), Number(m)]
}

/** 该年月实际有多少天。 */
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

// ── 排期 ────────────────────────────────────────────────────

/**
 * 计算严格晚于 `after` 的下一次执行时刻。
 *
 * @param lastRunAt interval 类型需要它作为起点；其余类型不用。
 * @returns 没有下一次（once 已过期）时返回 null
 */
export function nextRun(
  schedule: Schedule, after: number, tz: string, lastRunAt: number | null = null,
): number | null {
  switch (schedule.type) {
    case 'once':
      return schedule.at > after ? schedule.at : null

    case 'interval': {
      // 没跑过就立即到期：用户刚建好任务，等 N 天才第一次执行不符合预期
      if (lastRunAt === null) return after
      return lastRunAt + schedule.days * 86_400_000
    }

    case 'daily': {
      const [h, m] = parseTime(schedule.time)
      return searchDays(after, tz, 2, (y, mo, d) => ({ ok: true, at: wallTimeToEpoch(tz, y, mo, d, h, m) }))
    }

    case 'weekly': {
      const [h, m] = parseTime(schedule.time)
      const want = new Set(schedule.weekdays)
      return searchDays(after, tz, 8, (y, mo, d) => {
        const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
        return want.has(wd) ? { ok: true, at: wallTimeToEpoch(tz, y, mo, d, h, m) } : { ok: false }
      })
    }

    case 'monthly': {
      const [h, m] = parseTime(schedule.time)
      const want = [...schedule.days].sort((a, b) => a - b)
      return searchDays(after, tz, 370, (y, mo, d) => {
        const last = daysInMonth(y, mo)
        // 超出当月天数的配置落到月末：选了 31 号的人，2 月显然是想要 28/29 号，
        // 而不是这个月不执行
        const hit = want.some((x) => Math.min(x, last) === d)
        return hit ? { ok: true, at: wallTimeToEpoch(tz, y, mo, d, h, m) } : { ok: false }
      })
    }

    case 'yearly': {
      const [h, m] = parseTime(schedule.time)
      return searchDays(after, tz, 800, (y, mo, d) => {
        if (mo !== schedule.month) return { ok: false }
        const last = daysInMonth(y, mo)
        return Math.min(schedule.day, last) === d
          ? { ok: true, at: wallTimeToEpoch(tz, y, mo, d, h, m) }
          : { ok: false }
      })
    }
  }
}

/**
 * 从 after 当天开始按天向后找，返回第一个满足条件且时刻晚于 after 的执行点。
 *
 * 逐天枚举而不是做日历运算：多选星期几、月末回落、闰年这些情况用公式写
 * 极易出错，而最多几百次迭代的开销可以忽略。
 */
function searchDays(
  after: number, tz: string, maxDays: number,
  check: (year: number, month: number, day: number) => { ok: boolean; at?: number },
): number | null {
  const start = partsIn(after, tz)
  for (let i = 0; i < maxDays; i++) {
    const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day + i))
    const r = check(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate())
    if (r.ok && r.at !== undefined && r.at > after) return r.at
  }
  return null
}

/** 人类可读的排期描述，用于控制台与告警文案。 */
export function describe(schedule: Schedule): string {
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  switch (schedule.type) {
    case 'once': return `一次性 · ${new Date(schedule.at).toLocaleString('zh-CN', { hour12: false })}`
    case 'interval': return `每 ${schedule.days} 天`
    case 'daily': return `每天 ${schedule.time}`
    case 'weekly': return `每周 ${schedule.weekdays.slice().sort().map((d) => WD[d]).join('、')} ${schedule.time}`
    case 'monthly': return `每月 ${schedule.days.slice().sort((a, b) => a - b).join('、')} 日 ${schedule.time}`
    case 'yearly': return `每年 ${schedule.month} 月 ${schedule.day} 日 ${schedule.time}`
  }
}

/**
 * 按指定时区格式化成人看的时间，给通知模板的 {time} 用。
 *
 * 不用 ISO 串：推送到手机上的「2026-09-15T13:30:00.000Z」既难读又是 UTC，
 * 收到验证码的人要在脑子里做一次时区换算。
 */
export function formatWallTime(epoch: number, tz: string): string {
  const p = partsIn(epoch, tz)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}
