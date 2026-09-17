import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETENTION, RETENTION_SETTING, overflow, parseRetention,
  runRetention, sanitizeRetention, serializeRetention, newAccountRetention,
} from '../retention.js'

describe('解析已存的上限配置', () => {
  it('没设过 = 不限制，而不是套默认值', () => {
    // 方向不能反：上线一个功能就把已有账号的历史删到只剩 999 条，
    // 是这个功能唯一不可接受的失败
    expect(parseRetention(null)).toEqual({ sms: 0, call: 0, notification: 0, outbound: 0 })
    expect(parseRetention('')).toEqual({ sms: 0, call: 0, notification: 0, outbound: 0 })
  })

  it('坏数据往安全方向塌', () => {
    for (const bad of ['{不是 JSON', '[]', 'null', '"999"', '123']) {
      expect(parseRetention(bad)).toEqual({ sms: 0, call: 0, notification: 0, outbound: 0 })
    }
  })

  it('字符串数字不认 —— 它被悄悄转成数字就是一次静默的批量删除', () => {
    expect(parseRetention('{"sms":"999"}').sms).toBe(0)
  })

  it('负数、小数、NaN、Infinity 一律当没设', () => {
    expect(parseRetention('{"sms":-1}').sms).toBe(0)
    expect(parseRetention('{"sms":10.5}').sms).toBe(0)
    expect(parseRetention('{"sms":null}').sms).toBe(0)
  })

  it('只认识的键生效，多余的键忽略', () => {
    const c = parseRetention('{"sms":999,"call":200,"notification":500,"xx":1}')
    expect(c).toEqual({ sms: 999, call: 200, notification: 500, outbound: 0 })
  })
})

describe('界面提交上来的值', () => {
  it('只认档位里的数，手写的杂数一律当不限制', () => {
    expect(sanitizeRetention({ sms: 999, call: 200, notification: 5000, outbound: 500 }))
      .toEqual({ sms: 999, call: 200, notification: 5000, outbound: 500 })
    expect(sanitizeRetention({ sms: 3, call: -1, notification: 1e9 }))
      .toEqual({ sms: 0, call: 0, notification: 0, outbound: 0 })
  })
  it('0 是「不限制」不是「一条不留」', () => {
    expect(sanitizeRetention({ sms: 0 }).sms).toBe(0)
    expect(overflow(10_000, 0, 500)).toBe(0)
  })
})

describe('该删多少', () => {
  it('没超不删', () => { expect(overflow(999, 999, 500)).toBe(0) })
  it('超了删差额', () => { expect(overflow(1200, 999, 500)).toBe(201) })
  it('单轮封顶 —— 首次生效可能是十几万行', () => {
    expect(overflow(200_000, 999, 2000)).toBe(2000)
  })
})

