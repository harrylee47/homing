import { describe, expect, it } from 'vitest'
import { ALERT_WINDOW_MS, ALERT_WINDOW_SETTING, shouldAlert, type AlertWindowStore } from '../alertwindow.js'

const fakeStore = (): AlertWindowStore & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    async getUserSetting(u, k) { return data.get(`${u}:${k}`) ?? null },
    async setUserSetting(u, k, v) { data.set(`${u}:${k}`, v) },
  }
}

const T0 = 1_789_000_000_000

describe('告警压制窗口', () => {
  it('第一条放行，窗口内的后续全部压掉', async () => {
    const s = fakeStore()
    expect(await shouldAlert(s, 'u1', 'ch_a', T0)).toEqual({ send: true, suppressed: 0 })
    for (let i = 1; i <= 49; i++) {
      expect((await shouldAlert(s, 'u1', 'ch_a', T0 + i * 1000)).send).toBe(false)
    }
  })

  it('窗口过去后再放行，并把压掉的条数带出来', async () => {
    const s = fakeStore()
    await shouldAlert(s, 'u1', 'ch_a', T0)
    for (let i = 1; i <= 49; i++) await shouldAlert(s, 'u1', 'ch_a', T0 + i * 1000)

    // 「窗口内又失败了 49 条」本身就是信息：它区分「偶发一条」和「这个渠道瘫了」
    expect(await shouldAlert(s, 'u1', 'ch_a', T0 + ALERT_WINDOW_MS + 1))
      .toEqual({ send: true, suppressed: 49 })

    // 报过一次就清零，不能每次都把历史累计再报一遍
    expect(await shouldAlert(s, 'u1', 'ch_a', T0 + ALERT_WINDOW_MS * 3))
      .toEqual({ send: true, suppressed: 0 })
  })

  it('不同渠道各算各的', async () => {
    const s = fakeStore()
    expect((await shouldAlert(s, 'u1', 'ch_a', T0)).send).toBe(true)
    expect((await shouldAlert(s, 'u1', 'ch_b', T0)).send).toBe(true)
    expect((await shouldAlert(s, 'u1', 'ch_a', T0 + 1000)).send).toBe(false)
  })

  it('不同用户各算各的 —— 她的渠道坏了不该压掉你的告警', async () => {
    const s = fakeStore()
    expect((await shouldAlert(s, 'u1', 'ch_a', T0)).send).toBe(true)
    expect((await shouldAlert(s, 'u2', 'ch_a', T0)).send).toBe(true)
  })

  it('状态跨重启有效 —— 内存里的窗口会被一次部署清掉，恰恰发生在最不想被吵的时候', async () => {
    const s = fakeStore()
    await shouldAlert(s, 'u1', 'ch_a', T0)
    // 模拟重启：只有存储还在
    const s2 = fakeStore()
    for (const [k, v] of s.data) s2.data.set(k, v)
    expect((await shouldAlert(s2, 'u1', 'ch_a', T0 + 1000)).send).toBe(false)
  })

  it('过期条目会被清掉，不然删掉的渠道在这里留一条永不过期的垃圾', async () => {
    const s = fakeStore()
    await shouldAlert(s, 'u1', 'ch_old', T0)
    await shouldAlert(s, 'u1', 'ch_new', T0 + ALERT_WINDOW_MS * 5)
    const saved = JSON.parse(s.data.get(`u1:${ALERT_WINDOW_SETTING}`)!) as Record<string, unknown>
    expect(Object.keys(saved)).toEqual(['ch_new'])
  })

  it('设置坏了不能挡住告警 —— 读不出来就当没窗口，照发', async () => {
    const s = fakeStore()
    s.data.set(`u1:${ALERT_WINDOW_SETTING}`, '{ 这不是 JSON')
    expect((await shouldAlert(s, 'u1', 'ch_a', T0)).send).toBe(true)
  })
})
