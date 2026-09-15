import { describe, expect, it } from 'vitest'
import { eventFingerprint, planReconcile, type GatewayEvent, type PhoneFingerprint } from '../fingerprint.js'

const fp = (kind: string, from: string, content: string) => eventFingerprint(kind, from, content)

describe('指纹', () => {
  it('同一条短信在两条采集路径上算出同一个指纹', async () => {
    expect(await fp('sms', '95533', '您的验证码是 123456'))
      .toBe(await fp('sms', '95533', '您的验证码是 123456'))
  })

  it('号码的空格与连字符不影响', async () => {
    expect(await fp('sms', '138-0013-8000', 'hi')).toBe(await fp('sms', '13800138000', 'hi'))
  })

  it('正文不同就是不同的记录', async () => {
    expect(await fp('sms', '95533', 'a')).not.toBe(await fp('sms', '95533', 'b'))
  })

  it('通话不把描述文字计入——同一通电话三条路径写法不一样', async () => {
    // 实时捕获写「已接来电」，历史导入写「已接来电 · 通话 1分20秒」
    expect(await fp('call', '13800138000', '已接来电'))
      .toBe(await fp('call', '13800138000', '已接来电 · 通话 1分20秒'))
  })

  it('不同号码的通话仍然区分得开', async () => {
    expect(await fp('call', '138', 'x')).not.toBe(await fp('call', '139', 'x'))
  })
})

describe('对齐计划', () => {
  const ev = (id: string, fpv: string, at: number): GatewayEvent =>
    ({ id, kind: 'sms', occurred_at: at, fp: fpv })
  const ph = (fpv: string, at: number): PhoneFingerprint => ({ fp: fpv, at })

  const T = 1_700_000_000_000
  /** 上界：默认给一个远在未来的值，表示「比对到现在为止」 */
  const plan = (g: GatewayEvent[], p: PhoneFingerprint[], until = T + 3600_000) =>
    planReconcile(g, p, { until })

  it('手机上没有的就是要删的', () => {
    expect(plan([ev('a', 'f1', T), ev('b', 'f2', T + 1000)], [ph('f1', T)]).stale).toEqual(['b'])
  })

  it('时间差几百毫秒仍算同一条——两条路径的时间基准本来就不同', () => {
    expect(plan([ev('a', 'f1', T)], [ph('f1', T + 900)]).stale).toEqual([])
  })

  it('差得太远就是两条不同的记录', () => {
    expect(plan([ev('a', 'f1', T + 30_000)], [ph('f1', T)]).stale).toEqual(['a'])
  })

  it('比手机最老记录还早的一概不碰——那是网关的长期归档', () => {
    // 手机只留了最近的，网关里还有半年前的
    const r = plan(
      [ev('old', 'f0', T - 180 * 86400_000), ev('a', 'f1', T), ev('b', 'f2', T + 1000)],
      [ph('f1', T)],
    )
    expect(r.stale).toEqual(['b'])
    expect(r.stale).not.toContain('old')
  })

  it('手机上删掉最新几条，也要能同步掉', () => {
    // 上界如果取「手机最新那条」，这一条就永远删不掉——而删最新几条恰恰最常见
    const r = plan([ev('a', 'f1', T), ev('newest', 'f9', T + 600_000)], [ph('f1', T)])
    expect(r.stale).toEqual(['newest'])
  })

  it('上界之后的不碰——刚收到、还没落进手机库的那条不能误删', () => {
    const r = plan(
      [ev('a', 'f1', T), ev('justnow', 'f9', T + 7200_000)],
      [ph('f1', T)],
      T + 3600_000,
    )
    expect(r.stale).toEqual([])
  })

  it('手机一条都没报时放弃删除，并说明原因', () => {
    const r = plan([ev('a', 'f1', T), ev('b', 'f2', T)], [])
    expect(r.stale).toEqual([])
    expect(r.window).toBeNull()
    expect(r.reason).toContain('无法判断')
  })

  it('同一指纹的多条按时间各自配对', () => {
    // 同一个号码发来两条一模一样的短信，手机上只删了其中一条
    expect(plan([ev('a', 'f1', T), ev('b', 'f1', T + 120_000)], [ph('f1', T)]).stale).toEqual(['b'])
  })

  it('返回实际比对的时间窗，界面上要能说清删的是哪一段', () => {
    expect(plan([], [ph('f1', T), ph('f2', T + 5000)], T + 9000).window)
      .toEqual({ since: T, until: T + 9000 })
  })
})
