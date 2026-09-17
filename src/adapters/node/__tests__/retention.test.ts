/**
 * trimEvents 的真实 SQL 行为。纯逻辑那部分在 core/__tests__/retention.test.ts，
 * 这里测的是「SQL 到底删了哪几条」——而这正是纯逻辑测不出来的部分。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteStore } from '../store.js'
import type { StoredEvent } from '../../../core/store.js'

let store: SqliteStore
const ev = (id: string, over: Partial<StoredEvent> = {}): StoredEvent => ({
  id, user_id: 'u1', device_id: 'dev_1', kind: 'sms', direction: 'in', sim_slot: null,
  sender_enc: new Uint8Array([1]), content_enc: new Uint8Array([2]), enc_ver: 1,
  occurred_at: 1_000_000, received_at: 1_000_000, matched_rules: null, created_at: 1_000_000,
  ...over,
})

beforeEach(async () => {
  store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'homing-ret-')), 'db.sqlite'))
  await store.migrate()
  // events 有外键指向 users / devices，得先把它们建出来
  for (const id of ['u1', 'u2']) {
    await store.upsertUser({
      id, name: id, password_hash: 'x', totp_secret: '', role: 'admin',
      bot_token: `bot_${id}`, disabled: false, expires_at: null,
      agreed_version: null, agreed_at: null, created_at: 0,
    } as never)
  }
  await store.createDevice({
    id: 'dev_1', user_id: 'u1', name: 'd', token_hash: 'h', status: 'offline',
    last_seen_at: null, battery: null, charging: null, net_json: null,
    location_enc: null, location_at: null, app_version: null, created_at: 0,
  } as never)
  await store.createDevice({
    id: 'dev_2', user_id: 'u2', name: 'd2', token_hash: 'h2', status: 'offline',
    last_seen_at: null, battery: null, charging: null, net_json: null,
    location_enc: null, location_at: null, app_version: null, created_at: 0,
  } as never)
})

describe('trimEvents', () => {
  it('keep=0 一条都不删（0 是「不限制」）', async () => {
    for (let i = 0; i < 10; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 1000 + i }))
    expect(await store.trimEvents('u1', 'sms', 0, 100, Infinity)).toBe(0)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(10)
  })

  it('保留最新的，删掉最旧的', async () => {
    for (let i = 0; i < 10; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 1000 + i }))
    expect(await store.trimEvents('u1', 'sms', 3, 100, Infinity)).toBe(7)
    const left = (await store.listEvents({ user_id: 'u1', limit: 50, offset: 0 })).map((e) => e.id)
    expect(left.sort()).toEqual(['e7', 'e8', 'e9'])
  })

  /**
   * 同一毫秒多条：补传时并不罕见。只按 occurred_at 排的话，
   * 「最新 3 条」每次取到的可能是不同的 3 条——表现是每轮清理都在边界上
   * 反复删掉又留下不同的几条，而且不报错。
   */
  it('同毫秒多条时边界是稳的，跑多轮结果不变', async () => {
    for (let i = 0; i < 10; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 5000 }))
    await store.trimEvents('u1', 'sms', 3, 100, Infinity)
    const first = (await store.listEvents({ user_id: 'u1', limit: 50, offset: 0 })).map((e) => e.id).sort()
    expect(first).toHaveLength(3)
    // 再跑两轮，剩下的必须还是同样那三条
    for (let i = 0; i < 2; i++) expect(await store.trimEvents('u1', 'sms', 3, 100, Infinity)).toBe(0)
    const again = (await store.listEvents({ user_id: 'u1', limit: 50, offset: 0 })).map((e) => e.id).sort()
    expect(again).toEqual(first)
  })

  it('分批：单轮不超过 batch，多跑几轮补齐', async () => {
    for (let i = 0; i < 20; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 1000 + i }))
    expect(await store.trimEvents('u1', 'sms', 5, 4, Infinity)).toBe(4)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(16)
    let guard = 0
    while (await store.trimEvents('u1', 'sms', 5, 4, Infinity)) { if (++guard > 20) throw new Error('没收敛') }
    expect(await store.countEventsByKind('u1', 'sms')).toBe(5)
  })

  it('只动这一类，别的类型不受影响', async () => {
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`s${i}`, { kind: 'sms', occurred_at: 1000 + i }))
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`c${i}`, { kind: 'call', occurred_at: 1000 + i }))
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`n${i}`, { kind: 'notification', occurred_at: 1000 + i }))
    await store.trimEvents('u1', 'sms', 2, 100, Infinity)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(2)
    expect(await store.countEventsByKind('u1', 'call')).toBe(5)
    expect(await store.countEventsByKind('u1', 'notification')).toBe(5)
  })

  /** 清理任务跨用户遍历，漏一个 user_id 就是把别人的历史删了 */
  it('只动这个账号，别人的一条不碰', async () => {
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`a${i}`, { user_id: 'u1', occurred_at: 1000 + i }))
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`b${i}`, { user_id: 'u2', device_id: 'dev_2', occurred_at: 1000 + i }))
    await store.trimEvents('u1', 'sms', 1, 100, Infinity)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(1)
    expect(await store.countEventsByKind('u2', 'sms')).toBe(5)
  })

  /**
   * occurred_at 是**设备生成的**，协议明确不给它设边界。手机时钟跑偏时，
   * 新收到的验证码会带着一个很旧的 occurred_at 进来、排在保留窗口之外，
   * 当轮就被删掉——而它恰恰是用户此刻最需要的那一条。
   * 护栏看的是 received_at（落库时用服务端时钟写的，设备伪造不了）。
   */
  it('护栏：刚到手的一律不删，哪怕它的 occurred_at 是 1970 年', async () => {
    const NOW = 1_800_000_000_000
    // 20 条正常的老消息
    for (let i = 0; i < 20; i++) {
      await store.insertEvent(ev(`old${i}`, { occurred_at: NOW - 86400000 + i, received_at: NOW - 86400000 + i }))
    }
    // 一台时钟跑到 1970 的手机，刚刚送来 3 条验证码
    for (let i = 0; i < 3; i++) {
      await store.insertEvent(ev(`skew${i}`, { occurred_at: 1000 + i, received_at: NOW - 60_000 }))
    }
    // 上限 5：按 occurred_at 排，那 3 条时钟错的排在最末，本该第一批被删
    const deleted = await store.trimEvents('u1', 'sms', 5, 100, NOW - 3600_000)
    const left = (await store.listEvents({ user_id: 'u1', limit: 50, offset: 0 })).map((e) => e.id)
    for (let i = 0; i < 3; i++) expect(left).toContain(`skew${i}`)
    expect(deleted).toBeGreaterThan(0)          // 老的照删
  })

  it('护栏不改变「保留几条」的口径 —— 它只决定哪些可以删', async () => {
    const NOW = 1_800_000_000_000
    for (let i = 0; i < 10; i++) {
      await store.insertEvent(ev(`e${i}`, { occurred_at: NOW - 86400000 + i, received_at: NOW - 86400000 + i }))
    }
    // 全都在护栏之外，正常删到 3 条
    await store.trimEvents('u1', 'sms', 3, 100, NOW - 3600_000)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(3)
  })

  it('全部都在护栏内时一条都不删', async () => {
    const NOW = 1_800_000_000_000
    for (let i = 0; i < 10; i++) {
      await store.insertEvent(ev(`e${i}`, { occurred_at: NOW - 1000 + i, received_at: NOW - 1000 + i }))
    }
    expect(await store.trimEvents('u1', 'sms', 3, 100, NOW - 3600_000)).toBe(0)
  })

  it('oldestEventAt 给出「只留到哪一天」', async () => {
    expect(await store.oldestEventAt('u1', 'sms')).toBeNull()
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 5000 + i * 1000 }))
    expect(await store.oldestEventAt('u1', 'sms')).toBe(5000)
    await store.trimEvents('u1', 'sms', 2, 100, Infinity)
    expect(await store.oldestEventAt('u1', 'sms')).toBe(8000)
  })

  it('没超上限时不做任何删除', async () => {
    for (let i = 0; i < 3; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 1000 + i }))
    expect(await store.trimEvents('u1', 'sms', 999, 100, Infinity)).toBe(0)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(3)
  })
})
