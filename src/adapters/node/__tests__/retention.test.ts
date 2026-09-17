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
    expect(await store.trimEvents('u1', 'sms', 0, 100)).toBe(0)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(10)
  })

  it('保留最新的，删掉最旧的', async () => {
    for (let i = 0; i < 10; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 1000 + i }))
    expect(await store.trimEvents('u1', 'sms', 3, 100)).toBe(7)
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
    await store.trimEvents('u1', 'sms', 3, 100)
    const first = (await store.listEvents({ user_id: 'u1', limit: 50, offset: 0 })).map((e) => e.id).sort()
    expect(first).toHaveLength(3)
    // 再跑两轮，剩下的必须还是同样那三条
    for (let i = 0; i < 2; i++) expect(await store.trimEvents('u1', 'sms', 3, 100)).toBe(0)
    const again = (await store.listEvents({ user_id: 'u1', limit: 50, offset: 0 })).map((e) => e.id).sort()
    expect(again).toEqual(first)
  })

  it('分批：单轮不超过 batch，多跑几轮补齐', async () => {
    for (let i = 0; i < 20; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 1000 + i }))
    expect(await store.trimEvents('u1', 'sms', 5, 4)).toBe(4)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(16)
    let guard = 0
    while (await store.trimEvents('u1', 'sms', 5, 4)) { if (++guard > 20) throw new Error('没收敛') }
    expect(await store.countEventsByKind('u1', 'sms')).toBe(5)
  })

  it('只动这一类，别的类型不受影响', async () => {
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`s${i}`, { kind: 'sms', occurred_at: 1000 + i }))
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`c${i}`, { kind: 'call', occurred_at: 1000 + i }))
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`n${i}`, { kind: 'notification', occurred_at: 1000 + i }))
    await store.trimEvents('u1', 'sms', 2, 100)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(2)
    expect(await store.countEventsByKind('u1', 'call')).toBe(5)
    expect(await store.countEventsByKind('u1', 'notification')).toBe(5)
  })

  /** 清理任务跨用户遍历，漏一个 user_id 就是把别人的历史删了 */
  it('只动这个账号，别人的一条不碰', async () => {
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`a${i}`, { user_id: 'u1', occurred_at: 1000 + i }))
    for (let i = 0; i < 5; i++) await store.insertEvent(ev(`b${i}`, { user_id: 'u2', device_id: 'dev_2', occurred_at: 1000 + i }))
    await store.trimEvents('u1', 'sms', 1, 100)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(1)
    expect(await store.countEventsByKind('u2', 'sms')).toBe(5)
  })

  it('没超上限时不做任何删除', async () => {
    for (let i = 0; i < 3; i++) await store.insertEvent(ev(`e${i}`, { occurred_at: 1000 + i }))
    expect(await store.trimEvents('u1', 'sms', 999, 100)).toBe(0)
    expect(await store.countEventsByKind('u1', 'sms')).toBe(3)
  })
})
