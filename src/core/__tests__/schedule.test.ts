import { describe, expect, it } from 'vitest'
import { describe as describeSchedule, nextRun, Schedule, wallTimeToEpoch } from '../schedule.js'

const TOKYO = 'Asia/Tokyo'
const NY = 'America/New_York'

/** 把时刻格式化成指定时区的墙上时间，便于断言 */
const inTz = (epoch: number, tz: string): string =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(epoch)).replace(' ', ' ')

describe('时区换算', () => {
  it('东京 9:00 对应 UTC 0:00', () => {
    const e = wallTimeToEpoch(TOKYO, 2026, 9, 16, 9, 0)
    expect(new Date(e).toISOString()).toBe('2026-09-16T00:00:00.000Z')
  })

  it('换算结果在目标时区正是设定的墙上时间', () => {
    for (const [tz, y, mo, d, h, mi] of [
      [TOKYO, 2026, 1, 1, 0, 0], [TOKYO, 2026, 12, 31, 23, 59],
      [NY, 2026, 6, 15, 14, 30], [NY, 2026, 1, 15, 14, 30],
    ] as const) {
      const e = wallTimeToEpoch(tz, y, mo, d, h, mi)
      expect(inTz(e, tz)).toBe(
        `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`,
      )
    }
  })

  it('跨夏令时切换仍然正确（纽约 3 月与 11 月）', () => {
    // 夏令时开始后与结束后，同样的墙上时间对应不同的 UTC 偏移
    const march = wallTimeToEpoch(NY, 2026, 3, 20, 9, 0)
    const november = wallTimeToEpoch(NY, 2026, 11, 20, 9, 0)
    expect(inTz(march, NY)).toBe('2026-03-20 09:00')
    expect(inTz(november, NY)).toBe('2026-11-20 09:00')
    // 两者的 UTC 小时应相差 1，说明偏移确实跟着变了
    expect(new Date(march).getUTCHours()).not.toBe(new Date(november).getUTCHours())
  })
})

describe('每天', () => {
  const s = Schedule.parse({ type: 'daily', time: '09:00' })

  it('当天时刻未到则返回当天', () => {
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 8, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-09-16 09:00')
  })

  it('当天时刻已过则返回次日', () => {
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-09-17 09:00')
  })

  it('恰好等于执行时刻时返回次日 —— 严格晚于，避免同一时刻重复执行', () => {
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 9, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-09-17 09:00')
  })

  it('跨月跨年正确', () => {
    const now = wallTimeToEpoch(TOKYO, 2026, 12, 31, 23, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2027-01-01 09:00')
  })

  it('时区不同结果不同 —— 这正是用 UTC 判断会出错的地方', () => {
    const now = Date.UTC(2026, 8, 16, 1, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-09-17 09:00')
    expect(inTz(nextRun(s, now, NY)!, NY)).toBe('2026-09-16 09:00')
  })
})

describe('每周', () => {
  it('单个星期几', () => {
    const s = Schedule.parse({ type: 'weekly', time: '09:00', weekdays: [1] })
    // 2026-09-16 是周三
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-09-21 09:00')
  })

  it('多个星期几取最近的一个', () => {
    const s = Schedule.parse({ type: 'weekly', time: '09:00', weekdays: [1, 3, 5] })
    const wed = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, wed, TOKYO)!, TOKYO)).toBe('2026-09-18 09:00')
  })

  it('当天是目标星期几且时刻未到，返回当天', () => {
    const s = Schedule.parse({ type: 'weekly', time: '18:00', weekdays: [3] })
    const wed = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, wed, TOKYO)!, TOKYO)).toBe('2026-09-16 18:00')
  })

  it('周日用 0 表示', () => {
    const s = Schedule.parse({ type: 'weekly', time: '09:00', weekdays: [0] })
    const wed = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, wed, TOKYO)!, TOKYO)).toBe('2026-09-20 09:00')
  })
})

