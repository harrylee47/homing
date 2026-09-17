import { describe, expect, it } from 'vitest'
import {
  ANNOUNCE_BODY_MAX, ANNOUNCE_TITLE_MAX,
  dayStart, inviteState, normalizeAnnouncement,
} from '../notice.js'

const HOUR = 3_600_000
const TZ8 = 8 * HOUR

describe('「今天」的起点', () => {
  it('按传进来的时区切，不按 UTC', () => {
    // 2026-09-18T01:00:00Z = 东八区的 09:18 上午
    const t = Date.parse('2026-09-18T01:00:00Z')
    const start = dayStart(t, TZ8)
    expect(new Date(start).toISOString()).toBe('2026-09-17T16:00:00.000Z')
    // 也就是东八区的 2026-09-18 00:00
    expect(start + TZ8).toBe(Date.parse('2026-09-18T00:00:00Z'))
  })

  /**
   * 这一条是这个函数存在的全部理由：服务端跑在 UTC 的容器里，直接切 UTC 零点
   * 会让东八区的人在早上八点之前都算作「昨天活跃」——恰恰是他起床看验证码
   * 的那段时间。
   */
  it('东八区早上七点算今天，而按 UTC 切会算成昨天', () => {
    const t = Date.parse('2026-09-17T23:00:00Z')   // 东八区 09-18 07:00
    const utcStart = t - (t % 86_400_000)          // UTC 的今天零点 = 09-17T00:00Z
    expect(dayStart(t, TZ8)).toBeGreaterThan(utcStart)
    expect(dayStart(t, TZ8)).toBe(Date.parse('2026-09-17T16:00:00Z'))
  })

  it('负偏移（西半球）同样成立', () => {
    const t = Date.parse('2026-09-18T03:00:00Z')   // 纽约 09-17 23:00（UTC-4）
    expect(dayStart(t, -4 * HOUR)).toBe(Date.parse('2026-09-17T04:00:00Z'))
  })

  it('正好落在零点时，起点就是它自己', () => {
    const t = Date.parse('2026-09-17T16:00:00Z')
    expect(dayStart(t, TZ8)).toBe(t)
  })
})

describe('邀请码状态', () => {
  const NOW = 1_800_000_000_000
  it('没用过且没过期是 open', () => {
    expect(inviteState({ used_at: null, expires_at: NOW + HOUR }, NOW)).toBe('open')
  })
  it('用过就是 used，哪怕还没到期', () => {
    expect(inviteState({ used_at: NOW - HOUR, expires_at: NOW + HOUR }, NOW)).toBe('used')
  })
  /** 已用要压过已过期：一个「用掉之后又过了期」的码，读的人关心的是它被用了 */
  it('用过且过期了，仍然报 used', () => {
    expect(inviteState({ used_at: NOW - 2 * HOUR, expires_at: NOW - HOUR }, NOW)).toBe('used')
  })
  it('没用过但到点了是 expired', () => {
    expect(inviteState({ used_at: null, expires_at: NOW }, NOW)).toBe('expired')
  })
})

describe('公告校验', () => {
  it('标题与正文都必填', () => {
    expect(normalizeAnnouncement({ title: '', body: '正文' })).toEqual({ error: '标题不能为空' })
    expect(normalizeAnnouncement({ title: '标题', body: '   ' })).toEqual({ error: '正文不能为空' })
  })
  it('去掉首尾空白', () => {
    expect(normalizeAnnouncement({ title: '  维护通知 ', body: ' 今晚重启 ' }))
      .toEqual({ title: '维护通知', body: '今晚重启' })
  })
  it('超长的拒绝，不截断', () => {
    // 截断是静默改内容：管理员按下保存看到的和存进去的不一样
    expect(normalizeAnnouncement({ title: 'x'.repeat(ANNOUNCE_TITLE_MAX + 1), body: 'y' }))
      .toEqual({ error: `标题最多 ${ANNOUNCE_TITLE_MAX} 字` })
    expect(normalizeAnnouncement({ title: 'x', body: 'y'.repeat(ANNOUNCE_BODY_MAX + 1) }))
      .toEqual({ error: `正文最多 ${ANNOUNCE_BODY_MAX} 字` })
  })
  it('非字符串一律当空', () => {
    expect(normalizeAnnouncement({ title: 123, body: null })).toEqual({ error: '标题不能为空' })
  })
})