describe('跑一轮清理', () => {
  const mk = (users: string[], settings: Record<string, string>, counts: Record<string, number>) => {
    const trimmed: { u: string; k: string; keep: number; batch: number }[] = []
    return {
      trimmed,
      store: {
        async listUsers() { return users.map((id) => ({ id })) },
        async getUserSetting(u: string, k: string) { return k === RETENTION_SETTING ? settings[u] ?? null : null },
        async countEventsByKind(u: string, k: string) { return counts[`${u}:${k}`] ?? 0 },
        async trimEvents(u: string, k: string, keep: number, batch: number) {
          trimmed.push({ u, k, keep, batch })
          return Math.min(Math.max((counts[`${u}:${k}`] ?? 0) - keep, 0), batch)
        },
        async countOutbound(f: { user_id: string }) { return counts[`${f.user_id}:outbound`] ?? 0 },
        async trimOutbound(u: string, keep: number, batch: number) {
          trimmed.push({ u, k: 'outbound', keep, batch })
          return Math.min(Math.max((counts[`${u}:outbound`] ?? 0) - keep, 0), batch)
        },
      },
    }
  }

  it('没设上限的账号一条都不碰', async () => {
    const { store, trimmed } = mk(['u1'], {}, { 'u1:sms': 50_000 })
    expect(await runRetention(store as never)).toEqual([])
    expect(trimmed).toHaveLength(0)
  })

  it('只删超出的那一类，不牵连别的类', async () => {
    const { store, trimmed } = mk(
      ['u1'],
      { u1: serializeRetention({ sms: 999, call: 0, notification: 0, outbound: 0 }) },
      { 'u1:sms': 1500, 'u1:call': 9999, 'u1:notification': 9999 },
    )
    const r = await runRetention(store as never)
    expect(r).toEqual([{ user_id: 'u1', kind: 'sms', deleted: 501 }])
    expect(trimmed.map((t) => t.k)).toEqual(['sms'])
  })

  /**
   * 这条守的是多用户隔离：清理任务是少数几个必须跨用户遍历的地方之一，
   * 一旦在这里图快写一条「WHERE kind = ?」的批量语句，删掉的是所有人的历史。
   */
  it('逐个账号各按各的配置，不会拿一个人的上限去删另一个人的', async () => {
    const { store, trimmed } = mk(
      ['u1', 'u2'],
      { u1: serializeRetention({ sms: 200, call: 0, notification: 0, outbound: 0 }) },  // u2 没设
      { 'u1:sms': 1000, 'u2:sms': 99_999 },
    )
    const r = await runRetention(store as never)
    expect(r).toEqual([{ user_id: 'u1', kind: 'sms', deleted: 800 }])
    expect(trimmed.every((t) => t.u === 'u1')).toBe(true)
  })

  it('每次调用都带上 user_id 与 kind —— 少一个就是删别人的', async () => {
    const { store, trimmed } = mk(
      ['u1'], { u1: serializeRetention({ sms: 100, call: 100, notification: 100, outbound: 0 }) },
      { 'u1:sms': 500, 'u1:call': 500, 'u1:notification': 500 },
    )
    await runRetention(store as never)
    expect(trimmed).toHaveLength(3)
    for (const t of trimmed) { expect(t.u).toBe('u1'); expect(t.keep).toBe(100) }
  })
})

describe('发送记录也在管辖内', () => {
  const mk = (settings: Record<string, string>, counts: Record<string, number>) => {
    const trimmed: { u: string; k: string; keep: number }[] = []
    return { trimmed, store: {
      async listUsers() { return [{ id: 'u1' }] },
      async getUserSetting(u: string, k: string) { return k === RETENTION_SETTING ? settings[u] ?? null : null },
      async countEventsByKind(u: string, k: string) { return counts[`${u}:${k}`] ?? 0 },
      async trimEvents(u: string, k: string, keep: number, batch: number) {
        trimmed.push({ u, k, keep }); return Math.min(Math.max((counts[`${u}:${k}`] ?? 0) - keep, 0), batch)
      },
      async countOutbound(f: { user_id: string }) { return counts[`${f.user_id}:outbound`] ?? 0 },
      async trimOutbound(u: string, keep: number, batch: number) {
        trimmed.push({ u, k: 'outbound', keep }); return Math.min(Math.max((counts[`${u}:outbound`] ?? 0) - keep, 0), batch)
      },
    } }
  }

  it('超了就删，并且单独报出来', async () => {
    const { store } = mk(
      { u1: serializeRetention({ sms: 0, call: 0, notification: 0, outbound: 100 }) },
      { 'u1:outbound': 350 },
    )
    expect(await runRetention(store as never)).toEqual([{ user_id: 'u1', kind: 'outbound', deleted: 250 }])
  })

  it('没设就不碰 —— 和事件那三类一样，读不到等于不限制', async () => {
    const { store, trimmed } = mk({}, { 'u1:outbound': 99_999 })
    expect(await runRetention(store as never)).toEqual([])
    expect(trimmed).toHaveLength(0)
  })

  it('发送记录的上限不影响短信的上限，反之亦然', async () => {
    const { store, trimmed } = mk(
      { u1: serializeRetention({ sms: 0, call: 0, notification: 0, outbound: 50 }) },
      { 'u1:sms': 9999, 'u1:outbound': 200 },
    )
    const r = await runRetention(store as never)
    expect(r.map((x) => x.kind)).toEqual(['outbound'])
    expect(trimmed.map((t) => t.k)).toEqual(['outbound'])
  })
})

describe('新账号的默认值', () => {
  it('三类各 999', () => {
    expect(newAccountRetention()).toEqual({
      sms: DEFAULT_RETENTION, call: DEFAULT_RETENTION,
      notification: DEFAULT_RETENTION, outbound: DEFAULT_RETENTION,
    })
  })
  it('存进去再读出来不变形', () => {
    expect(parseRetention(serializeRetention(newAccountRetention()))).toEqual(newAccountRetention())
  })
})