describe('每月', () => {
  it('当月日期未到则返回当月', () => {
    const s = Schedule.parse({ type: 'monthly', time: '09:00', days: [20] })
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-09-20 09:00')
  })

  it('当月日期已过则返回次月', () => {
    const s = Schedule.parse({ type: 'monthly', time: '09:00', days: [10] })
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-10-10 09:00')
  })

  it('31 号在 2 月落到最后一天，而不是跳过整月', () => {
    const s = Schedule.parse({ type: 'monthly', time: '09:00', days: [31] })
    const jan31 = wallTimeToEpoch(TOKYO, 2026, 1, 31, 10, 0)
    expect(inTz(nextRun(s, jan31, TOKYO)!, TOKYO)).toBe('2026-02-28 09:00')
  })

  it('闰年 2 月落到 29 号', () => {
    const s = Schedule.parse({ type: 'monthly', time: '09:00', days: [31] })
    const jan31 = wallTimeToEpoch(TOKYO, 2028, 1, 31, 10, 0)
    expect(inTz(nextRun(s, jan31, TOKYO)!, TOKYO)).toBe('2028-02-29 09:00')
  })

  it('多个日期取最近的一个', () => {
    const s = Schedule.parse({ type: 'monthly', time: '09:00', days: [1, 15, 28] })
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-09-28 09:00')
  })
})

describe('每年', () => {
  it('当年日期未到则返回当年', () => {
    const s = Schedule.parse({ type: 'yearly', time: '09:00', month: 12, day: 25 })
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2026-12-25 09:00')
  })

  it('当年日期已过则返回次年', () => {
    const s = Schedule.parse({ type: 'yearly', time: '09:00', month: 1, day: 1 })
    const now = wallTimeToEpoch(TOKYO, 2026, 9, 16, 10, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2027-01-01 09:00')
  })

  it('2 月 29 日在平年落到 28 号', () => {
    const s = Schedule.parse({ type: 'yearly', time: '09:00', month: 2, day: 29 })
    const now = wallTimeToEpoch(TOKYO, 2026, 3, 1, 10, 0)
    expect(inTz(nextRun(s, now, TOKYO)!, TOKYO)).toBe('2027-02-28 09:00')
  })
})

describe('一次性与间隔', () => {
  it('一次性：未到则返回该时刻', () => {
    const at = wallTimeToEpoch(TOKYO, 2026, 9, 20, 9, 0)
    const s = Schedule.parse({ type: 'once', at })
    expect(nextRun(s, at - 1000, TOKYO)).toBe(at)
  })

  it('一次性：已过则返回 null，任务不再执行', () => {
    const at = wallTimeToEpoch(TOKYO, 2026, 9, 20, 9, 0)
    const s = Schedule.parse({ type: 'once', at })
    expect(nextRun(s, at + 1000, TOKYO)).toBeNull()
  })

  it('间隔：没跑过则立即到期', () => {
    const s = Schedule.parse({ type: 'interval', days: 30 })
    const now = Date.now()
    expect(nextRun(s, now, TOKYO, null)).toBe(now)
  })

  it('间隔：从上次执行时间往后推', () => {
    const s = Schedule.parse({ type: 'interval', days: 30 })
    const last = Date.UTC(2026, 8, 1)
    expect(nextRun(s, Date.now(), TOKYO, last)).toBe(last + 30 * 86_400_000)
  })
})

describe('校验', () => {
  it.each([
    { type: 'daily', time: '25:00' },
    { type: 'daily', time: '9:00' },
    { type: 'weekly', time: '09:00', weekdays: [] },
    { type: 'weekly', time: '09:00', weekdays: [7] },
    { type: 'monthly', time: '09:00', days: [32] },
    { type: 'monthly', time: '09:00', days: [] },
    { type: 'yearly', time: '09:00', month: 13, day: 1 },
    { type: 'interval', days: 0 },
  ])('拒绝非法配置 %j', (bad) => {
    expect(Schedule.safeParse(bad).success).toBe(false)
  })
})

describe('人类可读描述', () => {
  it.each([
    [{ type: 'daily', time: '09:00' }, '每天 09:00'],
    [{ type: 'weekly', time: '09:00', weekdays: [1, 3] }, '每周 周一、周三 09:00'],
    [{ type: 'monthly', time: '09:00', days: [1, 15] }, '每月 1、15 日 09:00'],
    [{ type: 'yearly', time: '09:00', month: 12, day: 25 }, '每年 12 月 25 日 09:00'],
    [{ type: 'interval', days: 30 }, '每 30 天'],
  ])('%j → %s', (s, want) => {
    expect(describeSchedule(Schedule.parse(s))).toBe(want)
  })
})
